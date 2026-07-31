/* 09-cross-section.js — STEP 1 only: Extract 2D cross-section from 3D mesh / IFC profile
 *
 * Does NOT change rendered shapes. Stamps `item.crossSection` for later steps.
 *
 * Priority:
 *   1) Mesh mid-slice (exact saw-cut) when triangle mesh available
 *   2) IFC profile dims → analytic polygon (standard Z/C/L/I/RHS/plate/rod)
 *   3) Bounding-box rectangle (welded / fallback)
 */

const CS_SEG_TOL_MM = 0.1;
const CS_MERGE_MM = 0.5;
const CS_STRAIGHT_DEG = 175;
const CS_HOLE_MIN_DIAM_MM = 50;
const CS_TAPER_AREA_RATIO = 0.10;

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Extract cross-section for one raw IFC item. Never mutates mesh geometry.
 * @returns {object} crossSection record (see Step 1F)
 */
function extractCrossSection(it) {
  if (!it) return null;
  if (it.crossSection && it.crossSection.outer_points?.length >= 3)
    return it.crossSection;

  const welded = csIsWeldedLike(it);
  let result = null;

  // Guide: Approach B first for standard profiles (accurate + fast),
  // then Approach A mesh slice for custom / unknown / built-up.
  const fromProfile = csExtractFromProfile(it);
  if (fromProfile && csVerify(fromProfile).ok && !welded) {
    result = fromProfile;
  }

  const mesh = csCollectMesh(it);
  if ((!result || !csVerify(result).ok) && mesh
      && mesh.positions.length >= 9 && mesh.indices.length >= 3) {
    const fromMesh = csExtractFromMesh(mesh, it);
    if (fromMesh && csVerify(fromMesh).ok) result = fromMesh;
  }

  // Built-up / last resort: bbox face ⊥ length
  if (!result || !csVerify(result).ok) {
    result = csExtractFromBBox(it, welded);
  }

  if (result) {
    result.source = result.source || 'unknown';
    result.welded_like = !!welded;
    result.inner_polygons = result.inner_points || []; // guide alias
    const v = csVerify(result);
    result.verified = v.ok;
    result.verify_notes = v.notes;
    result.polygon_closed = v.closed !== false;
  }

  it.crossSection = result;
  return result;
}

/** Stamp crossSection on every item in the scene (call after load). */
function attachCrossSectionsToItems(items) {
  let ok = 0, fail = 0;
  (items || []).forEach(it => {
    const cs = extractCrossSection(it);
    if (cs && cs.verified) ok++;
    else fail++;
  });
  try {
    console.info(`[Step1 cross-section] extracted ${ok} ok, ${fail} weak/failed of ${(items || []).length}`);
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length };
}

// ── classification helpers ──────────────────────────────────────────────────

function csIsWeldedLike(it) {
  const nParts = (it.parts && it.parts.length) ? it.parts.length : 0;
  if (typeof isBentSagRodItem === 'function' && isBentSagRodItem(it)) return false;
  if (it.pathPointsMm && it.pathPointsMm.length >= 3) return false;
  if (it.shapeKey === 'bent_sag_rod') return false;
  if (nParts >= 2) return true;
  const prof = `${it.profileDesc || ''}`.toUpperCase();
  if (/BUILT[\s-]?UP/.test(prof)) return true;
  return false;
}

function csCollectMesh(it) {
  const positions = [];
  const indices = [];
  const parts = (it.parts && it.parts.length) ? it.parts : [it];
  parts.forEach(p => {
    const pos = p.meshPositionsMm;
    if (!pos || pos.length < 9) return;
    const base = positions.length / 3;
    for (let i = 0; i < pos.length; i++) positions.push(Number(pos[i]) || 0);
    const idx = p.meshIndices;
    if (idx && idx.length >= 3) {
      for (let i = 0; i < idx.length; i++) indices.push(base + (idx[i] | 0));
    } else {
      // Non-indexed: assume sequential triangles
      const nVert = pos.length / 3;
      for (let i = 0; i + 2 < nVert; i += 3) {
        indices.push(base + i, base + i + 1, base + i + 2);
      }
    }
  });
  if (positions.length < 9 || indices.length < 3) return null;
  return { positions, indices };
}

// ── Sub-step 1A–1F: mesh slice ───────────────────────────────────────────────

function csMeshBounds(positions) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    extentX: maxX - minX,
    extentY: maxY - minY,
    extentZ: maxZ - minZ,
  };
}

function csLengthAxisFromBounds(b) {
  const { extentX: ex, extentY: ey, extentZ: ez } = b;
  if (ex >= ey && ex >= ez) return { length_axis: 'X', member_length: ex };
  if (ey >= ex && ey >= ez) return { length_axis: 'Y', member_length: ey };
  return { length_axis: 'Z', member_length: ez };
}

function csAxisCoord(v, axis) {
  if (axis === 'X') return v[0];
  if (axis === 'Y') return v[1];
  return v[2];
}

function csTo2D(v, axis) {
  if (axis === 'X') return [v[1], v[2]];
  if (axis === 'Y') return [v[0], v[2]];
  return [v[0], v[1]];
}

function csGetVert(positions, i) {
  const o = i * 3;
  return [positions[o], positions[o + 1], positions[o + 2]];
}

function csSliceMeshAt(positions, indices, length_axis, slice_position) {
  const segments = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const v0 = csGetVert(positions, i0);
    const v1 = csGetVert(positions, i1);
    const v2 = csGetVert(positions, i2);
    const a = csAxisCoord(v0, length_axis) - slice_position;
    const b = csAxisCoord(v1, length_axis) - slice_position;
    const c = csAxisCoord(v2, length_axis) - slice_position;
    // Entirely on one side of plane → skip
    if ((a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0)) continue;

    const hits = [];
    const edges = [[v0, v1, a, b], [v1, v2, b, c], [v2, v0, c, a]];
    edges.forEach(([p, q, sp, sq]) => {
      if (sp === 0) {
        hits.push(csTo2D(p, length_axis));
        return;
      }
      if (sq === 0) {
        hits.push(csTo2D(q, length_axis));
        return;
      }
      if ((sp > 0) === (sq > 0)) return;
      const tLerp = sp / (sp - sq);
      const ip = [
        p[0] + tLerp * (q[0] - p[0]),
        p[1] + tLerp * (q[1] - p[1]),
        p[2] + tLerp * (q[2] - p[2]),
      ];
      hits.push(csTo2D(ip, length_axis));
    });
    // Dedup hits, need 2 unique points
    const uniq = [];
    hits.forEach(h => {
      if (!uniq.some(u => Math.hypot(u[0] - h[0], u[1] - h[1]) < CS_SEG_TOL_MM))
        uniq.push(h);
    });
    if (uniq.length >= 2)
      segments.push({ start: uniq[0], end: uniq[1] });
  }
  return segments;
}

function csConnectSegments(segments) {
  const unused = segments.map((s, i) => ({ ...s, used: false, i }));
  const loops = [];

  function findNext(pt) {
    for (const s of unused) {
      if (s.used) continue;
      if (Math.hypot(s.start[0] - pt[0], s.start[1] - pt[1]) < CS_SEG_TOL_MM) {
        s.used = true;
        return s.end;
      }
      if (Math.hypot(s.end[0] - pt[0], s.end[1] - pt[1]) < CS_SEG_TOL_MM) {
        s.used = true;
        return s.start;
      }
    }
    return null;
  }

  while (true) {
    const seed = unused.find(s => !s.used);
    if (!seed) break;
    seed.used = true;
    const poly = [seed.start.slice(), seed.end.slice()];
    let cur = seed.end;
    let guard = 0;
    while (guard++ < unused.length + 5) {
      if (Math.hypot(cur[0] - poly[0][0], cur[1] - poly[0][1]) < CS_SEG_TOL_MM) break;
      const next = findNext(cur);
      if (!next) break;
      poly.push(next.slice());
      cur = next;
    }
    if (poly.length >= 3) loops.push(poly);
  }
  return loops;
}

function csSimplifyPolygon(pts) {
  if (!pts || pts.length < 3) return pts || [];
  // Close if needed
  let p = pts.map(q => q.slice());
  if (Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) > CS_SEG_TOL_MM)
    p.push(p[0].slice());

  // Merge close consecutive
  let q = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = q[q.length - 1], b = p[i];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= CS_MERGE_MM) q.push(b);
  }
  if (q.length >= 2 && Math.hypot(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]) < CS_MERGE_MM)
    q.pop();

  // Remove near-collinear
  const thr = CS_STRAIGHT_DEG * Math.PI / 180;
  let changed = true;
  while (changed && q.length > 3) {
    changed = false;
    const out = [];
    const n = q.length;
    for (let i = 0; i < n; i++) {
      const prev = q[(i - 1 + n) % n];
      const cur = q[i];
      const next = q[(i + 1) % n];
      const ax = cur[0] - prev[0], ay = cur[1] - prev[1];
      const bx = next[0] - cur[0], by = next[1] - cur[1];
      const la = Math.hypot(ax, ay) || 1e-9;
      const lb = Math.hypot(bx, by) || 1e-9;
      const dot = (ax * bx + ay * by) / (la * lb);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
      // angle at vertex between incoming and outgoing; nearly π = straight
      if (ang > thr) { changed = true; continue; }
      out.push(cur);
    }
    if (out.length < 3) break;
    q = out;
  }
  return q;
}

function csPolygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) * 0.5;
}

function csPolygonBBox(pts) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  pts.forEach(([u, v]) => {
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  });
  return {
    minU, maxU, minV, maxV,
    cs_width: maxU - minU,
    cs_height: maxV - minV,
    cs_centroid: [(minU + maxU) / 2, (minV + maxV) / 2],
  };
}

function csBuildRecord(outer, inners, meta) {
  // Analytic IFC profiles are already minimal (4–12 verts) — do NOT simplify
  // (0.5mm merge + collinear strip can erase 2.5mm flanges → wrong area).
  const analytic = meta.source === 'ifc_profile' && (outer || []).length <= 32;
  const outerS = analytic
    ? (outer || []).map(q => q.slice())
    : csSimplifyPolygon(outer);
  const innerS = (inners || [])
    .map(p => (analytic ? p.map(q => q.slice()) : csSimplifyPolygon(p)))
    .filter(p => {
      // Ignore bolt-hole sized loops
      const bb = csPolygonBBox(p);
      return Math.max(bb.cs_width, bb.cs_height) >= CS_HOLE_MIN_DIAM_MM;
    });
  const bb = csPolygonBBox(outerS);
  const area = csPolygonArea(outerS) - innerS.reduce((s, p) => s + csPolygonArea(p), 0);
  const rec = {
    outer_points: outerS,
    inner_points: innerS,
    inner_polygons: innerS, // guide name
    length_axis: meta.length_axis,
    member_length: meta.member_length,
    slice_position: meta.slice_position,
    cs_width: bb.cs_width,
    cs_height: bb.cs_height,
    cs_area: Math.max(0, area),
    cs_centroid: bb.cs_centroid,
    vertex_count: outerS.length,
    is_tapered: !!meta.is_tapered,
    is_short_plate_like: !!meta.is_short_plate_like,
    source: meta.source,
    welded_assembly: !!meta.welded_assembly,
  };
  return rec;
}

function csExtractFromMesh(mesh, it) {
  const b = csMeshBounds(mesh.positions);
  const { length_axis, member_length } = csLengthAxisFromBounds(b);
  const minA = length_axis === 'X' ? b.minX : length_axis === 'Y' ? b.minY : b.minZ;
  const extent = length_axis === 'X' ? b.extentX : length_axis === 'Y' ? b.extentY : b.extentZ;

  // Short member → plate-like flag (still extract)
  const csGuess = Math.max(
    length_axis === 'X' ? Math.max(b.extentY, b.extentZ) : 0,
    length_axis === 'Y' ? Math.max(b.extentX, b.extentZ) : 0,
    length_axis === 'Z' ? Math.max(b.extentX, b.extentY) : 0
  );
  const is_short_plate_like = member_length > 0 && member_length < 3 * csGuess;

  // Taper check: slices at 25% and 75%
  const pos25 = minA + extent * 0.25;
  const pos75 = minA + extent * 0.75;
  const pos50 = minA + extent * 0.5;

  const segs25 = csSliceMeshAt(mesh.positions, mesh.indices, length_axis, pos25);
  const segs75 = csSliceMeshAt(mesh.positions, mesh.indices, length_axis, pos75);
  const loops25 = csConnectSegments(segs25).map(csSimplifyPolygon);
  const loops75 = csConnectSegments(segs75).map(csSimplifyPolygon);
  const area25 = loops25.length ? csPolygonArea(loops25[0]) : 0;
  const area75 = loops75.length ? csPolygonArea(loops75[0]) : 0;
  let is_tapered = false;
  if (area25 > 0 && area75 > 0) {
    const ratio = Math.abs(area25 - area75) / Math.max(area25, area75);
    is_tapered = ratio > CS_TAPER_AREA_RATIO;
  }

  // Main slice at mid (or larger of 25/75 if tapered)
  let slice_position = pos50;
  let segs = csSliceMeshAt(mesh.positions, mesh.indices, length_axis, slice_position);
  let loops = csConnectSegments(segs);
  if (is_tapered) {
    const use25 = area25 >= area75;
    slice_position = use25 ? pos25 : pos75;
    segs = use25 ? segs25 : segs75;
    loops = use25 ? loops25 : loops75;
  }

  if (!loops.length || loops[0].length < 3) return null;

  // Largest loop = outer; others = inners
  loops.sort((a, b) => csPolygonArea(b) - csPolygonArea(a));
  const outer = loops[0];
  const inners = loops.slice(1);

  return csBuildRecord(outer, inners, {
    length_axis,
    member_length: member_length || it.lengthMm || 0,
    slice_position,
    is_tapered,
    is_short_plate_like,
    source: 'mesh_slice',
  });
}

// ── Simpler method: IFC profile → polygon ───────────────────────────────────

function csExtractFromProfile(it) {
  const r = (typeof resolveItemProfile === 'function') ? resolveItemProfile(it) : null;
  let H = (r && r.sectH) || it.sectH || 0;
  let W = (r && r.sectW) || it.sectW || 0;
  let T = (r && r.sectT) || it.sectT || 0;
  let Tf = (r && r.sectTf) || it.sectTf || 0;
  let Tw = (r && r.sectTw) || it.sectTw || 0;
  let sk = (r && (r.shapeKey || r.profileShape)) || it.shapeKey || it.profileShape || '';
  const profileDesc = (r && r.profileDesc) || it.profileDesc || '';

  if ((!(H > 0) || !(T > 0) || !sk) && typeof detectFromDescription === 'function') {
    const p = detectFromDescription(profileDesc);
    if (p) {
      if (!sk && p.shape) sk = p.shape;
      if (!(H > 0) && p.H) H = p.H;
      if (!(W > 0) && p.W) W = p.W;
      if (!(T > 0) && p.T) T = p.T;
    }
  }
  if (it.pathDiamMm > 0 && it.pathDiamMm <= 40) {
    sk = 'rod';
    H = W = T = it.pathDiamMm;
  }
  if (!(H > 0)) return null;

  if (!(W > 0)) W = H * 0.35;
  if (!(T > 0)) T = Math.max(H * 0.015, 1.2);

  let outer = null;
  let inner = null;
  // CHS / pipe from profile text when shapeKey not set
  if (!sk && /CHS|CIRCULAR.?HOLLOW|PIPE/i.test(it.profileDesc || ''))
    sk = 'chs';

  if (sk === 'z_channel') outer = csPolyZ(H, W, T, Tf || T);
  else if (sk === 'c_channel') outer = csPolyC(H, W, T);
  else if (sk === 'l_angle') outer = csPolyL(H, W || H, T);
  else if (sk === 'i_beam' || sk === 'h_beam') outer = csPolyI(H, W, Tw || T, Tf || T * 1.5);
  else if (sk === 'rhs') {
    const ring = csPolyRhs(H, W || H, T);
    outer = ring.outer;
    inner = ring.inner;
  } else if (sk === 'chs') {
    const D = Math.max(H, W, it.sectD || 0, (T > 0 && T < H) ? H : 0) || H;
    const wall = (T > 0 && T < D / 2) ? T : Math.max(D * 0.05, 1);
    const ring = csPolyChs(D, wall, 32);
    outer = ring.outer;
    inner = ring.inner;
  } else if (sk === 'plate') {
    const th = (T > 0 && T <= Math.min(H || 1e9, W || 1e9))
      ? T
      : Math.min(H || T, W || T, T || H) || T;
    const b = Math.max(W || 0, H || 0, th);
    // Plate CS ⊥ length ≈ width × thickness
    outer = [[0, 0], [b, 0], [b, th], [0, th]];
  } else if (sk === 'rod' || sk === 'bent_sag_rod') {
    outer = csPolyCircle(T || H || it.sectD || 12, 32);
  } else {
    return null;
  }

  const L = Math.max(it.lengthMm || 0, 1);
  // Length axis: assume extrusion along item length (X in viewer convention)
  const length_axis = 'X';
  const is_short_plate_like = L < 3 * Math.max(H, W);

  const rec = csBuildRecord(outer, inner ? [inner] : [], {
    length_axis,
    member_length: L,
    slice_position: L / 2,
    is_tapered: false,
    is_short_plate_like,
    source: 'ifc_profile',
  });
  // Open-profile shoelace under-counts — stamp analytic steel area
  const aArea = csAnalyticProfileArea(sk, H, W || H, T, Tf || T, Tw || T);
  if (aArea > 0) rec.cs_area = aArea;
  return rec;
}

/**
 * IfcZShapeProfileDef-style Z (8 corners).
 * Overall width ≈ 2W − tw. Solid region is Z-shaped (even-odd fill).
 * NOTE: shoelace on this ring under-counts (self-overlap algebra) — use
 * csAnalyticProfileArea for cs_area on analytic profiles.
 */
function csPolyZ(H, W, T, Tf) {
  const tw = Math.max(T, 0.5);
  const tf = Math.max(Tf != null ? Tf : T, 0.5);
  const raw = [
    [0, 0],
    [W, 0],
    [W, tf],
    [tw, tf],
    [tw, H - tf],
    [tw - W, H - tf],
    [tw - W, H],
    [0, H],
  ];
  const minU = Math.min(...raw.map(p => p[0]));
  const minV = Math.min(...raw.map(p => p[1]));
  return raw.map(([u, v]) => [u - minU, v - minV]);
}

/** Steel area from section dims (mm²) — preferred over shoelace for open profiles. */
function csAnalyticProfileArea(sk, H, W, T, Tf, Tw) {
  const h = Math.max(H || 0, 0);
  const w = Math.max(W || 0, 0);
  const t = Math.max(T || 0, 0);
  const tf = Math.max(Tf || T || 0, 0);
  const tw = Math.max(Tw || T || 0, 0);
  switch (sk) {
    case 'z_channel':
    case 'c_channel':
      return Math.max(0, (h - 2 * tf) * tw + 2 * w * tf);
    case 'l_angle':
      return Math.max(0, h * t + (w - t) * t);
    case 'i_beam':
    case 'h_beam':
      return Math.max(0, 2 * w * tf + (h - 2 * tf) * tw);
    case 'rhs': {
      const outer = h * w;
      const inner = Math.max(0, h - 2 * t) * Math.max(0, w - 2 * t);
      return Math.max(0, outer - inner);
    }
    case 'chs': {
      const D = Math.max(h, w);
      const ro = D / 2, ri = Math.max(ro - t, 0);
      return Math.PI * (ro * ro - ri * ri);
    }
    case 'rod':
    case 'bent_sag_rod': {
      const r = (t || h || w) / 2;
      return Math.PI * r * r;
    }
    case 'plate':
      return Math.max(h, t) * Math.max(w, t) > 0
        ? Math.min(h || t, w || t, t || h) * Math.max(h, w)
        : 0;
    default:
      return 0;
  }
}

function csPolyC(H, W, T) {
  const t = Math.max(T, 0.5);
  return [
    [0, 0], [W, 0], [W, t], [t, t], [t, H - t], [W, H - t], [W, H], [0, H],
  ];
}

function csPolyL(H, W, T) {
  const t = Math.max(T, 0.5);
  return [
    [0, 0], [W, 0], [W, t], [t, t], [t, H], [0, H],
  ];
}

function csPolyI(H, W, Tw, Tf) {
  const tw = Math.max(Tw, 0.8);
  const tf = Math.max(Tf, tw);
  const x0 = (W - tw) / 2;
  return [
    [0, 0], [W, 0], [W, tf], [x0 + tw, tf], [x0 + tw, H - tf],
    [W, H - tf], [W, H], [0, H], [0, H - tf], [x0, H - tf], [x0, tf], [0, tf],
  ];
}

function csPolyRhs(H, W, T) {
  const t = Math.max(T, 0.5);
  const outer = [[0, 0], [W, 0], [W, H], [0, H]];
  const inner = [[t, t], [W - t, t], [W - t, H - t], [t, H - t]];
  return { outer, inner };
}

function csPolyCircle(d, n) {
  const r = d / 2;
  const N = n || 32;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push([r + r * Math.cos(a), r + r * Math.sin(a)]);
  }
  return pts;
}

/** IfcCircleHollowProfileDef — outer + inner circle. */
function csPolyChs(diameter, wallT, n) {
  const D = Math.max(diameter, 1);
  const t = Math.max(Math.min(wallT, D / 2 - 0.1), 0.5);
  const outer = csPolyCircle(D, n || 32);
  const innerD = Math.max(D - 2 * t, 0.5);
  // Same centre as outer (circle builder centres at r,r in its local frame)
  const outerR = D / 2;
  const innerR = innerD / 2;
  const cx = outerR, cy = outerR;
  const N = n || 32;
  const inner = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    inner.push([cx + innerR * Math.cos(a), cy + innerR * Math.sin(a)]);
  }
  return { outer, inner };
}

// ── BBox fallback (welded / unknown) ────────────────────────────────────────

function csExtractFromBBox(it, welded) {
  const L = Math.max(it.lengthMm || 0, 1);
  const dims = [it.lengthMm || 0, it.widthMm || 0, it.heightMm || 0].filter(v => v > 0);
  dims.sort((a, b) => b - a);
  const member_length = dims[0] || L;
  const cs_h = dims[1] || it.heightMm || 100;
  const cs_w = dims[2] || it.widthMm || 50;
  const outer = [[0, 0], [cs_w, 0], [cs_w, cs_h], [0, cs_h]];
  const is_short_plate_like = member_length < 3 * Math.max(cs_w, cs_h);
  return csBuildRecord(outer, [], {
    length_axis: 'X',
    member_length,
    slice_position: member_length / 2,
    is_tapered: false,
    is_short_plate_like,
    source: welded ? 'bbox_welded' : 'bbox_fallback',
    welded_assembly: !!welded,
  });
}

// ── Verification (Step 1 checks) ────────────────────────────────────────────

function csVerify(cs) {
  const notes = [];
  if (!cs || !cs.outer_points || cs.outer_points.length < 3) {
    return { ok: false, notes: ['invalid polygon (<3 verts)'], closed: false };
  }
  const p = cs.outer_points;
  // Open ring is treated closed if first≠last (we close implicitly in area)
  const closedDist = Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
  const closed = closedDist < 0.5 || p.length >= 3;
  if (closedDist >= 0.5 && closedDist > Math.max(cs.cs_width, cs.cs_height) * 0.02)
    notes.push('open_ring_ok'); // not an error — shoelace closes it

  if (!(cs.cs_area > 0)) notes.push('area <= 0');
  const bboxA = (cs.cs_width || 0) * (cs.cs_height || 0);
  if (bboxA > 0 && cs.cs_area > bboxA * 1.05) notes.push('area > bbox');

  if (cs.vertex_count > 100) notes.push('too many verts — needs simplify');
  if (cs.vertex_count < 3) notes.push('too few verts');

  const ok = cs.cs_area > 0 && cs.vertex_count >= 3 && cs.vertex_count <= 200
    && !(bboxA > 0 && cs.cs_area > bboxA * 1.05);
  return { ok, notes, closed };
}

/** Debug helper: SVG path string for outer polygon */
function crossSectionToSvgPath(cs, scale) {
  if (!cs?.outer_points?.length) return '';
  const s = scale || 1;
  const pts = cs.outer_points;
  let d = `M ${pts[0][0] * s} ${pts[0][1] * s}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0] * s} ${pts[i][1] * s}`;
  d += ' Z';
  return d;
}
