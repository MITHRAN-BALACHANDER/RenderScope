# RenderScope 🔭

> **A production-grade Chrome DevTools extension for profiling and debugging Three.js / WebGL applications.**

RenderScope delivers **root-cause analysis** — identifying _why_ your Three.js scene is slow, not just _that_ it is slow. It patches directly into the Three.js renderer with zero changes to your app code.

---

## ✨ Features at a Glance

| Feature | Description |
|---------|-------------|
| **Overview** | Live FPS, draw calls, triangle count, frame-time bar chart, spike log |
| **Scene Analyzer** | Full scene graph table — per-object cost score, triangle count, textures, shadow flags, in-scene highlight |
| **Shader Analyzer** | GLSL analysis — texture lookups, loops, branches, discard, per-shader performance score |
| **Warnings** | 14 rule-based warnings with severity levels and Three.js docs links |
| **Timeline** | Accumulated frame chart with Min/Avg/Max/P95 stats |
| **Export** | Download full performance report as JSON |

---

## 📁 Project Structure

```
RenderScope/
├── manifest.json               ← Chrome Extension Manifest V3
├── background/
│   └── bridge.js               ← Service worker — messaging relay
├── content/
│   └── profiler.js             ← Injected profiler (patches renderer)
├── core/
│   ├── analyzer.js             ← Scene graph traversal + cost heuristics
│   ├── shaderAnalyzer.js       ← GLSL analysis engine
│   └── warnings.js             ← 14-rule actionable warnings engine
├── devtools/
│   ├── devtools.html           ← Silent DevTools entry-point
│   ├── devtools.js             ← Registers the panel
│   ├── panel.html              ← 5-tab DevTools panel UI
│   ├── panel.js                ← Panel logic + canvas charts
│   └── styles.css              ← Dark DevTools-native design
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── demo/
    └── index.html              ← Three.js demo scene
```

---

## 🚀 Deployment — Loading in Chrome

### Option A: Load from Local Files (Development)

1. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

2. Enable **Developer mode** using the toggle in the top-right corner.

3. Click **"Load unpacked"**.

4. Select the **`RenderScope`** folder (the one containing `manifest.json`).

5. The extension will appear in your list as **RenderScope**.

6. Open any Three.js web application, open Chrome DevTools (`F12`), and click the **RenderScope** tab.

> **Tip:** If you make changes to source files, click the **↻ Reload** icon on the extension card in `chrome://extensions` to reload it.

---

### Option B: Load from GitHub (Recommended for Teams)

#### Step 1 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/RenderScope.git
cd RenderScope
```



#### Step 2 — Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the cloned `RenderScope/` folder

That's it — no build step, no npm install, no compilation required.

#### Step 3 — Updating from Git

```bash
git pull origin main
```

Then click **↻ Reload** on the extension in `chrome://extensions`.

---

### Option C: Publish to Chrome Web Store (Production Deployment)

#### Step 1 — Package the extension

```bash
# From the RenderScope directory:
Compress-Archive -Path * -DestinationPath renderscope.zip -Force
```
or on Linux/Mac:
```bash
zip -r renderscope.zip . --exclude "*.git*" --exclude "*.md" --exclude "demo/*"
```

#### Step 2 — Create a Chrome Web Store listing

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Sign in with your Google account
3. Click **"New Item"**
4. Upload `renderscope.zip`
5. Fill in:
   - **Name:** RenderScope
   - **Short description:** Performance profiler for Three.js and WebGL — root-cause analysis in Chrome DevTools
   - **Category:** Developer Tools
   - **Screenshots:** Capture the panel in action (required, minimum 1280×800)
6. Click **Publish** → review takes 1–3 business days

> **Note:** Chrome Web Store requires a one-time $5 developer registration fee.

---

## 🧪 Running the Demo

The demo is a self-contained HTML file with Six interactive stress-test buttons.

### Serve locally

```bash
# Python (no install needed)
cd demo
python -m http.server 8080
```

Then open: **http://localhost:8080**

Open Chrome DevTools → **RenderScope** tab to see live profiling.

### Demo controls

| Button | Effect | What to observe in RenderScope |
|--------|--------|--------------------------------|
| **+ Add 50 meshes** | Adds 50 new icosahedron meshes | Draw calls ↑, warnings trigger |
| **+ Instanced ×500** | 500 spheres as one draw call | Scene Analyzer: ×500 instance badge |
| **Toggle Shadows** | Add/remove shadow render pass | Shadow light warning appears/clears |
| **+ Complex Shader** | Adds a ShaderMaterial with loops + branches | Shader Analyzer flags it as expensive |
| **+ LOD Object** | Adds a THREE.LOD sphere | Compare triangle counts at distances |
| **Clear Scene** | Removes added objects | All metrics drop back to baseline |

---

## ⚙️ How It Works

```
Three.js page
  └── content/profiler.js              ← patches WebGLRenderer.prototype.render
        ├── Measures frame time
        ├── Reads renderer.info.render (draw calls, triangles)
        ├── Traverses scene every 30 frames via core/analyzer.js
        ├── Intercepts materials via onBeforeCompile → core/shaderAnalyzer.js
        └── Generates warnings → core/warnings.js
              │ chrome.runtime.sendMessage (per frame)
              ▼
background/bridge.js                   ← service worker relay
              │ port.postMessage
              ▼
devtools/panel.js                      ← updates 5-tab UI + canvas charts
```

No build tools, service workers, or npm packages required. The entire extension is plain JavaScript.

---

## ⚠️ Edge Cases Handled

| Scenario | Behaviour |
|----------|-----------|
| Three.js not globally exposed | Exponential backoff detection (15s timeout) |
| Multiple `WebGLRenderer` instances | All tracked in a `Set` |
| Minified/bundled builds | Renderer prototype patched before any instances |
| Dynamic scene changes | Scene re-traversed every 30 frames |
| WebGL context loss | Profiling paused; panel notified; auto-resumes on restore |
| Panel/service worker restart | Port auto-reconnects |
| Material pre-compiled before hook | Gracefully skips, shows partial shader info |

---

## 🔧 Extending RenderScope

### Add a new warning rule

Open `core/warnings.js`, add an entry to the `RULES` array:

```js
{
  id: 'my-custom-rule',
  evaluate({ metrics, totals, objects, shaders }) {
    if (/* condition not met */) return null;
    return {
      severity: 'warning',      // 'error' | 'warning' | 'info'
      category: 'My Category',
      title: 'Short actionable headline',
      detail: 'Detailed explanation with specific steps to resolve.',
      metric: 'measured value display string',
      docsLink: 'https://threejs.org/docs/...',  // optional
    };
  },
},
```

### Adjust detection thresholds

Edit the `THRESHOLDS` object at the top of `core/warnings.js`.

---

## 📡 Export Report Format

Click **Export** in the panel header. A JSON file is saved:

```json
{
  "exportedAt": "2025-01-01T12:00:00.000Z",
  "url": "https://your-threejs-app.com",
  "metrics": {
    "objects": [...],
    "totals": { "meshCount": 42, "triangleCount": 124000, "textureCount": 8, ... },
    "warnings": [...],
    "shaders": [...]
  },
  "spikes": [{ "frameTime": "38.12", "drawCalls": 92, "triangles": 1240000 }],
  "frameTimes": [16.2, 16.8, 33.1, 17.0, ...]
}
```

---

## 🗺 Roadmap

- [ ] GPU timing via `EXT_disjoint_timer_query`
- [ ] Memory usage tracking (geometry buffer sizes, texture VRAM estimates)
- [ ] Scene object tree view
- [ ] Read-only GLSL shader source viewer in panel
- [ ] Performance recording — capture N frames, replay and compare
- [ ] Firefox WebExtension port

---

## 📄 License

MIT © RenderScope Contributors
