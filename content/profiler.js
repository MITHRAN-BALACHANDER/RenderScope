/**
 * FrameDoctor — Content Script / Profiler (content/profiler.js)
 *
 * EXECUTION CONTEXT: The inspected webpage (document_start).
 *
 * RESPONSIBILITIES:
 *   1. Detect Three.js (global window.THREE or module-exported renderer)
 *   2. Monkey-patch THREE.WebGLRenderer.prototype.render to intercept frames
 *   3. Track per-frame metrics: draw calls, triangles, frame time, FPS
 *   4. Traverse scene graph using core/analyzer.js
 *   5. Intercept materials via onBeforeCompile for shader analysis
 *   6. Generate warnings via core/warnings.js
 *   7. Send structured snapshots to the background bridge via chrome.runtime.sendMessage
 *   8. Listen for commands from DevTools panel (highlight object, start/stop profiling)
 *
 * DATA FLOW:
 *   profiler.js → chrome.runtime.sendMessage → bridge.js → devtools port → panel.js
 *   panel.js    → chrome.tabs.sendMessage    → bridge.js → profiler.js (commands)
 *
 * INJECTION STRATEGY:
 *   The profiler relies on THREE being a global. For apps that import THREE via
 *   ES modules (no global), we poll for a patched renderer instance via a
 *   known detection hook.
 */

(function () {
  'use strict';

  // ─── Guard: run once ────────────────────────────────────────────────────────
  if (window.__FrameDoctorActive) return;
  window.__FrameDoctorActive = true;

  // ─── State ──────────────────────────────────────────────────────────────────

  const state = {
    profiling: true,           // can be toggled by panel
    threeDetected: false,
    renderers: new Set(),       // track multiple renderers

    // Per-frame accumulators
    frameCount: 0,
    lastFrameTime: performance.now(),
    frameTimes: [],             // ring buffer of last 60 frame durations (ms)
    MAX_FRAME_HISTORY: 120,

    // Scene snapshot (refreshed every N frames)
    sceneSnapshot: null,
    SCENE_REFRESH_INTERVAL: 30, // frames between full scene traversals

    // Shader reports (keyed by material uuid, built up over time)
    shaderReports: {},

    // Object highlight state
    highlightedObject: null,
    originalEmissive: null,

    // Spike detection
    spikes: [],                 // last 10 spike events
    MAX_SPIKES: 10,
  };

  // ─── Load core modules via injected scripts ─────────────────────────────────
  // We inject analyzer.js, shaderAnalyzer.js, warnings.js into the page context
  // so they can access window.THREE directly.

  function injectScript(path) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(path);
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); resolve(); };  // graceful fail
      (document.head || document.documentElement).appendChild(script);
    });
  }

  // ─── Three.js Detection ─────────────────────────────────────────────────────

  /**
   * Attempt to detect THREE.js in the page.
   * Handles: window.THREE (CDN / direct script), deferred loading.
   */
  function detectThree() {
    // Case 1: standard CDN global
    if (window.THREE?.WebGLRenderer) {
      return window.THREE;
    }

    // Case 2: some bundlers expose r3f or other wrappers — look for a live renderer
    // We'll also detect it via the monkey-patch in initPatching()
    return null;
  }

  /**
   * Wait for THREE to become available with exponential backoff.
   * Gives up after ~15 seconds to avoid running forever.
   */
  function waitForThree(maxWaitMs = 15_000) {
    const start = Date.now();
    return new Promise((resolve) => {
      function check(delay) {
        const THREE = detectThree();
        if (THREE) { resolve(THREE); return; }
        if (Date.now() - start > maxWaitMs) { resolve(null); return; }
        setTimeout(() => check(Math.min(delay * 1.5, 2000)), delay);
      }
      check(100);
    });
  }

  // ─── Monkey-Patching ────────────────────────────────────────────────────────

  /**
   * Patch THREE.WebGLRenderer.prototype.render.
   * Wraps the original render call to:
   *   - Measure frame time
   *   - Capture renderer info (draw calls, triangles etc.)
   *   - Periodically trigger scene + shader analysis
   *   - Send snapshots to the extension
   */
  function patchRenderer(THREE) {
    const proto = THREE.WebGLRenderer.prototype;

    if (proto.__framedoctorPatched) return;  // idempotent
    proto.__framedoctorPatched = true;

    const originalRender = proto.render;

    proto.render = function framedoctorRender(scene, camera) {
      // Register this renderer instance
      if (!state.renderers.has(this)) {
        state.renderers.add(this);
        console.log('[FrameDoctor] WebGLRenderer instance detected');
      }

      // Call original
      const t0 = performance.now();
      originalRender.call(this, scene, camera);
      const t1 = performance.now();

      if (!state.profiling) return;

      const frameTime = t1 - t0;
      recordFrame(frameTime, this, scene, camera);
    };

    console.log('[FrameDoctor] WebGLRenderer.prototype.render patched ✓');
  }

  // ─── Shader Interception ────────────────────────────────────────────────────

  /**
   * Attach an onBeforeCompile hook to a material.
   * We intercept the compiled shader source and run shaderAnalyzer on it.
   */
  function patchMaterial(material) {
    if (!material || material.__framedoctorPatched) return;
    material.__framedoctorPatched = true;

    const originalHook = material.onBeforeCompile;

    material.onBeforeCompile = function (shader, renderer) {
      // Call any existing hook first (important: don't break user shaders)
      if (originalHook) originalHook.call(this, shader, renderer);

      // Analyze the final shader source after user hooks have modified it
      // We defer slightly to let the shader compilation finish
      const matName = material.name || material.type || 'unnamed';
      const matUuid = material.uuid;

      // Schedule analysis asynchronously (don't block compilation)
      setTimeout(() => {
        if (window.__FrameDoctor?.analyzeShaderProgram) {
          const report = window.__FrameDoctor.analyzeShaderProgram(
            shader.vertexShader,
            shader.fragmentShader,
            matName
          );
          state.shaderReports[matUuid] = report;
        }
      }, 0);
    };

    // For materials already compiled (no onBeforeCompile triggered after the fact),
    // we can't retroactively get the GLSL. We'll note this material exists
    // and show partial info.
  }

  /**
   * Patch all materials in a scene so we can intercept their shaders.
   */
  function patchSceneMaterials(scene) {
    scene.traverse((object) => {
      const mats = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of mats) {
        if (mat) patchMaterial(mat);
      }
    });
  }

  // ─── Frame Recording ────────────────────────────────────────────────────────

  let framesSinceLastSnapshot = 0;

  function recordFrame(frameTime, renderer, scene, camera) {
    state.frameCount++;
    framesSinceLastSnapshot++;

    // Maintain ring buffer of frame times
    state.frameTimes.push(frameTime);
    if (state.frameTimes.length > state.MAX_FRAME_HISTORY) {
      state.frameTimes.shift();
    }

    // Detect frame spikes
    if (frameTime > 33) {  // >33ms = <30fps
      const spike = {
        timestamp: performance.now(),
        frameTime: frameTime.toFixed(2),
        drawCalls: renderer.info?.render?.calls ?? 0,
        triangles: renderer.info?.render?.triangles ?? 0,
      };
      state.spikes.unshift(spike);
      if (state.spikes.length > state.MAX_SPIKES) state.spikes.pop();
    }

    // FPS: average over the last 60 frames
    const recentTimes = state.frameTimes.slice(-60);
    const avgFrameTime = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
    const fps = 1000 / avgFrameTime;

    // Render info from Three.js (accurate, updated by render())
    const info = renderer.info?.render ?? {};

    const metrics = {
      fps: Math.round(fps * 10) / 10,
      frameTime: Math.round(frameTime * 100) / 100,
      avgFrameTime: Math.round(avgFrameTime * 100) / 100,
      drawCalls: info.calls ?? 0,
      triangles: info.triangles ?? 0,
      points: info.points ?? 0,
      lines: info.lines ?? 0,
      frameCount: state.frameCount,
    };

    // Scene + shader analysis (every N frames to keep overhead low)
    let snapshot = state.sceneSnapshot;
    if (framesSinceLastSnapshot >= state.SCENE_REFRESH_INTERVAL) {
      framesSinceLastSnapshot = 0;

      // Patch new materials (scene may have changed)
      patchSceneMaterials(scene);

      if (window.__FrameDoctor?.analyzeScene) {
        const { objects, totals } = window.__FrameDoctor.analyzeScene(scene, renderer);

        const shaders = Object.values(state.shaderReports);

        let warnings = [];
        if (window.__FrameDoctor?.generateWarnings) {
          warnings = window.__FrameDoctor.generateWarnings({ metrics, totals, objects, shaders });
        }

        snapshot = { objects, totals, shaders, warnings, timestamp: Date.now() };
        state.sceneSnapshot = snapshot;
      }
    }

    // Build the full payload
    const payload = {
      source: 'framedoctor-content',
      type: 'frame-update',
      metrics,
      spikes: [...state.spikes],
      frameTimes: [...state.frameTimes],
      scene: snapshot,
    };

    // Send to background bridge → DevTools panel
    try {
      chrome.runtime.sendMessage(payload);
    } catch (err) {
      // Extension context invalidated (hot reload etc.) — re-check silently
    }
  }

  // ─── Object Highlighting ────────────────────────────────────────────────────

  /**
   * Highlight a scene object by its UUID.
   * Temporarily changes its emissive color to bright magenta.
   */
  function highlightObject(uuid) {
    // Restore previous highlight first
    unhighlightObject();

    for (const renderer of state.renderers) {
      // We need the scene — we don't store a ref to it, so we search renderers
      // The renderer itself doesn't expose the scene; we stored it in a WeakMap
    }

    // NOTE: object lookup is done in patchedRender via lastScene WeakRef
    const obj = state.lastScene?.getObjectByProperty('uuid', uuid);
    if (!obj) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    state.highlightedObject = obj;
    state.originalEmissive = mats.map(m => m.emissive?.clone?.() ?? null);

    const HIGHLIGHT_COLOR = { r: 1, g: 0, b: 1 };
    for (const mat of mats) {
      if (mat.emissive) mat.emissive.setRGB(HIGHLIGHT_COLOR.r, HIGHLIGHT_COLOR.g, HIGHLIGHT_COLOR.b);
    }
  }

  function unhighlightObject() {
    if (!state.highlightedObject) return;
    const obj = state.highlightedObject;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < mats.length; i++) {
      if (mats[i].emissive && state.originalEmissive[i]) {
        mats[i].emissive.copy(state.originalEmissive[i]);
      }
    }
    state.highlightedObject = null;
    state.originalEmissive = null;
  }

  // ─── Commands from DevTools Panel ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'framedoctor-content') return;

    switch (message.command) {
      case 'start-profiling':
        state.profiling = true;
        break;

      case 'stop-profiling':
        state.profiling = false;
        break;

      case 'highlight-object':
        highlightObject(message.uuid);
        break;

      case 'unhighlight-object':
        unhighlightObject();
        break;

      case 'request-snapshot':
        // Force an immediate scene refresh
        framesSinceLastSnapshot = state.SCENE_REFRESH_INTERVAL;
        break;

      case 'export-report':
        exportReport();
        break;
    }
  });

  // ─── Report Export ───────────────────────────────────────────────────────────

  function exportReport() {
    const report = {
      exportedAt: new Date().toISOString(),
      url: window.location.href,
      metrics: state.sceneSnapshot,
      spikes: state.spikes,
      shaders: Object.values(state.shaderReports),
      frameTimes: state.frameTimes,
    };

    const json = JSON.stringify(report, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `framedoctor-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── WebGL Context Loss Handling ─────────────────────────────────────────────

  window.addEventListener('webglcontextlost', (e) => {
    console.warn('[FrameDoctor] WebGL context lost — pausing profiling');
    state.profiling = false;
    try {
      chrome.runtime.sendMessage({
        source: 'framedoctor-content',
        type: 'context-lost',
      });
    } catch (_) {}
  }, false);

  window.addEventListener('webglcontextrestored', () => {
    console.log('[FrameDoctor] WebGL context restored — resuming profiling');
    state.profiling = true;
  }, false);

  // ─── Boot ────────────────────────────────────────────────────────────────────

  async function boot() {
    console.log('[FrameDoctor] Content script booting…');

    // Inject core modules (they attach to window.__FrameDoctor)
    await injectScript('core/analyzer.js');
    await injectScript('core/shaderAnalyzer.js');
    await injectScript('core/warnings.js');

    console.log('[FrameDoctor] Core modules loaded');

    // Wait for Three.js to appear
    const THREE = await waitForThree();

    if (!THREE) {
      console.warn('[FrameDoctor] THREE.js not detected on this page — no profiling active');
      try {
        chrome.runtime.sendMessage({
          source: 'framedoctor-content',
          type: 'three-not-detected',
        });
      } catch (_) {}
      return;
    }

    state.threeDetected = true;
    console.log(`[FrameDoctor] THREE.js r${THREE.REVISION} detected ✓`);

    // Patch the renderer prototype before any instances are created
    patchRenderer(THREE);

    // Also intercept renderer *construction* so we can store a scene reference
    const OriginalRenderer = THREE.WebGLRenderer;
    THREE.WebGLRenderer = function (...args) {
      const instance = new OriginalRenderer(...args);
      // Wrap render to capture the scene reference
      const orig = instance.render.bind(instance);
      instance.render = function (scene, camera) {
        state.lastScene = scene;
        orig(scene, camera);
      };
      return instance;
    };
    THREE.WebGLRenderer.prototype = OriginalRenderer.prototype;

    // Notify panel that Three.js is ready
    try {
      chrome.runtime.sendMessage({
        source: 'framedoctor-content',
        type: 'three-detected',
        revision: THREE.REVISION,
      });
    } catch (_) {}
  }

  boot().catch(console.error);

})();
