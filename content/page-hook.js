/**
 * RenderScope — Page Hook (content/page-hook.js)
 *
 * EXECUTION CONTEXT: The page's MAIN JavaScript world.
 * Injected as a <script src="..."> tag by content/profiler.js.
 *
 * Running in MAIN world gives full visibility into the page's JS environment:
 *   - window.THREE (CDN builds)
 *   - window.__webpack_require__.c (webpack module cache)
 *   - webpackChunk* arrays (Next.js 13+ App Router)
 *   - React fiber internals (React Three Fiber / R3F)
 *   - Any WebGL rendering activity (draw-call fallback)
 *
 * DETECTION ORDER (stops at first success):
 *   1. Known window globals (window.THREE, __THREE__, etc.)
 *   2. Window property scan (module namespace assigned to window)
 *   3. Webpack module cache (__webpack_require__.c)
 *   4. webpackChunk* arrays (lazy loaded chunks)
 *   5. React fiber tree scan (R3F stores renderer in hook state)
 *   6. Canvas-hook triggered re-runs of 1–5 at progressive intervals
 *   7. If nothing found: WebGL-level draw-call fallback (shows FPS + draw calls)
 *
 * Communication with isolated-world profiler.js uses window.postMessage.
 */
(function () {
  'use strict';

  if (window.__RenderScopePageHook) return;
  window.__RenderScopePageHook = true;

  // ─── Messaging ────────────────────────────────────────────────────────────────

  function sendToExt(type, extra) {
    window.postMessage(
      { __rs: true, dir: 'page-to-ext', source: 'renderscope-content', type, ...extra },
      '*'
    );
  }

  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__rs || e.data.dir !== 'ext-to-page') return;
    handlePanelCommand(e.data);
  });

  // ─── State ────────────────────────────────────────────────────────────────────

  const state = {
    profiling:   true,
    threeDetected: false,
    renderers:   new Set(),
    frameCount:  0,
    frameTimes:  [],
    MAX_FRAME_HISTORY: 120,
    sceneSnapshot: null,
    SCENE_REFRESH_INTERVAL: 30,
    shaderReports: {},
    highlightedObject: null,
    originalEmissive: null,
    lastScene: null,
    spikes: [],
    MAX_SPIKES: 10,
  };

  // ─── Detection helpers ────────────────────────────────────────────────────────

  function isThreeNamespace(val) {
    if (!val || typeof val !== 'object') return false;
    return (
      typeof val.WebGLRenderer === 'function' &&
      typeof val.Scene         === 'function' &&
      typeof val.Mesh          === 'function'
    );
  }

  /** Returns true if obj looks like a live WebGLRenderer instance. */
  function isRenderer(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return (
      typeof obj.render === 'function' &&
      obj.info?.render !== undefined &&
      typeof obj.setSize === 'function'
    );
  }

  // ─── Strategy 1 & 2: Window globals + property scan ─────────────────────────

  function detectFromGlobals() {
    for (const key of ['THREE', '__THREE__', 'three', 'Three', 'THREEjs']) {
      if (isThreeNamespace(window[key])) {
        console.log(`[RenderScope] THREE found at window.${key}`);
        return window[key];
      }
    }
    return null;
  }

  function detectFromWindowScan() {
    try {
      const keys = Object.keys(window);
      for (let i = 0; i < Math.min(keys.length, 600); i++) {
        try {
          const val = window[keys[i]];
          if (isThreeNamespace(val)) {
            console.log(`[RenderScope] THREE found via window scan: window.${keys[i]}`);
            return val;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // ─── Strategy 3 & 4: Webpack module cache ────────────────────────────────────

  function detectFromWebpack() {
    try {
      // Webpack 4/5: __webpack_require__.c (module cache)
      const wpReq = window.__webpack_require__;
      if (wpReq) {
        const cache = wpReq.c || {};
        for (const id in cache) {
          const exp = cache[id]?.exports;
          if (!exp) continue;
          if (isThreeNamespace(exp))         return exp;
          if (isThreeNamespace(exp?.default)) return exp.default;
          if (exp && typeof exp === 'object') {
            for (const k of Object.keys(exp)) {
              try { if (isThreeNamespace(exp[k])) return exp[k]; } catch (_) {}
            }
          }
        }
      }

      // Next.js 13+ App Router: window["webpackChunk_N_E"]
      for (const key of Object.keys(window)) {
        if (!key.startsWith('webpackChunk')) continue;
        const chunks = window[key];
        if (!Array.isArray(chunks)) continue;
        for (const chunk of chunks) {
          const moduleMap = chunk?.[1];
          if (!moduleMap || typeof moduleMap !== 'object') continue;
          for (const modId in moduleMap) {
            try {
              const fakeModule  = { exports: {} };
              const fakeRequire = () => ({});
              moduleMap[modId]?.(fakeModule, fakeModule.exports, fakeRequire);
              if (isThreeNamespace(fakeModule.exports)) {
                console.log(`[RenderScope] THREE found in webpackChunk module ${modId}`);
                return fakeModule.exports;
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // ─── Strategy 5: React fiber tree (React Three Fiber / R3F) ─────────────────
  //
  // R3F stores root state (with .gl=renderer, .scene, .camera) in React hook
  // memoizedState. We can reach it by walking the fiber tree from any canvas
  // element that has a React root attached.
  //
  // Returns the THREE namespace if one can be inferred, otherwise patches the
  // renderer directly and returns a special sentinel { _r3f: true, renderer, scene }.

  function detectFromReactFiber() {
    try {
      const canvases = document.querySelectorAll('canvas');
      for (const canvas of canvases) {
        const fiberKey = Object.keys(canvas).find((k) =>
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactInternals$') ||
          k.startsWith('__reactInternalInstance$')
        );
        if (!fiberKey) continue;

        console.log('[RenderScope] React fiber found on <canvas>, scanning for renderer…');
        const result = walkFiberForR3F(canvas[fiberKey], 0, new Set());
        if (result) {
          console.log('[RenderScope] Found R3F root state via React fiber ✓');
          return result;
        }
      }
    } catch (_) {}
    return null;
  }

  function walkFiberForR3F(fiber, depth, seen) {
    if (!fiber || depth > 300 || seen.has(fiber)) return null;
    seen.add(fiber);

    try {
      // Walk the memoizedState hook chain for this fiber node
      let hook = fiber.memoizedState;
      let hi   = 0;
      while (hook && hi < 30) {
        const val = hook.memoizedState;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          // R3F root store signature: { gl, scene, camera, size, viewport, ... }
          if (
            isRenderer(val.gl) &&
            val.scene && typeof val.scene.traverse === 'function' &&
            val.camera
          ) {
            // Return a sentinel object; boot() will handle it separately
            return { _r3f: true, renderer: val.gl, scene: val.scene, camera: val.camera };
          }

          // Sometimes state.queue.dispatch refers to a dispatch with the store
          const queue = hook.queue;
          if (queue) {
            const dispatch = queue.dispatch;
            if (dispatch?._origin &&
                isRenderer(dispatch._origin.gl) &&
                dispatch._origin.scene) {
              return { _r3f: true, renderer: dispatch._origin.gl, scene: dispatch._origin.scene };
            }
          }
        }
        hook = hook.next;
        hi++;
      }

      // Recurse depth-first (child then sibling)
      return (
        walkFiberForR3F(fiber.child,   depth + 1, seen) ||
        walkFiberForR3F(fiber.sibling, depth + 1, seen)
      );
    } catch (_) {
      return null;
    }
  }

  // ─── Master detection ─────────────────────────────────────────────────────────

  function detectThreeOrRenderer() {
    return (
      detectFromGlobals()    ||
      detectFromWindowScan() ||
      detectFromWebpack()    ||
      detectFromReactFiber()
    );
  }

  // ─── Strategy 6: Canvas hook ──────────────────────────────────────────────────

  let _resolveWaiter = null;

  function wakeWaiter(result) {
    if (_resolveWaiter) {
      const fn = _resolveWaiter;
      _resolveWaiter = null;
      fn(result);
    }
  }

  function installCanvasHook() {
    const _orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function __rsGetCtx(type, ...args) {
      const ctx = _orig.call(this, type, ...args);
      if (ctx && (type === 'webgl' || type === 'webgl2') && !state.threeDetected) {
        // Re-probe at increasing delays after a canvas is created
        [0, 80, 250, 600, 1500, 3500].forEach((d) => {
          setTimeout(() => {
            if (state.threeDetected) return;
            const r = detectThreeOrRenderer();
            if (r) {
              console.log(`[RenderScope] Detected via canvas hook (+${d}ms)`);
              wakeWaiter(r);
            }
          }, d);
        });
      }
      return ctx;
    };
    console.log('[RenderScope] getContext hook installed');
  }

  function waitForThreeOrRenderer(maxMs = 30_000) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      _resolveWaiter = resolve;

      (function tick(delay) {
        const r = detectThreeOrRenderer();
        if (r) { _resolveWaiter = null; resolve(r); return; }
        if (Date.now() - t0 > maxMs) { _resolveWaiter = null; resolve(null); return; }
        setTimeout(() => tick(Math.min(delay * 1.6, 2500)), delay);
      })(80);
    });
  }

  // ─── Strategy 7: WebGL-level fallback ────────────────────────────────────────
  //
  // When THREE (or an R3F renderer) is never found, we still hook the raw WebGL
  // draw calls to provide basic FPS + draw call metrics in the Overview tab.
  // Scene / Shader / Warnings tabs remain empty in this mode.

  function installWebGLFallback() {
    console.log('[RenderScope] Activating WebGL draw-call fallback (no THREE detected)');
    sendToExt('three-not-detected');

    let drawCalls = 0, triangles = 0, totalFrames = 0;
    let prevRAF  = performance.now();
    let frameTimes = [];

    // Hook drawElements on both WebGL contexts
    ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach((name) => {
      const proto = window[name]?.prototype;
      if (!proto) return;

      const _origDE = proto.drawElements;
      proto.drawElements = function (mode, count) {
        drawCalls++;
        triangles += Math.floor(count / 3);
        return _origDE.apply(this, arguments);
      };

      const _origDA = proto.drawArrays;
      proto.drawArrays = function (mode, first, count) {
        drawCalls++;
        triangles += Math.floor(count / 3);
        return _origDA.apply(this, arguments);
      };
    });

    // Use requestAnimationFrame boundaries to delimit frames
    const _origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      return _origRAF.call(window, function (ts) {
        const dt = ts - prevRAF;
        prevRAF  = ts;

        if (dt > 0 && state.profiling) {
          totalFrames++;
          frameTimes.push(dt);
          if (frameTimes.length > 120) frameTimes.shift();

          const recent  = frameTimes.slice(-60);
          const avgFT   = recent.reduce((a, b) => a + b, 0) / recent.length;
          const spikes  = [];

          if (dt > 33) {
            spikes.unshift({ timestamp: ts, frameTime: dt.toFixed(2), drawCalls, triangles });
          }

          sendToExt('frame-update', {
            metrics: {
              fps:          Math.round(1000 / avgFT * 10) / 10,
              frameTime:    Math.round(dt * 100)   / 100,
              avgFrameTime: Math.round(avgFT * 100) / 100,
              drawCalls,
              triangles,
              points:    0,
              lines:     0,
              frameCount: totalFrames,
            },
            spikes,
            frameTimes: [...frameTimes],
            scene: null,
          });

          drawCalls = 0;
          triangles = 0;
        }

        return cb(ts);
      });
    };
  }

  // ─── Renderer patching (THREE namespace mode) ─────────────────────────────────

  function patchRenderer(THREE) {
    const proto = THREE.WebGLRenderer.prototype;
    if (proto.__renderscopePatched) return;
    proto.__renderscopePatched = true;

    const _orig = proto.render;
    proto.render = function __rsRender(scene, camera) {
      if (!state.renderers.has(this)) {
        state.renderers.add(this);
        console.log('[RenderScope] WebGLRenderer instance hooked');
      }
      state.lastScene = scene;

      const t0 = performance.now();
      _orig.call(this, scene, camera);
      const dt = performance.now() - t0;

      if (state.profiling) recordFrame(dt, this, scene);
    };

    console.log('[RenderScope] WebGLRenderer.prototype.render patched ✓');
  }

  // ─── Renderer patching (direct instance — R3F / no-THREE-namespace mode) ─────

  function patchRendererDirect(renderer, scene) {
    if (renderer.__renderscopePatched) return;
    renderer.__renderscopePatched = true;

    // Capture the scene from the R3F state we already have
    state.lastScene = scene;

    const _orig = renderer.render.bind(renderer);
    renderer.render = function __rsDirectRender(s, camera) {
      state.lastScene = s || scene;
      const t0 = performance.now();
      _orig(s, camera);
      const dt = performance.now() - t0;
      if (state.profiling) recordFrame(dt, renderer, state.lastScene);
    };

    state.renderers.add(renderer);
    console.log('[RenderScope] Renderer instance patched directly (R3F mode) ✓');
  }

  // ─── Shader interception ─────────────────────────────────────────────────────

  function patchMaterial(mat) {
    if (!mat || mat.__renderscopePatched) return;
    mat.__renderscopePatched = true;

    const orig = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (orig) orig.call(this, shader, renderer);
      const name = mat.name || mat.type || 'unnamed';
      const uuid = mat.uuid;
      setTimeout(() => {
        if (window.__RenderScope?.analyzeShaderProgram) {
          state.shaderReports[uuid] = window.__RenderScope.analyzeShaderProgram(
            shader.vertexShader, shader.fragmentShader, name
          );
        }
      }, 0);
    };
  }

  function patchSceneMaterials(scene) {
    if (!scene?.traverse) return;
    scene.traverse((obj) => {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => { if (m) patchMaterial(m); });
    });
  }

  // ─── Frame recording ──────────────────────────────────────────────────────────

  let framesSince = 0;

  function recordFrame(frameTime, renderer, scene) {
    state.frameCount++;
    framesSince++;

    state.frameTimes.push(frameTime);
    if (state.frameTimes.length > state.MAX_FRAME_HISTORY) state.frameTimes.shift();

    if (frameTime > 33) {
      state.spikes.unshift({
        timestamp: performance.now(),
        frameTime: frameTime.toFixed(2),
        drawCalls: renderer.info?.render?.calls    ?? 0,
        triangles: renderer.info?.render?.triangles ?? 0,
      });
      if (state.spikes.length > state.MAX_SPIKES) state.spikes.pop();
    }

    const recent  = state.frameTimes.slice(-60);
    const avgFT   = recent.reduce((a, b) => a + b, 0) / recent.length;
    const info    = renderer.info?.render ?? {};

    const metrics = {
      fps:          Math.round(1000 / avgFT * 10) / 10,
      frameTime:    Math.round(frameTime * 100) / 100,
      avgFrameTime: Math.round(avgFT    * 100) / 100,
      drawCalls:    info.calls     ?? 0,
      triangles:    info.triangles ?? 0,
      points:       info.points    ?? 0,
      lines:        info.lines     ?? 0,
      frameCount:   state.frameCount,
    };

    // Scene analysis every N frames (works with or without THREE namespace)
    let snapshot = state.sceneSnapshot;
    if (framesSince >= state.SCENE_REFRESH_INTERVAL && scene && window.__RenderScope?.analyzeScene) {
      framesSince = 0;
      patchSceneMaterials(scene);

      try {
        const { objects, totals } = window.__RenderScope.analyzeScene(scene, renderer);
        const shaders  = Object.values(state.shaderReports);
        const warnings = window.__RenderScope?.generateWarnings
          ? window.__RenderScope.generateWarnings({ metrics, totals, objects, shaders })
          : [];
        snapshot = { objects, totals, shaders, warnings, timestamp: Date.now() };
        state.sceneSnapshot = snapshot;
      } catch (e) {
        // Scene may not be ready yet — skip this frame
      }
    }

    sendToExt('frame-update', {
      metrics,
      spikes:     [...state.spikes],
      frameTimes: [...state.frameTimes],
      scene:      snapshot,
    });
  }

  // ─── Object highlighting ──────────────────────────────────────────────────────

  function highlightObject(uuid) {
    unhighlightObject();
    const scene = state.lastScene;
    if (!scene?.getObjectByProperty) return;

    const obj = scene.getObjectByProperty('uuid', uuid);
    if (!obj) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    state.highlightedObject = obj;
    state.originalEmissive  = mats.map((m) => m?.emissive?.clone?.() ?? null);
    mats.forEach((m) => { if (m?.emissive) m.emissive.setRGB(1, 0, 1); });
  }

  function unhighlightObject() {
    if (!state.highlightedObject) return;
    const mats = Array.isArray(state.highlightedObject.material)
      ? state.highlightedObject.material
      : [state.highlightedObject.material];
    mats.forEach((m, i) => {
      if (m?.emissive && state.originalEmissive?.[i]) {
        m.emissive.copy(state.originalEmissive[i]);
      }
    });
    state.highlightedObject = null;
    state.originalEmissive  = null;
  }

  function exportReport() {
    const json = JSON.stringify({
      exportedAt: new Date().toISOString(),
      url:        window.location.href,
      metrics:    state.sceneSnapshot,
      spikes:     state.spikes,
      shaders:    Object.values(state.shaderReports),
      frameTimes: state.frameTimes,
    }, null, 2);
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `renderscope-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ─── Panel command handler ────────────────────────────────────────────────────

  function handlePanelCommand(msg) {
    switch (msg.command) {
      case 'start-profiling':    state.profiling = true;  break;
      case 'stop-profiling':     state.profiling = false; break;
      case 'highlight-object':   highlightObject(msg.uuid); break;
      case 'unhighlight-object': unhighlightObject();     break;
      case 'request-snapshot':   framesSince = state.SCENE_REFRESH_INTERVAL; break;
      case 'export-report':      exportReport(); break;
    }
  }

  // ─── WebGL context loss ───────────────────────────────────────────────────────

  window.addEventListener('webglcontextlost', () => {
    state.profiling = false;
    sendToExt('context-lost');
  }, false);

  window.addEventListener('webglcontextrestored', () => {
    state.profiling = true;
  }, false);

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  async function boot() {
    console.log('[RenderScope] Page hook active — detecting Three.js…');

    // Install canvas hook FIRST so we catch WebGL context creation immediately
    installCanvasHook();

    // Run all detection strategies with exponential backoff up to 30s
    const result = await waitForThreeOrRenderer(30_000);

    if (!result) {
      // ── Strategy 7: WebGL-level fallback ─────────────────────────────────────
      // THREE namespace AND a renderer instance both failed. We still hook the
      // raw WebGL draw functions so the Overview tab shows FPS + draw counts.
      installWebGLFallback();
      return;
    }

    state.threeDetected = true;

    // ── R3F / direct-renderer mode ────────────────────────────────────────────
    if (result._r3f) {
      const { renderer, scene } = result;
      console.log(`[RenderScope] R3F mode — patching renderer directly`);
      patchRendererDirect(renderer, scene);

      // Keep re-probing for the THREE namespace every 2 seconds so we can
      // upgrade to full scene-graph analysis if THREE becomes accessible.
      let probeCount = 0;
      const probeInterval = setInterval(() => {
        if (probeCount++ > 30) { clearInterval(probeInterval); return; }
        const three = detectFromGlobals() || detectFromWindowScan() || detectFromWebpack();
        if (three) {
          clearInterval(probeInterval);
          console.log('[RenderScope] THREE namespace found — upgrading to full mode');
          patchRenderer(three);
          sendToExt('three-detected', { revision: three.REVISION });
        }
      }, 2000);

      sendToExt('three-detected', { revision: '(R3F direct)' });
      return;
    }

    // ── Full THREE namespace mode ─────────────────────────────────────────────
    const THREE = result;
    console.log(`[RenderScope] THREE.js r${THREE.REVISION} detected ✓`);

    patchRenderer(THREE);

    // Wrap the constructor so future renderer instances are also captured
    const OrigRend = THREE.WebGLRenderer;
    if (!OrigRend.__rsCtorPatched) {
      THREE.WebGLRenderer = function (...args) {
        return new OrigRend(...args); // prototype already patched above
      };
      THREE.WebGLRenderer.prototype  = OrigRend.prototype;
      THREE.WebGLRenderer.__rsCtorPatched = true;
    }

    sendToExt('three-detected', { revision: THREE.REVISION });
  }

  boot().catch((err) => console.error('[RenderScope] Page hook error:', err));

})();
