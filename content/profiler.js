/**
 * RenderScope — Isolated-World Content Script (content/profiler.js)
 *
 * EXECUTION CONTEXT: Chrome Extension ISOLATED world (document_start).
 *
 * This script is intentionally thin. All Three.js detection, renderer
 * patching, and data collection lives in content/page-hook.js which is
 * injected into the page's MAIN JavaScript world so it can see bundled
 * Three.js (webpack, Vite, Next.js, etc.) that are invisible to this
 * isolated context.
 *
 * RESPONSIBILITIES:
 *   1. Install an early canvas-flag hook synchronously (inline <script>),
 *      before page scripts run, so we know if WebGL was used.
 *   2. Inject core analysis modules (they attach to window.__RenderScope).
 *   3. Inject page-hook.js into the MAIN world.
 *   4. Bridge window.postMessage ↔ chrome.runtime.sendMessage:
 *        page-hook.js → postMessage({ dir:'page-to-ext' }) → relay → bridge.js → panel.js
 *        panel.js → bridge.js → chrome.tabs.sendMessage → relay → postMessage({ dir:'ext-to-page' }) → page-hook.js
 */

(function () {
  'use strict';

  if (window.__RenderScopeActive) return;
  window.__RenderScopeActive = true;

  // Note: No inline script injection here — that would violate strict Content Security
  // Policies on many production sites. The canvas getContext hook is installed by
  // page-hook.js (MAIN world) which loads immediately via injectScript() below.


  // ─── Step 1: Script injector ─────────────────────────────────────────────────
  // Injects files from the extension into the page as <script> tags.
  // They run in the MAIN world and share window with the page.
  // Files MUST be listed in web_accessible_resources in manifest.json.

  function injectScript(path) {
    return new Promise((resolve) => {
      const url = chrome.runtime.getURL(path);
      if (!url || url.includes('chrome-extension://invalid')) {
        console.error(
          `[RenderScope] Script injection failed for "${path}". ` +
          'Add it to "web_accessible_resources" in manifest.json.'
        );
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = url;
      s.onload  = () => { s.remove(); resolve(); };
      s.onerror = () => {
        console.error(`[RenderScope] Failed to load "${path}".`);
        s.remove();
        resolve();
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ─── Step 2: postMessage relay ───────────────────────────────────────────────
  // page-hook.js  →  postMessage({ __rs, dir:'page-to-ext', ... })
  //               →  (this listener)
  //               →  chrome.runtime.sendMessage(payload)
  //               →  bridge.js  →  panel.js

  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__rs || e.data.dir !== 'page-to-ext') return;
    const { __rs, dir, ...payload } = e.data;
    try {
      chrome.runtime.sendMessage(payload);
    } catch (_) {
      // Extension context invalidated (page reload, devtools closed, etc.)
    }
  });

  // ─── Step 3: Command relay ───────────────────────────────────────────────────
  // bridge.js  →  chrome.tabs.sendMessage(tabId, { target:'renderscope-content', command, ... })
  //            →  (this listener)
  //            →  postMessage({ __rs, dir:'ext-to-page', ... })
  //            →  page-hook.js handlePanelCommand()

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'renderscope-content') return;
    window.postMessage({ __rs: true, dir: 'ext-to-page', ...message }, '*');
  });

  // ─── Step 4: Boot ─────────────────────────────────────────────────────────────

  async function boot() {
    console.log('[RenderScope] Isolated profiler booting — injecting page hook…');

    // Inject core analysis modules FIRST.
    // They attach to window.__RenderScope in the MAIN world.
    // page-hook.js depends on these being available.
    await injectScript('core/analyzer.js');
    await injectScript('core/shaderAnalyzer.js');
    await injectScript('core/warnings.js');

    // Inject the MAIN-world worker. It does all Three.js work and
    // sends results back via postMessage → this script → chrome.runtime.
    await injectScript('content/page-hook.js');

    console.log('[RenderScope] Page hook injected ✓');
  }

  boot().catch((err) => console.error('[RenderScope] Boot error:', err));

})();
