/**
 * RenderScope — Background Service Worker (bridge.js)
 *
 * Responsibility: Act as a reliable messaging relay between:
 *   - Content Script  (runs in the inspected page's context)
 *   - DevTools Panel  (runs in the devtools extension context)
 *
 * Architecture:
 *   Content Script → chrome.runtime.sendMessage → Bridge → port.postMessage → DevTools Panel
 *   DevTools Panel → port.postMessage            → Bridge → chrome.tabs.sendMessage → Content Script
 *
 * We use long-lived Port connections from the DevTools panel so messages
 * survive across multiple inspected-page navigations.
 */

// Map: tabId → Port (the devtools panel's port for that tab)
const devtoolsPorts = new Map();

// ─── DevTools Panel Connections ──────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('renderscope-devtools-')) return;

  // Port name encodes the inspected tab ID: "renderscope-devtools-<tabId>"
  const tabId = parseInt(port.name.split('-').pop(), 10);
  if (isNaN(tabId)) return;

  devtoolsPorts.set(tabId, port);
  console.log(`[RenderScope Bridge] DevTools panel connected for tab ${tabId}`);

  // Forward commands from DevTools panel → Content Script
  port.onMessage.addListener((message) => {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
      // Content script not ready / page unloaded — silently ignore
    });
  });

  // Cleanup on panel disconnect
  port.onDisconnect.addListener(() => {
    devtoolsPorts.delete(tabId);
    console.log(`[RenderScope Bridge] DevTools panel disconnected for tab ${tabId}`);
  });
});

// ─── Messages from Content Script ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only relay messages tagged for RenderScope
  if (!message || message.source !== 'renderscope-content') return false;

  const tabId = sender.tab?.id;
  if (tabId == null) return false;

  const port = devtoolsPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(message);
    } catch (err) {
      // Port was closed between the Map lookup and postMessage
      devtoolsPorts.delete(tabId);
    }
  }

  // Acknowledge receipt (required to avoid "message channel closed" errors)
  sendResponse({ ok: true });
  return true; // keep channel open for async
});

// ─── Tab lifecycle cleanup ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  devtoolsPorts.delete(tabId);
});
