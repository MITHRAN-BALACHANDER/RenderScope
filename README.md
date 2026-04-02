# FrameDoctor 🩺

> **A production-grade Chrome DevTools extension for profiling and debugging Three.js / WebGL applications.**

FrameDoctor goes beyond basic FPS counters. It delivers **root-cause analysis** — identifying _why_ your Three.js scene is slow, not just _that_ it is slow.

---

## ✨ Features

### Overview Panel
- Real-time **FPS** and **frame time** tracking
- **Draw call** count with health indicators (green / yellow / red)
- **Triangle count**, textures, geometries, mesh count
- Mini **frame-time bar chart** — color-coded by severity
- **Spike log** — captures frames >33ms with context (draw calls, triangles at time of spike)

### Scene Analyzer
- **Full scene graph traversal** — every mesh, instanced mesh, and skinned mesh
- Per-object: name, type, triangle count, texture count, material type, shadow flags
- **Estimated cost heuristic** (0–100 score) for each object
- Sort by cost, triangles, textures, or name
- Filter by name / type
- **Object highlighting** — click 💡 to highlight any object in the live scene (magenta emissive highlight)

### Shader Analyzer
- **Intercepts every material** via `onBeforeCompile`
- Per-stage analysis (vertex + fragment):
  - Lines of code
  - Texture lookup count
  - Loop count
  - Conditional / branch count
  - `discard` statements (disables early-z)
  - Dependent texture reads
- Per-shader combined **performance score (0–100)**
- **Detailed flags** per issue with severity levels

### Warnings Engine
- 12+ rules covering draw calls, geometry, textures, shadows, FPS, shaders, and maintainability
- Three severity levels: **Error** (red), **Warning** (yellow), **Info** (blue)
- Actionable detail with specific remediation steps
- Direct links to Three.js docs where relevant

**Example warnings generated:**
| Condition | Warning |
|-----------|---------|
| >150 draw calls, no InstancedMesh | "Use InstancedMesh — batch same geometry" |
| >2M triangles | "Implement THREE.LOD for distant objects" |
| >32 textures | "Pack into texture atlases" |
| 4+ shadow lights | "Each adds a full render pass — reduce shadow casters" |
| `discard` in fragment shader | "Discard prevents early-z optimization" |
| 8+ texture lookups per shader | "High texture sample count — consider atlas or fewer samples" |

### Timeline
- Full accumulated frame-time **area chart**
- Statistics: Min, Avg, Max, P95, spike count
- Spike dots overlaid in red
- Clear button to reset

---

## 🏗 Architecture

```
frame-doctor/
├── manifest.json              # Chrome Extension Manifest V3
├── background/
│   └── bridge.js              # Service worker — messaging relay
├── content/
│   └── profiler.js            # Injected into page — patches THREE.WebGLRenderer
├── core/
│   ├── analyzer.js            # Scene graph traversal + cost heuristics
│   ├── shaderAnalyzer.js      # GLSL analysis (lookups, loops, branches)
│   └── warnings.js            # Rule-based warnings engine
├── devtools/
│   ├── devtools.html          # Silent entry-point, registers panel
│   ├── devtools.js            # chrome.devtools.panels.create()
│   ├── panel.html             # Multi-tab DevTools panel UI
│   ├── panel.js               # Panel logic + canvas charts
│   └── styles.css             # Dark DevTools-native styling
├── icons/
│   ├── icon-gen.html          # Generate icons (open in browser)
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── demo/
    └── index.html             # Three.js demo scene for testing
```

### Data Flow

```
Page (Three.js)
  └── content/profiler.js  (monkey-patches renderer, traverses scene)
        │  chrome.runtime.sendMessage
        ▼
background/bridge.js  (service worker relay)
        │  port.postMessage
        ▼
devtools/panel.js  (updates UI, drives charts)
        │  port.postMessage → chrome.tabs.sendMessage
        ▼
content/profiler.js  (highlight, pause, export commands)
```

---

## 🚀 Installation

### Step 1: Generate Icons

1. Open `icons/icon-gen.html` in Chrome
2. Four PNG files will be auto-downloaded: `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`
3. Move them into the `icons/` folder

### Step 2: Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `RenderScope` project folder (the one containing `manifest.json`)

### Step 3: Open DevTools

1. Navigate to any Three.js application (or use the included demo)
2. Open Chrome DevTools (`F12` or `Cmd+Opt+I`)
3. Find and click the **FrameDoctor** tab

---

## 🧪 Demo Usage

Open `demo/index.html` in Chrome (use a local server or `file://` URL).

```bash
# Serve locally (Python)
cd demo
python -m http.server 8080
# Then open http://localhost:8080
```

The demo provides interactive buttons to trigger various performance conditions:

| Button | Effect | What to look for in FrameDoctor |
|--------|--------|----------------------------------|
| **+ Add 50 meshes** | Adds 50 new draw calls | Draw calls spike, warnings appear |
| **+ Instanced ×500** | Adds 500 instances as 1 draw call | Scene Analyzer shows ×500 instance count |
| **Toggle Shadows** | Adds/removes shadow pass | Shadow light warning appears/clears |
| **+ Complex Shader** | Adds a shader with loops + branches | Shader Analyzer flags it |
| **+ LOD Object** | Adds a THREE.LOD sphere | Compare triangle count at different distances |
| **Clear Scene** | Removes non-essential objects | Watch metrics drop |

---

## ⚙️ Edge Cases Handled

| Scenario | Handling |
|----------|----------|
| Three.js not globally exposed | 15-second exponential-backoff detection |
| Multiple WebGLRenderer instances | Tracked in a `Set`; all are monitored |
| Minified builds (no window.THREE) | Renderer prototype still patched |
| Dynamic scene changes | Scene re-traversed every 30 frames |
| WebGL context loss | Profiling paused; panel notified; resumes on restore |
| Panel disconnect / service worker restart | Port auto-reconnects |
| First-frame shader compilation | `onBeforeCompile` hook added preemptively |

---

## 📡 Export Report

Click the **Export** button in the panel header. A JSON file is downloaded containing:

```json
{
  "exportedAt": "2024-01-01T12:00:00.000Z",
  "url": "https://example.com",
  "metrics": { "objects": [...], "totals": {...}, "warnings": [...] },
  "spikes": [...],
  "shaders": [...],
  "frameTimes": [16.2, 16.8, 33.1, ...]
}
```

---

## 🔧 Extending FrameDoctor

### Adding a new warning rule

Edit `core/warnings.js` and add an entry to the `RULES` array:

```js
{
  id: 'my-new-rule',
  evaluate({ metrics, totals, objects, shaders }) {
    if (/* condition not met */) return null;
    return {
      severity: 'warning',   // 'error' | 'warning' | 'info'
      category: 'My Category',
      title: 'Short headline',
      detail: 'Actionable explanation with specific steps to fix.',
      metric: 'measured value',
    };
  },
},
```

### Adjusting thresholds

Edit the `THRESHOLDS` object at the top of `core/warnings.js`.

---

## 🗺 Roadmap

- [ ] GPU timing via `EXT_disjoint_timer_query` WebGL extension
- [ ] Memory usage tracking (geometry buffer sizes, texture VRAM estimates)
- [ ] Object tree view in Scene Analyzer
- [ ] Shader source viewer (read-only GLSL display in panel)
- [ ] Performance recording (capture N frames → export)
- [ ] Firefox DevTools port (WebExtensions compatible)

---

## 📄 License

MIT
