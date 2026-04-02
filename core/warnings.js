/**
 * FrameDoctor — Smart Warnings Engine (core/warnings.js)
 *
 * PURPOSE:
 *   Given a snapshot of frame metrics + scene analysis, produce a ranked
 *   list of actionable warnings with specific remediation suggestions.
 *
 * DESIGN:
 *   Each rule is a pure function (metrics) → Warning | null.
 *   Rules are declared in a registry and evaluated in order.
 *   Easy to add new rules without touching existing code.
 *
 * WARNING FORMAT:
 *   {
 *     id: string,          // unique, stable rule id (for deduplication)
 *     severity: 'error' | 'warning' | 'info',
 *     category: string,    // 'Draw Calls' | 'Geometry' | 'Textures' | etc.
 *     title: string,       // short headline
 *     detail: string,      // actionable explanation
 *     metric: string,      // the specific measured value that triggered this
 *     docsLink?: string,   // optional Three.js / MDN docs link
 *   }
 */

// ─── Thresholds (tunable constants) ──────────────────────────────────────────

const THRESHOLDS = {
  DRAW_CALLS_WARNING:          50,
  DRAW_CALLS_ERROR:           150,
  TRIANGLES_WARNING:      500_000,
  TRIANGLES_ERROR:      2_000_000,
  TEXTURES_WARNING:            16,
  TEXTURES_ERROR:              32,
  SHADOW_LIGHTS_WARNING:        2,
  SHADOW_LIGHTS_ERROR:          4,
  FPS_WARNING:                 45,   // below 45 fps is notable
  FPS_ERROR:                   25,   // below 25 fps is critical
  FRAME_TIME_SPIKE_MS:         33,   // > 33ms = below 30fps
  SHADER_SCORE_WARNING:        50,
  SHADER_SCORE_ERROR:          75,
  EXPENSIVE_OBJECTS_WARNING:    5,   // # of objects with cost > 50
};

// ─── Rule Registry ────────────────────────────────────────────────────────────

/**
 * Each rule receives:
 *   @param {FrameMetrics}  metrics  – live frame data
 *   @param {SceneTotals}   totals   – aggregated scene counts
 *   @param {AnalyzedObject[]} objects – per-object analysis results
 *   @param {ShaderProgramReport[]} shaders – shader analysis results
 *
 * Returns a Warning object or null.
 */
const RULES = [

  // ── Draw Call Rules ───────────────────────────────────────────────────────

  {
    id: 'draw-calls-critical',
    evaluate({ metrics }) {
      const dc = metrics.drawCalls;
      if (dc < THRESHOLDS.DRAW_CALLS_ERROR) return null;
      return {
        severity: 'error',
        category: 'Draw Calls',
        title: `Critical: ${dc} draw calls per frame`,
        detail: `Each draw call has GPU/CPU overhead. At ${dc} calls you are almost certainly CPU-bound. Batch geometry into a single BufferGeometry, use InstancedMesh for repeated objects, or merge static meshes with BufferGeometryUtils.mergeGeometries().`,
        metric: `${dc} draw calls`,
        docsLink: 'https://threejs.org/docs/#api/en/objects/InstancedMesh',
      };
    },
  },

  {
    id: 'draw-calls-high',
    evaluate({ metrics }) {
      const dc = metrics.drawCalls;
      if (dc < THRESHOLDS.DRAW_CALLS_WARNING || dc >= THRESHOLDS.DRAW_CALLS_ERROR) return null;
      return {
        severity: 'warning',
        category: 'Draw Calls',
        title: `High draw call count (${dc})`,
        detail: `${dc} draw calls is approaching the point where CPU overhead becomes a bottleneck. Consider using InstancedMesh for repeated geometry and merging static scene parts.`,
        metric: `${dc} draw calls`,
        docsLink: 'https://threejs.org/docs/#api/en/objects/InstancedMesh',
      };
    },
  },

  // ── Geometry Rules ────────────────────────────────────────────────────────

  {
    id: 'triangles-critical',
    evaluate({ totals }) {
      const t = totals.triangleCount;
      if (t < THRESHOLDS.TRIANGLES_ERROR) return null;
      return {
        severity: 'error',
        category: 'Geometry',
        title: `Excessive triangle count (${(t / 1_000_000).toFixed(1)}M)`,
        detail: `${(t / 1_000_000).toFixed(1)}M triangles is extremely high. Implement Level-of-Detail (LOD) via THREE.LOD so distant objects use simplified meshes. Also consider mesh decimation in your DCC tool (Blender, Houdini).`,
        metric: `${t.toLocaleString()} triangles`,
        docsLink: 'https://threejs.org/docs/#api/en/objects/LOD',
      };
    },
  },

  {
    id: 'triangles-high',
    evaluate({ totals }) {
      const t = totals.triangleCount;
      if (t < THRESHOLDS.TRIANGLES_WARNING || t >= THRESHOLDS.TRIANGLES_ERROR) return null;
      return {
        severity: 'warning',
        category: 'Geometry',
        title: `High triangle count (${(t / 1000).toFixed(0)}K)`,
        detail: `Consider LOD (THREE.LOD) to reduce triangle count for distant objects and mesh simplification for hero assets.`,
        metric: `${t.toLocaleString()} triangles`,
        docsLink: 'https://threejs.org/docs/#api/en/objects/LOD',
      };
    },
  },

  // ── Texture Rules ─────────────────────────────────────────────────────────

  {
    id: 'textures-critical',
    evaluate({ totals }) {
      const t = totals.textureCount;
      if (t < THRESHOLDS.TEXTURES_ERROR) return null;
      return {
        severity: 'error',
        category: 'Textures',
        title: `Too many unique textures (${t})`,
        detail: `${t} unique textures likely causes excessive GPU memory pressure and many texture binds. Pack textures into atlases, use sprite sheets, and ensure textures are power-of-two dimensions with mipmapping enabled.`,
        metric: `${t} textures`,
        docsLink: 'https://threejs.org/docs/#api/en/textures/CanvasTexture',
      };
    },
  },

  {
    id: 'textures-high',
    evaluate({ totals }) {
      const t = totals.textureCount;
      if (t < THRESHOLDS.TEXTURES_WARNING || t >= THRESHOLDS.TEXTURES_ERROR) return null;
      return {
        severity: 'warning',
        category: 'Textures',
        title: `High texture count (${t})`,
        detail: `${t} unique textures. Consider texture atlases and reusing materials across objects.`,
        metric: `${t} textures`,
      };
    },
  },

  // ── Shadow Rules ──────────────────────────────────────────────────────────

  {
    id: 'shadow-lights-critical',
    evaluate({ totals }) {
      const sl = totals.shadowLights;
      if (sl < THRESHOLDS.SHADOW_LIGHTS_ERROR) return null;
      return {
        severity: 'error',
        category: 'Shadows',
        title: `${sl} shadow-casting lights detected`,
        detail: `Each shadow light adds a full shadow-map render pass. At ${sl} lights you are doing ${sl} extra geometry traversals per frame. Reduce to 1–2 shadow casters, or bake shadows into lightmaps for static scenes.`,
        metric: `${sl} shadow casters`,
        docsLink: 'https://threejs.org/docs/#api/en/lights/shadows/LightShadow',
      };
    },
  },

  {
    id: 'shadow-lights-high',
    evaluate({ totals }) {
      const sl = totals.shadowLights;
      if (sl < THRESHOLDS.SHADOW_LIGHTS_WARNING || sl >= THRESHOLDS.SHADOW_LIGHTS_ERROR) return null;
      return {
        severity: 'warning',
        category: 'Shadows',
        title: `Multiple shadow-casting lights (${sl})`,
        detail: `${sl} shadow casters means ${sl} extra render passes. Consider limiting shadow casters or using a single cascaded shadow map.`,
        metric: `${sl} shadow casters`,
      };
    },
  },

  // ── FPS / Frame Time Rules ────────────────────────────────────────────────

  {
    id: 'fps-critical',
    evaluate({ metrics }) {
      const fps = metrics.fps;
      if (!fps || fps === 0 || fps >= THRESHOLDS.FPS_ERROR) return null;
      return {
        severity: 'error',
        category: 'Frame Rate',
        title: `Critical frame rate (${fps.toFixed(1)} FPS)`,
        detail: `${fps.toFixed(1)} FPS is far below the 60 FPS target. The application is severely bottlenecked. Check draw calls, triangle count, and shader complexity tabs for root causes.`,
        metric: `${fps.toFixed(1)} FPS`,
      };
    },
  },

  {
    id: 'fps-low',
    evaluate({ metrics }) {
      const fps = metrics.fps;
      if (!fps || fps === 0 || fps < THRESHOLDS.FPS_ERROR || fps >= THRESHOLDS.FPS_WARNING) return null;
      return {
        severity: 'warning',
        category: 'Frame Rate',
        title: `Below-target frame rate (${fps.toFixed(1)} FPS)`,
        detail: `Target 60 FPS for smooth interaction. Current rate of ${fps.toFixed(1)} FPS suggests a GPU or CPU bottleneck.`,
        metric: `${fps.toFixed(1)} FPS`,
      };
    },
  },

  // ── Shader Rules ──────────────────────────────────────────────────────────

  {
    id: 'expensive-shaders',
    evaluate({ shaders }) {
      if (!shaders || shaders.length === 0) return null;
      const expensive = shaders.filter(s => s.combinedScore >= THRESHOLDS.SHADER_SCORE_ERROR);
      if (expensive.length === 0) return null;
      const names = expensive.map(s => s.materialName).join(', ');
      return {
        severity: 'error',
        category: 'Shaders',
        title: `${expensive.length} expensive shader(s) detected`,
        detail: `Materials [${names}] have high shader complexity scores. Check the Shader Analyzer tab for specific issues (excessive texture lookups, deep loops, heavy branching).`,
        metric: `score ≥ ${THRESHOLDS.SHADER_SCORE_ERROR}`,
        docsLink: 'https://threejs.org/docs/#api/en/materials/ShaderMaterial',
      };
    },
  },

  // ── Missing Optimizations ─────────────────────────────────────────────────

  {
    id: 'no-instancing',
    evaluate({ totals, metrics }) {
      // High draw calls but zero instanced meshes — instancing is the obvious fix
      if (metrics.drawCalls < THRESHOLDS.DRAW_CALLS_WARNING) return null;
      if (totals.instancedMeshCount > 0) return null;
      return {
        severity: 'info',
        category: 'Optimization',
        title: 'No InstancedMesh found despite high draw calls',
        detail: 'You have many draw calls but no InstancedMesh objects. If you render many copies of the same geometry, replace Mesh with InstancedMesh to batch them into a single draw call.',
        metric: `${totals.instancedMeshCount} instanced meshes`,
        docsLink: 'https://threejs.org/docs/#api/en/objects/InstancedMesh',
      };
    },
  },

  {
    id: 'objects-without-names',
    evaluate({ objects }) {
      const unnamed = objects.filter(o => o.name.startsWith('(unnamed')).length;
      if (unnamed < 10) return null;
      return {
        severity: 'info',
        category: 'Maintainability',
        title: `${unnamed} unnamed scene objects`,
        detail: 'Set object.name on your Three.js objects. This makes profiling, debugging, and selective optimization much easier.',
        metric: `${unnamed} unnamed`,
      };
    },
  },

  {
    id: 'invisible-shadow-casters',
    evaluate({ objects }) {
      const hidden = objects.filter(o => !o.visible && o.castShadow);
      if (hidden.length === 0) return null;
      return {
        severity: 'warning',
        category: 'Shadows',
        title: `${hidden.length} invisible object(s) casting shadows`,
        detail: 'Invisible objects still participate in shadow passes. Set object.castShadow = false when hiding objects, or remove them from the scene entirely.',
        metric: `${hidden.length} objects`,
      };
    },
  },

];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all warning rules against the current frame snapshot.
 *
 * @param {object} snapshot
 * @param {FrameMetrics}         snapshot.metrics
 * @param {SceneTotals}          snapshot.totals
 * @param {AnalyzedObject[]}     snapshot.objects
 * @param {ShaderProgramReport[]} snapshot.shaders
 *
 * @returns {Warning[]} sorted by severity (error → warning → info)
 */
function generateWarnings(snapshot) {
  const warnings = [];
  const { metrics, totals, objects, shaders } = snapshot;

  for (const rule of RULES) {
    try {
      const warning = rule.evaluate({ metrics, totals, objects, shaders });
      if (warning) {
        warnings.push({ id: rule.id, ...warning });
      }
    } catch (err) {
      // Never let a buggy rule crash the profiler
      console.warn(`[FrameDoctor] Warning rule "${rule.id}" threw:`, err);
    }
  }

  // Sort: errors first, then warnings, then info
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
  warnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return warnings;
}

// ─── Export ───────────────────────────────────────────────────────────────────
window.__FrameDoctor = window.__FrameDoctor || {};
window.__FrameDoctor.generateWarnings = generateWarnings;
window.__FrameDoctor.THRESHOLDS = THRESHOLDS;
