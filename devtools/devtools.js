/**
 * RenderScope — DevTools Registration Script (devtools.js)
 *
 * Runs inside the hidden devtools.html page.
 * Registers the RenderScope panel in Chrome DevTools.
 */

chrome.devtools.panels.create(
  'RenderScope',          // Panel title (tab label)
  '/icons/icon32.png',   // Panel icon (shown in DevTools tab bar)
  '/devtools/panel.html' // Panel UI page
);
