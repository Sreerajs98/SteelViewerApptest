/* 11-cs-orient.js — STEP 3: Best orientation (stability + stackability)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / meshPositionsMm / meshIndices / pathPoints   ║
 * ║  • NEVER modify sectH/sectW/sectT / shapeKey / lengthMm…             ║
 * ║  • NEVER rotate or rebuild any THREE mesh here (Step 4 applies)      ║
 * ║  • ONLY write: item.orientation_info / best_orientation (metadata)   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Guide: score 3 orientations (which of D1/D2/D3 is vertical):
 *   A: D1=cs_height vertical, base = D2×D3
 *   B: D2=cs_width  vertical, base = D1×D3
 *   C: D3=length    vertical, base = D1×D2  (almost always disqualified)
 *
 * Input:  crossSection (Step1) + csAnalysis (Step2)
 * Output: orientation_info + best_orientation
 */

const CSO_STABILITY_W = 0.6;
const CSO_STACK_W = 0.4;
const CSO_TIP_OVER_MAX = 2.0;
const CSO_NEST_CLEARANCE_MM = 3.0;
const CSO_DEFAULT_CONTAINER_H = 2591;

function csoWeights() {
  if (typeof cfgScoring === 'function') {
    const w = cfgScoring();
    const sw = Number(w.stability_weight);
    const tw = Number(w.stackability_weight);
    if (sw > 0 && tw > 0) {
      const s = sw + tw;
      return { stability_weight: sw / s, stackability_weight: tw / s };
    }
  }
  return { stability_weight: CSO_STABILITY_W, stackability_weight: CSO_STACK_W };
}
function csoNestClearMm() {
  if (typeof cfgNestClearanceMm === 'function') return cfgNestClearanceMm('INTERLOCK_NEST');
  return CSO_NEST_CLEARANCE_MM;
}
function csoTipOverMax() {
  if (typeof cfgTipOverThreshold === 'function') return cfgTipOverThreshold();
  return CSO_TIP_OVER_MAX;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Score A/B/C orientations; pick winner. Metadata only — no mesh mutation.
 * @returns {object|null}
 */
function findBestOrientation(it) {
  if (!it) return null;

  if (!it.crossSection && typeof extractCrossSection === 'function')
    extractCrossSection(it);
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function')
    analyzeCrossSection(it);

  const cs = it.crossSection;
  const an = it.csAnalysis;
  if (!cs) {
    it.orientation_info = null;
    it.best_orientation = null;
    return null;
  }

  const dims = csoReadDimsForScoring(it, cs, an);
  const contH = csoContainerHeightMm();
  const tipMax = csoTipOverMax();
  const candidates = csoScoreAll(dims, an, contH, tipMax);
  if (!candidates.length) {
    it.orientation_info = null;
    it.best_orientation = null;
    return null;
  }

  // Prefer qualified (stability > 0); among those, highest total_score
  const qualified = candidates.filter(c => c.stability_score > 0 && !c.disqualified);
  let pool = qualified.length ? qualified : candidates;
  let winner = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const c = pool[i];
    if (c.total_score > winner.total_score + 1e-9) { winner = c; continue; }
    if (c.total_score < winner.total_score - 1e-9) continue;
    // Tie-break: wider base, then lower CoG, then stable id order A < B < C
    if (c.base_min_width > winner.base_min_width + 0.05) winner = c;
    else if (Math.abs(c.base_min_width - winner.base_min_width) <= 0.05
        && c.center_of_gravity < winner.center_of_gravity - 1e-9)
      winner = c;
    else if (Math.abs(c.total_score - winner.total_score) <= 1e-9
        && Math.abs(c.base_min_width - winner.base_min_width) <= 0.05
        && Math.abs(c.center_of_gravity - winner.center_of_gravity) <= 1e-9
        && c.orientation_id < winner.orientation_id)
      winner = c;
  }

  const needs_manual_review = !qualified.length;
  const rotation_needed = csoRotationNeeded(winner, dims, it);

  const best_orientation = {
    orientation_id: winner.orientation_id,
    vertical_dim: winner.vertical_mm,
    base_dim_1: winner.base_a,
    base_dim_2: winner.base_b,
    stability_score: winner.stability_score,
    stackability_score: winner.stackability_score,
    total_score: winner.total_score,
    tip_over_ratio: winner.tip_over_ratio,
    nest_step_mm: winner.nest_step_mm,
    disqualified: !!winner.disqualified,
    needs_manual_review,
    rotation_needed,
  };

  const orientation_info = {
    // Guide + legacy fields
    orientation_id: winner.orientation_id,
    vert_key: winner.vert_key,           // 'H' | 'W' | 'L'
    vertical_mm: winner.vertical_mm,
    vertical_dim: winner.vertical_mm,
    base_a_mm: winner.base_a,
    base_b_mm: winner.base_b,
    base_dim_1: winner.base_a,
    base_dim_2: winner.base_b,
    base_area: winner.base_area,
    base_width: winner.base_min_width,
    base_min_width: winner.base_min_width,
    center_of_gravity: winner.center_of_gravity,
    tip_over_ratio: winner.tip_over_ratio,
    stability_score: winner.stability_score,
    stackability_score: winner.stackability_score,
    nest_step_mm: winner.nest_step_mm,
    total_score: winner.total_score,
    rotation_needed,
    needs_manual_review,
    disqualified: !!winner.disqualified,

    dims_used: { D1: dims.D1, D2: dims.D2, D3: dims.D3, H: dims.D1, W: dims.D2, L: dims.D3, T: dims.T },

    candidates: candidates.map(c => ({
      orientation_id: c.orientation_id,
      vert_key: c.vert_key,
      vertical_mm: c.vertical_mm,
      base_dim_1: c.base_a,
      base_dim_2: c.base_b,
      base_area: c.base_area,
      base_min_width: c.base_min_width,
      tip_over_ratio: c.tip_over_ratio,
      stability_score: c.stability_score,
      stackability_score: c.stackability_score,
      nest_step_mm: c.nest_step_mm,
      total_score: c.total_score,
      disqualified: !!c.disqualified,
    })),

    scoring: {
      ...csoWeights(),
      tip_over_threshold: tipMax,
      nest_clearance_mm: csoNestClearMm(),
      container_height_mm: contH,
    },

    applies_to_display: false,
    mutates_geometry: false,
  };

  if (it.packOrientation) delete it.packOrientation;
  if (it.oriented_transform) delete it.oriented_transform;

  // Z_SHAPE: Nesting Angle from polygon (flange // ground, nest axis tilted)
  if (typeof attachZNestingAngleToOrientation === 'function'
      && typeof csNzIsZShape === 'function' && csNzIsZShape(it)) {
    attachZNestingAngleToOrientation(it, orientation_info);
  }

  it.orientation_info = orientation_info;
  it.best_orientation = best_orientation;
  return orientation_info;
}

/** Run Step 3 on all items after Steps 1–2. */
function attachOrientationsToItems(items) {
  let ok = 0, fail = 0;
  const tallies = { A: 0, B: 0, C: 0 };
  (items || []).forEach(it => {
    if (it.packOrientation) delete it.packOrientation;
    if (it.oriented_transform) delete it.oriented_transform;

    const o = findBestOrientation(it);
    if (o && o.orientation_id) {
      ok++;
      tallies[o.orientation_id] = (tallies[o.orientation_id] || 0) + 1;
    } else fail++;
  });
  try {
    console.info(
      `[Step3 orient] ${ok} ok, ${fail} failed | winners A=${tallies.A} B=${tallies.B} C=${tallies.C} (metadata only)`
    );
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length, tallies };
}

// ── dims ────────────────────────────────────────────────────────────────────

/**
 * D1=cs_height, D2=cs_width, D3=member_length (guide).
 * Prefer IFC/nominal sectH×sectW over polygon bbox (Z bbox is wider than flange).
 * T kept for nest-offset estimate only — not a separate orientation axis.
 */
function csoReadDimsForScoring(it, cs, an) {
  const sectH = Number(it.sectH || 0) || 0;
  const sectW = Number(it.sectW || 0) || 0;
  let D1 = sectH > 0 ? sectH : Number(cs.cs_height || an?.cs_height || 0) || 0;
  let D2 = sectW > 0 ? sectW : Number(cs.cs_width || an?.cs_width || 0) || 0;
  let D3 = Number(cs.member_length || it.lengthMm || 0) || 0;

  if (!(D1 > 0)) D1 = Math.max(Number(it.heightMm || 0), 1);
  if (!(D2 > 0)) D2 = Math.max(Number(it.widthMm || 0), 1);
  if (!(D3 > 0)) D3 = Math.max(Number(it.lengthMm || 0), 1);

  let T = Number(it.sectT || 0) || 0;
  if (!(T > 0)) {
    const pathD = Number(it.pathDiamMm || 0);
    if (pathD > 0 && pathD <= 40) T = pathD;
  }
  if (!(T > 0) && an?.nest_sep_v_mm > 0)
    T = Math.min(an.nest_sep_v_mm, an.nest_sep_u_mm || an.nest_sep_v_mm);
  if (!(T > 0)) T = Math.max(Math.min(D1, D2) * 0.05, 1);

  return { D1, D2, D3, T, H: D1, W: D2, L: D3 };
}

function csoContainerHeightMm() {
  try {
    if (typeof rawScene !== 'undefined' && rawScene?.containerSpec?.heightMm > 0)
      return rawScene.containerSpec.heightMm;
  } catch (_) { /* */ }
  return CSO_DEFAULT_CONTAINER_H;
}

// ── scoring ─────────────────────────────────────────────────────────────────

function csoScoreAll(dims, an, contH, tipMax) {
  // A / B / C — always all three (guide: math, not assumptions)
  const list = [
    { id: 'A', key: 'H', vertical: dims.D1, baseA: dims.D2, baseB: dims.D3 },
    { id: 'B', key: 'W', vertical: dims.D2, baseA: dims.D1, baseB: dims.D3 },
    { id: 'C', key: 'L', vertical: dims.D3, baseA: dims.D1, baseB: dims.D2 },
  ];
  return list.map(k => csoScoreOne(k, an, contH, tipMax, dims));
}

function csoScoreOne(k, an, contH, tipMax, dims) {
  const vertical = Math.max(k.vertical, 1e-6);
  const baseA = Math.max(k.baseA, 1e-6);
  const baseB = Math.max(k.baseB, 1e-6);
  const base_area = baseA * baseB;
  const base_min_width = Math.min(baseA, baseB);
  const center_of_gravity = vertical / 2;
  const tip_over_ratio = center_of_gravity / Math.max(base_min_width, 1e-9);

  let stability_score = 0;
  let disqualified = false;
  if (tip_over_ratio > tipMax) {
    disqualified = true;
    stability_score = 0;
  } else {
    // Guide: base_area × base_min_width / (CoG + 1)²
    const denom = (center_of_gravity + 1) * (center_of_gravity + 1);
    stability_score = (base_area * base_min_width) / Math.max(denom, 1e-12);
  }

  const nest_step_mm = csoNestStep(k, vertical, dims, an);
  const stackability_score = Math.floor(contH / Math.max(nest_step_mm, 1e-6));
  const w = csoWeights();
  const total_score = disqualified
    ? 0
    : stability_score * w.stability_weight
      + stackability_score * w.stackability_weight;

  return {
    orientation_id: k.id,
    vert_key: k.key,
    vertical_mm: vertical,
    base_a: baseA,
    base_b: baseB,
    base_area,
    base_min_width,
    center_of_gravity,
    tip_over_ratio,
    stability_score,
    stackability_score,
    nest_step_mm,
    total_score,
    disqualified,
  };
}

/**
 * Stack pitch for this orientation.
 * INTERLOCK + nest-friendly vertical → nest offset; else full vertical (+ clearance).
 */
function csoNestStep(k, vertical, dims, an) {
  const clear = csoNestClearMm();
  const nestType = String(an?.nest_type || '').toUpperCase();
  const T = Math.max(dims.T || 0, 0.5);
  const offsetEst = csoNestOffsetEstimate(an, dims);

  if (nestType === 'INTERLOCK' || nestType === 'STACK') {
    // Guide:
    //   B (width vertical / nest stack up) → nesting_offset (~T+clear)
    //   A (height vertical) → full cs_width per layer
    //   C → member length
    if (k.id === 'B') return Math.max(offsetEst, T * 0.5);
    if (k.id === 'A') return Math.max(dims.D2, T) + clear;
    return vertical + clear;
  }

  // PARALLEL / FLAT_STACK / BUNDLE / PER_MARK / WELDED
  return vertical + (nestType === 'PARALLEL' || nestType === 'CLOSED' ? clear : 0);
}

function csoNestOffsetEstimate(an, dims) {
  const clear = csoNestClearMm();
  const T = Math.max(dims.T || 0, 0.5);
  const seps = [an?.nest_sep_u_mm, an?.nest_sep_v_mm]
    .map(Number)
    .filter(v => v > 0 && v < Math.max(dims.D1, dims.D2) * 1.5);
  if (seps.length) return Math.min(...seps);
  // Default: web/wall thickness + clearance (guide ≈ 5.5 for t=2.5)
  return T + clear;
}

/**
 * Rotation metadata from "assumed IFC CS upright = H vertical" to winner.
 * Step 4 applies; here we only record axis + angle.
 */
function csoRotationNeeded(winner, dims, it) {
  // Assume modeled with length along X, cs_height along Y (H vertical).
  if (!winner || winner.orientation_id === 'A') {
    return { axis: 'none', angle: 0, length_axis: 'X' };
  }
  if (winner.orientation_id === 'B') {
    // Swap H↔W in CS plane → 90° about length
    return { axis: 'length_axis', angle: 90, length_axis: 'X' };
  }
  // C: stand on end — 90° about Z (or Y) to raise length
  return { axis: 'Z', angle: 90, length_axis: 'X' };
}
