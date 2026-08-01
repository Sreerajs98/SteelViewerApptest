/* 14-cs-nest-offset.js — STEP 7: Nesting Offset Calculation (auto)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / meshPositionsMm / meshIndices / pathPoints   ║
 * ║  • NEVER modify sectH/sectW/sectT / shapeKey / lengthMm / profile     ║
 * ║  • NEVER rebuild ExtrudeGeometry / morph cross-section               ║
 * ║  • ONLY write: item.nestingInfo  (offset + placement metadata)       ║
 * ║  • Render/packing may use offset for POSITION / envelope only        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Guide (ALL from geometry — no profile-name hardcode):
 *   INTERLOCK:  polygon slide → min non-overlap gap + 3mm clearance
 *   PARALLEL:   item_width + 5mm clearance
 *   FLAT STACK: item_thickness (NO clearance)
 *   STACK:      thickness + 3mm
 *   HEX:        d+clear, (d+clear)×cos30°
 *   PER_MARK:   height + 3mm (dunnage)
 *
 * Alternate 180° flip ONLY when Step6 alternate_flip is true (symmetric).
 */

const CSOFF_CLEARANCE_MM = 3.0;           // INTERLOCK / STACK nest clearance
const CSOFF_PARALLEL_CLEARANCE_MM = 2.5;  // PARALLEL guide
const CSOFF_OVERLAP_EPS = 0.02;

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Calculate nesting offset + placement metadata for one item.
 * Geometry / meshes are never mutated.
 * @returns {object|null}
 */
function calculateNestingOffset(it) {
  if (!it) return null;

  if (!it.crossSection && typeof extractCrossSection === 'function')
    extractCrossSection(it);
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function')
    analyzeCrossSection(it);
  if (!it.nestMethod && typeof decideNestMethod === 'function')
    decideNestMethod(it);

  const nm = it.nestMethod;
  const method = nm?.method || 'PARALLEL_BUNDLE';
  const an = it.csAnalysis || null;
  const cs = it.crossSection || null;
  // Guide clearances: PARALLEL 5mm, others 3mm (FLAT = 0)
  const clear = csoffClearanceForMethod(method);

  const dims = csoffReadDims(it, cs, an);
  const nestDir2d = an?.nest_direction === 'v' ? 'v' : 'u'; // CS plane axis used for slide

  let nesting_offset = 0;
  let nesting_offset_x = 0;
  let nesting_offset_y = 0;
  let alternate_flip = !!(nm && nm.alternate_flip);
  let stack_axis = 'y'; // world-up for gravity nest
  let place_mode = 'stack_up';
  let slide_mm = null;
  let gap_mm = null; // min non-overlap before clearance (INTERLOCK)
  let source = 'formula';

  switch (method) {
    case 'INTERLOCK_NEST': {
      // Flip ONLY when Step6 says so — offset math must match placement flip
      alternate_flip = !!(nm && nm.alternate_flip);
      const slide = csoffInterlockSlide(cs, an, alternate_flip, nestDir2d, dims);
      gap_mm = Math.max(slide.distance, 0);
      slide_mm = gap_mm;
      nesting_offset = gap_mm + clear; // guide: gap + 3mm
      stack_axis = 'y';
      place_mode = 'collision_interlock';
      source = slide.source === 'polygon_slide' ? 'collision_fit' : slide.source;
      break;
    }
    case 'STACK_NEST': {
      nesting_offset = Math.max(dims.t, 0.5) + clear;
      stack_axis = 'y';
      place_mode = 'stack_up';
      source = 'thickness_plus_clearance';
      break;
    }
    case 'PARALLEL_BUNDLE': {
      // Guide: offset = item_width + 5mm
      const wNest = nestDir2d === 'v' ? dims.h : dims.w;
      nesting_offset = Math.max(wNest, 1) + clear;
      stack_axis = 'horizontal';
      place_mode = 'side_by_side';
      source = 'width_plus_clearance';
      break;
    }
    case 'FLAT_STACK': {
      // Guide: offset = thickness, NO clearance
      nesting_offset = Math.max(dims.t, 0.5);
      stack_axis = 'y';
      place_mode = 'stack_up';
      source = 'thickness_no_clearance';
      break;
    }
    case 'HEX_BUNDLE': {
      const d = Math.max(dims.min, dims.t, 1);
      nesting_offset_x = d + clear;
      nesting_offset_y = (d + clear) * Math.cos(Math.PI / 6); // cos30°
      nesting_offset = nesting_offset_x; // primary
      stack_axis = 'hex';
      place_mode = 'hex';
      source = 'hex_diameter';
      break;
    }
    case 'PER_MARK_STACK': {
      const tapered = !!(cs?.is_tapered || it.taperProfile?.non_uniform);
      nesting_offset = Math.max(dims.h, dims.w, 1) + clear;
      stack_axis = 'y';
      place_mode = tapered ? 'station_clearance' : 'stack_up';
      source = tapered ? 'taper_station_ceiling' : 'per_mark_dunnage';
      break;
    }
    default: {
      nesting_offset = Math.max(dims.w, dims.h, 1) + clear;
      stack_axis = 'horizontal';
      place_mode = 'side_by_side';
      source = 'fallback_parallel';
    }
  }

  // Never-zero rule — but FLAT must NOT gain clearance (guide)
  if (method === 'FLAT_STACK') {
    nesting_offset = Math.max(+nesting_offset || 0, 0.5);
  } else if (typeof cfgEnsureNestOffset === 'function') {
    nesting_offset = cfgEnsureNestOffset(nesting_offset, method);
    if (nesting_offset_x > 0)
      nesting_offset_x = cfgEnsureNestOffset(nesting_offset_x, method);
    if (nesting_offset_y > 0)
      nesting_offset_y = Math.max(nesting_offset_y, clear * Math.cos(Math.PI / 6));
  } else {
    nesting_offset = Math.max(+nesting_offset || 0, clear, 0.5);
  }

  const nestingInfo = {
    method,
    nesting_offset: +nesting_offset || 0,
    nesting_offset_x: +nesting_offset_x || 0,
    nesting_offset_y: +nesting_offset_y || 0,
    clearance_mm: method === 'FLAT_STACK' ? 0 : clear,
    gap_mm: gap_mm != null ? +gap_mm : null,
    alternate_flip,
    nest_direction_2d: nestDir2d,   // u|v in CS (slide axis for interlock math)
    stack_axis,                     // y | horizontal | hex | tilted
    place_mode,                     // collision_interlock | stack_up | side_by_side | hex
    fit_mode: method === 'INTERLOCK_NEST'
      ? 'collision_interlock'
      : (place_mode === 'station_clearance' ? 'station_clearance' : 'formula'),
    slide_mm,
    source,
    dims_used: { ...dims },
    gravity: true,
    no_float: true,
    applies_to_display: false,
    mutates_geometry: false,
  };

  // OPEN+concave: offset along tilted nest axis (leveled web), not pure AABB
  if ((typeof requiresLiveRotateSearch === 'function'
        ? requiresLiveRotateSearch(it)
        : (typeof csNzIsZShape === 'function' && csNzIsZShape(it)))
      && (method === 'INTERLOCK_NEST' || method === 'STACK_NEST')) {
    if (typeof attachZNestingAngleToOrientation === 'function')
      attachZNestingAngleToOrientation(it, it.orientation_info);
    const zNest = it.orientation_info?.z_nesting || null;
    const axis = Number(
      zNest?.nest_axis_angle_rad
      ?? it.orientation_info?.nest_axis_angle_rad
      ?? 0
    ) || 0;
    const off = +nestingInfo.nesting_offset || 0;
    // World YZ: dy = off·cos(axis), dz = off·sin(axis)  (axis from +Y toward +Z)
    nestingInfo.nest_axis_angle_rad = axis;
    nestingInfo.nest_axis_angle_deg = +((axis * 180) / Math.PI).toFixed(4);
    nestingInfo.nesting_offset_y = off * Math.cos(axis);
    nestingInfo.nesting_offset_z = off * Math.sin(axis);
    nestingInfo.use_tilted_nest_axis = true;
    nestingInfo.stack_axis = 'tilted';
    nestingInfo.nesting_angle_rad = Number(zNest?.nesting_angle_rad) || 0;
    nestingInfo.nesting_angle_deg = Number(zNest?.nesting_angle_deg) || 0;
    nestingInfo.profile_type = 'Z_SHAPE';
  }

  it.nestingInfo = nestingInfo;
  // Convenience alias used by older bundle/packing code paths
  it.nestingOffsetMm = nestingInfo.nesting_offset;
  return nestingInfo;
}

/** Stamp nestingInfo on all items (after Step 6 nest method). */
function attachNestingOffsetsToItems(items) {
  const tallies = {};
  let ok = 0, fail = 0;
  (items || []).forEach(it => {
    const n = calculateNestingOffset(it);
    if (n && n.nesting_offset >= 0) {
      ok++;
      const k = n.method || '?';
      tallies[k] = (tallies[k] || 0) + 1;
    } else fail++;
  });
  try {
    const parts = Object.keys(tallies).map(k => `${k}=${tallies[k]}`).join(' ');
    console.info(
      `[Step7 nest-offset] ${ok} ok, ${fail} failed | ${parts} (metadata only — shapes unchanged)`
    );
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length, tallies };
}

/** Guide clearance for method (PARALLEL 5, else 3; FLAT 0). */
function csoffClearanceForMethod(method) {
  if (method === 'FLAT_STACK') return 0;
  if (typeof cfgNestClearanceMm === 'function')
    return cfgNestClearanceMm(method);
  if (method === 'PARALLEL_BUNDLE') return CSOFF_PARALLEL_CLEARANCE_MM;
  return CSOFF_CLEARANCE_MM;
}

/**
 * Verify N interlock placements have no polygon dig-in (overlap ≤ eps).
 * Metadata / math only — never mutates geometry.
 * @returns {{ ok, max_overlap, pairs: Array }}
 */
function verifyNestNoOverlap(it, count) {
  const n = Math.max(2, count | 0);
  if (!it?.crossSection?.outer_points
      || typeof csaOverlapFraction !== 'function') {
    return { ok: true, max_overlap: 0, pairs: [], skipped: true };
  }
  const info = it.nestingInfo || calculateNestingOffset(it);
  const dir = info?.nest_direction_2d || 'u';
  const clear = info?.clearance_mm != null ? info.clearance_mm : CSOFF_CLEARANCE_MM;
  const allowFlip = !!info?.alternate_flip;
  const pack = computeInterlockNestPlacements(
    it.crossSection, n, dir, clear, allowFlip
  );
  const outer = it.crossSection.outer_points;
  const base = csaCopyPoly(outer);
  const bb0 = csaBBox(base);
  const cx = bb0.cx, cy = bb0.cy;
  const du = dir === 'u' ? 1 : 0;
  const dv = dir === 'v' ? 1 : 0;

  function polyAt(flip, slide) {
    let p = flip ? csaRotate180About(base, cx, cy) : csaCopyPoly(base);
    if (slide) p = csaTranslate(p, du * slide, dv * slide);
    return p;
  }

  let max_overlap = 0;
  const pairs = [];
  for (let i = 1; i < pack.placements.length; i++) {
    const a = pack.placements[i - 1];
    const b = pack.placements[i];
    const ov = csaOverlapFraction(
      polyAt(!!a.flip, a.slide_mm || 0),
      polyAt(!!b.flip, b.slide_mm || 0)
    );
    if (ov > max_overlap) max_overlap = ov;
    pairs.push({ i: i - 1, j: i, overlap: ov, ok: ov <= CSOFF_OVERLAP_EPS });
  }
  return {
    ok: max_overlap <= CSOFF_OVERLAP_EPS,
    max_overlap,
    pairs,
    bundle_span_mm: pack.bundle_span_mm,
    source: pack.source,
  };
}

/**
 * Local pose of piece i in a nest (relative to base at origin, Y-up).
 * Rigid transform only — never changes piece geometry.
 */
function nestPlacementForIndex(i, nestingInfo, itemDims) {
  const info = nestingInfo || {};
  const method = info.method || 'PARALLEL_BUNDLE';
  const off = Math.max(Number(info.nesting_offset) || 0, 0);
  const idx = Math.max(0, i | 0);
  const flip = !!(info.alternate_flip && method === 'INTERLOCK_NEST' && (idx % 2 === 1));

  let x = 0, y = 0, z = 0;
  let rotY = 0; // radians about length / up as needed by caller

  if (method === 'PARALLEL_BUNDLE') {
    x = idx * off;
    y = 0;
    z = 0;
  } else if (method === 'HEX_BUNDLE') {
    const ox = Math.max(Number(info.nesting_offset_x) || off, 0);
    const oy = Math.max(Number(info.nesting_offset_y) || off * Math.cos(Math.PI / 6), 0);
    // row-major hex: caller may remap; provide linear index → rough row/col
    const cols = Math.max(1, Math.ceil(Math.sqrt(idx + 1)));
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    x = col * ox + (row % 2) * (ox * 0.5);
    y = row * oy;
    z = 0;
  } else {
    // INTERLOCK / STACK / FLAT / PER_MARK — stack UP (or tilted for Z)
    x = 0;
    if (info.use_tilted_nest_axis) {
      const axis = Number(info.nest_axis_angle_rad) || 0;
      const oy = Number(info.nesting_offset_y);
      const oz = Number(info.nesting_offset_z);
      const dy = (oy > 0 || oz > 0) ? oy : off * Math.cos(axis);
      const dz = (oy > 0 || oz > 0) ? oz : off * Math.sin(axis);
      y = idx * dy;
      z = idx * dz;
    } else {
      y = idx * off;
      z = 0;
    }
  }

  if (flip) rotY = Math.PI; // 180° — apply about length axis in renderer

  return {
    index: idx,
    x, y, z,
    rotation_rad: flip ? Math.PI : 0,
    alternate_flip: flip,
    rests_on_below: idx === 0 || method !== 'PARALLEL_BUNDLE',
  };
}

/**
 * Bundle AABB from nest formula (mm). Does not touch meshes.
 * itemDims: { length, width, height, thickness? }
 */
function computeNestBundleBounds(n, nestingInfo, itemDims) {
  const N = Math.max(1, n | 0);
  const info = nestingInfo || {};
  const method = info.method || 'PARALLEL_BUNDLE';
  const off = Math.max(Number(info.nesting_offset) || 0, 0);
  const L = Math.max(Number(itemDims?.length) || 0, 1);
  const W = Math.max(Number(itemDims?.width) || 0, 1);
  const H = Math.max(Number(itemDims?.height) || 0, 1);
  const T = Math.max(Number(itemDims?.thickness) || info.dims_used?.t || Math.min(W, H), 0.5);

  if (method === 'PARALLEL_BUNDLE') {
    return {
      bundle_length: L,
      bundle_width: W + (N - 1) * off,
      bundle_height: H,
    };
  }
  if (method === 'FLAT_STACK') {
    return {
      bundle_length: L,
      bundle_width: W,
      bundle_height: N * (off > 0 ? off : T),
    };
  }
  if (method === 'HEX_BUNDLE') {
    const ox = Math.max(Number(info.nesting_offset_x) || off, T);
    const oy = Math.max(Number(info.nesting_offset_y) || ox * Math.cos(Math.PI / 6), T);
    const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
    const rows = Math.max(1, Math.ceil(N / cols));
    return {
      bundle_length: L,
      bundle_width: cols * ox,
      bundle_height: Math.max(H, rows * oy),
    };
  }
  // INTERLOCK / STACK / PER_MARK — stack up (or tilted for Z)
  if (info.use_tilted_nest_axis) {
    const axis = Number(info.nest_axis_angle_rad) || 0;
    const oy = Number(info.nesting_offset_y);
    const oz = Number(info.nesting_offset_z);
    const dy = (Math.abs(oy) > 0 || Math.abs(oz) > 0) ? oy : off * Math.cos(axis);
    const dz = (Math.abs(oy) > 0 || Math.abs(oz) > 0) ? oz : off * Math.sin(axis);
    return {
      bundle_length: L,
      bundle_width: W + Math.max(0, N - 1) * Math.abs(dz),
      bundle_height: H + Math.max(0, N - 1) * Math.abs(dy),
    };
  }
  return {
    bundle_length: L,
    bundle_width: W,
    bundle_height: H + (N - 1) * off,
  };
}

/** Resolve nestingInfo from a staging group / pack unit. */
function resolveNestingInfo(g) {
  if (!g) return null;
  if (g.nestingInfo && g.nestingInfo.nesting_offset >= 0) return g.nestingInfo;
  const pcs = g.memberPieces || g.nestPieces || [];
  for (const p of pcs) {
    if (p?.nestingInfo) return p.nestingInfo;
  }
  if (g.nestingOffsetMm > 0) {
    return {
      method: g.nestMethod?.method || 'STACK_NEST',
      nesting_offset: g.nestingOffsetMm,
      alternate_flip: !!g.nestMethod?.alternate_flip,
      stack_axis: 'y',
      place_mode: 'stack_up',
    };
  }
  return null;
}

// ── INTERLOCK: collision-based sequential fit ───────────────────────────────

const CSOFF_FIT_STEP_MM = 0.1;

/**
 * True geometry interlocking placements for N open-profile pieces.
 * - If allowFlip: even i → 0°, odd i → 180° (planar about CS centroid)
 * - Else: all same orientation (L-angle / non-symmetric)
 * - Piece i starts fully overlapping piece i-1, then slides 0.1mm steps
 *   along nest_direction until polygon overlap ≈ 0, then + CLEARANCE.
 * NEVER mutates item meshes / section dims — returns metadata only.
 *
 * @returns {{ placements: Array, bundle_span_mm: number, nest_direction_2d: string }}
 */
function computeInterlockNestPlacements(cs, count, nestDir2d, clearanceMm, allowFlip) {
  const n = Math.max(1, count | 0);
  const clear = clearanceMm != null ? clearanceMm : CSOFF_CLEARANCE_MM;
  const dir = nestDir2d === 'v' ? 'v' : 'u';
  const doFlip = !!allowFlip;
  const outer = cs?.outer_points;

  if (!outer || outer.length < 3
      || typeof csaMinSeparation !== 'function'
      || typeof csaOverlapFraction !== 'function') {
    // Fallback: thickness-ish equal steps
    const t = Math.max(clear + 1, 2);
    const placements = [];
    for (let i = 0; i < n; i++) {
      placements.push({
        index: i,
        slide_mm: i * t,
        flip: doFlip && (i % 2) === 1,
        min_along: i * t,
        max_along: i * t + t,
      });
    }
    return {
      placements,
      bundle_span_mm: (n - 1) * t + t,
      nest_direction_2d: dir,
      source: 'fallback_equal_step',
      alternate_flip: doFlip,
    };
  }

  const base = csaCopyPoly(outer);
  const bb0 = csaBBox(base);
  const cx = bb0.cx, cy = bb0.cy;
  const du = dir === 'u' ? 1 : 0;
  const dv = dir === 'v' ? 1 : 0;
  const span = Math.max(dir === 'u' ? bb0.w : bb0.h, 10);
  const maxExtra = span * 1.6;

  function polyAt(flip, slide) {
    let p = flip
      ? csaRotate180About(base, cx, cy)
      : csaCopyPoly(base);
    if (slide) p = csaTranslate(p, du * slide, dv * slide);
    return p;
  }

  function extentAlong(poly) {
    let lo = Infinity, hi = -Infinity;
    for (const pt of poly) {
      const a = du ? pt[0] : pt[1];
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    return { min: lo, max: hi };
  }

  const placements = [];
  let prevPoly = polyAt(false, 0);
  let prevSlide = 0;
  {
    const e0 = extentAlong(prevPoly);
    placements.push({
      index: 0,
      slide_mm: 0,
      flip: false,
      min_along: e0.min,
      max_along: e0.max,
      step_from_prev_mm: 0,
    });
  }

  for (let i = 1; i < n; i++) {
    const flip = doFlip && (i % 2) === 1;
    // Start fully overlapping previous (same slide), then walk out 0.1mm
    let slide = prevSlide;
    const limit = prevSlide + maxExtra;
    let found = false;

    while (slide <= limit) {
      const moved = polyAt(flip, slide);
      if (csaOverlapFraction(prevPoly, moved) <= CSOFF_OVERLAP_EPS) {
        found = true;
        break;
      }
      slide += CSOFF_FIT_STEP_MM;
    }
    if (!found) {
      const moving0 = flip ? csaRotate180About(base, cx, cy) : csaCopyPoly(base);
      const rel = csaMinSeparation(
        prevPoly,
        csaTranslate(moving0, du * prevSlide, dv * prevSlide),
        du, dv, maxExtra
      );
      slide = prevSlide + Math.max(rel, CSOFF_FIT_STEP_MM);
    }

    // Clearance beyond first non-overlap contact
    slide += clear;

    // No floating: if a large gap opened past previous max, pull back to contact+clearance
    let finalPoly = polyAt(flip, slide);
    const ePrev = extentAlong(prevPoly);
    let eCur = extentAlong(finalPoly);
    const gap = eCur.min - ePrev.max;
    if (gap > clear + 0.5) {
      slide -= (gap - clear);
      finalPoly = polyAt(flip, slide);
      eCur = extentAlong(finalPoly);
    }

    placements.push({
      index: i,
      slide_mm: slide,
      flip,
      min_along: eCur.min,
      max_along: eCur.max,
      step_from_prev_mm: slide - prevSlide,
    });
    prevPoly = finalPoly;
    prevSlide = slide;
  }

  const mins = placements.map(p => p.min_along);
  const maxs = placements.map(p => p.max_along);
  const bundle_span_mm = Math.max(...maxs) - Math.min(...mins);

  return {
    placements,
    bundle_span_mm,
    nest_direction_2d: dir,
    source: 'collision_fit_0.1mm',
    alternate_flip: doFlip,
  };
}

/**
 * World placements for INTERLOCK — maps CS slide → correct world axis.
 *
 * Extruded profiles (Z/L/C): length along X, cross-section in YZ:
 *   CS 'v' (height) → world Y
 *   CS 'u' (width)  → world Z
 *
 * Earlier bug mapped ALL slides to Y → pieces dug into each other when
 * nest_direction was 'u' (side nest). Rigid pose only — no shape morph.
 */
function computeInterlockWorldYPlacements(it, count) {
  if (!it.crossSection && typeof extractCrossSection === 'function')
    extractCrossSection(it);
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function')
    analyzeCrossSection(it);
  if (!it.nestingInfo && typeof calculateNestingOffset === 'function')
    calculateNestingOffset(it);

  const cs = it.crossSection;
  const an = it.csAnalysis;
  const info = it.nestingInfo;
  const dir = info?.nest_direction_2d || an?.nest_direction || 'u';
  const clear = info?.clearance_mm != null ? info.clearance_mm : CSOFF_CLEARANCE_MM;
  const allowFlip = !!(info?.alternate_flip || it.nestMethod?.alternate_flip);
  const pack = computeInterlockNestPlacements(cs, count, dir, clear, allowFlip);

  // Relative slide from piece 0
  const s0 = pack.placements[0]?.slide_mm || 0;
  const alongY = dir === 'v'; // else along world Z
  const useTilt = !!(info?.use_tilted_nest_axis
    && (typeof requiresLiveRotateSearch === 'function'
      ? requiresLiveRotateSearch(it)
      : (typeof csNzIsZShape !== 'function' || csNzIsZShape(it))));
  const axis = useTilt ? (Number(info.nest_axis_angle_rad) || 0) : 0;

  const world = pack.placements.map(p => {
    const slide = (p.slide_mm || 0) - s0;
    if (useTilt) {
      return {
        index: p.index,
        y_offset_mm: slide * Math.cos(axis),
        z_offset_mm: slide * Math.sin(axis),
        flip: !!p.flip,
        step_from_prev_mm: p.step_from_prev_mm || 0,
      };
    }
    return {
      index: p.index,
      y_offset_mm: alongY ? slide : 0,
      z_offset_mm: alongY ? 0 : slide,
      flip: !!p.flip,
      step_from_prev_mm: p.step_from_prev_mm || 0,
    };
  });

  const H = Math.max(
    Number(info?.dims_used?.h) || Number(cs?.cs_height) || Number(it.sectH) || 0,
    1
  );
  const W = Math.max(
    Number(info?.dims_used?.w) || Number(cs?.cs_width) || Number(it.sectW) || 0,
    1
  );
  const lastY = world.length ? world[world.length - 1].y_offset_mm : 0;
  const lastZ = world.length ? world[world.length - 1].z_offset_mm : 0;

  return {
    placements: world,
    bundle_length_mm: Number(it.lengthMm || it.l || 0) || 0,
    bundle_width_mm: useTilt ? (W + Math.abs(lastZ)) : (alongY ? W : (W + lastZ)),
    bundle_height_mm: useTilt ? (H + Math.abs(lastY)) : (alongY ? (H + lastY) : H),
    nest_direction_2d: pack.nest_direction_2d,
    nest_world_axis: useTilt ? 'tilted' : (alongY ? 'y' : 'z'),
    nest_axis_angle_rad: useTilt ? axis : (alongY ? 0 : Math.PI / 2),
    source: pack.source,
  };
}

/**
 * After rough nest placement: push each piece along nest axis until CS
 * polygons no longer dig in (+ clearance). Rigid translate only.
 * Call BEFORE group rest-pose / ensureStableShape.
 */
function refineInterlockNestGroup(group, it) {
  if (!group || !it || group.children.length < 2) return;
  const cs = it.crossSection;
  const outer = cs?.outer_points;
  if (!outer || outer.length < 3
      || typeof csaOverlapFraction !== 'function'
      || typeof csaCopyPoly !== 'function') return;

  const an = it.csAnalysis;
  const info = it.nestingInfo;
  const dir = info?.nest_direction_2d || an?.nest_direction || 'u';
  const clear = info?.clearance_mm != null ? info.clearance_mm : CSOFF_CLEARANCE_MM;
  const alongY = dir === 'v';
  const S = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;

  const base = csaCopyPoly(outer);
  const bb0 = csaBBox(base);
  const cx = bb0.cx, cy = bb0.cy;
  const du = dir === 'u' ? 1 : 0;
  const dv = dir === 'v' ? 1 : 0;
  const span = Math.max(dir === 'u' ? bb0.w : bb0.h, 10);
  const maxExtra = span * 2.0;

  function polyAt(flip, slide) {
    let p = flip ? csaRotate180About(base, cx, cy) : csaCopyPoly(base);
    if (slide) p = csaTranslate(p, du * slide, dv * slide);
    return p;
  }

  function slideOf(ch) {
    // Nest slide relative to piece 0 along the nest world axis
    const a0 = group.children[0];
    if (alongY) return (ch.position.y - a0.position.y) / S;
    return (ch.position.z - a0.position.z) / S;
  }

  function extentAlong(poly) {
    let lo = Infinity, hi = -Infinity;
    for (const pt of poly) {
      const a = du ? pt[0] : pt[1];
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    return { min: lo, max: hi };
  }

  for (let i = 1; i < group.children.length; i++) {
    const prev = group.children[i - 1];
    const cur = group.children[i];
    const flip = !!(cur.userData && cur.userData.nestFlip);
    const prevFlip = !!(prev.userData && prev.userData.nestFlip);
    const prevSlide = slideOf(prev);
    let slide = slideOf(cur);
    const prevPoly = polyAt(prevFlip, prevSlide);
    const startSlide = slide;

    // Dig-in? Walk out 0.1mm until polygons clear
    let guard = 0;
    while (guard++ < 20000
        && csaOverlapFraction(prevPoly, polyAt(flip, slide)) > CSOFF_OVERLAP_EPS) {
      slide += CSOFF_FIT_STEP_MM;
      if (slide - prevSlide > maxExtra) break;
    }

    // Top up clearance only if gap along nest axis is below target
    // (do NOT double-add when placements already included clearance)
    const ePrev = extentAlong(prevPoly);
    const eCur = extentAlong(polyAt(flip, slide));
    const gap = eCur.min - ePrev.max;
    if (gap < clear) slide += (clear - gap);

    const deltaMm = slide - startSlide;
    if (Math.abs(deltaMm) < 1e-6) continue;
    if (alongY) cur.position.y += deltaMm * S;
    else cur.position.z += deltaMm * S;
    cur.updateMatrixWorld(true);
  }

  if (typeof recenterGroupAabb === 'function') recenterGroupAabb(group);
  try {
    console.info(
      `[nest-refine] ${it.mark || '?'} axis=${alongY ? 'Y' : 'Z'}`
      + ` pcs=${group.children.length} (no dig-in + ${clear}mm clear)`
    );
  } catch (_) { /* */ }
}

// ── INTERLOCK polygon slide (first-pair — used for nesting_offset stamp) ───

function csoffInterlockSlide(cs, an, wantFlip, nestDir2d, dims) {
  const outer = cs?.outer_points;
  if (!outer || outer.length < 3) {
    // Fallback: Step2 sep or thickness-like
    const sep = nestDir2d === 'v'
      ? Number(an?.nest_sep_v_mm)
      : Number(an?.nest_sep_u_mm);
    if (sep > 0 && isFinite(sep))
      return { distance: sep, used_flip: !!wantFlip || !!an?.nest_uses_flip, source: 'step2_sep' };
    return { distance: Math.max(dims.t, 1), used_flip: !!wantFlip, source: 'thickness_fallback' };
  }

  if (typeof csaMinSeparation !== 'function' || typeof csaCopyPoly !== 'function') {
    const sep = nestDir2d === 'v' ? Number(an?.nest_sep_v_mm) : Number(an?.nest_sep_u_mm);
    if (sep > 0 && isFinite(sep))
      return { distance: sep, used_flip: !!wantFlip || !!an?.nest_uses_flip, source: 'step2_sep' };
    return { distance: Math.max(dims.t, 1), used_flip: !!wantFlip, source: 'thickness_fallback' };
  }

  const fixed = csaCopyPoly(outer);
  const bb = typeof csaBBox === 'function' ? csaBBox(fixed) : csoffBBox(fixed);
  const maxSlide = Math.max(bb.w, bb.h, dims.w, dims.h, 10) * 1.5;

  const candidates = [];
  // CRITICAL: only measure with flip when Step6 allows it.
  // Measuring with flip then stacking without flip → dig-in / wrong offset.
  const tryFlip = [false];
  if (wantFlip) tryFlip.push(true);

  for (const flip of tryFlip) {
    let moving = fixed;
    const cx = bb.cx != null ? bb.cx : (bb.minU + bb.maxU) / 2;
    const cy = bb.cy != null ? bb.cy : (bb.minV + bb.maxV) / 2;
    if (flip && typeof csaRotate180About === 'function')
      moving = csaRotate180About(fixed, cx, cy);
    else if (flip)
      moving = csoffRotate180(fixed, cx, cy);

    // Primary nest direction from Step 2
    const du = nestDir2d === 'u' ? 1 : 0;
    const dv = nestDir2d === 'v' ? 1 : 0;
    let sep = csaMinSeparation(fixed, moving, du, dv, maxSlide);

    // Also evaluate opposite CS axis — keep the tighter interlocking (smaller sep)
    // only if it clearly nests better (matches “maximum interlocking”)
    const sepAlt = csaMinSeparation(fixed, moving, 1 - du, 1 - dv, maxSlide);
    const spanPri = nestDir2d === 'u' ? bb.w : bb.h;
    const spanAlt = nestDir2d === 'u' ? bb.h : bb.w;
    const scorePri = spanPri > 0 ? 1 - Math.min(sep / spanPri, 1) : 0;
    const scoreAlt = spanAlt > 0 ? 1 - Math.min(sepAlt / spanAlt, 1) : 0;
    if (scoreAlt > scorePri + 0.02) sep = sepAlt;

    candidates.push({ distance: sep, used_flip: flip, score: Math.max(scorePri, scoreAlt) });
  }

  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = candidates[0] || { distance: dims.t, used_flip: wantFlip };
  // Guard: offset must be positive and less than full span (else not really nesting)
  let d = best.distance;
  if (!(d > 0) || !isFinite(d)) d = Math.max(dims.t, 1);
  if (d > Math.max(bb.w, bb.h) * 1.2) d = Math.max(dims.t, 1);
  return { distance: d, used_flip: !!best.used_flip, source: 'polygon_slide' };
}

// ── dims / helpers ──────────────────────────────────────────────────────────

function csoffReadDims(it, cs, an) {
  let h = Number(cs?.cs_height || an?.cs_height || it.sectH || 0) || 0;
  let w = Number(cs?.cs_width || an?.cs_width || it.sectW || 0) || 0;
  let t = Number(it.sectT || 0) || 0;
  if (!(h > 0)) h = Number(it.heightMm || it.unitHeight || 0) || 0;
  if (!(w > 0)) w = Number(it.widthMm || it.unitWidth || 0) || 0;
  if (!(t > 0) && it.pathDiamMm > 0) t = it.pathDiamMm;
  if (!(t > 0)) {
    const thin = Math.min(h || 1e9, w || 1e9);
    t = isFinite(thin) && thin < 1e8 ? Math.max(thin * 0.05, 1) : 1;
  }
  if (!(h > 0)) h = Math.max(w, t, 10);
  if (!(w > 0)) w = Math.max(h * 0.35, t, 10);
  return {
    h, w, t,
    min: Math.min(h, w),
    max: Math.max(h, w),
  };
}

function csoffBBox(pts) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  pts.forEach(([u, v]) => {
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  });
  return {
    minU, maxU, minV, maxV,
    w: maxU - minU, h: maxV - minV,
    cx: (minU + maxU) / 2, cy: (minV + maxV) / 2,
  };
}

function csoffRotate180(poly, cx, cy) {
  return poly.map(([u, v]) => [cx - (u - cx), cy - (v - cy)]);
}
