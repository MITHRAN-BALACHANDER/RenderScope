/**
 * FrameDoctor — Shader Analyzer (core/shaderAnalyzer.js)
 *
 * PURPOSE:
 *   Intercept, analyze, and score GLSL shaders for performance issues.
 *
 * HOW IT INTEGRATES:
 *   Called from profiler.js via material.onBeforeCompile hook.
 *   Every unique shader pair (vertex + fragment) is analyzed once and
 *   stored by a stable key (material uuid → shader report).
 *
 * WHAT WE ANALYZE:
 *   • Shader source length (proxy for complexity)
 *   • Texture2D / texture lookup count
 *   • Loop depth (nested for-loops are expensive)
 *   • Conditional count (branching hurts warps)
 *   • Discard statements (forces depth test override)
 *   • Derivative functions (dFdx/dFdy — forces helper invocations)
 *   • Dependent texture reads (texture read inside a conditional)
 */

/**
 * Analyze a single GLSL shader string.
 *
 * @param {string} src - Raw GLSL source
 * @param {'vertex'|'fragment'} stage
 * @returns {ShaderStageReport}
 */
function analyzeGLSL(src, stage) {
  if (!src || typeof src !== 'string') {
    return { stage, lines: 0, textureLookups: 0, loops: 0, conditionals: 0, discards: 0, derivatives: 0, score: 0, flags: [] };
  }

  const lines = src.split('\n').length;
  const flags = [];

  // ── Texture lookups ──────────────────────────────────
  // Match texture(), texture2D(), textureCube(), texelFetch() etc.
  const texturePattern = /\btexture(?:2D|Cube|3D|Lod|2DLodEXT|Grad|Offset|Proj|ProjLod)?\s*\(/g;
  const textureLookups = (src.match(texturePattern) || []).length;

  // ── Loops ────────────────────────────────────────────
  const forLoops = (src.match(/\bfor\s*\(/g) || []).length;
  const whileLoops = (src.match(/\bwhile\s*\(/g) || []).length;
  const loops = forLoops + whileLoops;

  // ── Conditionals ─────────────────────────────────────
  const conditionals = (src.match(/\bif\s*\(/g) || []).length;

  // ── Discard statements ───────────────────────────────
  const discards = (src.match(/\bdiscard\b/g) || []).length;

  // ── Derivative functions ──────────────────────────────
  const derivatives = (src.match(/\bd[Ff]dx\b|\bd[Ff]dy\b|\bfwidth\b/g) || []).length;

  // ── Dependent texture reads ───────────────────────────
  // Heuristic: texture call appears inside an if-block
  const dependentTextureReads = countDependentTextureReads(src);

  // ── Flags / Warnings ─────────────────────────────────
  if (textureLookups > 8)           flags.push({ severity: 'error',   msg: `High texture lookup count (${textureLookups}) — consider a texture atlas or fewer samples` });
  else if (textureLookups > 4)      flags.push({ severity: 'warning', msg: `Moderate texture lookups (${textureLookups})` });

  if (loops > 4)                    flags.push({ severity: 'error',   msg: `${loops} loop(s) detected — GPU divergence risk; prefer unrolled or data-driven approaches` });
  else if (loops > 1)               flags.push({ severity: 'warning', msg: `${loops} loop(s) in shader` });

  if (conditionals > 6)             flags.push({ severity: 'error',   msg: `${conditionals} conditional branches — severe warp divergence on GPU` });
  else if (conditionals > 3)        flags.push({ severity: 'warning', msg: `${conditionals} conditionals — watch warp divergence` });

  if (stage === 'fragment' && discards > 0)
                                    flags.push({ severity: 'warning', msg: `discard statement prevents early-z optimization` });

  if (dependentTextureReads > 0)    flags.push({ severity: 'warning', msg: `${dependentTextureReads} dependent texture read(s) — prevents texture prefetching` });

  if (lines > 300)                  flags.push({ severity: 'warning', msg: `Long shader (${lines} lines) — consider splitting or optimizing` });

  // ── Score (0–100, higher = more expensive) ───────────
  const score = computeShaderScore({ lines, textureLookups, loops, conditionals, discards, derivatives, dependentTextureReads });

  return {
    stage,
    lines,
    textureLookups,
    loops,
    conditionals,
    discards,
    derivatives,
    dependentTextureReads,
    score,
    flags,
  };
}

/**
 * Heuristic: count texture() calls that appear to be inside if-blocks.
 * We use a simple line-based state machine for this.
 */
function countDependentTextureReads(src) {
  const lines = src.split('\n');
  let depth = 0;
  let insideIf = 0;
  let count = 0;
  let braceDepthAtIf = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track brace depth
    for (const ch of trimmed) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (insideIf > 0 && depth < braceDepthAtIf) {
          insideIf--;
        }
      }
    }

    if (/^\s*if\s*\(/.test(line)) {
      insideIf++;
      braceDepthAtIf = depth;
    }

    if (insideIf > 0 && /\btexture(?:2D|Cube|3D|Lod|2DLodEXT|Grad|Offset|Proj|ProjLod)?\s*\(/.test(line)) {
      count++;
    }
  }

  return count;
}

/**
 * Compute a 0–100 score for a shader stage.
 */
function computeShaderScore({ lines, textureLookups, loops, conditionals, discards, derivatives, dependentTextureReads }) {
  let score = 0;
  score += Math.min(20, lines / 15);                 // up to 20 pts for length
  score += Math.min(30, textureLookups * 3.5);       // up to 30 pts for texture lookups
  score += Math.min(20, loops * 5);                  // up to 20 pts for loops
  score += Math.min(15, conditionals * 2.5);         // up to 15 for conditionals
  score += discards * 5;                             // 5 pts each
  score += dependentTextureReads * 4;                // 4 pts each
  score += derivatives * 2;                          // 2 pts each
  return Math.min(100, Math.round(score));
}

/**
 * Analyze a complete shader program (vertex + fragment pair).
 *
 * @param {string} vertexSrc
 * @param {string} fragmentSrc
 * @param {string} materialName
 * @returns {ShaderProgramReport}
 */
function analyzeShaderProgram(vertexSrc, fragmentSrc, materialName) {
  const vertex   = analyzeGLSL(vertexSrc,   'vertex');
  const fragment = analyzeGLSL(fragmentSrc, 'fragment');

  const combinedScore = Math.round((vertex.score * 0.4) + (fragment.score * 0.6));
  const allFlags = [
    ...vertex.flags.map(f => ({ ...f, stage: 'vertex' })),
    ...fragment.flags.map(f => ({ ...f, stage: 'fragment' })),
  ];

  return {
    materialName: materialName || 'unnamed material',
    vertex,
    fragment,
    combinedScore,
    flags: allFlags,
    isExpensive: combinedScore > 50,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────
window.__FrameDoctor = window.__FrameDoctor || {};
window.__FrameDoctor.analyzeShaderProgram = analyzeShaderProgram;
