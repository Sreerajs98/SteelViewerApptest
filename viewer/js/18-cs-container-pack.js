/* 18-cs-container-pack.js — STEP 8 ONLY: Container fit & pack
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER morph meshes / ExtrudeGeometry / sect dims / parts          ║
 * ║  • Bundle rest-pose stays from stability; pack may try stable faces  ║
 * ║  • Face rolls ONLY when needed for envelope fit (constraint Rule #1) ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Shipping policy (Pass 1 + Pass 2):
 *   RULE #1 CONSTRAINT-FIRST (Pass1 foundation):
 *     Most constrained cargo first (fewest valid orients / longest / heaviest)
 *     Discrete tiers: assembly → floor → secondary → filler
 *     Pre-orient from Stage A/B is PRIMARY; face-roll fallback for fit
 *     Planar bearing ≥80% · OR two-point rails for OPEN+concave (Z)
 *     MinY = floor or skid · no tip
 *   Pass2 COMPACT+FILL: lock yaw, slide toward back/gaps, residual fill
 *
 * Heightmap 100mm; AABB; CoG soft 10% / hard 15%
 */

/** Constraint-first thresholds (Rule #1). */
const CS8_CONSTRAINT_LEN_FLOOR = 0.70;
const CS8_CONSTRAINT_LEN_FILLER = 0.30;
const CS8_CONSTRAINT_KG_FLOOR = 1000;
const CS8_CONSTRAINT_KG_FILLER = 100;

const CS8_CELL_MM = 100;
const CS8_SUPPORT_MIN = 0.40;           // Pass2 / upper loose
const CS8_FLOOR_ANCHOR_SUPPORT = 0.80;  // Rule #1 planar bearing
/** Two contact rails (tip+joint) — each edge strip must be ≥ this. */
const CS8_TWO_POINT_EDGE_MIN = 0.70;
const CS8_OVERHANG_MAX = 0.30;
const CS8_EPS = 0.5;
/** Soft target: keep CoG within 10% of geometric centre (matches UI). */
const CS8_COG_SOFT = 0.10;
/** Hard reject when a same-shelf candidate stays inside soft band. */
const CS8_COG_HARD = 0.15;
/** Max air gap under planar base (mm). */
const CS8_MAX_BASE_GAP_MM = 80;
/** Tighter air gap for two-point OPEN bases (mm) — no floating on air. */
const CS8_MAX_BASE_GAP_TWOPT_MM = 35;

function cs8SupportMin() {
  return (typeof cfgSupport === 'function') ? cfgSupport('min_frac', CS8_SUPPORT_MIN) : CS8_SUPPORT_MIN;
}
/** Rule #1 Floor Anchor — ≥80% bearing on floor / skid / base layer. */
function cs8FloorAnchorSupportMin() {
  if (typeof getLoadingRules === 'function') {
    const r = getLoadingRules();
    if (r.FLOOR_ANCHOR_SUPPORT_MIN != null && isFinite(r.FLOOR_ANCHOR_SUPPORT_MIN))
      return +r.FLOOR_ANCHOR_SUPPORT_MIN;
  }
  if (typeof cfgSupport === 'function')
    return cfgSupport('floor_anchor_min_frac', CS8_FLOOR_ANCHOR_SUPPORT);
  return CS8_FLOOR_ANCHOR_SUPPORT;
}
function cs8SkidHeightMm() {
  if (typeof getLoadingRules === 'function') {
    const r = getLoadingRules();
    if (r.SKID_HEIGHT_MM != null && isFinite(r.SKID_HEIGHT_MM))
      return Math.max(0, +r.SKID_HEIGHT_MM);
  }
  return 100;
}
/** True when y0 is container floor or timber skid height. */
function cs8IsFloorOrSkidY(y0) {
  const y = Number(y0) || 0;
  if (y <= CS8_EPS) return true;
  const skid = cs8SkidHeightMm();
  return Math.abs(y - skid) <= CS8_CELL_MM * 0.5 + CS8_EPS;
}
function cs8OverhangMax() {
  return (typeof cfgSupport === 'function') ? cfgSupport('max_overhang_frac', CS8_OVERHANG_MAX) : CS8_OVERHANG_MAX;
}
function cs8CogSoft() {
  if (typeof getLoadingRules === 'function')
    return getLoadingRules().MAX_COG_OFFSET_FRAC;
  return CS8_COG_SOFT;
}
function cs8WallGapSide() {
  if (typeof getLoadingRules === 'function')
    return getLoadingRules().WALL_CLEARANCE_SIDE_MM;
  return (typeof cfgClearance === 'function')
    ? cfgClearance('bundle_to_wall_side_mm', cfgClearance('bundle_to_wall_mm', 50))
    : 50;
}
function cs8WallGapEnd() {
  if (typeof getLoadingRules === 'function')
    return getLoadingRules().WALL_CLEARANCE_END_MM;
  return (typeof cfgClearance === 'function')
    ? cfgClearance('bundle_to_wall_end_mm', 100)
    : 100;
}
function cs8WallGapTop() {
  if (typeof getLoadingRules === 'function')
    return getLoadingRules().WALL_CLEARANCE_TOP_MM;
  return (typeof cfgClearance === 'function')
    ? cfgClearance('bundle_to_wall_top_mm', 50)
    : 50;
}
/** @deprecated use cs8WallGapSide — kept for older callers */
function cs8WallGap() {
  return cs8WallGapSide();
}

/**
 * Wall clearance that still allows the footprint to fit.
 * End clearance (length) vs side clearance (width) from Safe-Zone rules.
 * If piece is near full L/W, shrink gap (min 0). Never morphs the item.
 */
function cs8EffectiveWallGaps(fl, fw, Lmax, Wmax) {
  const wantL = cs8WallGapEnd();
  const wantW = cs8WallGapSide();
  const minPrefer = 20; // keep a little end gap when slack exists
  function axisGap(span, limit, want) {
    if (!(span > 0) || !(limit > 0)) return want;
    if (span + 2 * want <= limit + CS8_EPS) return want;
    const slack = Math.max(0, limit - span);
    if (slack >= 2 * minPrefer) return Math.min(want, slack / 2);
    return slack / 2; // may be 0 for near-full-length members
  }
  return { gL: axisGap(fl, Lmax, wantL), gW: axisGap(fw, Wmax, wantW) };
}
function cs8BundleGap() {
  if (typeof getLoadingRules === 'function')
    return getLoadingRules().MIN_BUNDLE_GAP_MM;
  return (typeof cfgClearance === 'function') ? cfgClearance('bundle_to_bundle_mm', 20) : 20;
}
function cs8Dunnage() {
  return (typeof cfgClearance === 'function') ? cfgClearance('dunnage_mm', 75) : 75;
}

/**
 * Build X/Z scan axes for a footprint.
 * - Narrow items (foot < 30% of container axis) → 100mm step (not 200)
 * - Seed exact adjacent slots beside/after every placed box (yard snug-fit)
 */
function cs8BuildScanAxes(c, fl, fw, Lmax, Wmax, gL, gW, bundleGap) {
  const xMax0 = Lmax - gL - fl;
  const zMax0 = Wmax - gW - fw;
  const gap = bundleGap != null ? bundleGap : cs8BundleGap();

  // Narrow / short footprints need finer grid so 300mm rafters don't miss Z=350
  const stepXm = (fl < Lmax * 0.3)
    ? CS8_CELL_MM
    : Math.max(CS8_CELL_MM, Math.min(fl, CS8_CELL_MM * 2));
  const stepZm = (fw < Wmax * 0.3)
    ? CS8_CELL_MM
    : Math.max(CS8_CELL_MM, Math.min(fw, CS8_CELL_MM * 2));

  const xs = [];
  const zs = [];
  if (xMax0 >= gL - CS8_EPS) {
    for (let x = gL; x <= xMax0 + CS8_EPS; x += stepXm) xs.push(x);
    if (!xs.length || Math.abs(xs[xs.length - 1] - xMax0) > CS8_EPS) xs.push(xMax0);
  }
  if (zMax0 >= gW - CS8_EPS) {
    for (let z = gW; z <= zMax0 + CS8_EPS; z += stepZm) zs.push(z);
    if (!zs.length || Math.abs(zs[zs.length - 1] - zMax0) > CS8_EPS) zs.push(zMax0);
  }

  // Exact adjacent seeds from already-placed cargo (worker: "next to #1")
  const boxes = (c && c.boxes) || [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    const xAfter = b.maxX + gap;
    const xBefore = b.minX - fl - gap;
    const zAfter = b.maxZ + gap;
    const zBefore = b.minZ - fw - gap;
    if (xAfter >= gL - CS8_EPS && xAfter <= xMax0 + CS8_EPS) xs.push(xAfter);
    if (xBefore >= gL - CS8_EPS && xBefore <= xMax0 + CS8_EPS) xs.push(xBefore);
    if (zAfter >= gW - CS8_EPS && zAfter <= zMax0 + CS8_EPS) zs.push(zAfter);
    if (zBefore >= gW - CS8_EPS && zBefore <= zMax0 + CS8_EPS) zs.push(zBefore);
  }

  const uniqSort = (arr) => {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = Math.round(arr[i]);
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    out.sort((a, b) => a - b);
    return out;
  };

  return {
    xs: uniqSort(xs),
    zs: uniqSort(zs),
    stepXm,
    stepZm,
    xMax0,
    zMax0,
  };
}

/** Welded / multi-part assembly = container BASE cargo. */
function cs8IsAssemblyUnit(u) {
  return !!(u && (u.isAssembly || u.groupKind === 'welded_assembly'
    || (u.parts && u.parts.length >= 2)));
}

/** Absolute pack height ceiling (may shrink preferred top clearance to 0). */
function cs8AbsolutePackHeightMm(Houter, floorClearMm) {
  const H = Math.max(1, Number(Houter) || 0);
  const floor = Math.max(0, Number(floorClearMm) || 0);
  return Math.max(1, H - floor);
}

/**
 * Preferred Hpack, but allow near-full-height floor cargo by shrinking top gap
 * (same idea as cs8EffectiveWallGaps for length/width).
 */
function cs8EffectiveOrientHeightMm(needH, Hpack, Houter, floorClearMm) {
  const prefer = Math.max(1, Number(Hpack) || 0);
  const abs = cs8AbsolutePackHeightMm(Houter != null ? Houter : prefer, floorClearMm);
  const h = Math.max(0, Number(needH) || 0);
  if (h <= prefer + CS8_EPS) return prefer;
  return abs;
}

/** Longest AABB edge — used for length-ratio constraint. */
function cs8LongestDimMm(u) {
  if (!u) return 0;
  return Math.max(
    +u.l || 0, +u.w || 0, +u.h || 0,
    +u.lengthMm || 0, +u.lengthMaxMm || 0, +u.widthMm || 0, +u.heightMm || 0,
    0
  );
}

/** kg per piece for constraint thresholds (never nest/pack bulk as "piece"). */
function cs8PieceWeightKg(u) {
  if (!u) return 0;
  const uw = Math.max(0, Number(u.unitWeightKg) || 0);
  if (uw > 0) return uw;
  const qty = Math.max(1, Number(u.qty) || 1);
  const total = cs8UnitWeightKg(u);
  if (cs8IsAssemblyUnit(u)) return total / qty;
  const gk = String(u.groupKind || '').toLowerCase();
  // Nest / multi-piece packs: total is the set, not one lift piece
  if (/^nest_/.test(gk) || gk === 'bundle_rod' || gk === 'bundle_rhs'
      || gk === 'bundle_bent') {
    if (qty > 1) return total / qty;
    // Unknown set size — do not treat pack kg as a single-piece floor trigger
    return Math.min(total, CS8_CONSTRAINT_KG_FILLER);
  }
  if (qty > 1) return total / qty;
  return total;
}

/**
 * Family hint only (no length/orient math). Used inside constraint tier.
 *   0 assembly · 1 floor family · 2 secondary · 3 filler · -1 unknown
 */
function cs8FamilyTierHint(u, LmaxHint) {
  if (!u) return -1;
  if (cs8IsAssemblyUnit(u)) return 0;
  const gk = String(u.groupKind || '').toLowerCase();
  const blob = `${u.assemblyName || ''} ${u.mark || ''} ${u.profileDesc || ''} ${u.groupKind || ''}`;
  if (gk === 'welded_assembly'
      || /PORTAL|FRAME|RAFTER|COLUMN|BUILT[\s-]?UP|welded_assembly/i.test(blob))
    return 0;
  if (gk === 'bundle_beam' || gk === 'stack_plate') return 1;
  if (gk === 'bundle_rhs' || gk === 'nest_z' || gk === 'nest_c' || gk === 'nest_l')
    return 2;
  if (gk === 'bundle_rod' || gk === 'bundle_bent' || gk === 'loose_small')
    return 3;

  const sk = String(u.shapeKey || u.profileShape || '').toLowerCase();
  const cat = String(u.category || '').toLowerCase();
  const L = Math.max(+u.l || 0, +u.lengthMm || 0, +u.lengthMaxMm || 0, 0);
  const longLane = L >= 6000 || (LmaxHint > 0 && L >= LmaxHint * 0.50);
  if (sk === 'i_beam' || cat === 'beam' || longLane) return 1;
  if (sk === 'plate' || sk === 'flat' || cat === 'plate') return 1;
  if (sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle'
      || sk === 'rhs' || sk === 'shs' || sk === 'chs' || cat === 'rhs')
    return 2;
  if (sk === 'rod' || sk === 'round_bar' || sk === 'bar' || cat === 'rod')
    return 3;
  return -1;
}

/**
 * Valid gravity-stable orients that FIT the envelope.
 * Allows shrinking preferred top clearance up to absolute roof (Houter).
 */
function cs8ValidOrients(u, Lmax, Wmax, Hmax, opts) {
  const o = opts || {};
  if (typeof cs8StableBaseOrients === 'function')
    return cs8StableBaseOrients(u, Lmax, Wmax, Hmax, o);
  return cs8YawOrientsFloorAnchor(u, Lmax, Wmax, Hmax);
}

function cs8ValidOrientCount(u, Lmax, Wmax, Hmax, opts) {
  return (cs8ValidOrients(u, Lmax, Wmax, Hmax, opts) || []).length;
}

/**
 * RULE #1 — Constraint-First tier:
 *   0 = assemblies / portal (floor)
 *   1 = floor anchors (long / heavy / single-orient / beam·plate)
 *   2 = secondary (nests, RHS, medium)
 *   3 = gap fillers (short+light / rod·loose)
 *
 * @param {object} u
 * @param {number} LmaxHint
 * @param {object} [envOpts] { Wmax, Hmax, Houter, floorClearMm, maxKg }
 */
function cs8ConstraintTier(u, LmaxHint, envOpts) {
  if (!u) return 3;
  const Lref = Math.max(1, Number(LmaxHint) || 12192);
  const eo = envOpts || {};
  const fam = cs8FamilyTierHint(u, Lref);
  if (fam === 0 || cs8IsAssemblyUnit(u)) return 0;

  const longest = cs8LongestDimMm(u);
  const lengthRatio = longest / Lref;
  const kg = cs8PieceWeightKg(u);

  let nOri = eo.validOrients;
  if (nOri == null && eo.Wmax > 0 && eo.Hmax > 0) {
    nOri = cs8ValidOrientCount(u, Lref, eo.Wmax, eo.Hmax, {
      Houter: eo.Houter != null ? eo.Houter : eo.Hmax,
      floorClearMm: eo.floorClearMm || 0,
    });
  }
  const singleOrient = nOri != null && nOri > 0 && nOri <= 1;
  const familyFloor = fam === 1;
  const familySecondary = fam === 2;
  const familyFiller = fam === 3;

  // Tier 1 — most constrained floor cargo
  // (nest/RHS pack totals must NOT trigger the 1000 kg rule)
  if (lengthRatio >= CS8_CONSTRAINT_LEN_FLOOR
      || familyFloor
      || singleOrient
      || (kg >= CS8_CONSTRAINT_KG_FLOOR && !familySecondary && !familyFiller)) {
    return 1;
  }

  // Tier 3 — explicit fillers, or short+light unknowns (not nests/RHS)
  if (familyFiller) return 3;
  if (!familySecondary
      && lengthRatio < CS8_CONSTRAINT_LEN_FILLER
      && kg < CS8_CONSTRAINT_KG_FILLER) {
    return 3;
  }

  // Tier 2 — secondary (nests / RHS / medium)
  return 2;
}

/**
 * Legacy name — delegates to constraint-first tier (Rule #1).
 * Staging + packer share this.
 */
function cs8AnchorTier(u, LmaxHint, envOpts) {
  return cs8ConstraintTier(u, LmaxHint, envOpts);
}

/** Floor-anchor cargo must stay on the floor layer (not stacked). */
function cs8IsFloorAnchorCargo(u, LmaxHint, envOpts) {
  return cs8ConstraintTier(u, LmaxHint, envOpts) <= 1;
}

/** True 90° yaw only — NOT 180° (π). Bug: |y|>0.1 treated 180 as 90. */
function cs8OrientIsYaw90(orient) {
  if (!orient) return false;
  if (orient.tag === 'yaw90') return true;
  if (orient.tag === 'yaw0' || orient.tag === 'yaw180') return false;
  return cs8YawTagFromRad(orient.rot && orient.rot.y) === 'yaw90';
}

// Preserve legacy packer from 05-packing.js before we override layoutOptimized
var _layoutOptimizedLegacy = (typeof layoutOptimized === 'function'
  && !layoutOptimized._isStep8)
  ? layoutOptimized
  : null;

// ── public API ──────────────────────────────────────────────────────────────

/**
 * STEP 8 packer. Same return shape as layoutOptimized:
 *   { containers: [...], oversized: [...] }
 */
function layoutContainerPackStep8(items, spec, rotMap, opts) {
  const o = opts || {};
  const maxContainers = o.maxContainers != null ? o.maxContainers : 1;
  const seedItems = o.seedItems || [];
  const markOrder = o.markOrder instanceof Map ? o.markOrder : null;

  const Lmax = Math.max(1, spec.lengthMm || (typeof getPackConfig === 'function'
    ? getPackConfig().container.lengthMm : 12192));
  const Wmax = Math.max(1, spec.widthMm || 2438);
  const Hmax = Math.max(1, spec.heightMm || 2591);
  const maxKg = Math.max(1, spec.maxWeightKg
    || ((typeof cfgLimit === 'function') ? cfgLimit('max_container_kg', 26000) : 26000));
  const env = (typeof getPackEnvelope === 'function')
    ? getPackEnvelope({ lengthMm: Lmax, widthMm: Wmax, heightMm: Hmax })
    : null;
  const topClear = env ? env.clearanceTopMm : cs8WallGapTop();
  const floorClear = env ? env.clearanceFloorMm : 0;
  const Hpack = Math.max(1, Hmax - topClear - floorClear);
  const wallGap = cs8WallGapSide(); // legacy arg; findPlacement uses asymmetric gaps
  const bundleGap = env ? env.bundleGapMm : cs8BundleGap();
  const dunnageMm = cs8Dunnage();

  // Build placeable units (pack units preferred — no shape rewrite)
  let units = [];
  if (o.packUnits && o.packUnits.length) {
    units = o.packUnits.map(cs8UnitFromPackUnit).filter(Boolean);
  } else if (o.stagingGroups && o.stagingGroups.length) {
    o.stagingGroups.forEach(g => {
      const pus = g.packUnits || (typeof createPackUnits === 'function' ? createPackUnits(g) : []);
      (pus || []).forEach(pu => {
        const u = cs8UnitFromPackUnit(pu);
        if (u) units.push(u);
      });
    });
  } else {
    const expanded = (typeof expandUnits === 'function')
      ? expandUnits(items || [], spec) : [];
    units = expanded.map(cs8UnitFromExpand).filter(Boolean);
  }

  // Stamp envelope so diagnose / orient can shrink top clearance for tall uprights
  const envOpts = {
    Wmax,
    Hmax: Hpack,
    Houter: Hmax,
    floorClearMm: floorClear,
    maxKg,
  };
  units.forEach(u => {
    u._Houter = Hmax;
    u._floorClearMm = floorClear;
  });

  // Rule #1 Constraint-First: most constrained → first. Click Order ignored.
  cs8SortHeavyAnchor(units, Lmax, envOpts);

  const containers = [];
  const oversized = [];
  const placementSteps = []; // for optional live animate reveal

  function newContainer() {
    const nx = Math.ceil(Lmax / CS8_CELL_MM);
    const nz = Math.ceil(Wmax / CS8_CELL_MM);
    const hm = new Float64Array(nx * nz);
    return {
      weightUsed: 0,
      volumeUsed: 0,
      items: [],
      boxes: [],
      nx, nz, hm,
      leftWeight: 0,
      rightWeight: 0,
      sumMX: 0,
      sumMZ: 0,
    };
  }

  function hmSet(c, ix, iz, y) {
    if (ix < 0 || iz < 0 || ix >= c.nx || iz >= c.nz) return;
    const i = iz * c.nx + ix;
    if (y > c.hm[i]) c.hm[i] = y;
  }

  // Seed already-placed items into first container
  if (seedItems.length) {
    const c0 = newContainer();
    seedItems.forEach(it => {
      const uL = it.lengthMm || it.l || 500;
      const uW = it.widthMm || it.w || 200;
      const uH = it.heightMm || it.h || 200;
      const cx = it.x != null ? it.x : uL / 2;
      const cy = it.y != null ? it.y : uH / 2;
      const cz = it.z != null ? it.z : 0;
      const packerCx = Lmax - cx;
      const box = {
        minX: Math.max(0, packerCx - uL / 2),
        maxX: Math.max(0, packerCx - uL / 2) + uL,
        minY: Math.max(0, cy - uH / 2),
        maxY: Math.max(0, cy - uH / 2) + uH,
        minZ: Math.max(0, cz + Wmax / 2 - uW / 2),
        maxZ: Math.max(0, cz + Wmax / 2 - uW / 2) + uW,
      };
      const wt = (it.unitWeightKg || it.weight || 0) * (it.qty || 1);
      c0.weightUsed += wt;
      c0.volumeUsed += uL * uW * uH;
      c0.boxes.push(box);
      cs8StampHeightmap(c0, box, hmSet);
      const zFromLeft = cz + Wmax / 2;
      c0.sumMX += wt * packerCx;
      c0.sumMZ += wt * zFromLeft;
      if (cz >= 0) c0.rightWeight += wt; else c0.leftWeight += wt;
      c0.items.push({
        ...it,
        lengthMm: uL, widthMm: uW, heightMm: uH,
        x: packerCx, y: cy, z: cz,
        unitWeightKg: it.unitWeightKg || it.weight || 0,
        _seeded: true,
        packYawOnly: false,
        baseLayerLock: cs8IsFloorAnchorCargo(it),
        floorAnchor: cs8IsFloorOrSkidY(Math.max(0, cy - uH / 2)),
        anchorTier: cs8AnchorTier(it),
      });
    });
    containers.push(c0);
  }

  if (!containers.length) containers.push(newContainer());

  function tryPlaceUnit(u, placeOpts) {
    const canWeight = containers.some(c => c.weightUsed + u.weight <= maxKg + 1e-6)
      || containers.length < maxContainers;
    const trialLog = [];
    const mark = u.mark || (u.marks && u.marks[0]) || '?';
    placementSteps.push({
      type: 'unit_start',
      mark,
      marks: u.marks ? [...u.marks] : [mark],
      weight: cs8UnitWeightKg(u),
      tier: cs8ConstraintTier(u, Lmax, envOpts),
      isAssembly: cs8IsAssemblyUnit(u),
      floorAnchor: !!(placeOpts && placeOpts.floorAnchor),
      pass: (placeOpts && placeOpts.pass) || 1,
      l: u.l, w: u.w, h: u.h,
    });
    if (!canWeight) {
      placementSteps.push({ type: 'reject', mark, reason: 'weight_limit' });
      return false;
    }

    const optsWithLog = Object.assign({}, placeOpts || {}, {
      trialLog: trialLog,
      Houter: Hmax,
      floorClearMm: floorClear,
    });
    let placed = false;
    for (const c of containers) {
      if (c.weightUsed + u.weight > maxKg + 1e-6) continue;
      const pose = cs8FindPlacement(
        c, u, Lmax, Wmax, Hpack, wallGap, bundleGap, dunnageMm, optsWithLog);
      if (!pose) continue;
      cs8Commit(c, u, pose, Lmax, Wmax);
      const last = c.items[c.items.length - 1];
      last.baseLayerLock = cs8IsFloorAnchorCargo(u, Lmax, envOpts);
      last.floorAnchor = !!(placeOpts && placeOpts.floorAnchor);
      last.anchorTier = cs8ConstraintTier(u, Lmax, envOpts);
      for (let ti = 0; ti < trialLog.length; ti++) placementSteps.push(trialLog[ti]);
      placementSteps.push({
        type: 'commit',
        mark: last.mark,
        marks: last.marks ? [...last.marks] : [last.mark],
        isAssembly: !!last.baseLayerLock,
        floorAnchor: !!last.floorAnchor,
        pass: placeOpts?.pass || 1,
        containerNumber: containers.indexOf(c) + 1,
        tag: last.packOrientTag || (pose.o && pose.o.tag),
        x: last.x, y: last.y, z: last.z,
      });
      placed = true;
      break;
    }

    if (!placed && containers.length < maxContainers) {
      const c = newContainer();
      containers.push(c);
      if (c.weightUsed + u.weight <= maxKg + 1e-6) {
        const pose = cs8FindPlacement(
          c, u, Lmax, Wmax, Hpack, wallGap, bundleGap, dunnageMm, optsWithLog);
        if (pose) {
          cs8Commit(c, u, pose, Lmax, Wmax);
          const last = c.items[c.items.length - 1];
          last.baseLayerLock = cs8IsFloorAnchorCargo(u, Lmax, envOpts);
          last.floorAnchor = !!(placeOpts && placeOpts.floorAnchor);
          last.anchorTier = cs8ConstraintTier(u, Lmax, envOpts);
          for (let ti = 0; ti < trialLog.length; ti++) placementSteps.push(trialLog[ti]);
          placementSteps.push({
            type: 'commit',
            mark: last.mark,
            marks: last.marks ? [...last.marks] : [last.mark],
            isAssembly: !!last.baseLayerLock,
            floorAnchor: !!last.floorAnchor,
            pass: placeOpts?.pass || 1,
            containerNumber: containers.indexOf(c) + 1,
            tag: last.packOrientTag || (pose.o && pose.o.tag),
            x: last.x, y: last.y, z: last.z,
          });
          placed = true;
        }
      }
      if (!placed) containers.pop();
    }
    if (!placed) {
      for (let ti = 0; ti < trialLog.length; ti++) placementSteps.push(trialLog[ti]);
      if (!trialLog.some(t => t.type === 'reject'))
        placementSteps.push({ type: 'reject', mark, reason: 'unplaced' });
    }
    return placed;
  }

  // ── Pass 1: RULE #1 Floor Anchor ───────────────────────────────────────
  // Phase A — floor anchors (assemblies / beams / long lanes) on floor only
  // Phase B — loose bundles: try floor, else allow stack (bundle filler)
  function pass1Place(u, floorOnly) {
    if (tryPlaceUnit(u, { pass: 1, floorAnchor: true })) return true;
    if (!floorOnly && tryPlaceUnit(u, { pass: 1, floorAnchor: false })) return true;
    const diag = cs8DiagnoseUnfit(u, Lmax, Wmax, Hpack, containers, maxKg);
    oversized.push(cs8ToOversized(u, diag.code, diag));
    try {
      console.warn(
        `[Constraint REJECT] ${u.mark || '?'} tier=${cs8ConstraintTier(u, Lmax, envOpts)}`
        + ` ${Math.round(cs8UnitWeightKg(u))}kg`
        + ` ${Math.round(u.l || 0)}×${Math.round(u.w || 0)}×${Math.round(u.h || 0)}`
        + ` → ${diag.code}: ${diag.msg}`
      );
    } catch (_) { /* */ }
    return false;
  }

  units.forEach(u => {
    const anchor = cs8IsFloorAnchorCargo(u, Lmax, envOpts);
    pass1Place(u, anchor); // anchors: floor-only; loose: floor then stack
  });

  // ── Pass 2: compact (locked yaw) + residual gap fill ────────────────────
  let pass2Stats = { compacted: 0, filled: 0 };
  if (o.pass2 !== false) {
    pass2Stats = cs8Pass2CompactAndFill(
      containers, oversized, Lmax, Wmax, Hpack,
      wallGap, bundleGap, dunnageMm, maxKg, maxContainers, placementSteps
    );
  }

  const filled = containers.filter(c => c.items && c.items.length);
  if (!filled.length && containers.length) filled.push(containers[0]);

  const cv = Lmax * Wmax * Hmax;
  const result = filled.map((c, idx) => {
    const cog = cs8ContainerCog(c, Lmax, Wmax);
    return {
      containerNumber: idx + 1,
      lengthMm: Lmax, widthMm: Wmax, heightMm: Hmax,
      maxWeightKg: maxKg,
      usedWeightKg: typeof round2 === 'function' ? round2(c.weightUsed) : +c.weightUsed.toFixed(2),
      weightUtilizationPct: typeof round1 === 'function'
        ? round1(c.weightUsed / maxKg * 100) : +(c.weightUsed / maxKg * 100).toFixed(1),
      volumeUtilizationPct: typeof round1 === 'function'
        ? round1(c.volumeUsed / cv * 100) : +(c.volumeUsed / cv * 100).toFixed(1),
      cogX_mm: cog.cogX_render,
      cogZ_mm: cog.cogZ_render,
      cogBalanced: cog.balanced,
      items: c.items.map(it => {
        const clean = { ...it };
        clean.x = Lmax - clean.x;
        delete clean._box;
        return clean;
      }),
    };
  });

  // Mirror placement-step coords are not stored — UI reveals by mark from final items
  try {
    const bal = result.filter(r => r.cogBalanced).length;
    const nPlaced = units.length - oversized.length;
    console.info(
      `[Step8 FloorAnchor+P2] ${result.length} container(s),`
      + ` ${nPlaced}/${units.length} placed, ${oversized.length} leftover,`
      + ` CoG ok ${bal}/${result.length}`
      + ` | compact~${pass2Stats.compacted} fill+${pass2Stats.filled}`
      + ` — Rule#1 ≥80% / yaw0|180 / floor-Y, shapes unchanged`
    );
  } catch (_) { /* */ }

  return {
    containers: result,
    oversized,
    placementSteps,
    packPasses: { pass1: true, pass2: o.pass2 !== false, ...pass2Stats },
  };
}

/** Step 8 becomes the default Optimise / Place packer (Y-yaw only). */
function layoutOptimized(items, spec, rotMap, opts) {
  if (!(opts && opts.forceLegacyPacker)) {
    return layoutContainerPackStep8(items, spec, rotMap, opts);
  }
  return _layoutOptimizedLegacy
    ? _layoutOptimizedLegacy(items, spec, rotMap, opts)
    : { containers: [], oversized: items || [] };
}
layoutOptimized._isStep8 = true;

// ── unit builders (metadata / dims only — never rewrite sect geometry) ─────

function cs8UnitFromPackUnit(pu) {
  if (!pu) return null;
  const bb = pu.bundle_bbox || {};
  // Construction dims for makeShape / nest (NEVER rewritten by rest-pose swap)
  const memberL = Math.max(
    pu.lengthMaxMm || pu.lengthMm || bb.l || pu.l || 1, 1);
  const constructH = Math.max(
    pu.sectH || pu.unitHeight || pu.heightMm || bb.h || 1, 1);
  const constructW = Math.max(
    pu.sectW || pu.unitWidth || pu.widthMm || bb.w || 1, 1);

  // Pack footprint: prefer measured post-rest-pose AABB (matches render)
  let sb = pu.stableBundleMm;
  if ((!sb || !(sb.l > 0)) && typeof measureStableBundleMm === 'function') {
    try {
      sb = measureStableBundleMm({
        mark: pu.mark,
        marks: pu.marks,
        profileShape: pu.profileShape || pu.shapeKey,
        shapeKey: pu.shapeKey,
        sectH: pu.sectH, sectW: pu.sectW, sectT: pu.sectT,
        sectD: pu.sectD, sectTf: pu.sectTf, sectTw: pu.sectTw,
        lengthMm: memberL,
        widthMm: constructW,
        heightMm: constructH,
        unitHeight: pu.sectH || constructH,
        unitWidth: pu.sectW || constructW,
        qty: pu.qty || 1,
        nestPieces: pu.nestPieces || null,
        nestingInfo: pu.nestingInfo,
        nestMethod: pu.nestMethod || { method: pu.nest_method },
        orientation_info: pu.orientation_info || pu.orientation,
        isAssembly: !!pu.isAssembly,
        parts: pu.parts || null,
        pathPointsMm: pu.pathPointsMm,
        pathDiamMm: pu.pathDiamMm,
        category: pu.category,
      });
      if (sb) pu.stableBundleMm = sb;
    } catch (_) { /* */ }
  }

  const l = Math.max(sb?.l || bb.l || memberL, 1);
  const w = Math.max(sb?.w || bb.w || constructW, 1);
  const h = Math.max(sb?.h || bb.h || constructH, 1);
  const weight = Math.max(0, pu.total_weight || pu.weightKg || pu.weight || 0);
  const volume = Math.max(l * w * h, 1);
  return {
    mark: pu.mark,
    marks: pu.marks ? [...pu.marks] : [pu.mark],
    assemblyName: pu.profileDesc || pu.mark,
    category: pu.category,
    profileShape: pu.profileShape || pu.shapeKey,
    shapeKey: pu.shapeKey,
    // Pass through section dims READ-ONLY for makeShape (do not invent new CS)
    sectH: pu.sectH, sectW: pu.sectW, sectT: pu.sectT,
    sectD: pu.sectD, sectTf: pu.sectTf, sectTw: pu.sectTw,
    unitHeight: pu.sectH || constructH,
    unitWidth: pu.sectW || constructW,
    qty: pu.qty || 1,
    // Packer envelope (post rest-pose when measured)
    l, w, h,
    // makeShape construction dims — member length + sect, NOT swapped envelope
    lengthMm: memberL,
    widthMm: constructW,
    heightMm: constructH,
    stableBundleMm: sb || null,
    weight,
    unitWeightKg: weight,
    volume,
    // Assemblies get a soft priority bump so they win density ties as base cargo
    pack_priority: (weight / volume) * (pu.isAssembly ? 1.25 : 1),
    nestPieces: pu.nestPieces || null,
    nestingInfo: pu.nestingInfo,
    nestingOffsetMm: pu.nesting_offset || pu.nestingOffsetMm,
    nestMethod: pu.nestMethod || { method: pu.nest_method },
    orientation_info: pu.orientation_info || pu.orientation,
    stabilityInfo: pu.stabilityInfo,
    rule1_orientation: pu.rule1_orientation || (pu.stabilityInfo && pu.stabilityInfo.rule1_orientation) || null,
    two_point_base: !!(pu.two_point_base
      || (pu.rule1_orientation && pu.rule1_orientation.two_point_base)
      || (pu.stabilityInfo && pu.stabilityInfo.two_point_base)),
    taperProfile: pu.taperProfile || null,
    groupKind: pu.groupKind || null,
    isAssembly: !!pu.isAssembly,
    parts: pu.parts || null,
    pathPointsMm: pu.pathPointsMm,
    pathDiamMm: pu.pathDiamMm,
    nested: !!(pu.nest_method && pu.nest_method !== 'PER_MARK_STACK'),
    stacked: true,
    bundled: true,
    surfaceTreatment: pu.surfaceTreatment,
    destination: pu.destination,
    specialHandling: pu.specialHandling,
    stagingGroupId: pu.stagingGroupId,
    packUnitIndex: pu.packUnitIndex,
    mutates_geometry: false,
  };
}

function cs8UnitFromExpand(u) {
  if (!u) return null;
  const l = Math.max(u.l || u.lengthMm || 1, 1);
  const w = Math.max(u.w || u.widthMm || 1, 1);
  const h = Math.max(u.h || u.heightMm || 1, 1);
  const weight = Math.max(0, u.weight || u.unitWeightKg || 0);
  const volume = Math.max(l * w * h, 1);
  return {
    ...u,
    l, w, h,
    lengthMm: l, widthMm: w, heightMm: h,
    weight,
    volume,
    pack_priority: weight / volume,
    mutates_geometry: false,
  };
}

function cs8MarkOrder(u, markOrder) {
  let best = 99999;
  [u.mark, ...(u.marks || [])].forEach(m => {
    if (m && markOrder.has(m)) best = Math.min(best, markOrder.get(m));
  });
  return best;
}

function cs8UnitWeightKg(u) {
  return Math.max(
    +u.weight || 0, +u.weightKg || 0, +u.total_weight || 0,
    +u.unitWeightKg || 0, 0
  );
}
/**
 * Weight of the UNIT the worker places:
 *   Assembly → single piece (qty÷ guard if old multi-qty unit arrives)
 *   Nest/bundle → full pack-unit weight (already one nest set)
 */
function cs8PackSortWeightKg(u) {
  const total = cs8UnitWeightKg(u);
  if (cs8IsAssemblyUnit(u)) {
    const qty = Math.max(1, Number(u.qty) || 1);
    return total / qty;
  }
  return total;
}
function cs8UnitLengthMm(u) {
  return Math.max(
    +u.l || 0, +u.lengthMm || 0, +u.lengthMaxMm || 0, +u.lengthMax || 0, 0
  );
}

/**
 * Optimise insert order — RULE #1 Constraint-First:
 *   1) Assemblies: heaviest piece → longest
 *   2) Floor (tier 1): longest → heaviest → fewest valid orients
 *   3) Secondary / filler: heaviest → longest
 * Click Order ignored.
 *
 * @param {object[]} units
 * @param {number} LmaxHint
 * @param {object} [envOpts] { Wmax, Hmax, Houter, floorClearMm }
 */
function cs8SortHeavyAnchor(units, LmaxHint, envOpts) {
  const Lref = LmaxHint || 0;
  const eo = envOpts || {};
  const orientKey = (u) => {
    if (!(eo.Wmax > 0 && eo.Hmax > 0)) return 99;
    return cs8ValidOrientCount(u, Lref, eo.Wmax, eo.Hmax, {
      Houter: eo.Houter != null ? eo.Houter : eo.Hmax,
      floorClearMm: eo.floorClearMm || 0,
    });
  };
  (units || []).sort((a, b) => {
    const aAsm = cs8IsAssemblyUnit(a) ? 0 : 1;
    const bAsm = cs8IsAssemblyUnit(b) ? 0 : 1;
    if (aAsm !== bAsm) return aAsm - bAsm;
    if (aAsm === 0) {
      const dw = cs8PackSortWeightKg(b) - cs8PackSortWeightKg(a);
      if (Math.abs(dw) > 1e-3) return dw;
      return cs8LongestDimMm(b) - cs8LongestDimMm(a);
    }
    const ta = cs8ConstraintTier(a, Lref, eo);
    const tb = cs8ConstraintTier(b, Lref, eo);
    if (ta !== tb) return ta - tb;
    const dL = cs8LongestDimMm(b) - cs8LongestDimMm(a);
    const dw = cs8PieceWeightKg(b) - cs8PieceWeightKg(a);
    // Floor: length first (lane claimers), then kg, then fewer orients
    if (ta === 1) {
      if (Math.abs(dL) > 100) return dL;
      if (Math.abs(dw) > 1e-3) return dw;
      return orientKey(a) - orientKey(b);
    }
    // Secondary + filler: heavier first, then longer
    if (Math.abs(dw) > 1e-3) return dw;
    if (Math.abs(dL) > 1) return dL;
    return orientKey(a) - orientKey(b);
  });
  return units;
}

/**
 * Constraint Override Log — why an item stayed outside (shipping-readable).
 */
function cs8DiagnoseUnfit(u, Lmax, Wmax, Hmax, containers, maxKg) {
  const L = Math.max(+u.l || 0, 1);
  const W = Math.max(+u.w || 0, 1);
  const H = Math.max(+u.h || 0, 1);
  const wt = cs8UnitWeightKg(u);
  const end = cs8WallGapEnd();
  const side = cs8WallGapSide();
  const availL = Math.max(0, Lmax - 2 * end);
  const availW = Math.max(0, Wmax - 2 * side);

  if (wt > (maxKg || 0) + 1e-6) {
    return {
      code: 'WEIGHT_LIMIT',
      msg: `Weight ${Math.round(wt)} kg > container max ${Math.round(maxKg)} kg`,
    };
  }
  if (containers && containers.length
      && containers.every(c => (c.weightUsed || 0) + wt > maxKg + 1e-6)) {
    return {
      code: 'WEIGHT_LIMIT',
      msg: `Remaining capacity < ${Math.round(wt)} kg`,
    };
  }
  // Absolute: no axis of the AABB may exceed the longest container edge
  const maxEdge = Math.max(Lmax, Wmax, Hmax);
  if (Math.max(L, W, H) > maxEdge + CS8_EPS) {
    return {
      code: 'LENGTH_EXCEEDS_CONTAINER',
      msg: `Largest dim ${Math.round(Math.max(L, W, H))} mm > box max ${Math.round(maxEdge)} mm`,
    };
  }
  // Prefer Hmax as pack height; also try absolute roof if caller passed raw H via u._Houter
  const Houter = (u && u._Houter != null) ? +u._Houter : Hmax;
  const orients = cs8ValidOrients(u, Lmax, Wmax, Hmax, {
    Houter,
    floorClearMm: (u && u._floorClearMm) || 0,
  });
  if (!orients.length) {
    return {
      code: 'WIDTH_EXCEEDS_ENVELOPE',
      msg: `No face/yaw fit for ${Math.round(L)}×${Math.round(W)}×${Math.round(H)} mm`
        + ` in ${Lmax}×${Wmax}×${Math.round(Houter)} (tried all stable-base directions)`
        + ` — need Open Top / Flat Rack`,
    };
  }
  // Fits only if end clearance shrinks below preferred 100 mm
  if (L > availL + CS8_EPS) {
    return {
      code: 'END_CLEARANCE_TIGHT',
      msg: `Length ${Math.round(L)} mm > preferred ${Math.round(availL)} mm`
        + ` (${end} mm ends) — no free floor slot with reduced clearance`,
    };
  }
  if (W > availW + CS8_EPS) {
    return {
      code: 'SIDE_CLEARANCE_TIGHT',
      msg: `Width ${Math.round(W)} mm > preferred ${Math.round(availW)} mm`
        + ` (${side} mm sides) — blocked on floor`,
    };
  }
  return {
    code: 'NO_FLOOR_SLOT',
    msg: `No floor slot with ≥${Math.round(cs8FloorAnchorSupportMin() * 100)}% bearing`
      + ` (collision / CoG / other cargo)`,
  };
}

function cs8ToOversized(u, reason, detail) {
  const d = detail && typeof detail === 'object' ? detail : null;
  const code = (d && d.code) || reason || 'no_fit';
  const msg = (d && d.msg) || (typeof reason === 'string' ? reason : code);
  return {
    ...u,
    fitReason: code,
    fitReasonMsg: msg,
    lengthMm: u.l, widthMm: u.w, heightMm: u.h,
  };
}

// ── Y-only orientations ─────────────────────────────────────────────────────

/**
 * Legacy longitudinal-only (0°/180°) — kept for tests / Pass2 prefer list.
 */
function cs8YawOrientsFloorAnchor(u, Lmax, Wmax, Hmax) {
  const L = u.l, W = u.w, H = u.h;
  const list = [];
  if (L <= Lmax + CS8_EPS && W <= Wmax + CS8_EPS && H <= Hmax + CS8_EPS) {
    list.push({
      l: L, w: W, h: H,
      rot: { x: 0, y: 0, z: 0 },
      tag: 'yaw0',
      shipPreferred: true,
      floorAnchor: true,
      packYawOnly: true,
      packComposeRot: false,
      baseArea: L * W,
      stabilityScore: L * W,
    });
    list.push({
      l: L, w: W, h: H,
      rot: { x: 0, y: Math.PI, z: 0 },
      tag: 'yaw180',
      shipPreferred: true,
      floorAnchor: true,
      packYawOnly: true,
      packComposeRot: false,
      baseArea: L * W,
      stabilityScore: L * W - 1,
    });
  }
  return list;
}

/**
 * Tip penalty for a candidate face.
 *
 * BUG (fixed): tipPen = 1e9×(tipRatio-2) buried upright I-beams
 *   (e.g. rafter 11608×200×2508 → score ≈ −10e9) even though
 *   standing on flanges is normal shipping practice.
 *
 * Soft penalty (tipRatio×100) when:
 *   1) isStructuralUpright — tall (h > baseW×3), baseW > 100, beam/assy
 *   2) isOnlyFit — sole envelope-fit pose (caller passes onlyFit=true)
 * Else keep a real tip penalty for skinny non-structural uprights (Z etc.).
 */
function cs8OrientTipPenalty(f, u, onlyFit) {
  const baseW = Math.min(f.l, f.w);
  const tipRatio = f.h / Math.max(baseW, 1);
  if (onlyFit) return tipRatio * 100;

  const sk = String((u && (u.shapeKey || u.profileShape)) || '').toLowerCase();
  const cat = String((u && u.category) || '').toLowerCase();
  const gk = String((u && u.groupKind) || '').toLowerCase();
  const blob = `${(u && u.assemblyName) || ''} ${(u && u.mark) || ''} ${gk}`;
  const isBeamFamily = !!(
    cs8IsAssemblyUnit(u)
    || sk === 'i_beam' || sk === 'built_up' || cat === 'beam'
    || gk === 'bundle_beam' || gk === 'welded_assembly'
    || /RAFTER|COLUMN|PORTAL|FRAME|BUILT[\s-]?UP/i.test(blob)
  );
  // tall + flange-width base + structural family = I-beam on flanges
  const isStructuralUpright = isBeamFamily
    && baseW > 100
    && f.h > baseW * 3;
  if (isStructuralUpright) return tipRatio * 100;

  // Non-structural skinny upright (e.g. Z on edge) — keep strong penalty
  if (tipRatio > 2.0) return 1e9 * (tipRatio - 2);
  return tipRatio * 1e4;
}

/**
 * Yard-style ALL-DIRECTION trials for Floor Anchor:
 * yaw 0/90/180/270 + Rx/Rz face rolls. Only orients that FIT the box.
 * Sole-fit poses (e.g. upright rafter) always rank first — tipPen cannot bury them.
 *
 * opts.Houter / opts.floorClearMm — allow shrinking preferred top clearance
 * so upright rafters (e.g. H=2508 in 2591 box) still get a valid orient.
 */
function cs8StableBaseOrients(u, Lmax, Wmax, Hmax, opts) {
  const o = opts || {};
  const Hprefer = Math.max(1, Number(Hmax) || 1);
  const Houter = o.Houter != null ? Number(o.Houter) : Hprefer;
  const floorClear = Math.max(0, Number(o.floorClearMm) || 0);
  const Habs = cs8AbsolutePackHeightMm(Houter, floorClear);

  const A = Math.max(+u.l || 1, 1);
  const B = Math.max(+u.w || 1, 1);
  const C = Math.max(+u.h || 1, 1);
  const faces = [
    { l: A, w: B, h: C, rot: { x: 0, y: 0, z: 0 }, tag: 'yaw0', yawOnly: true },
    { l: A, w: B, h: C, rot: { x: 0, y: Math.PI, z: 0 }, tag: 'yaw180', yawOnly: true },
    { l: B, w: A, h: C, rot: { x: 0, y: Math.PI / 2, z: 0 }, tag: 'yaw90', yawOnly: true },
    { l: B, w: A, h: C, rot: { x: 0, y: -Math.PI / 2, z: 0 }, tag: 'yaw270', yawOnly: true },
    { l: A, w: C, h: B, rot: { x: Math.PI / 2, y: 0, z: 0 }, tag: 'Rx90', yawOnly: false },
    { l: A, w: C, h: B, rot: { x: Math.PI / 2, y: Math.PI, z: 0 }, tag: 'Rx90_Ry180', yawOnly: false },
    { l: C, w: A, h: B, rot: { x: Math.PI / 2, y: Math.PI / 2, z: 0 }, tag: 'Rx90_yaw90', yawOnly: false },
    { l: A, w: C, h: B, rot: { x: -Math.PI / 2, y: 0, z: 0 }, tag: 'Rx270', yawOnly: false },
    { l: C, w: A, h: B, rot: { x: -Math.PI / 2, y: Math.PI / 2, z: 0 }, tag: 'Rx270_yaw90', yawOnly: false },
    { l: B, w: C, h: A, rot: { x: 0, y: 0, z: Math.PI / 2 }, tag: 'Rz90', yawOnly: false },
    { l: C, w: B, h: A, rot: { x: 0, y: Math.PI / 2, z: Math.PI / 2 }, tag: 'Rz90_yaw90', yawOnly: false },
    { l: B, w: C, h: A, rot: { x: 0, y: 0, z: -Math.PI / 2 }, tag: 'Rz270', yawOnly: false },
  ];
  // First pass: which faces FIT (needed so onlyFit can soft-penalize the last option)
  const fitted = [];
  const seen = new Set();
  faces.forEach(f => {
    if (f.l > Lmax + CS8_EPS || f.w > Wmax + CS8_EPS) return;
    if (f.h > Habs + CS8_EPS) return;
    const key = f.yawOnly
      ? `${Math.round(f.l)}|${Math.round(f.w)}|${Math.round(f.h)}|${f.tag}`
      : `${Math.round(f.l)}|${Math.round(f.w)}|${Math.round(f.h)}`;
    if (seen.has(key)) return;
    seen.add(key);
    fitted.push(f);
  });
  // Unique footprints (yaw0/180 share dims) for only-fit detection
  const uniqFoot = new Set(fitted.map(f =>
    `${Math.round(f.l)}|${Math.round(f.w)}|${Math.round(f.h)}`));
  const onlyFit = uniqFoot.size === 1;

  const list = [];
  fitted.forEach(f => {
    const reducedTop = f.h > Hprefer + CS8_EPS;
    const baseArea = f.l * f.w;
    const tipRatio = f.h / Math.max(Math.min(f.l, f.w), 1);
    const tipPen = cs8OrientTipPenalty(f, u, onlyFit);
    const topPen = reducedTop ? 5e3 : 0;
    list.push({
      l: f.l, w: f.w, h: f.h,
      rot: { x: f.rot.x || 0, y: f.rot.y || 0, z: f.rot.z || 0 },
      tag: f.tag,
      shipPreferred: f.yawOnly && (f.tag === 'yaw0' || f.tag === 'yaw180') && !reducedTop,
      floorAnchor: true,
      packYawOnly: !!f.yawOnly,
      packComposeRot: !f.yawOnly,
      baseArea,
      tipRatio,
      reducedTopClearance: reducedTop,
      soleFit: onlyFit,
      tipPen,
      stabilityScore: baseArea - f.h * 40 - tipPen - topPen,
    });
  });

  // Sole envelope-fit pose = ALWAYS first (constraint-first)
  if (onlyFit && list.length) {
    list.forEach(o => {
      o.soleFit = true;
      o.shipPreferred = true;
      o.stabilityScore += 1e12;
    });
  } else if (list.length > 1) {
    list.forEach(o => {
      if (o.l >= Lmax * 0.70 && o.w <= Wmax + CS8_EPS && o.h <= Habs + CS8_EPS)
        o.stabilityScore += o.l * 0.5;
    });
  }

  list.sort((a, b) => (b.stabilityScore - a.stabilityScore)
    || (b.baseArea - a.baseArea)
    || ((a.tipRatio || 0) - (b.tipRatio || 0)));
  return list;
}

/** OPEN+concave (Z-style): two contact rails, not planar 80% bearing. */
function cs8NeedsTwoPointBase(u) {
  if (!u) return false;
  if (u.two_point_base || (u.rule1_orientation && u.rule1_orientation.two_point_base))
    return true;
  if (u.stabilityInfo && u.stabilityInfo.two_point_base) return true;
  if (typeof needsZStyleGroundFix === 'function') {
    try { return !!needsZStyleGroundFix(u); } catch (_) { /* */ }
  }
  return false;
}

/**
 * Rule1 Stage A/B → packer primary orients.
 * Rest-pose already baked in makeShape; only Y-yaw 0°/180° for door facing.
 * Does NOT re-roll Rx/Rz (that would undo N-position / warehouse face).
 */
function cs8Rule1PrimaryOrients(u, Lmax, Wmax, Hmax) {
  const r1 = u && (u.rule1_orientation
    || (u.stabilityInfo && u.stabilityInfo.rule1_orientation));
  if (!r1 || r1.ground_stable === false) return [];
  const L = Math.max(+u.l || 1, 1);
  const W = Math.max(+u.w || 1, 1);
  const H = Math.max(+u.h || 1, 1);
  if (L > Lmax + CS8_EPS || W > Wmax + CS8_EPS || H > Hmax + CS8_EPS) return [];
  const twoPt = !!(r1.two_point_base || cs8NeedsTwoPointBase(u));
  const base = L * W;
  const mk = (yaw, tag) => ({
    l: L, w: W, h: H,
    rot: { x: 0, y: yaw, z: 0 },
    tag,
    shipPreferred: true,
    floorAnchor: true,
    packYawOnly: true,
    packComposeRot: false,
    baseArea: base,
    tipRatio: H / Math.max(Math.min(L, W), 1),
    // Huge boost so Rule1 beats any fallback face-roll
    stabilityScore: base * 1e6 - (tag === 'rule1_yaw180' ? 1 : 0),
    rule1Primary: true,
    two_point_base: twoPt,
  });
  return [mk(0, 'rule1_yaw0'), mk(Math.PI, 'rule1_yaw180')];
}

/**
 * Orient list for placement:
 *   1) Rule1 primary (gravity pose) if present + fits
 *   2) Else / fallback: cs8StableBaseOrients or yaw orients
 * When `preferRule1Only`, return primary alone (caller retries fallback if empty).
 * opts: { Houter, floorClearMm } — allow upright near-full-height fits.
 */
function cs8ResolveTryOrients(u, Lmax, Wmax, Hmax, floorAnchor, preferRule1Only, opts) {
  const o = opts || {};
  const primary = cs8Rule1PrimaryOrients(u, Lmax, Wmax, Hmax);
  const fallback = floorAnchor
    ? cs8StableBaseOrients(u, Lmax, Wmax, Hmax, o)
    : cs8YawOrients(u, Lmax, Wmax, Hmax);
  if (primary.length && preferRule1Only !== false) {
    return { primary, fallback };
  }
  return { primary: [], fallback };
}

/**
 * Pass2 / non-anchor fill: prefer longitudinal; 90° for short loose pieces.
 * Floor-anchor callers use cs8StableBaseOrients instead.
 */
function cs8YawOrients(u, Lmax, Wmax, Hmax) {
  const L = u.l, W = u.w, H = u.h;
  const list = cs8YawOrientsFloorAnchor(u, Lmax, Wmax, Hmax).slice();
  const isAsm = cs8IsAssemblyUnit(u);
  const longMember = L >= Math.min(Lmax, Wmax) * 0.55;
  const fit90 = W <= Lmax + CS8_EPS && L <= Wmax + CS8_EPS && H <= Hmax + CS8_EPS;
  if (fit90 && !isAsm && !longMember && !cs8IsFloorAnchorCargo(u)) {
    list.push({
      l: W, w: L, h: H,
      rot: { x: 0, y: Math.PI / 2, z: 0 },
      tag: 'yaw90',
      shipPreferred: false,
      floorAnchor: false,
      packYawOnly: true,
      packComposeRot: false,
      baseArea: W * L,
      stabilityScore: W * L,
    });
  }
  return list;
}

// ── CoG balance ─────────────────────────────────────────────────────────────

function cs8ContainerCog(c, Lmax, Wmax) {
  const m = c.weightUsed || 0;
  const packX = m > 0 ? c.sumMX / m : Lmax / 2;
  const packZ = m > 0 ? c.sumMZ / m : Wmax / 2;
  const cogX_render = Lmax - packX; // door convention (same mirror as items)
  const cogZ_render = packZ - Wmax / 2;
  const offX = Math.abs(packX - Lmax / 2) / Math.max(Lmax / 2, 1);
  const offZ = Math.abs(packZ - Wmax / 2) / Math.max(Wmax / 2, 1);
  return {
    packX, packZ, cogX_render, cogZ_render, offX, offZ,
    balanced: offX <= cs8CogSoft() + 1e-9 && offZ <= cs8CogSoft() + 1e-9,
  };
}

/** Predicted CoG after placing mass at packer centre (cx, zFromLeft). */
function cs8PredictCog(c, weight, cx, zFromLeft, Lmax, Wmax) {
  const m = (c.weightUsed || 0) + weight;
  if (m <= 0) return { offX: 0, offZ: 0, soft: 0 };
  const packX = (c.sumMX + weight * cx) / m;
  const packZ = (c.sumMZ + weight * zFromLeft) / m;
  const offX = Math.abs(packX - Lmax / 2) / Math.max(Lmax / 2, 1);
  const offZ = Math.abs(packZ - Wmax / 2) / Math.max(Wmax / 2, 1);
  return { offX, offZ, packX, packZ, penalty: offX + offZ };
}

// ── taper station helpers (metadata only — no mesh morph) ───────────────────

function cs8ResolveTaperProfile(u) {
  if (!u) return null;
  if (u.taperProfile && u.taperProfile.stations && u.taperProfile.stations.length)
    return u.taperProfile;
  if (typeof isTaperedOrNonUniformItem === 'function' && isTaperedOrNonUniformItem(u)
      && typeof sampleTaperWidthProfile === 'function') {
    try { return sampleTaperWidthProfile(u); } catch (_) { /* */ }
  }
  return u.taperProfile || null;
}

/**
 * Station strips along member length for support/stamp.
 * alongPackX: member length runs along packer X (Option A); else along Z (Option B).
 */
function cs8BuildStations(u, orient) {
  // CRITICAL: yaw180 (π) is NOT yaw90 — length still along packer X
  const yaw90 = cs8OrientIsYaw90(orient);
  const memberL = Math.max(u.l || 1, 1);
  const aabbH = Math.max(u.h || orient.h || 1, 1);
  const aabbW = Math.max(u.w || 1, 1);
  const prof = cs8ResolveTaperProfile(u);
  const tapered = !!(prof && (prof.non_uniform || prof.height_non_uniform));

  if (!tapered || !(prof.stations && prof.stations.length)) {
    return {
      tapered: false,
      alongPackX: !yaw90,
      memberL,
      stations: [{ s: 0, width: yaw90 ? memberL : aabbW, topH: aabbH }],
    };
  }

  const hMax = Math.min(aabbH, Math.max(prof.maxHeightMm || aabbH, 1));
  const hMin = Math.min(hMax, Math.max(prof.minHeightMm || hMax, 1));
  const stations = prof.stations.map(st => {
    const s = Math.max(0, st.s_mm || 0);
    const w = Math.max(1, Math.min(st.width_mm || aabbW, yaw90 ? orient.l : orient.w));
    let h = st.height_mm;
    if (!(h > 0)) {
      if (prof.maxWidthMm > prof.minWidthMm + 1) {
        const t = ((st.width_mm || aabbW) - prof.minWidthMm)
          / (prof.maxWidthMm - prof.minWidthMm);
        h = hMin + Math.max(0, Math.min(1, t)) * (hMax - hMin);
      } else {
        h = aabbH;
      }
    }
    h = Math.min(Math.max(h, 1), aabbH);
    return { s, width: w, topH: h };
  });

  return { tapered: true, alongPackX: !yaw90, memberL, stations };
}

function cs8InterpStation(stations, s, memberL) {
  if (!stations || !stations.length) {
    return { s: 0, width: 1, topH: 1 };
  }
  if (stations.length === 1) return stations[0];
  const L = Math.max(memberL, stations[stations.length - 1].s, 1);
  const ss = Math.max(0, Math.min(s, L));
  if (ss <= stations[0].s) return stations[0];
  for (let i = 1; i < stations.length; i++) {
    if (ss <= stations[i].s + 1e-6) {
      const a = stations[i - 1], b = stations[i];
      const span = Math.max(b.s - a.s, 1e-6);
      const t = (ss - a.s) / span;
      return {
        s: ss,
        width: a.width + t * (b.width - a.width),
        topH: a.topH + t * (b.topH - a.topH),
      };
    }
  }
  return stations[stations.length - 1];
}

/** True contact cell? (inside station width — skips empty AABB corners on tapers). */
function cs8CellInStationMask(info, x0, z0, fl, fw, cellCx, cellCz) {
  const lx = cellCx - x0;
  const lz = cellCz - z0;
  let s, lat, halfLat;
  if (info.alongPackX) {
    s = lx;
    lat = lz - fw / 2;
    halfLat = fw / 2;
  } else {
    s = lz;
    lat = lx - fl / 2;
    halfLat = fl / 2;
  }
  if (!info.tapered) {
    return Math.abs(lat) <= halfLat + CS8_EPS
      ? { ok: true, st: info.stations[0] }
      : { ok: false, st: null };
  }
  const st = cs8InterpStation(info.stations, s, info.memberL);
  return Math.abs(lat) <= st.width * 0.5 + CS8_EPS
    ? { ok: true, st }
    : { ok: false, st: null };
}

// ── heightmap + placement ───────────────────────────────────────────────────

function cs8StampHeightmap(c, box, setter) {
  const set = setter || function (cc, ix, iz, y) {
    if (ix < 0 || iz < 0 || ix >= cc.nx || iz >= cc.nz) return;
    const i = iz * cc.nx + ix;
    if (y > cc.hm[i]) cc.hm[i] = y;
  };
  const ix0 = Math.max(0, Math.floor(box.minX / CS8_CELL_MM));
  const ix1 = Math.min(c.nx - 1, Math.ceil(box.maxX / CS8_CELL_MM) - 1);
  const iz0 = Math.max(0, Math.floor(box.minZ / CS8_CELL_MM));
  const iz1 = Math.min(c.nz - 1, Math.ceil(box.maxZ / CS8_CELL_MM) - 1);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) set(c, ix, iz, box.maxY);
  }
}

/** Stamp true top surface — tapered stations vary height/width (no phantom flat roof). */
function cs8StampUnitTop(c, pose, u) {
  const { x, z, y0, o, box } = pose;
  const info = cs8BuildStations(u, o);
  if (!info.tapered) {
    cs8StampHeightmap(c, box);
    return;
  }
  const fl = o.l, fw = o.w;
  const ix0 = Math.max(0, Math.floor(x / CS8_CELL_MM));
  const ix1 = Math.min(c.nx - 1, Math.ceil((x + fl) / CS8_CELL_MM) - 1);
  const iz0 = Math.max(0, Math.floor(z / CS8_CELL_MM));
  const iz1 = Math.min(c.nz - 1, Math.ceil((z + fw) / CS8_CELL_MM) - 1);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const cellCx = (ix + 0.5) * CS8_CELL_MM;
      const cellCz = (iz + 0.5) * CS8_CELL_MM;
      const hit = cs8CellInStationMask(info, x, z, fl, fw, cellCx, cellCz);
      if (!hit.ok || !hit.st) continue;
      const topY = y0 + hit.st.topH;
      const i = iz * c.nx + ix;
      if (topY > c.hm[i]) c.hm[i] = topY;
    }
  }
}

function cs8AabbCollide(a, b) {
  return a.maxX > b.minX + CS8_EPS && a.minX < b.maxX - CS8_EPS
    && a.maxY > b.minY + CS8_EPS && a.minY < b.maxY - CS8_EPS
    && a.maxZ > b.minZ + CS8_EPS && a.minZ < b.maxZ - CS8_EPS;
}

/**
 * Support under TRUE contact mask (station width for tapers).
 * Also measures left/right Z-edge strips for two-point (tip+joint) OPEN bases.
 */
function cs8EvalFootprint(c, x, z, fl, fw, u, o) {
  const info = cs8BuildStations(u, o || { l: fl, w: fw, h: u.h, rot: { y: 0 } });
  const ix0 = Math.max(0, Math.floor(x / CS8_CELL_MM));
  const ix1 = Math.min(c.nx - 1, Math.ceil((x + fl) / CS8_CELL_MM) - 1);
  const iz0 = Math.max(0, Math.floor(z / CS8_CELL_MM));
  const iz1 = Math.min(c.nz - 1, Math.ceil((z + fw) / CS8_CELL_MM) - 1);
  if (ix1 < ix0 || iz1 < iz0) return null;

  const twoPt = !!(o && o.two_point_base) || cs8NeedsTwoPointBase(u);
  const gapLim = Math.max(twoPt ? CS8_MAX_BASE_GAP_TWOPT_MM : CS8_MAX_BASE_GAP_MM, CS8_EPS);

  let supportY = 0;
  let cells = 0;
  let minY = Infinity;
  const samples = [];
  let leftCells = 0, leftSupp = 0, rightCells = 0, rightSupp = 0;

  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const cellCx = (ix + 0.5) * CS8_CELL_MM;
      const cellCz = (iz + 0.5) * CS8_CELL_MM;
      const hit = cs8CellInStationMask(info, x, z, fl, fw, cellCx, cellCz);
      if (!hit.ok) continue;
      const y = c.hm[iz * c.nx + ix];
      samples.push({ y, cellCz });
      if (y > supportY) supportY = y;
      if (y < minY) minY = y;
      cells++;
    }
  }
  if (cells <= 0) return null;

  let supportCells = 0;
  let lowCells = 0;
  let hangCells = 0;
  for (let i = 0; i < samples.length; i++) {
    const y = samples[i].y;
    const t = fw > 1e-6 ? (samples[i].cellCz - z) / fw : 0.5;
    const onSupport = Math.abs(y - supportY) <= CS8_EPS;
    if (onSupport) supportCells++;
    if (y < supportY - CS8_EPS) lowCells++;
    if (supportY - y > gapLim) hangCells++;
    // Edge rails ≈ tip / joint contact lines along length
    if (t <= 0.22) {
      leftCells++;
      if (onSupport || (supportY - y) <= gapLim) leftSupp++;
    }
    if (t >= 0.78) {
      rightCells++;
      if (onSupport || (supportY - y) <= gapLim) rightSupp++;
    }
  }
  const supportFrac = supportCells / cells;
  const overhangFrac = lowCells / cells;
  const hangFrac = hangCells / cells;
  const leftFrac = leftCells > 0 ? leftSupp / leftCells : 0;
  const rightFrac = rightCells > 0 ? rightSupp / rightCells : 0;
  const edgeSupportMin = Math.min(leftFrac, rightFrac);
  const twoPointOk = leftCells > 0 && rightCells > 0
    && edgeSupportMin + 1e-9 >= CS8_TWO_POINT_EDGE_MIN
    && hangFrac <= cs8OverhangMax() + 1e-9;

  // Flat base on sloped roof: >30% hanging air → reject
  if (hangFrac > cs8OverhangMax() + 1e-9) {
    return null;
  }

  return {
    supportY, supportFrac, overhangFrac, hangFrac,
    leftFrac, rightFrac, edgeSupportMin, twoPointOk,
    ix0, ix1, iz0, iz1, tapered: info.tapered,
  };
}

/** Support gate: planar 80% OR two-point rails for OPEN+concave. */
function cs8SupportAccepted(ev, u, o, supportMin, floorAnchor) {
  if (!ev) return false;
  const twoPt = !!(o && o.two_point_base) || (floorAnchor && cs8NeedsTwoPointBase(u));
  if (twoPt) return !!ev.twoPointOk;
  return ev.supportFrac + 1e-9 >= supportMin;
}

function cs8YawTagFromRad(y) {
  const a = Math.abs(Number(y) || 0) % (Math.PI * 2);
  if (a < 0.15 || Math.abs(a - Math.PI * 2) < 0.15) return 'yaw0';
  if (Math.abs(a - Math.PI) < 0.15) return 'yaw180';
  if (Math.abs(a - Math.PI / 2) < 0.15 || Math.abs(a - 3 * Math.PI / 2) < 0.15)
    return 'yaw90';
  return 'yaw';
}

function cs8FindPlacement(c, u, Lmax, Wmax, Hmax, wallGap, bundleGap, dunnageMm, placeOpts) {
  const po = placeOpts || {};
  const floorAnchor = !!po.floorAnchor;
  const log = Array.isArray(po.trialLog) ? po.trialLog : null;
  const mark = u.mark || (u.marks && u.marks[0]) || '?';
  const orientOpts = {
    Houter: po.Houter != null ? po.Houter : (u._Houter != null ? u._Houter : Hmax),
    floorClearMm: po.floorClearMm != null ? po.floorClearMm
      : (u._floorClearMm != null ? u._floorClearMm : 0),
  };

  // Rule1 continuity: Stage A/B gravity pose PRIMARY; face-roll fallback for fit
  const resolved = cs8ResolveTryOrients(
    u, Lmax, Wmax, Hmax, floorAnchor, true, orientOpts
  );
  let tryOrients;
  if (resolved.primary.length) {
    const fb = (resolved.fallback || []).filter(o => !o.rule1Primary);
    // If primary dims don't leave room but a face-roll does, still try rolls
    tryOrients = resolved.primary.concat(fb);
  } else {
    tryOrients = (resolved.fallback || []).slice();
  }

  // Pass2 / base lock: keep Pass1 footprint + rotation (no re-roll)
  if (po.lockedOrient && po.lockedOrient.l > 0) {
    tryOrients = [po.lockedOrient];
  } else if (po.lockedYaw != null && isFinite(po.lockedYaw)) {
    const fl = Math.max(u.packFootprintL || 0, 0);
    const fw = Math.max(u.packFootprintW || 0, 0);
    const fh = Math.max(u.packFootprintH || u.h || 0, 0);
    if (fl > 0 && fw > 0 && fh > 0) {
      const tag = cs8YawTagFromRad(po.lockedYaw);
      tryOrients = [{
        l: fl, w: fw, h: fh,
        rot: {
          x: (u.userRot && u.userRot.x) || 0,
          y: po.lockedYaw,
          z: (u.userRot && u.userRot.z) || 0,
        },
        tag,
        shipPreferred: tag === 'yaw0' || tag === 'yaw180',
        floorAnchor: true,
        packYawOnly: !!(u.packYawOnly !== false && !(u.packComposeRot)),
        packComposeRot: !!u.packComposeRot,
        baseArea: fl * fw,
        stabilityScore: fl * fw,
      }];
    } else {
      const locked = tryOrients.filter(o =>
        Math.abs((o.rot.y || 0) - po.lockedYaw) < 0.15);
      if (locked.length) tryOrients = locked;
    }
  }
  if (!tryOrients.length) {
    if (log) log.push({ type: 'orient_fail', mark, tag: '-', reason: 'no_orient_fits' });
    return null;
  }

  const supportMin = floorAnchor
    ? cs8FloorAnchorSupportMin()
    : cs8SupportMin();

  const candidates = [];

  for (const o of tryOrients) {
    const fl = o.l, fw = o.w, fh = o.h;
    if (log) {
      log.push({
        type: 'orient',
        mark,
        tag: o.tag,
        l: fl, w: fw, h: fh,
        rot: { x: o.rot.x || 0, y: o.rot.y || 0, z: o.rot.z || 0 },
        baseArea: o.baseArea || (fl * fw),
        packYawOnly: !!o.packYawOnly,
        packComposeRot: !!o.packComposeRot,
      });
    }
    const gaps = cs8EffectiveWallGaps(fl, fw, Lmax, Wmax);
    const gL = gaps.gL;
    const gW = gaps.gW;
    const gap = bundleGap != null ? bundleGap : cs8BundleGap();
    const scan = cs8BuildScanAxes(c, fl, fw, Lmax, Wmax, gL, gW, gap);
    const xMax0 = scan.xMax0;
    const zMax0 = scan.zMax0;
    if (xMax0 < gL - CS8_EPS || zMax0 < gW - CS8_EPS) {
      if (log) log.push({ type: 'orient_fail', mark, tag: o.tag, reason: 'envelope' });
      continue;
    }

    const xs = scan.xs;
    const zs = scan.zs;
    if (!xs.length || !zs.length) {
      if (log) log.push({ type: 'orient_fail', mark, tag: o.tag, reason: 'no_scan_axis' });
      continue;
    }

    // Sample corners + mid for live anim (full search still runs)
    const sampleXs = [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]]
      .filter((v, i, a) => v != null && a.indexOf(v) === i);
    const sampleZs = [zs[0], zs[Math.floor(zs.length / 2)], zs[zs.length - 1]]
      .filter((v, i, a) => v != null && a.indexOf(v) === i);
    let slotsLogged = 0;
    let orientHits = 0;

    for (let zi = 0; zi < zs.length; zi++) {
      for (let xi = 0; xi < xs.length; xi++) {
        const x = xs[xi];
        const z = zs[zi];
        const isSample = sampleXs.includes(x) && sampleZs.includes(z);

        const ev = cs8EvalFootprint(c, x, z, fl, fw, u, o);
        if (!ev) {
          if (log && isSample && slotsLogged < 5) {
            log.push({
              type: 'slot', mark, tag: o.tag, x, z, ok: false,
              reason: 'support_map', rot: o.rot, l: fl, w: fw, h: fh,
              packYawOnly: !!o.packYawOnly, packComposeRot: !!o.packComposeRot,
            });
            slotsLogged++;
          }
          continue;
        }
        if (!cs8SupportAccepted(ev, u, o, supportMin, floorAnchor)) {
          if (log && isSample && slotsLogged < 5) {
            const twoPt = !!(o.two_point_base) || cs8NeedsTwoPointBase(u);
            log.push({
              type: 'slot', mark, tag: o.tag, x, z, ok: false,
              reason: twoPt
                ? `two-point edge ${Math.round((ev.edgeSupportMin || 0) * 100)}%`
                : `bearing ${Math.round(ev.supportFrac * 100)}%`,
              supportFrac: ev.supportFrac,
              edgeSupportMin: ev.edgeSupportMin,
              rot: o.rot, l: fl, w: fw, h: fh,
              packYawOnly: !!o.packYawOnly, packComposeRot: !!o.packComposeRot,
            });
            slotsLogged++;
          }
          continue;
        }
        if (ev.overhangFrac - 1e-9 > cs8OverhangMax()) continue;

        let y0 = ev.supportY;
        if (y0 > CS8_EPS) {
          const belowFam = cs8FamilyUnder(c, x, z, fl, fw, y0);
          const myFam = u.groupKind || u.category || null;
          if (belowFam && myFam && belowFam !== myFam)
            y0 += (dunnageMm != null ? dunnageMm : cs8Dunnage());
        }

        if (floorAnchor && !cs8IsFloorOrSkidY(y0)) {
          if (log && isSample && slotsLogged < 5) {
            log.push({
              type: 'slot', mark, tag: o.tag, x, z, y0, ok: false,
              reason: 'not_floor', rot: o.rot, l: fl, w: fw, h: fh,
              packYawOnly: !!o.packYawOnly, packComposeRot: !!o.packComposeRot,
            });
            slotsLogged++;
          }
          continue;
        }

        // Prefer Hpack; allow absolute roof when upright needs reduced top clearance
        const Hceil = cs8AbsolutePackHeightMm(orientOpts.Houter, orientOpts.floorClearMm);
        if (y0 + fh > Hceil + CS8_EPS) continue;

        const box = {
          minX: x, maxX: x + fl,
          minY: y0, maxY: y0 + fh,
          minZ: z, maxZ: z + fw,
          family: u.groupKind || u.category || null,
        };
        const gap = bundleGap != null ? bundleGap : cs8BundleGap();
        const boxInfl = {
          minX: box.minX - gap * 0.5, maxX: box.maxX + gap * 0.5,
          minY: box.minY, maxY: box.maxY,
          minZ: box.minZ - gap * 0.5, maxZ: box.maxZ + gap * 0.5,
        };
        if (c.boxes.some(b => {
          const bi = {
            minX: b.minX - gap * 0.5, maxX: b.maxX + gap * 0.5,
            minY: b.minY, maxY: b.maxY,
            minZ: b.minZ - gap * 0.5, maxZ: b.maxZ + gap * 0.5,
          };
          return cs8AabbCollide(boxInfl, bi);
        })) {
          if (log && isSample && slotsLogged < 5) {
            log.push({
              type: 'slot', mark, tag: o.tag, x, z, y0, ok: false,
              reason: 'collision', rot: o.rot, l: fl, w: fw, h: fh,
              packYawOnly: !!o.packYawOnly, packComposeRot: !!o.packComposeRot,
            });
            slotsLogged++;
          }
          continue;
        }

        const cx = x + fl / 2;
        const zFromLeft = z + fw / 2;
        const cog = cs8PredictCog(c, u.weight, cx, zFromLeft, Lmax, Wmax);
        orientHits++;
        if (log && slotsLogged < 8) {
          log.push({
            type: 'slot', mark, tag: o.tag, x, z, y0, ok: true,
            supportFrac: ev.supportFrac,
            rot: o.rot, l: fl, w: fw, h: fh,
            packYawOnly: !!o.packYawOnly, packComposeRot: !!o.packComposeRot,
          });
          slotsLogged++;
        }
        candidates.push({
          x, z, y0, o, box, cog, fl, fw,
          supportFrac: ev.supportFrac,
          overhangFrac: ev.overhangFrac,
        });
      }
    }
    if (log && !orientHits) {
      log.push({ type: 'orient_fail', mark, tag: o.tag, reason: 'no_slot' });
    }
  }

  if (!candidates.length) {
    if (log) log.push({ type: 'orient_fail', mark, tag: '*', reason: 'no_candidate' });
    return null;
  }

  let pool = candidates;
  if (!floorAnchor) {
    const minY = Math.min(...candidates.map(p => p.y0));
    const shelf = candidates.filter(p => Math.abs(p.y0 - minY) <= CS8_CELL_MM);
    const cogSoft = cs8CogSoft();
    const softOk = shelf.some(p =>
      p.cog.offX <= cogSoft + 1e-9 && p.cog.offZ <= cogSoft + 1e-9);
    if (softOk) {
      pool = candidates.filter(p =>
        p.cog.offX <= CS8_COG_HARD + 1e-9 && p.cog.offZ <= CS8_COG_HARD + 1e-9);
      if (!pool.length) pool = candidates;
    }
  }

  // Hard envelope guard — never accept a pose that sticks through the wall
  pool = pool.filter(p =>
    p.fl <= Lmax + CS8_EPS
    && p.fw <= Wmax + CS8_EPS
    && (p.y0 + ((p.o && p.o.h) || 0)) <= cs8AbsolutePackHeightMm(
      orientOpts.Houter, orientOpts.floorClearMm
    ) + CS8_EPS
  );
  if (!pool.length) {
    if (log) log.push({ type: 'orient_fail', mark, tag: '*', reason: 'envelope_guard' });
    return null;
  }

  // If Rule1 gravity pose found ANY valid seat — never override with face-roll
  // UNLESS that seat is the only class… already filtered by envelope above.
  const rule1Pool = pool.filter(p => p.o && p.o.rule1Primary);
  if (rule1Pool.length) pool = rule1Pool;

  // Prefer ship yaw ONLY when a ship-preferred fit exists; never bury sole face-roll
  const anyShip = pool.some(p => p.o && p.o.shipPreferred);
  const anySole = pool.some(p => p.o && p.o.soleFit);

  // Select: lowest Y → sole-fit / stable → ship-preferred (if any) → CoG → X/Z
  let best = null;
  for (const p of pool) {
    const stabCost = -((p.o && p.o.stabilityScore) || (p.fl * p.fw) || 0);
    const yawCost = (anyShip && !anySole && p.o && p.o.shipPreferred === false) ? 1e8 : 0;
    const yaw180Cost = (p.o && (p.o.tag === 'yaw180' || p.o.tag === 'rule1_yaw180')) ? 1e5 : 0;
    const soleBonus = (p.o && p.o.soleFit) ? -1e11 : 0;
    const score = p.y0 * 1e12 + stabCost * 1e0 + yawCost + yaw180Cost + soleBonus
      + p.cog.penalty * 1e9 + p.x * 1e3 + p.z;
    if (!best || score < best.score) best = { score, ...p };
  }
  if (log && best) {
    log.push({
      type: 'accept',
      mark,
      tag: best.o.tag,
      x: best.x, z: best.z, y0: best.y0,
      l: best.fl, w: best.fw, h: best.o.h,
      rot: {
        x: best.o.rot.x || 0,
        y: best.o.rot.y || 0,
        z: best.o.rot.z || 0,
      },
      supportFrac: best.supportFrac,
      packYawOnly: !!best.o.packYawOnly,
      packComposeRot: !!best.o.packComposeRot,
    });
  }
  return best;
}

/** Family of box whose top ≈ supportY under footprint (for dunnage). */
function cs8FamilyUnder(c, x, z, fl, fw, supportY) {
  let fam = null;
  for (let i = c.boxes.length - 1; i >= 0; i--) {
    const b = c.boxes[i];
    if (Math.abs(b.maxY - supportY) > CS8_CELL_MM) continue;
    const overlap = !(x + fl <= b.minX || x >= b.maxX || z + fw <= b.minZ || z >= b.maxZ);
    if (overlap) { fam = b.family || null; break; }
  }
  return fam;
}

function cs8Commit(c, u, pose, Lmax, Wmax) {
  const { x, z, y0, o, box } = pose;
  c.boxes.push(box);
  cs8StampUnitTop(c, pose, u); // station top for tapers — not a flat phantom roof
  c.weightUsed += u.weight;
  c.volumeUsed += o.l * o.w * o.h;

  const cx = x + o.l / 2;
  const cy = y0 + o.h / 2;
  const cz = z + o.w / 2 - Wmax / 2; // render Z centered on container
  const zFromLeft = z + o.w / 2;

  c.sumMX += u.weight * cx;
  c.sumMZ += u.weight * zFromLeft;
  if (cz >= 0) c.rightWeight += u.weight;
  else c.leftWeight += u.weight;

  // SHAPE SAFE: makeShape uses construction dims (member L + sect).
  // Pack footprint o.* is heightmap AABB only — never rewrite sect geometry.
  const cL = u.lengthMm || u.l;
  const cW = u.widthMm || u.w;
  const cH = u.heightMm || u.h;
  c.items.push({
    ...u,
    lengthMm: cL,
    widthMm: cW,
    heightMm: cH,
    l: cL, w: cW, h: cH,
    packFootprintL: o.l,
    packFootprintW: o.w,
    packFootprintH: o.h,
    x: cx,
    y: cy,
    z: cz,
    userRot: {
      x: o.rot.x || 0,
      y: o.rot.y || 0,
      z: o.rot.z || 0,
    },
    // yaw-only = spin on rest-pose; compose = face-roll delta on rest-pose
    packYawOnly: o.packComposeRot ? false : (o.packYawOnly !== false),
    packComposeRot: !!o.packComposeRot,
    packPoseLock: true, // render must not gravity-rewrite this pose
    packOrientTag: o.tag || null,
    baseLayerLock: cs8IsFloorAnchorCargo(u),
    floorAnchor: cs8IsFloorOrSkidY(y0),
    anchorTier: cs8AnchorTier(u),
    unitWeightKg: u.weight,
    weight: u.weight,
    groupKind: u.groupKind || u.category || null,
    _supportFrac: pose.supportFrac,
    _overhangFrac: pose.overhangFrac,
    mutates_geometry: false,
  });
}

// ── Pass 2: compact (locked yaw) + residual fill ────────────────────────────

/** Convert a committed packer-space item back into a placeable unit. */
function cs8UnitFromPackedItem(it) {
  if (!it) return null;
  // Rest-pose AABB (pre-yaw) for leftover fill; Pass2 lock uses packFootprint*
  const l = Math.max(it.l || it.lengthMm || it.packFootprintL || 1, 1);
  const w = Math.max(it.w || it.widthMm || it.packFootprintW || 1, 1);
  const h = Math.max(it.h || it.heightMm || it.packFootprintH || 1, 1);
  const weight = Math.max(0, it.unitWeightKg || it.weight || 0);
  return {
    ...it,
    l, w, h,
    lengthMm: it.lengthMm || it.l || l,
    widthMm: it.widthMm || it.w || w,
    heightMm: it.heightMm || it.h || h,
    packFootprintL: it.packFootprintL || null,
    packFootprintW: it.packFootprintW || null,
    packFootprintH: it.packFootprintH || null,
    weight,
    unitWeightKg: weight,
    volume: Math.max(l * w * h, 1),
    pack_priority: weight / Math.max(l * w * h, 1),
    isAssembly: !!(it.isAssembly || it.baseLayerLock),
    mutates_geometry: false,
  };
}

/** Clear heightmap/boxes/items but keep seeded cargo, then re-stamp seeds. */
function cs8ResetContainerForCompact(c, seeds, Lmax, Wmax) {
  c.items = [];
  c.boxes = [];
  c.hm.fill(0);
  c.weightUsed = 0;
  c.volumeUsed = 0;
  c.leftWeight = 0;
  c.rightWeight = 0;
  c.sumMX = 0;
  c.sumMZ = 0;
  (seeds || []).forEach(it => {
    const fl = it.packFootprintL || it.lengthMm || it.l || 500;
    const fw = it.packFootprintW || it.widthMm || it.w || 200;
    const fh = it.packFootprintH || it.heightMm || it.h || 200;
    const cx = it.x, cy = it.y, cz = it.z;
    const box = {
      minX: cx - fl / 2, maxX: cx + fl / 2,
      minY: cy - fh / 2, maxY: cy + fh / 2,
      minZ: cz + Wmax / 2 - fw / 2, maxZ: cz + Wmax / 2 + fw / 2,
      family: it.groupKind || it.category || null,
    };
    const wt = it.unitWeightKg || it.weight || 0;
    c.weightUsed += wt;
    c.volumeUsed += fl * fw * fh;
    c.boxes.push(box);
    cs8StampHeightmap(c, box, (cont, ix, iz, y) => {
      if (ix < 0 || iz < 0 || ix >= cont.nx || iz >= cont.nz) return;
      const i = iz * cont.nx + ix;
      if (y > cont.hm[i]) cont.hm[i] = y;
    });
    c.sumMX += wt * cx;
    c.sumMZ += wt * (cz + Wmax / 2);
    if (cz >= 0) c.rightWeight += wt; else c.leftWeight += wt;
    c.items.push({ ...it, _seeded: true });
  });
}

/** Force-commit prior pose if compact search fails (never drop cargo). */
function cs8ForceCommitPackedItem(c, it, Lmax, Wmax) {
  const fl = it.packFootprintL || it.lengthMm || it.l || 500;
  const fw = it.packFootprintW || it.widthMm || it.w || 200;
  const fh = it.packFootprintH || it.heightMm || it.h || 200;
  const cx = it.x, cy = it.y, cz = it.z;
  const box = {
    minX: cx - fl / 2, maxX: cx + fl / 2,
    minY: cy - fh / 2, maxY: cy + fh / 2,
    minZ: cz + Wmax / 2 - fw / 2, maxZ: cz + Wmax / 2 + fw / 2,
    family: it.groupKind || it.category || null,
  };
  const wt = it.unitWeightKg || it.weight || 0;
  const pose = {
    x: box.minX, z: box.minZ, y0: box.minY,
    o: {
      l: fl, w: fw, h: fh,
      rot: it.userRot || { x: 0, y: 0, z: 0 },
    },
    box,
  };
  c.weightUsed += wt;
  c.volumeUsed += fl * fw * fh;
  c.boxes.push(box);
  cs8StampUnitTop(c, pose, it);
  c.sumMX += wt * cx;
  c.sumMZ += wt * (cz + Wmax / 2);
  if (cz >= 0) c.rightWeight += wt; else c.leftWeight += wt;
  c.items.push({ ...it });
}

/**
 * Pass2: re-seat with locked Pass1 yaw (assemblies base-locked),
 * then retry leftovers into freed gaps. Positions only — no tip.
 */
function cs8Pass2CompactAndFill(
  containers, oversized, Lmax, Wmax, Hpack,
  wallGap, bundleGap, dunnageMm, maxKg, maxContainers, placementSteps
) {
  let compacted = 0;
  let filled = 0;

  (containers || []).forEach(c => {
    const prev = (c.items || []).slice();
    if (prev.length < 1) return;
    const seeds = prev.filter(it => it._seeded);
    const movable = prev.filter(it => !it._seeded);
    if (!movable.length) return;

    movable.sort((a, b) => {
      const ta = a.anchorTier != null ? a.anchorTier : cs8AnchorTier(a);
      const tb = b.anchorTier != null ? b.anchorTier : cs8AnchorTier(b);
      if (ta !== tb) return ta - tb;
      const dw = (b.weight || 0) - (a.weight || 0);
      if (Math.abs(dw) > 1e-6) return dw;
      return (a.x || 0) - (b.x || 0);
    });

    cs8ResetContainerForCompact(c, seeds, Lmax, Wmax);

    movable.forEach(it => {
      const u = cs8UnitFromPackedItem(it);
      const isAnchor = !!(it.baseLayerLock || it.floorAnchor || cs8IsFloorAnchorCargo(it));
      const fl = it.packFootprintL || u.l;
      const fw = it.packFootprintW || u.w;
      const fh = it.packFootprintH || u.h;
      const lockedOrient = {
        l: fl, w: fw, h: fh,
        rot: {
          x: (it.userRot && it.userRot.x) || 0,
          y: (it.userRot && it.userRot.y) || 0,
          z: (it.userRot && it.userRot.z) || 0,
        },
        tag: it.packOrientTag || 'locked',
        shipPreferred: true,
        floorAnchor: isAnchor,
        packYawOnly: !!it.packYawOnly,
        packComposeRot: !!it.packComposeRot,
        baseArea: fl * fw,
        stabilityScore: fl * fw,
      };
      // Shipping: keep Pass1 face/yaw; only slide position
      const pose = cs8FindPlacement(
        c, u, Lmax, Wmax, Hpack, wallGap, bundleGap, dunnageMm,
        { lockedOrient, pass: 2, floorAnchor: isAnchor }
      );
      if (pose) {
        const prevX = it.x;
        cs8Commit(c, u, pose, Lmax, Wmax);
        const last = c.items[c.items.length - 1];
        last.baseLayerLock = isAnchor;
        last.floorAnchor = isAnchor;
        last.anchorTier = cs8AnchorTier(it);
        if (Math.abs((last.x || 0) - (prevX || 0)) > CS8_CELL_MM * 0.5) compacted++;
      } else {
        cs8ForceCommitPackedItem(c, it, Lmax, Wmax);
      }
    });
  });

  // Residual fill: floor-anchor leftovers still Rule #1; loose may stack (40%)
  for (let i = oversized.length - 1; i >= 0; i--) {
    const u0 = oversized[i];
    // Hard envelope / weight fails cannot be fixed by gap fill
    if (/LENGTH_EXCEEDS|WIDTH_EXCEEDS|HEIGHT_EXCEEDS|ORIENT_INCOMPATIBLE|WEIGHT_LIMIT|needs_human_review/i
        .test(String(u0.fitReason || ''))) continue;
    const u = cs8UnitFromPackedItem(u0) || u0;
    if (!u || !(u.weight >= 0)) continue;
    const isAnchor = cs8IsFloorAnchorCargo(u);

    let placed = false;
    for (const c of containers) {
      if (c.weightUsed + (u.weight || 0) > maxKg + 1e-6) continue;
      const pose = cs8FindPlacement(
        c, u, Lmax, Wmax, Hpack, wallGap, bundleGap, dunnageMm,
        { pass: 2, floorAnchor: isAnchor }
      );
      if (!pose) continue;
      cs8Commit(c, u, pose, Lmax, Wmax);
      const last = c.items[c.items.length - 1];
      last.baseLayerLock = isAnchor;
      last.floorAnchor = isAnchor;
      last.anchorTier = cs8AnchorTier(u);
      if (placementSteps) {
        placementSteps.push({
          mark: last.mark,
          marks: last.marks ? [...last.marks] : [last.mark],
          isAssembly: !!last.baseLayerLock,
          floorAnchor: isAnchor,
          pass: 2,
          containerNumber: containers.indexOf(c) + 1,
        });
      }
      placed = true;
      filled++;
      break;
    }
    if (placed) oversized.splice(i, 1);
  }

  return { compacted, filled };
}
