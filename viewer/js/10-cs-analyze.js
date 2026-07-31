/* 10-cs-analyze.js — STEP 2 only: Analyze 2D cross-section properties
 *
 * Input:  item.crossSection from Step 1 (outer_points, inner_points, dims…)
 * Output: item.csAnalysis (+ crossSection.analysis) — no mesh/shape changes
 *
 * Properties:
 *   1) open | closed | solid
 *   2) concavity_ratio (+ nest depth class)
 *   3) symmetry_180 (+ can_alternate_flip)
 *   4) nest_direction (u | v) with interlocking scores
 */

const CSA_CONCAVITY_HIGH = 0.15;
const CSA_CONCAVITY_LOW = 0.05;
const CSA_SYM_FLIP_MIN = 0.85;   // guide: ≥0.85 → 180° flip useful
const CSA_GRID_N = 28;           // occupancy grid for symmetry / overlap
const CSA_INNER_AREA_MIN = 1;    // mm² — ignore tiny noise holes
const CSA_THIN_ASPECT = 10;      // plate override: W/H or H/W > this → SOLID

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Analyze one item's Step-1 cross-section.
 * @param {object} it raw item with crossSection
 * @returns {object|null} csAnalysis
 */
function analyzeCrossSection(it) {
  if (!it) return null;

  let cs = it.crossSection;
  if (!cs || !cs.outer_points || cs.outer_points.length < 3) {
    if (typeof extractCrossSection === 'function') cs = extractCrossSection(it);
  }
  if (!cs || !cs.outer_points || cs.outer_points.length < 3) {
    it.csAnalysis = null;
    return null;
  }

  const outer = csaCopyPoly(cs.outer_points);
  const inners = (cs.inner_points || cs.inner_polygons || [])
    .map(csaCopyPoly)
    .filter(p => csaPolygonArea(p) >= CSA_INNER_AREA_MIN);

  // Prefer Step1 analytic steel area (open Z shoelace under-counts)
  const polyOuterArea = csaPolygonArea(outer);
  const innerArea = inners.reduce((s, p) => s + csaPolygonArea(p), 0);
  const steelArea = (cs.cs_area > 0)
    ? cs.cs_area
    : Math.max(0, polyOuterArea - innerArea);
  const netArea = steelArea;

  const hull = csaConvexHull(outer);
  const hullArea = Math.max(csaPolygonArea(hull), 1e-6);
  // Concavity vs hull uses steel area (guide: hull − actual)
  const concavity_area = Math.max(0, hullArea - steelArea);
  let concavity_ratio = concavity_area / hullArea;

  const bb = csaBBox(outer);
  const bboxArea = Math.max(bb.w * bb.h, 1e-6);
  const area_ratio = steelArea / bboxArea;
  const peri = csaPerimeter(outer);
  const peri_ratio = peri / Math.max(2 * (bb.w + bb.h), 1e-6);
  const aspect_raw = (bb.h > 0 && bb.w > 0) ? bb.h / bb.w : 1;
  const aspect_ratio = Math.max(aspect_raw, 1 / Math.max(aspect_raw, 1e-9));

  const welded = !!(cs.welded_like || cs.welded_assembly
    || (typeof csgIsWeldedOrTapered === 'function' && csgIsWeldedOrTapered(it)));

  // ── PROPERTY 1: open / closed / solid / welded ───────────────────────────
  let open_closed = csaClassifyOpenClosed({
    hasInner: inners.length > 0 && innerArea > CSA_INNER_AREA_MIN,
    concavity_ratio,
    area_ratio,
    welded_like: welded,
    is_tapered: !!cs.is_tapered,
  });

  // Thin plate override (guide Case 2 / Test 2.17)
  if (open_closed !== 'closed' && !welded && aspect_ratio > CSA_THIN_ASPECT) {
    open_closed = 'solid';
    concavity_ratio = Math.min(concavity_ratio, 0.02);
  }

  if (welded) open_closed = 'welded';

  // ── PROPERTY 2: concavity depth class ────────────────────────────────────
  let concavity_class = 'moderate';
  if (open_closed === 'closed' || open_closed === 'welded') concavity_class = 'n/a';
  else if (concavity_ratio > CSA_CONCAVITY_HIGH) concavity_class = 'deep';
  else if (concavity_ratio < CSA_CONCAVITY_LOW) concavity_class = 'shallow';

  const max_concavity_depth = (open_closed === 'open')
    ? csaMaxConcavityDepth(outer, hull)
    : 0;

  // ── PROPERTY 3: 180° symmetry ────────────────────────────────────────────
  const symmetry = (open_closed === 'welded')
    ? { score: 0, samples: 0 }
    : csaSymmetry180(outer, bb);
  const has_180_symmetry = symmetry.score >= CSA_SYM_FLIP_MIN;
  const can_alternate_flip = has_180_symmetry && open_closed === 'open';

  // ── PROPERTY 4: nest direction ───────────────────────────────────────────
  const nest = (open_closed === 'welded')
    ? { direction: 'u', score_u: 0, score_v: 0, sep_u: 0, sep_v: 0, used_flip: false }
    : csaNestDirection(outer, { open_closed, can_alternate_flip, bb });

  // ── PROPERTY 5: nest type (guide decision tree) ──────────────────────────
  const nestInfo = csaDecideNestType({
    open_closed,
    concavity_ratio,
    aspect_ratio,
    area_ratio,
    vertex_count: cs.vertex_count || outer.length,
    has_180_symmetry,
    nest_direction: nest.direction,
  });

  const can_interlock_nest = nestInfo.nest_type === 'INTERLOCK';
  const can_stack_nest = nestInfo.nest_type === 'STACK';
  const parallel_only = nestInfo.nest_type === 'PARALLEL'
    || nestInfo.nest_type === 'FLAT_STACK'
    || nestInfo.nest_type === 'BUNDLE'
    || nestInfo.nest_type === 'PER_MARK';

  // ── PROPERTY 4 guide: shape signature + hash ─────────────────────────────
  const signature = {
    vertex_count: (cs.vertex_count || outer.length) | 0,
    area_ratio: +area_ratio || 0,
    perimeter_ratio: +peri_ratio || 0,
    concavity_ratio: open_closed === 'closed' || open_closed === 'welded'
      ? 0 : (+concavity_ratio || 0),
    symmetry_score: +symmetry.score || 0,
    aspect_ratio: +aspect_ratio || 1,
  };
  const signature_hash = csaSignatureHash(signature);

  const analysis = {
    // Guide names (uppercase) + legacy lowercase
    profile_type: String(open_closed).toUpperCase(), // OPEN|CLOSED|SOLID|WELDED
    open_closed,                 // 'open' | 'closed' | 'solid' | 'welded'
    has_inner_void: inners.length > 0,
    inner_count: inners.length,
    inner_area: innerArea,
    net_area: netArea,

    concavity_ratio: signature.concavity_ratio,
    concavity_area,
    hull_area: hullArea,
    convex_hull_area: hullArea,
    concavity_class,
    max_concavity_depth,
    area_ratio,
    perimeter_ratio: peri_ratio,
    aspect_ratio,

    symmetry_180: symmetry.score,
    symmetry_score: symmetry.score,
    has_180_symmetry,
    can_alternate_flip,
    can_flip: nestInfo.can_flip,

    nest_direction: nestInfo.nest_direction || nest.direction,
    nest_direction_uv: nest.direction,
    nest_score_u: nest.score_u,
    nest_score_v: nest.score_v,
    nest_sep_u_mm: nest.sep_u,
    nest_sep_v_mm: nest.sep_v,
    nest_uses_flip: nest.used_flip,

    can_nest: nestInfo.can_nest,
    nest_type: nestInfo.nest_type,
    can_interlock_nest,
    can_stack_nest,
    parallel_only,

    signature,
    signature_hash,

    cs_width: cs.cs_width || bb.w,
    cs_height: cs.cs_height || bb.h,
    member_length: cs.member_length,
    length_axis: cs.length_axis,
    vertex_count: signature.vertex_count,
    source_cs: cs.source,
  };

  it.csAnalysis = analysis;
  cs.analysis = analysis;
  return analysis;
}

/** Run Step 2 on all items (after Step 1). */
function attachCsAnalysisToItems(items) {
  let ok = 0, fail = 0;
  const tallies = { open: 0, closed: 0, solid: 0, welded: 0 };
  (items || []).forEach(it => {
    const a = analyzeCrossSection(it);
    if (a && a.open_closed) {
      ok++;
      tallies[a.open_closed] = (tallies[a.open_closed] || 0) + 1;
    } else fail++;
  });
  try {
    console.info(
      `[Step2 cs-analyze] ${ok} ok, ${fail} failed | open=${tallies.open} closed=${tallies.closed}`
      + ` solid=${tallies.solid} welded=${tallies.welded}`
    );
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length, tallies };
}

// ── Property 1 logic ────────────────────────────────────────────────────────

/**
 * CLOSED: hollow (outer + meaningful inner)
 * OPEN:   concave channel — can potentially interlock (Z/C/L-like)
 * SOLID:  nearly convex, no void (plate, round bar, filled rect)
 *
 * Welded/tapered bbox rects → solid (packing uses mark rules later).
 */
function csaClassifyOpenClosed({ hasInner, concavity_ratio, area_ratio, welded_like, is_tapered }) {
  if (hasInner) return 'closed';
  // Welded handled by caller → 'welded'; leave solid hint for bbox
  if (welded_like && concavity_ratio < CSA_CONCAVITY_LOW) return 'solid';

  if (concavity_ratio > CSA_CONCAVITY_LOW && area_ratio < 0.88)
    return 'open';
  if (concavity_ratio < CSA_CONCAVITY_LOW) return 'solid';
  if (concavity_ratio >= CSA_CONCAVITY_LOW) return 'open';
  return 'solid';
}

/**
 * Guide Property 5 — nest type from open/closed/solid + concavity + aspect.
 */
function csaDecideNestType(p) {
  const {
    open_closed, concavity_ratio, aspect_ratio, area_ratio,
    vertex_count, has_180_symmetry, nest_direction,
  } = p;

  if (open_closed === 'welded') {
    return {
      can_nest: false,
      nest_type: 'PER_MARK',
      can_flip: false,
      nest_direction: 'Y',
    };
  }
  if (open_closed === 'closed') {
    return {
      can_nest: false,
      nest_type: 'PARALLEL',
      can_flip: false,
      nest_direction: 'X',
    };
  }
  if (open_closed === 'solid') {
    // Round bar: circle fill ≈ π/4, aspect ≈ 1, many verts
    const roundish = area_ratio > 0.65 && area_ratio < 0.92
      && aspect_ratio < 1.35 && (vertex_count || 0) >= 16;
    if (roundish) {
      return {
        can_nest: false,
        nest_type: 'BUNDLE',
        can_flip: false,
        nest_direction: 'X',
      };
    }
    return {
      can_nest: false,
      nest_type: 'FLAT_STACK',
      can_flip: false,
      nest_direction: 'Y',
    };
  }
  // OPEN
  if (concavity_ratio > CSA_CONCAVITY_HIGH) {
    return {
      can_nest: true,
      nest_type: 'INTERLOCK',
      can_flip: !!has_180_symmetry,
      nest_direction: nest_direction === 'u' ? 'X' : 'Y',
    };
  }
  return {
    can_nest: true,
    nest_type: 'STACK',
    can_flip: false,
    nest_direction: nest_direction === 'u' ? 'X' : 'Y',
  };
}

function csaSignatureHash(sig) {
  const q = (v, d) => {
    const x = Number(v) || 0;
    const m = Math.pow(10, d);
    return (Math.round(x * m) / m).toFixed(d);
  };
  return [
    sig.vertex_count | 0,
    q(sig.area_ratio, 2),
    q(sig.perimeter_ratio, 2),
    q(sig.concavity_ratio, 2),
    q(sig.symmetry_score, 1),
    q(sig.aspect_ratio, 1),
  ].join('|');
}

/** Guide match: two signatures = same shape type (dims handled later). */
function signaturesMatch(a, b) {
  if (!a || !b) return false;
  if ((a.vertex_count | 0) !== (b.vertex_count | 0)) return false;
  if (Math.abs((a.area_ratio || 0) - (b.area_ratio || 0)) > 0.05) return false;
  if (Math.abs((a.perimeter_ratio || 0) - (b.perimeter_ratio || 0)) > 0.05) return false;
  if (Math.abs((a.concavity_ratio || 0) - (b.concavity_ratio || 0)) > 0.05) return false;
  if (Math.abs((a.symmetry_score || 0) - (b.symmetry_score || 0)) > 0.1) return false;
  if (Math.abs((a.aspect_ratio || 0) - (b.aspect_ratio || 0)) > 0.1) return false;
  return true;
}

/**
 * Max gap depth (mm): how far the shape sits inside its convex hull.
 * Samples along each hull edge; distance into the hull until steel (poly) is hit.
 * For Z/C this ≈ flange width (slide-in depth for interlocking).
 */
function csaMaxConcavityDepth(poly, hull) {
  if (!poly || !hull || hull.length < 2) return 0;
  let maxD = 0;
  // Vertex-to-hull-edge (guide baseline)
  poly.forEach(pt => {
    let minD = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const d = csaDistPointSeg(pt[0], pt[1], a[0], a[1], b[0], b[1]);
      if (d < minD) minD = d;
    }
    if (minD > maxD) maxD = minD;
  });
  // Ray inward from hull-edge midpoints → first hit on polygon boundary
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5;
    let dx = cx - mx, dy = cy - my;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // March inward up to bbox diagonal
    const maxMarch = Math.hypot(
      Math.max(...poly.map(p => p[0])) - Math.min(...poly.map(p => p[0])),
      Math.max(...poly.map(p => p[1])) - Math.min(...poly.map(p => p[1]))
    ) + 1;
    let hit = 0;
    const step = Math.max(0.5, maxMarch / 200);
    for (let t = step; t < maxMarch; t += step) {
      if (csaPointInPoly(mx + dx * t, my + dy * t, poly)) {
        hit = t;
        break;
      }
    }
    if (hit > maxD) maxD = hit;
  }
  return maxD;
}

function csaDistPointSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1e-12;
  let t = ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// ── Property 3: symmetry ────────────────────────────────────────────────────

function csaSymmetry180(poly, bb) {
  const cx = bb.cx, cy = bb.cy;
  // Half-extent normalize so polygon fits in ~[-1,1] (full-span /s left y outside grid)
  const s = Math.max(bb.w, bb.h, 1e-6) * 0.5;
  const norm = poly.map(([x, y]) => [(x - cx) / s, (y - cy) / s]);
  const flipped = norm.map(([x, y]) => [-x, -y]);

  const N = CSA_GRID_N;
  let agree = 0, either = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = -1 + 2 * (i + 0.5) / N;
      const v = -1 + 2 * (j + 0.5) / N;
      const a = csaPointInPoly(u, v, norm);
      const b = csaPointInPoly(u, v, flipped);
      if (a || b) {
        either++;
        if (a === b) agree++;
      }
    }
  }
  let score = either > 0 ? agree / either : 0;

  // Guide fallback: nearest-vertex distance after 180° (robust when fill is thin)
  const size = Math.max(bb.w, bb.h, 1e-6);
  let distSum = 0;
  poly.forEach(([x, y]) => {
    const rx = 2 * cx - x, ry = 2 * cy - y;
    let best = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const d = Math.hypot(poly[k][0] - rx, poly[k][1] - ry);
      if (d < best) best = d;
    }
    distSum += best;
  });
  const vertScore = Math.max(0, Math.min(1, 1 - (distSum / poly.length) / size));
  // Prefer the better of fill-grid vs vertex match
  if (vertScore > score) score = vertScore;

  return { score, samples: either, vertScore };
}

// ── Property 4: nest direction ──────────────────────────────────────────────

/**
 * Interlocking quality when sliding a second copy along +U or +V.
 * Higher score = can sit closer / more overlap of hulls with less solid overlap
 * = better nest direction.
 *
 * Score ≈ (bbox_span - min_separation_no_overlap) / bbox_span
 * Clamped to [0,1]. Optional 180° flip of copy when alternate-flip allowed.
 */
function csaNestDirection(poly, { open_closed, can_alternate_flip, bb }) {
  const variants = [poly];
  if (can_alternate_flip) {
    variants.push(csaRotate180About(poly, bb.cx, bb.cy));
  }

  let bestU = { score: -1, sep: Infinity, flip: false };
  let bestV = { score: -1, sep: Infinity, flip: false };

  variants.forEach((other, vi) => {
    const flip = vi > 0;
    const sepU = csaMinSeparation(poly, other, 1, 0, bb.w * 1.5);
    const sepV = csaMinSeparation(poly, other, 0, 1, bb.h * 1.5);
    const scoreU = csaNestScore(sepU, bb.w);
    const scoreV = csaNestScore(sepV, bb.h);
    if (scoreU > bestU.score || (scoreU === bestU.score && sepU < bestU.sep))
      bestU = { score: scoreU, sep: sepU, flip };
    if (scoreV > bestV.score || (scoreV === bestV.score && sepV < bestV.sep))
      bestV = { score: scoreV, sep: sepV, flip };
  });

  // Closed / solid: interlocking scores usually low — still report better axis
  // (used later for parallel bundle row direction)
  let direction = 'u';
  let used_flip = bestU.flip;
  if (bestV.score > bestU.score + 0.02) {
    direction = 'v';
    used_flip = bestV.flip;
  } else if (Math.abs(bestV.score - bestU.score) <= 0.02) {
    // Tie → prefer the axis with smaller absolute separation (tighter pack)
    if (bestV.sep < bestU.sep) {
      direction = 'v';
      used_flip = bestV.flip;
    }
  }

  // Open profiles with almost no interlocking either way → keep best but mark weak
  return {
    direction,
    score_u: bestU.score,
    score_v: bestV.score,
    sep_u: bestU.sep,
    sep_v: bestV.sep,
    used_flip,
  };
}

function csaNestScore(sep, span) {
  if (!(span > 0)) return 0;
  // sep ≈ 0 → fully overlapping start (bad physically but means deep nest potential
  // after clearance). sep ≈ span → just touching side-by-side (weak nest).
  // We want SMALL sep relative to span for interlocking channels.
  const t = 1 - Math.min(Math.max(sep / span, 0), 1);
  return t;
}

/**
 * Binary search: minimum translation of `moving` along (dirU, dirV) with
 * essentially zero solid overlap vs `fixed`.
 */
function csaMinSeparation(fixed, moving, dirU, dirV, maxSlide) {
  const maxS = Math.max(maxSlide, 1);
  // If already separated at 0 with no overlap, return 0
  if (csaOverlapFraction(fixed, moving) < 0.02) return 0;

  let lo = 0, hi = maxS;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2;
    const shifted = csaTranslate(moving, dirU * mid, dirV * mid);
    if (csaOverlapFraction(fixed, shifted) > 0.02) lo = mid;
    else hi = mid;
  }
  return hi;
}

function csaOverlapFraction(a, b) {
  const all = a.concat(b);
  const bb = csaBBox(all);
  if (bb.w < 1e-6 || bb.h < 1e-6) return 0;
  const N = CSA_GRID_N;
  let both = 0, either = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = bb.minU + (i + 0.5) * bb.w / N;
      const v = bb.minV + (j + 0.5) * bb.h / N;
      const inA = csaPointInPoly(u, v, a);
      const inB = csaPointInPoly(u, v, b);
      if (inA || inB) either++;
      if (inA && inB) both++;
    }
  }
  return either > 0 ? both / either : 0;
}

// ── geometry helpers ────────────────────────────────────────────────────────

function csaCopyPoly(p) {
  return (p || []).map(pt => [Number(pt[0]) || 0, Number(pt[1]) || 0]);
}

function csaPolygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) * 0.5;
}

function csaPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

function csaBBox(pts) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  pts.forEach(([u, v]) => {
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  });
  return {
    minU, maxU, minV, maxV,
    w: maxU - minU,
    h: maxV - minV,
    cx: (minU + maxU) / 2,
    cy: (minV + maxV) / 2,
  };
}

function csaTranslate(poly, du, dv) {
  return poly.map(([u, v]) => [u + du, v + dv]);
}

function csaRotate180About(poly, cx, cy) {
  return poly.map(([u, v]) => [cx - (u - cx), cy - (v - cy)]);
}

function csaPointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi))
      inside = !inside;
  }
  return inside;
}

function csaConvexHull(pts) {
  if (!pts || pts.length <= 2) return (pts || []).map(p => p.slice());
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
