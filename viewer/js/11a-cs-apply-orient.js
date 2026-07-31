/* 11a-cs-apply-orient.js — STEP 4: Apply orientation (rotate + align)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY                                                        ║
 * ║  • NEVER mutate meshPositionsMm / meshIndices / pathPoints / sect*   ║
 * ║  • Deep-copy vertices into oriented_* only                           ║
 * ║  • Display meshes unchanged here (pack/viz may use oriented_* later) ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Sub-steps:
 *   4A Rotate 0°/90° about length axis so Y = Step3 vertical_dim
 *   4B Translate minY → 0 (ground)
 *   4C Translate minX,minZ → 0 (origin)
 *   + Enforce X=length ≥ Z=width
 *
 * Input:  Step1 crossSection + Step3 best_orientation / orientation_info
 * Output: item.orientedItem (+ oriented_length/width/height/bbox)
 */

const CSA4_TOL_MM = 1.0; // match vertical_dim / extents

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Apply Step3 winner → oriented bbox/mesh copy. Originals untouched.
 * @returns {object|null} orientedItem
 */
function applyOrientation(it) {
  if (!it) return null;

  if (!it.orientation_info && typeof findBestOrientation === 'function')
    findBestOrientation(it);

  const oi = it.orientation_info;
  const best = it.best_orientation || (oi ? {
    orientation_id: oi.orientation_id,
    vertical_dim: oi.vertical_dim || oi.vertical_mm,
    rotation_needed: oi.rotation_needed,
    stability_score: oi.stability_score,
    stackability_score: oi.stackability_score,
  } : null);

  if (!best || !(best.vertical_dim > 0)) {
    it.orientedItem = null;
    return null;
  }

  const dims = csa4ReadDims(it, oi);
  const collected = csa4CollectPoints(it, dims);
  const original_vertices = csa4CloneVerts(collected.vertices);
  const original_bbox = csa4BBox(original_vertices);
  const original_parts = collected.parts.map(p => ({
    name: p.name,
    vertices: csa4CloneVerts(p.vertices),
  }));

  // Working copies
  let verts = csa4CloneVerts(original_vertices);
  let partVerts = collected.parts.map(p => csa4CloneVerts(p.vertices));

  const length_axis = csa4LengthAxis(it, original_bbox, dims);
  const targetV = Number(best.vertical_dim);

  // ── 4A: rotate so Y-extent ≈ vertical_dim ────────────────────────────────
  let rotation_axis = length_axis;
  let rotation_angle = 0;
  let bb = csa4BBox(verts);
  let ey = bb.maxY - bb.minY;

  if (Math.abs(ey - targetV) > CSA4_TOL_MM) {
    // Prefer Step3 hint; fallback try ±90 about length axis
    const tryAngles = [];
    const hinted = best.rotation_needed || oi?.rotation_needed;
    if (hinted && Math.abs(hinted.angle) > 0) {
      const ax = csa4NormalizeAxis(hinted.axis, length_axis);
      tryAngles.push({ axis: ax, angle: hinted.angle | 0 });
    }
    tryAngles.push({ axis: length_axis, angle: 90 });
    tryAngles.push({ axis: length_axis, angle: -90 });
    // Length→vertical (orientation C): rotate about Z or Y
    tryAngles.push({ axis: 'Z', angle: 90 });
    tryAngles.push({ axis: 'Y', angle: 90 });

    let found = null;
    for (let t = 0; t < tryAngles.length; t++) {
      const trial = csa4CloneVerts(original_vertices);
      const center = csa4Center(original_bbox);
      csa4RotateInPlace(trial, tryAngles[t].axis, tryAngles[t].angle, center);
      const tb = csa4BBox(trial);
      if (Math.abs((tb.maxY - tb.minY) - targetV) <= CSA4_TOL_MM) {
        found = tryAngles[t];
        verts = trial;
        // Same transform on parts from originals
        partVerts = original_parts.map(p => {
          const pv = csa4CloneVerts(p.vertices);
          csa4RotateInPlace(pv, found.axis, found.angle, center);
          return pv;
        });
        break;
      }
    }
    if (found) {
      rotation_axis = found.axis;
      rotation_angle = found.angle;
      bb = csa4BBox(verts);
    } else {
      // Last resort: rebuild box already in target orientation (packing dims)
      const L = dims.D3, H = targetV;
      const W = Math.abs(targetV - dims.D2) <= CSA4_TOL_MM ? dims.D1 : dims.D2;
      verts = csa4BoxCorners(L, H, W);
      partVerts = [csa4CloneVerts(verts)];
      rotation_axis = length_axis;
      rotation_angle = (oi?.orientation_id === 'A' || best.orientation_id === 'A') ? 0 : 90;
      bb = csa4BBox(verts);
    }
  }

  // ── Z_SHAPE Nesting Angle: two-point ground level (rigid roll) ───────────
  let nesting_roll_deg = 0;
  if (typeof csNzIsZShape === 'function' && csNzIsZShape(it)) {
    if (typeof attachZNestingAngleToOrientation === 'function')
      attachZNestingAngleToOrientation(it, oi || it.orientation_info);
    const zNest = it.orientation_info?.z_nesting || it.orientation_info;
    nesting_roll_deg = Number(
      zNest?.nesting_angle_deg
      ?? it.orientation_info?.nesting_angle_deg
      ?? 0
    ) || 0;
    if (Math.abs(nesting_roll_deg) > 1e-4) {
      const center = csa4Center(csa4BBox(verts));
      csa4RotateInPlace(verts, length_axis, nesting_roll_deg, center);
      partVerts.forEach(pv => csa4RotateInPlace(pv, length_axis, nesting_roll_deg, center));
      bb = csa4BBox(verts);
    }
  }

  // ── 4B + 4C: ground + origin ─────────────────────────────────────────────
  bb = csa4BBox(verts);
  const t1 = { x: -bb.minX, y: -bb.minY, z: -bb.minZ };
  csa4TranslateInPlace(verts, t1.x, t1.y, t1.z);
  partVerts.forEach(pv => csa4TranslateInPlace(pv, t1.x, t1.y, t1.z));

  // ── Enforce X=length ≥ Z=width ───────────────────────────────────────────
  bb = csa4BBox(verts);
  let ex = bb.maxX - bb.minX;
  let ez = bb.maxZ - bb.minZ;
  let yaw90 = false;
  if (ez > ex + CSA4_TOL_MM) {
    const center = csa4Center(bb);
    csa4RotateInPlace(verts, 'Y', 90, center);
    partVerts.forEach(pv => csa4RotateInPlace(pv, 'Y', 90, center));
    yaw90 = true;
    bb = csa4BBox(verts);
    const t2 = { x: -bb.minX, y: -bb.minY, z: -bb.minZ };
    csa4TranslateInPlace(verts, t2.x, t2.y, t2.z);
    partVerts.forEach(pv => csa4TranslateInPlace(pv, t2.x, t2.y, t2.z));
    t1.x += t2.x; t1.y += t2.y; t1.z += t2.z;
    // Combined rotation record stays primary CS rot; yaw noted separately
  }

  bb = csa4BBox(verts);
  const oriented_length = bb.maxX - bb.minX;
  const oriented_height = bb.maxY - bb.minY;
  const oriented_width = bb.maxZ - bb.minZ;

  const oriented_parts = original_parts.map((p, i) => ({
    name: p.name,
    oriented_vertices: partVerts[i] || [],
    original_vertices: p.vertices,
  }));

  const transformation = {
    rotation_axis,
    rotation_angle,
    nesting_roll_deg,
    yaw90_length_enforce: yaw90,
    translation: { x: t1.x, y: t1.y, z: t1.z },
    length_along: 'X',
    width_along: 'Z',
    height_along: 'Y',
    length_axis_used: length_axis,
  };

  const orientedItem = {
    oriented_vertices: verts,
    mesh_indices: collected.indices ? collected.indices.slice() : null,
    oriented_bbox: {
      minX: bb.minX, maxX: bb.maxX,
      minY: bb.minY, maxY: bb.maxY,
      minZ: bb.minZ, maxZ: bb.maxZ,
    },
    oriented_length,
    oriented_width,
    oriented_height,
    transformation,
    original_vertices,
    original_bbox,
    oriented_parts,
    source: collected.source,
    orientation_id: best.orientation_id || oi?.orientation_id,
    vertical_dim_target: targetV,
    height_matches_target: Math.abs(oriented_height - targetV) <= CSA4_TOL_MM,
    stability_score: best.stability_score ?? oi?.stability_score,
    stackability_score: best.stackability_score ?? oi?.stackability_score,
    mutates_geometry: false,
  };

  it.orientedItem = orientedItem;
  it.oriented_length = oriented_length;
  it.oriented_width = oriented_width;
  it.oriented_height = oriented_height;
  it.oriented_bbox = orientedItem.oriented_bbox;
  it.oriented_transform = transformation;

  return orientedItem;
}

/** Apply Step 4 to all items (after Step 3). */
function attachAppliedOrientationsToItems(items) {
  let ok = 0, fail = 0;
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  (items || []).forEach(it => {
    const o = applyOrientation(it);
    if (o && o.oriented_bbox && o.oriented_height >= 0) ok++;
    else fail++;
  });
  const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
  try {
    console.info(`[Step4 apply-orient] ${ok} ok, ${fail} failed of ${(items || []).length} in ${ms.toFixed(1)}ms`);
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length, ms };
}

/**
 * Reverse oriented → original space (verify round-trip).
 * Does not mutate item meshes.
 */
function reverseOrientationVertices(orientedVerts, transformation, original_bbox) {
  if (!orientedVerts || !transformation) return null;
  let v = csa4CloneVerts(orientedVerts);
  // Undo translation
  const t = transformation.translation || { x: 0, y: 0, z: 0 };
  csa4TranslateInPlace(v, -t.x, -t.y, -t.z);
  // Undo yaw enforce
  if (transformation.yaw90_length_enforce) {
    const bb = csa4BBox(v);
    csa4RotateInPlace(v, 'Y', -90, csa4Center(bb));
  }
  // Undo primary rotation about original center
  if (Math.abs(transformation.rotation_angle) > 0) {
    const center = original_bbox
      ? csa4Center(original_bbox)
      : csa4Center(csa4BBox(v));
    csa4RotateInPlace(v, transformation.rotation_axis, -transformation.rotation_angle, center);
  }
  return v;
}

// ── collect / dims ──────────────────────────────────────────────────────────

function csa4ReadDims(it, oi) {
  const d = oi?.dims_used || {};
  const D1 = Number(d.D1 || d.H || it.sectH || it.crossSection?.cs_height || 0) || 0;
  const D2 = Number(d.D2 || d.W || it.sectW || it.crossSection?.cs_width || 0) || 0;
  const D3 = Number(d.D3 || d.L || it.lengthMm || it.crossSection?.member_length || 0) || 0;
  return {
    D1: D1 || Math.max(Number(it.heightMm || 0), 1),
    D2: D2 || Math.max(Number(it.widthMm || 0), 1),
    D3: D3 || Math.max(Number(it.lengthMm || 0), 1),
  };
}

/**
 * Collect vertices as [{x,y,z}] copies. Prefer mesh; else bbox corners.
 * Assumes IFC-like pose: length X, cs_height Y, cs_width Z (Step3 baseline).
 */
function csa4CollectPoints(it, dims) {
  const partsOut = [];
  const indices = [];
  let source = 'bbox';

  const parts = (it.parts && it.parts.length) ? it.parts : null;
  if (parts) {
    let any = false;
    parts.forEach((p, pi) => {
      const flat = p.meshPositionsMm;
      if (flat && flat.length >= 9) {
        any = true;
        const verts = csa4FlatToVerts(flat);
        partsOut.push({ name: p.name || ('part' + pi), vertices: verts });
      } else if (p.boxXMm > 0 || p.lengthMm > 0) {
        const L = Number(p.boxXMm || p.lengthMm || dims.D3) || dims.D3;
        const H = Number(p.boxYMm || p.heightMm || dims.D1) || dims.D1;
        const W = Number(p.boxZMm || p.widthMm || dims.D2) || dims.D2;
        const ox = Number(p.offsetXMm || 0), oy = Number(p.offsetYMm || 0), oz = Number(p.offsetZMm || 0);
        const box = csa4BoxCorners(L, H, W).map(([x, y, z]) => [x + ox, y + oy, z + oz]);
        partsOut.push({ name: p.name || ('part' + pi), vertices: box });
        any = true;
      }
    });
    if (any) {
      source = 'parts';
      const merged = [];
      partsOut.forEach(p => p.vertices.forEach(v => merged.push(v)));
      return { vertices: merged, parts: partsOut, indices: null, source };
    }
  }

  const flat = it.meshPositionsMm;
  if (flat && flat.length >= 9) {
    const verts = csa4FlatToVerts(flat);
    if (it.meshIndices && it.meshIndices.length) {
      for (let i = 0; i < it.meshIndices.length; i++) indices.push(it.meshIndices[i] | 0);
    }
    return {
      vertices: verts,
      parts: [{ name: 'main', vertices: csa4CloneVerts(verts) }],
      indices: indices.length ? indices : null,
      source: 'mesh',
    };
  }

  // Synthetic AABB: X=length, Y=height(D1), Z=width(D2)
  const verts = csa4BoxCorners(dims.D3, dims.D1, dims.D2);
  return {
    vertices: verts,
    parts: [{ name: 'bbox', vertices: csa4CloneVerts(verts) }],
    indices: null,
    source: 'bbox',
  };
}

function csa4BoxCorners(L, H, W) {
  const l = Math.max(L, 0), h = Math.max(H, 0), w = Math.max(W, 0);
  return [
    [0, 0, 0], [l, 0, 0], [l, h, 0], [0, h, 0],
    [0, 0, w], [l, 0, w], [l, h, w], [0, h, w],
  ];
}

function csa4FlatToVerts(flat) {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3)
    out.push([Number(flat[i]) || 0, Number(flat[i + 1]) || 0, Number(flat[i + 2]) || 0]);
  return out;
}

function csa4CloneVerts(verts) {
  return (verts || []).map(v => [v[0], v[1], v[2]]);
}

function csa4LengthAxis(it, bb, dims) {
  const fromCs = it.crossSection?.length_axis;
  if (fromCs === 'X' || fromCs === 'Y' || fromCs === 'Z') return fromCs;
  const ex = bb.maxX - bb.minX, ey = bb.maxY - bb.minY, ez = bb.maxZ - bb.minZ;
  if (ex >= ey && ex >= ez) return 'X';
  if (ey >= ex && ey >= ez) return 'Y';
  return 'Z';
}

function csa4NormalizeAxis(axis, fallback) {
  const a = String(axis || '').toUpperCase();
  if (a === 'X' || a === 'Y' || a === 'Z') return a;
  if (a === 'LENGTH_AXIS' || a === 'LENGTH') return fallback || 'X';
  if (a === 'NONE') return fallback || 'X';
  return fallback || 'X';
}

// ── geometry ops ────────────────────────────────────────────────────────────

function csa4BBox(verts) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const x = verts[i][0], y = verts[i][1], z = verts[i][2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) {
    minX = maxX = minY = maxY = minZ = maxZ = 0;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function csa4Center(bb) {
  return {
    x: (bb.minX + bb.maxX) * 0.5,
    y: (bb.minY + bb.maxY) * 0.5,
    z: (bb.minZ + bb.maxZ) * 0.5,
  };
}

/** Rotate ±90° (or any degrees) around axis through center. In-place. */
function csa4RotateInPlace(verts, axis, angleDeg, center) {
  const ax = String(axis || 'X').toUpperCase();
  const rad = (Number(angleDeg) || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const cx = center.x, cy = center.y, cz = center.z;

  for (let i = 0; i < verts.length; i++) {
    let x = verts[i][0] - cx;
    let y = verts[i][1] - cy;
    let z = verts[i][2] - cz;
    let nx = x, ny = y, nz = z;
    if (ax === 'X') {
      ny = c * y - s * z;
      nz = s * y + c * z;
    } else if (ax === 'Y') {
      nx = c * x + s * z;
      nz = -s * x + c * z;
    } else { // Z
      nx = c * x - s * y;
      ny = s * x + c * y;
    }
    verts[i][0] = nx + cx;
    verts[i][1] = ny + cy;
    verts[i][2] = nz + cz;
  }
}

function csa4TranslateInPlace(verts, dx, dy, dz) {
  for (let i = 0; i < verts.length; i++) {
    verts[i][0] += dx;
    verts[i][1] += dy;
    verts[i][2] += dz;
  }
}
