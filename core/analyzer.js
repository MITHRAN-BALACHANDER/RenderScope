/**
 * RenderScope — Core Scene Analyzer (core/analyzer.js)
 *
 * PURPOSE:
 *   Traverse a Three.js scene graph and extract per-object cost data.
 *   This module runs *inside the content script* so it has direct access
 *   to live THREE objects.
 *
 * OUTPUT FORMAT (AnalyzedObject):
 *   {
 *     uuid: string,
 *     name: string,
 *     type: string,             // e.g. "Mesh", "InstancedMesh", "SkinnedMesh"
 *     visible: boolean,
 *     triangles: number,
 *     instanceCount: number,    // >1 for InstancedMesh
 *     materialType: string,     // e.g. "MeshStandardMaterial"
 *     materialCount: number,    // multi-material arrays
 *     textureCount: number,
 *     textureNames: string[],
 *     castShadow: boolean,
 *     receiveShadow: boolean,
 *     vertexColors: boolean,
 *     morphTargets: boolean,
 *     skinned: boolean,
 *     renderOrder: number,
 *     estimatedCost: number,    // composite heuristic score (0–100)
 *   }
 */

/**
 * Traverse the THREE scene and produce a flat array of analyzed objects.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ objects: AnalyzedObject[], totals: SceneTotals }}
 */
function analyzeScene(scene, renderer) {
  const objects = [];
  let totalTriangles = 0;
  let totalTextures = 0;
  let totalMeshes = 0;
  let shadowLights = 0;
  let instancedMeshCount = 0;

  // Collect unique textures across the scene to avoid double-counting
  const seenTextures = new Set();
  const seenGeometries = new Set();

  scene.traverse((object) => {
    // Count shadow-casting lights
    if (object.isLight && object.castShadow) {
      shadowLights++;
      return;
    }

    if (!object.isMesh && !object.isInstancedMesh && !object.isSkinnedMesh) return;

    totalMeshes++;
    if (object.isInstancedMesh) instancedMeshCount++;

    // ── Geometry Analysis ─────────────────────────────
    let triangles = 0;
    const geo = object.geometry;
    if (geo) {
      if (!seenGeometries.has(geo.uuid)) {
        seenGeometries.add(geo.uuid);
      }
      if (geo.index) {
        triangles = geo.index.count / 3;
      } else if (geo.attributes.position) {
        triangles = geo.attributes.position.count / 3;
      }

      // InstancedMesh multiplies draw cost by instance count
      const instanceCount = object.isInstancedMesh ? object.count : 1;
      triangles *= instanceCount;
      totalTriangles += triangles;
    }

    // ── Material Analysis ─────────────────────────────
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    let textureCount = 0;
    const textureNames = [];

    for (const mat of materials) {
      if (!mat) continue;

      // Enumerate all well-known Three.js texture slots
      const TEXTURE_SLOTS = [
        'map', 'normalMap', 'roughnessMap', 'metalnessMap',
        'aoMap', 'emissiveMap', 'displacementMap', 'alphaMap',
        'envMap', 'lightMap', 'bumpMap', 'specularMap',
        'clearcoatMap', 'clearcoatNormalMap', 'sheenColorMap',
        'transmissionMap', 'thicknessMap', 'iridescenceMap',
      ];

      for (const slot of TEXTURE_SLOTS) {
        const tex = mat[slot];
        if (tex && tex.isTexture) {
          if (!seenTextures.has(tex.uuid)) {
            seenTextures.add(tex.uuid);
            totalTextures++;
          }
          textureCount++;
          textureNames.push(tex.name || slot);
        }
      }
    }

    // ── Feature flags ─────────────────────────────────
    const firstMat = materials[0] || {};
    const morphTargets = !!object.morphTargetInfluences?.length;

    // ── Cost Heuristic ────────────────────────────────
    const estimatedCost = computeObjectCost({
      triangles,
      textureCount,
      castShadow: object.castShadow,
      skinned: object.isSkinnedMesh,
      morphTargets,
      materialCount: materials.length,
    });

    objects.push({
      uuid: object.uuid,
      name: object.name || `(unnamed ${object.type})`,
      type: object.type,
      visible: object.visible,
      triangles: Math.round(triangles),
      instanceCount: object.isInstancedMesh ? object.count : 1,
      materialType: firstMat.type || 'unknown',
      materialCount: materials.length,
      textureCount,
      textureNames,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      vertexColors: firstMat.vertexColors || false,
      morphTargets,
      skinned: !!object.isSkinnedMesh,
      renderOrder: object.renderOrder,
      estimatedCost,
    });
  });

  const totals = {
    meshCount: totalMeshes,
    triangleCount: Math.round(totalTriangles),
    textureCount: totalTextures,
    geometryCount: seenGeometries.size,
    shadowLights,
    instancedMeshCount,
  };

  return { objects, totals };
}

/**
 * Compute a 0–100 relative cost heuristic for a single object.
 * Higher = more expensive.  Used for sorting in the Scene Analyzer tab.
 *
 * Weights are intentionally simplistic but tunable.
 */
function computeObjectCost({ triangles, textureCount, castShadow, skinned, morphTargets, materialCount }) {
  let score = 0;

  // Triangles: 1 point per 500 triangles, capped at 40
  score += Math.min(40, triangles / 500);

  // Textures: 5 points each, capped at 30
  score += Math.min(30, textureCount * 5);

  // Shadow casting: expensive due to extra shadow pass
  if (castShadow) score += 15;

  // Skinning: vertex shader cost
  if (skinned) score += 10;

  // Morph targets: additional attribute reads
  if (morphTargets) score += 5;

  // Multi-material: extra draw calls
  score += (materialCount - 1) * 3;

  return Math.min(100, Math.round(score));
}

// ─── Export for use in profiler.js ───────────────────────────────────────────
// (Content scripts don't use ES module syntax; attach to window namespace)
window.__RenderScope = window.__RenderScope || {};
window.__RenderScope.analyzeScene = analyzeScene;
