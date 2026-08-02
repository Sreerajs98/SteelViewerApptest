/* 17-cs-pack-units.js — STEP 7 ONLY: Build pack units
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / mesh / ExtrudeGeometry / sect dims           ║
 * ║  • NEVER rewrite lengthMm / profileShape / crossSection polygons     ║
 * ║  • ONLY: sort pieces, chunk into sets, stamp pack-unit METADATA      ║
 * ║  • Mixed-length = order + align flag for later POSITION only         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Within each group:
 *   1) Sort LONGEST → SHORTEST
 *   2) SET_SIZE = min(MAX_SET(method), floor(3000kg / avg_weight))
 *   3) Same-length sets first; fill remainder with closest lengths
 *   4) Mixed length: align ONE END; longest outside/bottom; shortest inside/top
 *   5) Store nest_method, offset, flip_pattern, bbox, weight, orient, stability
 */

const CSPU_MAX_KG = 3000;
const CSPU_MAX_ROD_KG = 2000;
const CSPU_LEN_BIN_MM = 50;
/** Timber skid / dunnage under pack unit — bbox height only (no mesh morph). */
const CSPU_SKID_HEIGHT_MM = 100;

function cspuSkidHeightMm() {
  try {
    if (typeof PACK_CONFIG !== 'undefined' && PACK_CONFIG?.clearance?.skid_height_mm != null
        && isFinite(PACK_CONFIG.clearance.skid_height_mm))
      return Math.max(0, +PACK_CONFIG.clearance.skid_height_mm);
    if (typeof getLoadingRules === 'function') {
      const r = getLoadingRules();
      if (r && r.SKID_HEIGHT_MM != null && isFinite(r.SKID_HEIGHT_MM))
        return Math.max(0, +r.SKID_HEIGHT_MM);
    }
    if (typeof LOADING_RULES !== 'undefined' && LOADING_RULES.SKID_HEIGHT_MM != null)
      return Math.max(0, +LOADING_RULES.SKID_HEIGHT_MM);
  } catch (_) { /* */ }
  return CSPU_SKID_HEIGHT_MM;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * STEP 7 — Build pack units for one staging / CS group.
 * Metadata + piece lists only. Shapes never change.
 * @returns {object[]}
 */
function buildPackUnitsStep7(stageGroup) {
  if (!stageGroup) return [];

  const family = stageGroup.groupKind || 'loose_small';
  // Always expand qty (e.g. RF-1 qty=5 → 5 pieces) before pack-unit chunking
  const rawPieces = (stageGroup.memberPieces && stageGroup.memberPieces.length)
    ? stageGroup.memberPieces
    : (stageGroup.memberItems || (typeof itemsForStagingGroup === 'function'
      ? itemsForStagingGroup(stageGroup, []) : []));
  const pieces = (typeof expandToPieces === 'function')
    ? expandToPieces(rawPieces)
    : rawPieces.flatMap(p => {
      const n = Math.max(1, Number(p.qty) || 1);
      return Array.from({ length: n }, (_, i) => ({ ...p, qty: 1, _pieceIdx: i }));
    });

  if (!pieces.length) return [];

  // Ensure Step5/6 metadata available on seed piece (no geometry write beyond stamps)
  const seed = pieces[0];
  if (!seed.nestMethod && typeof decideNestMethod === 'function')
    decideNestMethod(seed);
  if (!seed.nestingInfo && typeof calculateNestingOffset === 'function')
    calculateNestingOffset(seed);

  const method = cspuResolveMethod(stageGroup, pieces);

  /**
   * Welded assemblies = ONE pack unit PER piece (shipping yard rule).
   * Never pre-stack 5 rafters into one tall unit that exceeds container H —
   * place #1, #2, … until floor/weight full; leftovers → next container.
   */
  if (family === 'welded_assembly') {
    const units = pieces.map((p, i) =>
      cspuMakePackUnit([p], stageGroup, i + 1, method || 'PER_MARK_STACK'));
    try {
      console.info(
        `[Step7 pack-units] ${stageGroup.id || '?'} welded_assembly`
        + ` → ${units.length} unit(s) (1 assembly each, shapes unchanged)`
      );
    } catch (_) { /* */ }
    return units;
  }

  // Per-mark: assemblies still 1-each; loose plates/etc. weight-split
  if (method === 'PER_MARK_STACK') {
    const allAsm = pieces.every(p =>
      !!(p.isAssembly || (p.parts && p.parts.length >= 2)));
    if (allAsm) {
      return pieces.map((p, i) => cspuMakePackUnit([p], stageGroup, i + 1, method));
    }
    const chunks = cspuSplitByWeight(pieces, family, method);
    return chunks.map((c, i) => cspuMakePackUnit(c, stageGroup, i + 1, method));
  }

  // Safety: never nest mixed thicknesses in one Z/C/L set (2.5 ≠ 2.0 ≠ 1.5)
  const thicknessBuckets = cspuPartitionByThickness(pieces, family);
  const final = [];
  thicknessBuckets.forEach(bucket => {
    const setSize = cspuCalcSetSize(bucket, method, family);
    const chunks = cspuChunkByLength(bucket, setSize);
    chunks.forEach(ch => {
      cspuSplitByWeight(ch, family, method).forEach(c => final.push(c));
    });
  });

  const units = final.map((c, i) => cspuMakePackUnit(c, stageGroup, i + 1, method));
  try {
    console.info(
      `[Step7 pack-units] ${stageGroup.id || '?'} method=${method}`
      + ` tBuckets=${thicknessBuckets.length}`
      + ` → ${units.length} unit(s), ${pieces.length} pcs (shapes unchanged)`
    );
  } catch (_) { /* */ }
  return units;
}

/** Split nestable cold-form pieces by wall thickness (±0.15 mm bins). */
function cspuPartitionByThickness(pieces, family) {
  const nest = family === 'nest_z' || family === 'nest_c' || family === 'nest_l'
    || family === 'z_channel' || family === 'c_channel' || family === 'l_angle';
  if (!nest || !pieces || pieces.length <= 1) return [pieces || []];
  const tTol = (typeof csgTTol === 'function') ? csgTTol() : 0.15;
  const tStep = Math.max(tTol * 2, 1e-6);
  const map = new Map();
  pieces.forEach(p => {
    let T = Number(p.sectT) || 0;
    if (!(T > 0) && typeof csgSectT === 'function') T = csgSectT(p) || 0;
    if (!(T > 0) && typeof resolveItemSection === 'function') {
      const s = resolveItemSection(p);
      T = s?.sectT || 0;
    }
    const key = T > 0
      ? (Math.floor(T / tStep + 1e-9) * tStep).toFixed(2)
      : (`P${String(p.profileDesc || '').trim().toUpperCase().slice(0, 24)}` || 'Tunk');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  });
  return Array.from(map.values());
}

/**
 * Override / primary createPackUnits used by staging + inspection.
 * Keeps legacy name so callers stay unchanged.
 */
function createPackUnits(stageGroup) {
  return buildPackUnitsStep7(stageGroup);
}

/** Stamp packUnits on every staging group (optional helper). */
function attachPackUnitsToGroups(groups) {
  let n = 0;
  (groups || []).forEach(g => {
    g.packUnits = createPackUnits(g);
    n += (g.packUnits || []).length;
  });
  try {
    console.info(`[Step7] attached pack units: ${n} across ${(groups || []).length} groups`);
  } catch (_) { /* */ }
  return n;
}

// ── SET_SIZE ────────────────────────────────────────────────────────────────

function cspuResolveMethod(stageGroup, pieces) {
  return stageGroup?.nestMethod?.method
    || pieces[0]?.nestMethod?.method
    || stageGroup?.nestingInfo?.method
    || 'PARALLEL_BUNDLE';
}

/** MAX_SET by nest method — Step9 PACK_CONFIG when available. */
function cspuMaxSetForMethod(method) {
  if (typeof cfgMaxSetForMethod === 'function')
    return cfgMaxSetForMethod(method);
  switch (method) {
    case 'INTERLOCK_NEST': return 12;   // Step9 default
    case 'PARALLEL_BUNDLE': return 15;
    case 'STACK_NEST': return 20;
    case 'FLAT_STACK': return 10;
    case 'HEX_BUNDLE': return 18;
    case 'PER_MARK_STACK': return 2;
    default: return 15;
  }
}

function cspuMaxKg(family, method) {
  if (family === 'bundle_rod' || family === 'bundle_bent' || method === 'HEX_BUNDLE')
    return (typeof cfgLimit === 'function')
      ? cfgLimit('max_rod_bundle_kg', CSPU_MAX_ROD_KG) : CSPU_MAX_ROD_KG;
  return (typeof cfgLimit === 'function')
    ? cfgLimit('max_bundle_kg', CSPU_MAX_KG) : CSPU_MAX_KG;
}

function cspuCalcSetSize(pieces, method, family) {
  const maxKg = cspuMaxKg(family, method);
  let sumW = 0, n = 0;
  pieces.forEach(p => {
    const w = Number(p.unitWeightKg) || 0;
    if (w > 0) { sumW += w; n++; }
  });
  const avg = n > 0 ? sumW / n : 50;
  const byWeight = Math.max(1, Math.floor(maxKg / Math.max(avg, 1e-6)));
  const maxSet = cspuMaxSetForMethod(method);

  // Special handling → tiny sets
  const special = pieces.some(p =>
    (typeof resolveSpecialHandling === 'function' && resolveSpecialHandling(p))
    || p.specialHandling);
  if (special) return Math.min(2, byWeight, maxSet);

  return Math.max(1, Math.min(maxSet, byWeight));
}

// ── Chunking ────────────────────────────────────────────────────────────────

function cspuLenBin(mm) {
  const bin = (typeof cfgTol === 'function')
    ? cfgTol('length_bin_mm', CSPU_LEN_BIN_MM) : CSPU_LEN_BIN_MM;
  return Math.round((mm || 0) / bin) * bin;
}

/**
 * Even pack sizes: 25 pcs / setSize 12 → [9,8,8] not [12,12,1].
 */
function cspuBalancedSizes(n, setSize) {
  const N = Math.max(0, n | 0);
  const ss = Math.max(1, setSize | 0);
  if (N <= 0) return [];
  if (N <= ss) return [N];
  const k = Math.ceil(N / ss);
  const base = Math.floor(N / k);
  let rem = N % k;
  const sizes = [];
  for (let i = 0; i < k; i++) {
    sizes.push(base + (rem > 0 ? 1 : 0));
    if (rem > 0) rem--;
  }
  return sizes;
}

/**
 * 1) Sort longest→shortest (global)
 * 2) Split into k = ceil(n/setSize) balanced packs (no orphan 1-pc leftover)
 * 3) Within each pack prefer closest lengths to seed, then re-sort L→S
 */
function cspuChunkByLength(pieces, setSize) {
  const sorted = pieces.slice().sort((a, b) =>
    (b.lengthMm || 0) - (a.lengthMm || 0)
    || String(a.mark || '').localeCompare(String(b.mark || '')));

  const ss = Math.max(1, setSize | 0);
  const sizes = cspuBalancedSizes(sorted.length, ss);
  const remain = sorted.slice();
  const units = [];

  sizes.forEach(sz => {
    if (!remain.length) return;
    const set = [remain.shift()];
    const seedL = set[0].lengthMm || 0;
    while (set.length < sz && remain.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remain.length; i++) {
        const d = Math.abs((remain[i].lengthMm || 0) - seedL);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      set.push(remain.splice(bestIdx, 1)[0]);
    }
    // Mixed-length rule: longest outside/bottom → shortest inside/top
    set.sort((a, b) => (b.lengthMm || 0) - (a.lengthMm || 0));
    units.push(set);
  });

  return units;
}

function cspuSplitByWeight(chunk, family, method) {
  const maxKg = cspuMaxKg(family, method);
  const out = [];
  let cur = [];
  let w = 0;
  chunk.forEach(p => {
    const pw = Math.max(0, Number(p.unitWeightKg) || 0);
    if (cur.length && w + pw > maxKg + 1e-6) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(p);
    w += pw;
  });
  if (cur.length) out.push(cur);
  return out;
}

// ── Pack unit record ────────────────────────────────────────────────────────

function cspuFlipPattern(n, alternateFlip) {
  const arr = [];
  for (let i = 0; i < n; i++)
    arr.push(!!(alternateFlip && (i % 2) === 1));
  return arr;
}

function cspuWithSkid(bbox) {
  const skid = cspuSkidHeightMm();
  return {
    l: bbox.l,
    w: bbox.w,
    h: (Number(bbox.h) || 0) + skid,
    source: bbox.source,
    skidMm: skid,
    hSteel: Number(bbox.h) || 0,
  };
}

function cspuBundleBBox(pieces, nestInfo, method, stageGroup) {
  const n = pieces.length;
  const L = Math.max(...pieces.map(p => p.lengthMm || 0), stageGroup.lengthMm || 0, 1);
  const H = Number(stageGroup.sectH) || Number(pieces[0]?.sectH) || Number(stageGroup.virtualHmm) || 1;
  const W = Number(stageGroup.sectW) || Number(pieces[0]?.sectW) || Number(stageGroup.virtualWmm) || 1;
  const T = Number(stageGroup.sectT) || Number(pieces[0]?.sectT) || 1;
  const off = Number(nestInfo?.nesting_offset) || 0;

  if (method === 'INTERLOCK_NEST' && typeof computeInterlockWorldYPlacements === 'function') {
    try {
      const sample = {
        ...pieces[0],
        lengthMm: L,
        sectH: H, sectW: W, sectT: T,
        nestingInfo: nestInfo,
        nestMethod: { method: 'INTERLOCK_NEST', alternate_flip: true },
        crossSection: pieces[0].crossSection
          || stageGroup.memberItems?.[0]?.crossSection
          || null,
      };
      if (!sample.crossSection && typeof extractCrossSection === 'function')
        extractCrossSection(sample);
      const fit = computeInterlockWorldYPlacements(sample, n);
      return cspuWithSkid({
        l: fit.bundle_length_mm || L,
        w: fit.bundle_width_mm || W,
        h: fit.bundle_height_mm || H,
        source: fit.source || 'interlock_fit',
      });
    } catch (_) { /* fall through */ }
  }

  // Nest families (L/Z/C): ALWAYS nest stack envelope — even when Tekla marks
  // each piece isAssembly. Using assembly_single here under-sizes the pack unit
  // vs makeLAngleBundle height → yard dig-in / eject / braces left outside.
  const nestFam = stageGroup.groupKind === 'nest_l'
    || stageGroup.groupKind === 'nest_z'
    || stageGroup.groupKind === 'nest_c'
    || stageGroup.shapeKey === 'l_angle'
    || stageGroup.shapeKey === 'z_channel'
    || stageGroup.shapeKey === 'c_channel'
    || method === 'STACK_NEST' || method === 'INTERLOCK_NEST'
    || method === 'PARALLEL_BUNDLE' || method === 'FLAT_STACK';

  // Welded / assembly: envelope of ONE piece (pack units are 1-each)
  if (!nestFam && (stageGroup.groupKind === 'welded_assembly' || pieces[0]?.isAssembly)) {
    const p0 = pieces[0] || {};
    let aL = Math.max(L, p0.lengthMm || 0, 1);
    let aW = Math.max(
      Number(p0.widthMm) || 0,
      Number(p0.sectW) || 0,
      Number(stageGroup.virtualWmm) || 0,
      W, 1);
    let aH = Math.max(
      Number(p0.heightMm) || 0,
      Number(p0.sectH) || 0,
      Number(stageGroup.virtualHmm) || 0,
      H, 1);
    // IFC axis swap: span often lands on widthMm (RF012 200×11607×2507)
    if (typeof cs8NormalizeAssemblyShipAxes === 'function') {
      const ax = cs8NormalizeAssemblyShipAxes(aL, aW, aH, {
        mark: p0.mark || stageGroup.mark,
        assemblyName: p0.assemblyName || stageGroup.name,
        isAssembly: true,
        groupKind: 'welded_assembly',
      });
      if (ax) { aL = ax.l; aW = ax.w; aH = ax.h; }
    }
    return cspuWithSkid({ l: aL, w: aW, h: aH, source: 'assembly_single' });
  }

  if (typeof computeNestBundleBounds === 'function' && nestInfo) {
    try {
      // Prefer pack-unit method (STACK for L) over stale nestingInfo.method
      const info = Object.assign({}, nestInfo, {
        method: method || nestInfo.method,
      });
      // L STACK: never tilted dual-axis growth (wafer / fat foot)
      if ((method === 'STACK_NEST' || stageGroup.groupKind === 'nest_l'
          || stageGroup.shapeKey === 'l_angle')
          && info.use_tilted_nest_axis) {
        info.use_tilted_nest_axis = false;
      }
      const b = computeNestBundleBounds(n, info, {
        length: L, width: W, height: H, thickness: T,
      });
      if (b) {
        return cspuWithSkid({
          l: b.bundle_length || L,
          w: b.bundle_width || W,
          h: b.bundle_height || H,
          source: 'nest_bounds',
        });
      }
    } catch (_) { /* */ }
  }

  // Formula fallbacks (envelope only — not geometry)
  if (method === 'FLAT_STACK') {
    const step = off > 0 ? off : Math.max(T, 1);
    return cspuWithSkid({ l: L, w: W, h: step * n, source: 'flat_formula' });
  }
  if (method === 'PARALLEL_BUNDLE' || method === 'PER_MARK_STACK') {
    const step = off > 0 ? off : (W + 3);
    return cspuWithSkid({ l: L, w: step * n, h: H, source: 'parallel_formula' });
  }
  // STACK_NEST / L face-down: grow on Y only (matches makeLAngleBundle)
  if (method === 'STACK_NEST' || stageGroup.shapeKey === 'l_angle'
      || stageGroup.groupKind === 'nest_l') {
    const stepY = off > 0 ? off : Math.max(T, 1.5);
    return cspuWithSkid({
      l: L,
      w: W,
      h: H + Math.max(0, n - 1) * stepY,
      source: 'stack_y_only',
    });
  }
  // INTERLOCK fallback: grow on both nest axes lightly
  const step = off > 0 ? off : Math.max(T, 1.5);
  return cspuWithSkid({
    l: L,
    w: W + Math.max(0, n - 1) * step,
    h: H + Math.max(0, n - 1) * step,
    source: 'stack_formula',
  });
}

function cspuMakePackUnit(pieces, stageGroup, idx, method) {
  const family = stageGroup.groupKind || 'loose_small';
  const first = pieces[0];
  const nestMethod = stageGroup.nestMethod || first.nestMethod || { method };
  const nestingInfo = stageGroup.nestingInfo || first.nestingInfo || null;
  const alternate = !!(nestMethod.alternate_flip
    || nestingInfo?.alternate_flip
    || method === 'INTERLOCK_NEST');

  // Ensure longest → shortest (outside/bottom → inside/top)
  const ordered = pieces.slice().sort((a, b) =>
    (b.lengthMm || 0) - (a.lengthMm || 0));

  let maxL = 0, minL = Infinity, weight = 0;
  const marks = [];
  const lengths = [];
  ordered.forEach(p => {
    let L = p.lengthMm || 0;
    // IFC sometimes leaves flange-brace length 0 — use part box / fallback
    if (!(L > 10)) {
      const bx = Math.max(p.boxXMm || 0, p.widthMm || 0, 0);
      const by = Math.max(p.boxYMm || 0, p.heightMm || 0, 0);
      const bz = Math.max(p.boxZMm || 0, 0);
      L = Math.max(bx, by, bz, 0);
      if (L < 10 || L <= Math.max(p.sectH || 0, p.sectW || 0) * 1.5)
        L = Math.max(stageGroup.lengthMm || 0, 300);
    }
    maxL = Math.max(maxL, L);
    if (L > 0) minL = Math.min(minL, L);
    weight += Math.max(0, Number(p.unitWeightKg) || 0);
    if (p.mark && !marks.includes(p.mark)) marks.push(p.mark);
    lengths.push(L);
  });
  if (!isFinite(minL)) minL = maxL;
  if (!(maxL > 10)) maxL = 300;

  const mixed = lengths.length > 1
    && (Math.max(...lengths) - Math.min(...lengths)) > 1;

  const byMark = new Map();
  ordered.forEach(p => {
    if (!byMark.has(p.mark)) byMark.set(p.mark, { ...p, qty: 0 });
    byMark.get(p.mark).qty += 1;
  });

  const orient = stageGroup.orientation_info || first.orientation_info || null;
  const stability = stageGroup.stabilityInfo || first.stabilityInfo || null;
  const stability_score = (stability && stability.score != null)
    ? stability.score
    : (orient && orient.score != null ? orient.score : null);
  // Rule1 Stage A/B → packer Stage C (orientation continuity)
  const rule1_orientation = stageGroup.rule1_orientation
    || first.rule1_orientation
    || (stability && stability.rule1_orientation)
    || null;

  const flip_pattern = cspuFlipPattern(ordered.length, alternate);
  const nesting_offset = nestingInfo?.nesting_offset > 0
    ? nestingInfo.nesting_offset
    : (stageGroup.nestingOffsetMm || first.nestingOffsetMm || 0);
  let bundle_bbox = cspuBundleBBox(ordered, nestingInfo, method, stageGroup);
  // Keep pack-unit lengthMm on the true member span (not IFC short axis)
  let packLen = maxL;
  let packW = bundle_bbox.w;
  let packH = bundle_bbox.h;
  if (family === 'welded_assembly' && typeof cs8NormalizeAssemblyShipAxes === 'function') {
    const ax = cs8NormalizeAssemblyShipAxes(
      maxL,
      Math.max(Number(first.widthMm) || 0, packW),
      Math.max(Number(first.heightMm) || 0, packH),
      {
        mark: first.mark || stageGroup.mark,
        assemblyName: first.assemblyName || stageGroup.name,
        isAssembly: true,
        groupKind: 'welded_assembly',
      }
    );
    if (ax) {
      packLen = ax.l;
      packW = ax.w;
      packH = ax.h;
      const skid = (bundle_bbox && bundle_bbox.skidMm != null)
        ? bundle_bbox.skidMm : cspuSkidHeightMm();
      bundle_bbox = {
        l: ax.l, w: ax.w,
        h: ax.h + (Number(skid) || 0),
        hSteel: ax.h,
        skidMm: skid,
        source: (bundle_bbox && bundle_bbox.source) || 'assembly_single',
      };
    }
  }

  const nestPieces = ordered.map((p, i) => {
    const s = (typeof resolveItemSection === 'function')
      ? resolveItemSection(p)
      : { sectH: p.sectH, sectW: p.sectW, sectT: p.sectT, sectD: p.sectD };
    return {
      mark: p.mark,
      qty: 1,
      sectH: s.sectH || p.heightMm,
      sectW: s.sectW || 0,
      sectT: s.sectT || 0,
      sectD: s.sectD || 0,
      profileDesc: p.profileDesc || '',
      lengthMm: p.lengthMm || 0,
      unitWeightKg: p.unitWeightKg || 0,
      // Position hints only — render may use later; never morphs CS
      stack_index: i,                 // 0 = outside/bottom (longest)
      flip: flip_pattern[i],
      align_end: 'start',             // one-end align for mixed lengths
    };
  });

  const pu = {
    stagingGroupId: stageGroup.id,
    packUnitIndex: idx,
    groupKind: family,
    mark: `${stageGroup.profileDesc || stageGroup.dimLabel || stageGroup.mark} · set ${idx}`,
    marks,
    profileDesc: stageGroup.profileDesc,
    profileShape: stageGroup.profileShape || stageGroup.shapeKey,
    shapeKey: stageGroup.shapeKey,
    sectH: stageGroup.sectH, sectW: stageGroup.sectW, sectT: stageGroup.sectT,
    sectD: stageGroup.sectD, sectTf: stageGroup.sectTf, sectTw: stageGroup.sectTw,
    category: stageGroup.category,
    surfaceTreatment: stageGroup.surfaceTreatment,
    destination: stageGroup.destination,
    specialHandling: stageGroup.specialHandling
      || ordered.some(p => typeof resolveSpecialHandling === 'function' && resolveSpecialHandling(p)),
    qty: ordered.length,
    weightKg: weight,
    total_weight: weight,
    lengthMm: packLen,
    lengthMinMm: family === 'welded_assembly' ? packLen : minL,
    lengthMaxMm: packLen,
    widthMm: packW,
    heightMm: packH,
    // Durable IFC shipping-pose fields (when extract stamped them)
    shippingLengthMm: +first.shippingLengthMm || 0,
    shippingWidthMm: +first.shippingWidthMm || +first.flangeWidthMm || 0,
    shippingHeightMm: +first.shippingHeightMm || 0,
    flangeWidthMm: +first.flangeWidthMm || +first.shippingWidthMm || 0,
    flangeClearGapMm: +first.flangeClearGapMm || 0,
    skidMm: bundle_bbox.skidMm != null ? bundle_bbox.skidMm : cspuSkidHeightMm(),
    memberItems: Array.from(byMark.values()),
    nestPieces,
    // ── Step 7 explicit fields ──────────────────────────────────────────
    items: nestPieces.map(np => ({
      mark: np.mark,
      lengthMm: np.lengthMm,
      unitWeightKg: np.unitWeightKg,
      flip: np.flip,
      stack_index: np.stack_index,
    })),
    nest_method: method,
    nestMethod: nestMethod,
    nesting_offset,
    nestingInfo: nestingInfo || undefined,
    nestingOffsetMm: nesting_offset,
    flip_pattern,
    alternate_flip: alternate,
    bundle_bbox,
    orientation: orient,
    orientation_info: orient,
    stability_score,
    stabilityInfo: stability || undefined,
    rule1_orientation: rule1_orientation || undefined,
    two_point_base: !!(rule1_orientation && rule1_orientation.two_point_base)
      || (typeof needsZStyleGroundFix === 'function' && needsZStyleGroundFix(first)),
    // Taper stations (metadata) for Step8 heightmap — never morphs geometry
    taperProfile: stageGroup.taperProfile || first.taperProfile || null,
    // Mixed-length placement policy (POSITION later — shapes unchanged)
    length_align: 'one_end',
    align_end: 'start',
    longest_outside: true,
    mixed_length: mixed,
    set_size_used: ordered.length,
    mutates_geometry: false,
    applies_to_display: false,
    isAssembly: family === 'welded_assembly',
    parts: family === 'welded_assembly' ? (stageGroup.parts || first.parts || null) : null,
    pathPointsMm: stageGroup.pathPointsMm,
    pathDiamMm: stageGroup.pathDiamMm,
  };

  // Ship Prep: load-ready pose (assemblies + nests + plates). Source of truth for Optimise.
  if (typeof csShipPrepPackUnit === 'function') {
    try {
      const prep = csShipPrepPackUnit(pu);
      if (pu.stableBundleMm && pu.stableBundleMm.l > 0) {
        pu.bundle_bbox = {
          l: pu.stableBundleMm.l,
          w: pu.stableBundleMm.w,
          h: pu.stableBundleMm.h,
          skidMm: pu.skidMm,
          source: pu.stableBundleMm.source || 'ship_prep',
        };
      }
      if (!(prep && prep.ok) && !pu._shipPrepped) {
        pu.needs_ship_prep = true;
        pu._shipPrepped = false;
      } else {
        pu.needs_ship_prep = false;
      }
    } catch (_) {
      pu.needs_ship_prep = !pu._shipPrepped;
    }
  } else if (pu.isAssembly && typeof measureStableBundleMm === 'function') {
    // Legacy fallback if ship-prep script missing
    try {
      const probe = {
        mark: pu.mark,
        marks: pu.marks,
        profileShape: pu.profileShape || pu.shapeKey,
        shapeKey: pu.shapeKey,
        sectH: pu.sectH, sectW: pu.sectW, sectT: pu.sectT,
        lengthMm: pu.lengthMm,
        widthMm: first.widthMm || pu.widthMm,
        heightMm: first.heightMm || pu.heightMm,
        qty: 1,
        isAssembly: true,
        parts: pu.parts,
        groupKind: 'welded_assembly',
        category: pu.category,
        orientation_info: orient,
        _yardStraighten: true,
        assemblyShipPose: true,
      };
      let sb = measureStableBundleMm(probe);
      if (sb && sb.l > 0) {
        const faceDown = sb.h <= sb.w * 1.08 + 1e-6;
        const fits40 = sb.w <= 2438 + 1 && sb.h <= 2690 + 1 && sb.l <= 12192 + 1;
        if (probe._groupByQuat) pu._groupByQuat = { ...probe._groupByQuat };
        if (faceDown && fits40) {
          sb.source = 'yard_straighten';
          pu._freezeGroupByPose = true;
        } else if (typeof cs8SanitizePitchedAssemblyEnvelope === 'function') {
          const scrubbed = cs8SanitizePitchedAssemblyEnvelope(
            sb, pu,
            pu.lengthMm || sb.l,
            first.widthMm || pu.widthMm,
            first.heightMm || pu.heightMm
          );
          if (scrubbed) sb = scrubbed;
        }
        pu.stableBundleMm = sb;
        pu.bundle_bbox = {
          l: sb.l, w: sb.w, h: sb.h,
          skidMm: pu.skidMm,
          source: sb.source || 'assembly_measured',
        };
      }
    } catch (_) { /* */ }
  }

  // Nest packs: stamp ship-prep ready without remorphing nest roll
  const nestLike = family === 'nest_z' || family === 'nest_c' || family === 'nest_l'
    || family === 'z_channel' || family === 'c_channel' || family === 'l_angle';
  if (nestLike) {
    pu._keepGroupByBundle = true;
    pu._shipPrepped = true;
    pu._freezeGroupByPose = true;
    if (!pu.stableBundleMm && pu.bundle_bbox) {
      pu.stableBundleMm = {
        l: pu.bundle_bbox.l || pu.l,
        w: pu.bundle_bbox.w || pu.w,
        h: pu.bundle_bbox.h || pu.h,
        source: 'ship_prep',
      };
    } else if (pu.stableBundleMm && !pu.stableBundleMm.source) {
      pu.stableBundleMm.source = 'ship_prep';
    }
  }

  return pu;
}

