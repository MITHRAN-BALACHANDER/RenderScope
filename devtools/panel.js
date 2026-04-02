/**
 * RenderScope — DevTools Panel Logic (devtools/panel.js)
 *
 * EXECUTION CONTEXT: DevTools panel page (extension context).
 *
 * RESPONSIBILITIES:
 *   1. Connect to background bridge via a long-lived Port
 *   2. Receive structured frame-data messages from the content script
 *   3. Update the multi-tab UI — Overview, Scene, Shaders, Warnings, Timeline
 *   4. Render mini canvas charts (frame-time sparkline + timeline)
 *   5. Forward user commands (highlight, export, pause) back to content script
 *
 * STATE MANAGEMENT:
 *   All mutable UI state is held in a single `state` object.
 *   UI rendering functions are pure: take state → dom mutations.
 */

'use strict';

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const tabId = chrome.devtools.inspectedWindow.tabId;

// Connect to background bridge
let port = chrome.runtime.connect({ name: `renderscope-devtools-${tabId}` });

// Reconnect on disconnect (service worker can restart)
port.onDisconnect.addListener(() => {
  try {
    port = chrome.runtime.connect({ name: `renderscope-devtools-${tabId}` });
    port.onMessage.addListener(handleContentMessage);
    port.onDisconnect.addListener(arguments.callee);
  } catch (_) {}
});

port.onMessage.addListener(handleContentMessage);

// ─── Application State ────────────────────────────────────────────────────────

const state = {
  profiling: true,              // mirrored from content script
  threeDetected: false,
  threeRevision: null,
  contextLost: false,

  // Latest frame data
  metrics: null,
  frameTimes: [],               // ring buffer from content
  spikes: [],
  scene: null,                  // { objects, totals, shaders, warnings }

  // UI state
  activeTab: 'overview',
  sceneFilter: '',
  sceneSort: 'cost',
  showInvisible: false,
  filterErrors: true,
  filterWarnings: true,
  filterInfo: true,

  // Charts
  frameChartCtx: null,
  timelineCtx: null,
  timelineData: [],             // full accumulated timeline
  MAX_TIMELINE: 600,
};

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const DOM = {
  // Status
  statusDot:       $('statusDot'),
  statusText:      $('statusText'),
  threeVersion:    $('threeVersion'),

  // Controls
  btnToggle:       $('btnToggleProfiling'),
  iconPlay:        $('iconPlay'),
  iconPause:       $('iconPause'),
  profilingLabel:  $('profilingLabel'),
  btnExport:       $('btnExport'),

  // Tab buttons
  tabs:            document.querySelectorAll('.tab'),

  // Panels
  panelOverview:   $('panel-overview'),
  panelScene:      $('panel-scene'),
  panelShaders:    $('panel-shaders'),
  panelWarnings:   $('panel-warnings'),
  panelTimeline:   $('panel-timeline'),

  // Overview
  metFps:          $('metFps'),
  metFpsSub:       $('metFpsSub'),
  metDrawCalls:    $('metDrawCalls'),
  metTriangles:    $('metTriangles'),
  metTextures:     $('metTextures'),
  metGeometries:   $('metGeometries'),
  metMeshes:       $('metMeshes'),
  cardFps:         $('card-fps'),
  cardDC:          $('card-drawcalls'),
  cardTri:         $('card-triangles'),
  frameChart:      $('frameChart'),
  spikeList:       $('spikeList'),
  spikeCount:      $('spikeCount'),

  // Scene
  sceneSearch:     $('sceneSearch'),
  sceneSort:       $('sceneSort'),
  showInvisible:   $('showInvisible'),
  sceneTableBody:  $('sceneTableBody'),
  sceneObjCount:   $('sceneObjCount'),
  sceneTotalTris:  $('sceneTotalTris'),
  sceneTotalTex:   $('sceneTotalTex'),
  sceneShadowLights: $('sceneShadowLights'),

  // Shaders
  shaderList:      $('shaderList'),

  // Warnings
  warningsList:    $('warningsList'),
  warningsBadge:   $('warningsBadge'),
  filterErrors:    $('filterErrors'),
  filterWarnings:  $('filterWarnings'),
  filterInfo:      $('filterInfo'),

  // Timeline
  timelineChart:   $('timelineChart'),
  statMin:         $('statMin'),
  statAvg:         $('statAvg'),
  statMax:         $('statMax'),
  statP95:         $('statP95'),
  statSpikes:      $('statSpikes'),
  btnClearTimeline: $('btnClearTimeline'),
};

// ─── Message Handler ─────────────────────────────────────────────────────────

function handleContentMessage(message) {
  if (!message || message.source !== 'renderscope-content') return;

  switch (message.type) {
    case 'three-detected':
      state.threeDetected = true;
      state.threeRevision = message.revision;
      state.contextLost = false;
      updateStatus();
      break;

    case 'three-not-detected':
      state.threeDetected = false;
      updateStatus();
      break;

    case 'context-lost':
      state.contextLost = true;
      updateStatus();
      break;

    case 'frame-update':
      onFrameUpdate(message);
      break;
  }
}

// ─── Frame Update Handler ─────────────────────────────────────────────────────

let animFrameQueued = false;
let pendingUpdate = null;

function onFrameUpdate(message) {
  // Throttle UI updates to rAF — no point updating faster than the panel repaints
  pendingUpdate = message;
  if (!animFrameQueued) {
    animFrameQueued = true;
    requestAnimationFrame(flushUpdate);
  }
}

function flushUpdate() {
  animFrameQueued = false;
  if (!pendingUpdate) return;

  const msg = pendingUpdate;
  pendingUpdate = null;

  state.metrics    = msg.metrics;
  state.frameTimes = msg.frameTimes || [];
  state.spikes     = msg.spikes || [];
  if (msg.scene) state.scene = msg.scene;

  // Accumulate timeline
  if (msg.metrics?.frameTime != null) {
    state.timelineData.push(msg.metrics.frameTime);
    if (state.timelineData.length > state.MAX_TIMELINE) {
      state.timelineData.shift();
    }
  }

  // If Three.js data is streaming, it must be active
  if (!state.threeDetected) {
    state.threeDetected = true;
    updateStatus();
  }

  renderUI();
}

// ─── UI Rendering ─────────────────────────────────────────────────────────────

function renderUI() {
  switch (state.activeTab) {
    case 'overview':  renderOverview();  break;
    case 'scene':     renderScene();     break;
    case 'shaders':   renderShaders();   break;
    case 'warnings':  renderWarnings();  break;
    case 'timeline':  renderTimeline();  break;
  }

  // Always update warnings badge
  updateWarningsBadge();
}

// ── Overview ─────────────────────────────────────────────────────────────────

function renderOverview() {
  const m = state.metrics;
  if (!m) return;

  // FPS card with color coding
  const fps = m.fps;
  DOM.metFps.textContent = fps.toFixed(1);
  DOM.metFpsSub.textContent = `${m.frameTime.toFixed(2)}ms`;
  DOM.cardFps.dataset.health = fps >= 55 ? 'good' : fps >= 30 ? 'warn' : 'bad';

  // Draw calls
  DOM.metDrawCalls.textContent = m.drawCalls.toLocaleString();
  DOM.cardDC.dataset.health = m.drawCalls < 50 ? 'good' : m.drawCalls < 150 ? 'warn' : 'bad';

  // Triangles
  DOM.metTriangles.textContent = formatNumber(m.triangles);
  DOM.cardTri.dataset.health = m.triangles < 500_000 ? 'good' : m.triangles < 2_000_000 ? 'warn' : 'bad';

  // Scene totals
  const totals = state.scene?.totals;
  DOM.metTextures.textContent   = totals ? totals.textureCount.toLocaleString()  : '—';
  DOM.metGeometries.textContent = totals ? totals.geometryCount.toLocaleString() : '—';
  DOM.metMeshes.textContent     = totals ? totals.meshCount.toLocaleString()     : '—';

  // Frame chart
  drawFrameChart();

  // Spikes
  renderSpikes();
}

function drawFrameChart() {
  const canvas = DOM.frameChart;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const data = state.frameTimes;

  ctx.clearRect(0, 0, W, H);

  if (data.length === 0) return;

  const MAX_MS = 50;   // chart ceiling
  const barW = W / 120;

  // Target line guides
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  [16, 33].forEach(ms => {
    const y = H - (ms / MAX_MS) * H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  });

  // Bars
  data.forEach((ft, i) => {
    const x = i * barW;
    const h = Math.min(H, (ft / MAX_MS) * H);
    const color = ft <= 16 ? '#4ade80'  // green
                : ft <= 33 ? '#facc15'  // yellow
                :             '#f87171'; // red
    ctx.fillStyle = color;
    ctx.fillRect(x, H - h, barW - 0.5, h);
  });
}

function renderSpikes() {
  const spikes = state.spikes;
  DOM.spikeCount.textContent = `${spikes.length} recorded`;

  if (spikes.length === 0) {
    DOM.spikeList.innerHTML = '<div class="empty-state">No spikes detected</div>';
    return;
  }

  DOM.spikeList.innerHTML = spikes.map(s => `
    <div class="spike-item">
      <span class="spike-time">${s.frameTime}ms</span>
      <span class="spike-detail">${s.drawCalls} draw calls · ${formatNumber(s.triangles)} tris</span>
      <span class="spike-age">${timeSince(s.timestamp)}</span>
    </div>
  `).join('');
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function renderScene() {
  const scene = state.scene;
  if (!scene) {
    DOM.sceneTableBody.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty-state">Waiting for scene data…</td></tr>';
    return;
  }

  const { objects, totals } = scene;

  // Totals bar
  DOM.sceneObjCount.textContent     = `${totals.meshCount} objects`;
  DOM.sceneTotalTris.textContent    = `${formatNumber(totals.triangleCount)} triangles`;
  DOM.sceneTotalTex.textContent     = `${totals.textureCount} textures`;
  DOM.sceneShadowLights.textContent = `${totals.shadowLights} shadow lights`;

  // Filter
  const filter = state.sceneFilter.toLowerCase();
  let filtered = objects.filter(o => {
    if (!state.showInvisible && !o.visible) return false;
    if (filter && !o.name.toLowerCase().includes(filter) && !o.type.toLowerCase().includes(filter)) return false;
    return true;
  });

  // Sort
  const sortKey = state.sceneSort;
  filtered.sort((a, b) => {
    if (sortKey === 'cost')      return b.estimatedCost - a.estimatedCost;
    if (sortKey === 'triangles') return b.triangles - a.triangles;
    if (sortKey === 'textures')  return b.textureCount - a.textureCount;
    if (sortKey === 'name')      return a.name.localeCompare(b.name);
    return 0;
  });

  if (filtered.length === 0) {
    DOM.sceneTableBody.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty-state">No objects match filter</td></tr>';
    return;
  }

  DOM.sceneTableBody.innerHTML = filtered.map(obj => {
    const costClass = obj.estimatedCost >= 60 ? 'cost-high' : obj.estimatedCost >= 30 ? 'cost-mid' : 'cost-low';
    const visIcon = obj.visible ? '' : '<span class="badge-hidden" title="Hidden">H</span>';
    const shadowIcon = obj.castShadow ? '<span class="badge-shadow" title="Casts shadow">☀</span>' : '';
    const skinnedIcon = obj.skinned ? '<span class="badge-skinned" title="Skinned mesh">S</span>' : '';
    const instancedIcon = obj.instanceCount > 1 ? `<span class="badge-instanced" title="Instanced (${obj.instanceCount}x)">×${obj.instanceCount}</span>` : '';

    return `
      <tr data-uuid="${obj.uuid}" class="scene-row${!obj.visible ? ' row-hidden' : ''}">
        <td class="obj-name">
          <span class="obj-type-dot type-${obj.type.toLowerCase()}"></span>
          <span class="name-text" title="${obj.name}">${truncate(obj.name, 32)}</span>
          ${visIcon}${shadowIcon}${skinnedIcon}${instancedIcon}
        </td>
        <td><span class="type-chip">${obj.type}</span></td>
        <td class="num">${formatNumber(obj.triangles)}</td>
        <td class="num">${obj.textureCount}</td>
        <td><span class="mat-chip">${obj.materialType}</span></td>
        <td class="num">
          <div class="cost-bar-wrap">
            <div class="cost-bar ${costClass}" style="width:${obj.estimatedCost}%"></div>
            <span class="cost-num">${obj.estimatedCost}</span>
          </div>
        </td>
        <td>
          <button class="btn-highlight btn-icon" data-uuid="${obj.uuid}" title="Highlight in scene">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11">
              <circle cx="7" cy="7" r="5"/>
              <line x1="7" y1="1" x2="7" y2="3"/>
              <line x1="7" y1="11" x2="7" y2="13"/>
              <line x1="1" y1="7" x2="3" y2="7"/>
              <line x1="11" y1="7" x2="13" y2="7"/>
            </svg>
          </button>
        </td>
      </tr>`;
  }).join('');

  // Attach highlight click handlers
  DOM.sceneTableBody.querySelectorAll('.btn-highlight').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const uuid = btn.dataset.uuid;
      // Toggle: if already highlighted, unhighlight
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        sendToContent({ target: 'renderscope-content', command: 'unhighlight-object' });
      } else {
        DOM.sceneTableBody.querySelectorAll('.btn-highlight.active').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sendToContent({ target: 'renderscope-content', command: 'highlight-object', uuid });
      }
      e.stopPropagation();
    });
  });
}

// ── Shaders ──────────────────────────────────────────────────────────────────

function renderShaders() {
  const shaders = state.scene?.shaders ?? [];

  if (shaders.length === 0) {
    DOM.shaderList.innerHTML = '<div class="empty-state">No shaders intercepted yet.<br>Shaders are captured on first render of each material.</div>';
    return;
  }

  DOM.shaderList.innerHTML = shaders
    .sort((a, b) => b.combinedScore - a.combinedScore)  // most expensive first
    .map(s => {
      const scoreClass = s.combinedScore >= 75 ? 'score-high' : s.combinedScore >= 50 ? 'score-mid' : 'score-low';
      const allFlags = s.flags || [];

      return `
        <div class="shader-card ${s.isExpensive ? 'shader-expensive' : ''}">
          <div class="shader-card-header">
            <div class="shader-name">
              <span class="shader-material-icon">▲</span>
              ${escapeHtml(s.materialName)}
              ${s.isExpensive ? '<span class="badge-expensive">EXPENSIVE</span>' : ''}
            </div>
            <div class="shader-score ${scoreClass}">
              <span class="score-label">Score</span>
              <span class="score-value">${s.combinedScore}</span>
              <span class="score-max">/100</span>
            </div>
          </div>

          <div class="shader-stages">
            ${renderShaderStage(s.vertex, 'Vertex')}
            ${renderShaderStage(s.fragment, 'Fragment')}
          </div>

          ${allFlags.length > 0 ? `
          <div class="shader-flags">
            ${allFlags.map(f => `
              <div class="shader-flag severity-${f.severity}">
                <span class="flag-stage">[${f.stage}]</span>
                ${escapeHtml(f.msg)}
              </div>
            `).join('')}
          </div>` : ''}
        </div>`;
    }).join('');
}

function renderShaderStage(stage, label) {
  if (!stage) return '';
  return `
    <div class="shader-stage">
      <div class="stage-label">${label}</div>
      <div class="stage-metrics">
        <span class="sm-item" title="Lines of code"><b>${stage.lines}</b> lines</span>
        <span class="sm-item" title="Texture lookups"><b>${stage.textureLookups}</b> tex</span>
        <span class="sm-item" title="Loops"><b>${stage.loops}</b> loops</span>
        <span class="sm-item" title="Conditionals"><b>${stage.conditionals}</b> if</span>
        ${stage.discards > 0 ? `<span class="sm-item warn-item" title="discard statements"><b>${stage.discards}</b> discard</span>` : ''}
        <span class="sm-score ${stage.score >= 50 ? 'high' : ''}">${stage.score}/100</span>
      </div>
    </div>`;
}

// ── Warnings ─────────────────────────────────────────────────────────────────

function renderWarnings() {
  const warnings = state.scene?.warnings ?? [];

  const visible = warnings.filter(w => {
    if (w.severity === 'error'   && !state.filterErrors)   return false;
    if (w.severity === 'warning' && !state.filterWarnings) return false;
    if (w.severity === 'info'    && !state.filterInfo)     return false;
    return true;
  });

  if (visible.length === 0) {
    DOM.warningsList.innerHTML = warnings.length === 0
      ? '<div class="empty-state">✓ No warnings — scene looks healthy</div>'
      : '<div class="empty-state">All warnings filtered out</div>';
    return;
  }

  DOM.warningsList.innerHTML = visible.map(w => `
    <div class="warning-card severity-${w.severity}">
      <div class="warning-header">
        <span class="warning-icon">${severityIcon(w.severity)}</span>
        <span class="warning-category">${escapeHtml(w.category)}</span>
        <span class="warning-severity severity-chip-${w.severity}">${w.severity.toUpperCase()}</span>
        <span class="warning-metric">${escapeHtml(w.metric)}</span>
      </div>
      <div class="warning-title">${escapeHtml(w.title)}</div>
      <div class="warning-detail">${escapeHtml(w.detail)}</div>
      ${w.docsLink ? `<a class="warning-docs" href="${w.docsLink}" target="_blank" rel="noopener">Three.js docs ↗</a>` : ''}
    </div>
  `).join('');
}

function updateWarningsBadge() {
  const warnings = state.scene?.warnings ?? [];
  const errors = warnings.filter(w => w.severity === 'error').length;
  const total = warnings.length;

  if (total === 0) {
    DOM.warningsBadge.style.display = 'none';
  } else {
    DOM.warningsBadge.style.display = 'inline-flex';
    DOM.warningsBadge.textContent = total;
    DOM.warningsBadge.className = `badge ${errors > 0 ? 'badge-error' : 'badge-warn'}`;
  }
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function renderTimeline() {
  const canvas = DOM.timelineChart;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const data = state.timelineData;

  ctx.clearRect(0, 0, W, H);

  if (data.length < 2) return;

  const maxMs = Math.max(50, ...data);
  const barW = W / state.MAX_TIMELINE;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [8, 16, 33, 50].forEach(ms => {
    if (ms > maxMs) return;
    const y = H - (ms / maxMs) * H;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText(`${ms}ms`, 2, y - 2);
  });

  // Draw area chart
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.02)');

  ctx.beginPath();
  ctx.moveTo(0, H);

  data.forEach((ft, i) => {
    const x = i * barW;
    const y = H - (ft / maxMs) * H;
    if (i === 0) ctx.lineTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.lineTo((data.length - 1) * barW, H);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line on top
  ctx.beginPath();
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 1.5;

  data.forEach((ft, i) => {
    const x = i * barW;
    const y = H - (ft / maxMs) * H;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Spike dots
  data.forEach((ft, i) => {
    if (ft > 33) {
      const x = i * barW;
      const y = H - (ft / maxMs) * H;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f87171';
      ctx.fill();
    }
  });

  // Stats
  const sorted = [...data].sort((a, b) => a - b);
  const sum = data.reduce((a, b) => a + b, 0);
  const avg = sum / data.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const spikes = data.filter(ft => ft > 33).length;

  DOM.statMin.textContent   = `${sorted[0].toFixed(2)}ms`;
  DOM.statAvg.textContent   = `${avg.toFixed(2)}ms`;
  DOM.statMax.textContent   = `${sorted[sorted.length - 1].toFixed(2)}ms`;
  DOM.statP95.textContent   = `${p95?.toFixed(2) ?? '—'}ms`;
  DOM.statSpikes.textContent = spikes.toString();
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function updateStatus() {
  const status = DOM.statusDot;
  const text   = DOM.statusText;
  const ver    = DOM.threeVersion;

  if (state.contextLost) {
    status.className = 'status-dot dot-error';
    text.textContent = 'WebGL context lost';
  } else if (!state.threeDetected) {
    status.className = 'status-dot dot-idle';
    text.textContent = 'Waiting for Three.js…';
  } else if (!state.profiling) {
    status.className = 'status-dot dot-paused';
    text.textContent = 'Profiling paused';
  } else {
    status.className = 'status-dot dot-active';
    text.textContent = 'Profiling active';
  }

  ver.textContent = state.threeRevision ? `r${state.threeRevision}` : '';
}

// ─── Tab Switching ────────────────────────────────────────────────────────────

DOM.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    state.activeTab = id;

    DOM.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));

    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('active', p.id === `panel-${id}`);
    });

    renderUI();  // Immediately render the newly active tab
  });
});

// ─── Control Event Handlers ───────────────────────────────────────────────────

DOM.btnToggle.addEventListener('click', () => {
  state.profiling = !state.profiling;
  DOM.iconPlay.style.display   = state.profiling ? 'none'  : 'block';
  DOM.iconPause.style.display  = state.profiling ? 'block' : 'none';
  DOM.profilingLabel.textContent = state.profiling ? 'Pause' : 'Resume';
  sendToContent({ target: 'renderscope-content', command: state.profiling ? 'start-profiling' : 'stop-profiling' });
  updateStatus();
});

DOM.btnExport.addEventListener('click', () => {
  sendToContent({ target: 'renderscope-content', command: 'export-report' });
});

DOM.sceneSearch?.addEventListener('input', (e) => {
  state.sceneFilter = e.target.value;
  renderScene();
});

DOM.sceneSort?.addEventListener('change', (e) => {
  state.sceneSort = e.target.value;
  renderScene();
});

DOM.showInvisible?.addEventListener('change', (e) => {
  state.showInvisible = e.target.checked;
  renderScene();
});

DOM.filterErrors?.addEventListener('change',   (e) => { state.filterErrors   = e.target.checked; renderWarnings(); });
DOM.filterWarnings?.addEventListener('change', (e) => { state.filterWarnings = e.target.checked; renderWarnings(); });
DOM.filterInfo?.addEventListener('change',     (e) => { state.filterInfo     = e.target.checked; renderWarnings(); });

DOM.btnClearTimeline?.addEventListener('click', () => {
  state.timelineData = [];
  renderTimeline();
});

// Initial state for profiling button — starts active
DOM.iconPause.style.display = 'block';
DOM.iconPlay.style.display  = 'none';
DOM.profilingLabel.textContent = 'Pause';

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendToContent(message) {
  try {
    port.postMessage(message);
  } catch (_) {
    // Port may be dead; reconnect happens automatically
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityIcon(severity) {
  if (severity === 'error')   return '✕';
  if (severity === 'warning') return '⚠';
  return 'ℹ';
}

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

updateStatus();
