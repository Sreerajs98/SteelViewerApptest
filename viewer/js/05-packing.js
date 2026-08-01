/* 05-packing.js — expandUnits, layoutQuick/Optimized */

const ABS_MAX_MM = 50000;
const ABS_MAX_KG = 50000;

function findDataProblems(it) {
  const problems = [];
  const checkDim = (val, label) => {
    if (!isFinite(val) || val === null || val === undefined) problems.push(`${label} is missing/invalid`);
    else if (val <= 0) problems.push(`${label} is ${val} (must be > 0)`);
    else if (val > ABS_MAX_MM) problems.push(`${label} is ${Math.round(val)}mm - exceeds ${ABS_MAX_MM}mm sanity limit`);
  };
  checkDim(it.lengthMm, 'length');
  checkDim(it.widthMm, 'width');
  checkDim(it.heightMm, 'height');
  if (!isFinite(it.unitWeightKg) || it.unitWeightKg === null || it.unitWeightKg === undefined)
    problems.push('weight is missing/invalid');
  else if (it.unitWeightKg <= 0) problems.push(`weight is ${it.unitWeightKg} (must be > 0)`);
  else if (it.unitWeightKg > ABS_MAX_KG) problems.push(`weight is ${Math.round(it.unitWeightKg)}kg - exceeds sanity limit`);
  return problems;
}

// Real fill factors (steel volume ÷ bounding-box volume) for common
// structural profiles. Only applied when the C# side flagged the weight
// as "estimated from geometry" - i.e. the IFC had no property-set weight
// and we fell back to bounding-box × steel-density (7850 kg/m³). For a
// cold-formed Z-purlin that's off by ~50× because a Z is mostly air.
// Values are conservative averages across common gauges.
const FILL_FACTORS = {
  plate:     1.00,   // solid sheet
  rod:       1.00,   // solid bar
  bent_sag_rod: 1.00,
  z_channel: 0.08,   // cold-formed Z, thin walls
  c_channel: 0.08,   // cold-formed C
  l_angle:   0.15,   // hot-rolled L, thicker
  i_beam:    0.20,   // hot-rolled I
  rhs:       0.30    // rectangular hollow section
};

/** Max plausible single cargo unit (kg) — above this cannot be real kg for one placeable unit. */
const WEIGHT_MAX_UNIT_KG = 26000;

/**
 * Prefer section formula over fat assembly AABB (AABB×0.08 often looks like tonnes
 * and blocks grams→kg for rods/plates).
 */
function estimateBboxSteelKg(it) {
  if (!it) return 0;
  const L = Math.max(0, Number(it.lengthMm) || 0);
  const sk = String(it.shapeKey || it.profileShape || '').toLowerCase();
  const blob = `${it.profileDesc || ''} ${it.mark || ''} ${it.assemblyName || ''}`.toUpperCase();
  const dens = 7850;

  // Solid rod / hex bar
  if (sk === 'rod' || sk === 'bent_sag_rod' || /\bROD\b|HEX|ROUND.?BAR/.test(blob)) {
    const d = Math.max(
      Number(it.pathDiamMm) || 0,
      Number(it.sectD) || 0,
      Number(it.sectW) || 0,
      Number(it.sectH) || 0,
      20
    );
    if (L > 0 && d > 0)
      return Math.PI * Math.pow(d / 2000, 2) * (L / 1000) * dens;
  }
  // Plate / flat
  if (sk === 'plate' || /\bPL(ATE)?\b|\bFLAT\b|PANEL/.test(blob)) {
    const th = Math.max(Number(it.sectT) || 0, Math.min(Number(it.heightMm) || 0, Number(it.widthMm) || 0) || 0, 6);
    const W = Math.max(Number(it.sectW) || 0, Number(it.widthMm) || 0, Number(it.heightMm) || 0, 1);
    if (L > 0 && W > 0 && th > 0)
      return (L / 1000) * (W / 1000) * (th / 1000) * dens;
  }

  const W = Math.max(0, Number(it.widthMm) || Number(it.sectW) || 0);
  const H = Math.max(0, Number(it.heightMm) || Number(it.sectH) || 0);
  if (!(L > 0 && W > 0 && H > 0)) return 0;
  // Cap fill so huge assembly AABB cannot “prove” a 20t reading is kg
  const fill = (it.isAssembly && it.parts && it.parts.length >= 2) ? 0.04 : 0.08;
  return (L * W * H) / 1e9 * dens * fill;
}

/**
 * IFC mass → kg. Explicit shipping rule: unit > 26t cannot be kg.
 * e.g. 27900 / 16866 (grams) → 27.9 / 16.9 kg when estimate is light.
 */
function normalizeMassToKg(raw, estimateKg) {
  const w = Number(raw);
  if (!(w > 0) || !isFinite(w)) return 0;
  const est = Math.max(0, Number(estimateKg) || 0);
  const asG = w / 1000;
  const asT = w * 1000;

  // Hard: exceeds container payload as one unit → must be grams
  if (w > WEIGHT_MAX_UNIT_KG && asG >= 0.05 && asG <= WEIGHT_MAX_UNIT_KG)
    return asG;

  // Estimate-guided (cap est so fat AABB cannot prefer raw tonnes)
  const estUse = est >= 1 ? Math.min(est, 5000) : 0;
  if (estUse >= 1) {
    let best = w;
    let bestScore = Infinity;
    [w, asG, asT].forEach(c => {
      if (c < 0.05 || c > WEIGHT_MAX_UNIT_KG) return;
      const ratio = c / estUse;
      if (ratio < 0.05 || ratio > 25) return;
      const score = Math.abs(Math.log(ratio));
      if (score < bestScore) { bestScore = score; best = c; }
    });
    if (bestScore < Infinity) return best;

    // Light section (rod/plate est < 500 kg) + huge raw → grams
    if (estUse < 500 && w >= 5000 && asG >= 0.5 && asG <= 5000)
      return asG;
  }

  // No / weak estimate: only convert clear container-busting leftovers
  if (w > 100000) return asG;
  if (w < 0.05) return asT;
  return w;
}

function normalizeItemWeightKg(it, force) {
  if (!it) return it;
  if (it._weightUnitNormalized && !force) {
    // Re-fix if still impossible as kg
    const cur = Number(it.unitWeightKg) || 0;
    if (!(cur > WEIGHT_MAX_UNIT_KG)) return it;
  }
  const est = estimateBboxSteelKg(it);
  const before = Number(it.unitWeightKg) || 0;
  if (before > 0) {
    const after = normalizeMassToKg(before, est);
    if (after > 0 && Math.abs(after - before) > 1e-6) {
      it.unitWeightKg = after;
      if (it.weight != null) it.weight = after * Math.max(1, it.qty || 1);
      it._weightWasScaled = true;
      try {
        console.info(
          `[weight-unit] ${it.mark || '?'} ${Math.round(before)} → ${after.toFixed(2)} kg`
          + ` (est≈${est.toFixed(1)} kg)`
        );
      } catch (_) { /* */ }
    }
  }
  it._weightUnitNormalized = true;
  return it;
}

function applyWeightCorrection(items) {
  items.forEach(it => {
    normalizeItemWeightKg(it);
    if (!it.weightEstimated) return;             // real property-set weight → trust scale fix above
    if (it._weightCorrected) return;
    // C# EstimateSteelWeightKg already applied bbox×7850×0.08.
    // Do NOT multiply by FILL_FACTORS again (was crushing e.g. 3655kg → 731kg).
    it._weightCorrected = true;
  });
}

function validateRawItems(items) {
  applyWeightCorrection(items);
  const valid = [], issues = [];
  items.forEach(it => {
    const problems = findDataProblems(it);
    if (problems.length > 0) issues.push({ mark:it.mark, assemblyName:it.assemblyName, qty:it.qty,
      lengthMm:it.lengthMm, widthMm:it.widthMm, heightMm:it.heightMm, unitWeightKg:it.unitWeightKg, problems });
    else valid.push(it);
  });
  return { valid, issues };
}

const CHANNEL_NEST_FACTOR = 0.35;

// Expand items into packable units. Real-world grouping rules:
//   - Plates same-mark  -> ONE stacked bundle (thickness × qty)
//   - Purlins/channels same-mark -> ONE nested bundle (C-sections tuck inside each other)
//   - Rods same-mark -> ONE bundled bunch (arranged in a compact grid pattern, strapped)
//   - Beams same-mark -> ONE side-by-side bundle (stacked in a column with dunnage)
//   - Anything else with qty > 1 -> ONE bundled group at the same section
// Individual same-mark items are almost never loaded loose - they arrive at
// the container as pre-bundled units, so packing them one-at-a-time is
// what wastes space.
function expandUnits(items, spec) {
  const units = [];
  const groups = {};

  items.forEach(it => {
    // Part profile wins over empty parent / name guess (shared resolveItemProfile)
    const resolved = (typeof resolveItemProfile === 'function')
      ? resolveItemProfile(it)
      : null;
    const profileDesc = (resolved && resolved.profileDesc) || it.profileDesc || '';
    let profileShape = (resolved && resolved.profileShape) || null;
    let shapeKey = (resolved && resolved.shapeKey) || it.shapeKey || null;
    let sectH = (resolved && resolved.sectH) || it.sectH || 0;
    let sectW = (resolved && resolved.sectW) || it.sectW || 0;
    let sectT = (resolved && resolved.sectT) || it.sectT || 0;
    let sectD = (resolved && resolved.sectD) || it.sectD || 0;
    let sectTf = (resolved && resolved.sectTf) || it.sectTf || 0;
    let sectTw = (resolved && resolved.sectTw) || it.sectTw || 0;
    if (!profileShape) {
      const detected = detectProfileShape(profileDesc, it.assemblyName);
      profileShape = detected ? detected.shape : null;
    }
    if (!shapeKey && profileShape) shapeKey = profileShape;

    // Bent sag rod: IFC path / name / shapeKey wins over generic rod
    if ((it.pathPointsMm && it.pathPointsMm.length >= 3) || isBentSagRodItem(it)
        || shapeKey === 'bent_sag_rod' || profileShape === 'bent_sag_rod') {
      profileShape = 'bent_sag_rod';
      shapeKey = 'bent_sag_rod';
      if (it.pathDiamMm > 0) { sectH = it.pathDiamMm; sectW = it.pathDiamMm; sectT = it.pathDiamMm; }
    }

    // Welded multi-part assemblies: AABB envelope + exact parts mesh (no nest merge).
    // Nestable single-part (or clear Z/C/L/plate/rod profile) falls through to yard bundling.
    const shapeIdEarly = shapeKey || profileShape || '-';
    const nestableProfile = shapeIdEarly === 'z_channel' || shapeIdEarly === 'c_channel'
      || shapeIdEarly === 'l_angle' || shapeIdEarly === 'plate' || shapeIdEarly === 'rod'
      || shapeIdEarly === 'bent_sag_rod' || shapeIdEarly === 'rhs' || shapeIdEarly === 'i_beam'
      || shapeIdEarly === 'h_beam' || it.category === 'rod' || it.category === 'plate'
      || it.category === 'beam' || it.category === 'purlin';
    // SAG_ROD_ASSY / bent sag — never take welded assembly mesh path
    const isBentSag = shapeKey === 'bent_sag_rod' || profileShape === 'bent_sag_rod'
      || (typeof isBentSagRodItem === 'function' && isBentSagRodItem(it));

    const multiPartAsm = it.isAssembly && it.parts && it.parts.length >= 2;
    const singleNestableAsm = it.isAssembly && it.parts && it.parts.length === 1 && nestableProfile;

    if (!isBentSag && (multiPartAsm || (it.isAssembly && it.parts && it.parts.length >= 1 && !singleNestableAsm && !nestableProfile))) {
      let l = Math.max(1, it.lengthMm || 0);
      let w = Math.max(1, it.widthMm || 0);
      let h = Math.max(1, it.heightMm || 0);
      if (!(it.lengthMm > 0 && it.widthMm > 0 && it.heightMm > 0)) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        it.parts.forEach(p => {
          const hx = (p.boxXMm || p.lengthMm || 0) / 2;
          const hy = (p.boxYMm || p.heightMm || 0) / 2;
          const hz = (p.boxZMm || p.widthMm || 0) / 2;
          const cx = p.offsetXMm || 0, cy = p.offsetYMm || 0, cz = p.offsetZMm || 0;
          minX = Math.min(minX, cx - hx); maxX = Math.max(maxX, cx + hx);
          minY = Math.min(minY, cy - hy); maxY = Math.max(maxY, cy + hy);
          minZ = Math.min(minZ, cz - hz); maxZ = Math.max(maxZ, cz + hz);
        });
        l = Math.max(1, maxX - minX);
        h = Math.max(1, maxY - minY);
        w = Math.max(1, maxZ - minZ);
      }
      units.push({
        mark: it.mark,
        marks: [it.mark],
        assemblyName: it.assemblyName,
        category: it.category,
        profileShape: profileShape || shapeKey,
        profileDesc: profileDesc || it.profileDesc || '',
        remarks: it.remarks || '',
        l, w, h,
        lengthMm: l, widthMm: w, heightMm: h,
        shapeKey,
        sectH, sectW, sectT, sectTf, sectTw, sectD,
        sectFromPset: it.sectFromPset || false,
        weight: it.qty * it.unitWeightKg,
        qty: it.qty,
        isAssembly: true,
        parts: it.parts,
        packEnvelope: 'assembly_aabb',
        nested: false,
        stacked: false,
        bundled: false,
      });
      return;
    }

    // Pack-unit members already length-chunked by createPackUnits.
    // Nest Z/C/L: merge by section (+ surface/dest) — length lives on nestPieces.
    const shapeId = shapeKey || profileShape || '-';
    const isNestable = shapeId === 'z_channel' || shapeId === 'c_channel' || shapeId === 'l_angle'
      || shapeId === 'rod' || shapeId === 'bent_sag_rod' || shapeId === 'rhs'
      || shapeId === 'plate' || it.category === 'rod' || it.category === 'plate';
    const lenBin = Math.round(it.lengthMm / 50) * 50;
    const hBin = Math.round((sectH || it.heightMm || 0) / 2) * 2;
    const wBin = Math.round((sectW || it.widthMm || 0) / 2) * 2;
    const tStr = sectT > 0 ? (Math.round(sectT / 0.15) * 0.15).toFixed(2) : '-';
    const surf = String(it.surfaceTreatment || 'BARE').toUpperCase();
    const dest = String(it.destination || 'DEFAULT').toUpperCase();
    const specFlag = it.specialHandling ? 'SPEC' : 'NORM';
    const key = (shapeId === 'z_channel' || shapeId === 'c_channel' || shapeId === 'l_angle')
      ? `${shapeId}|H${hBin}|W${wBin}|T${tStr}|${surf}|${dest}|${specFlag}`
      : (shapeId === 'plate' || it.category === 'plate')
        ? `plate|th${tStr}|A${Math.max(hBin, wBin)}|B${Math.min(hBin, wBin)}|L${lenBin}|${surf}|${dest}`
      : (shapeId === 'rhs')
        ? `rhs|H${hBin}|W${wBin}|L${lenBin}|${surf}|${dest}`
      : (shapeId === 'bent_sag_rod')
        ? `bent_sag|D${hBin}|${surf}|${dest}`
      : isNestable
        ? `${shapeId}|H${hBin}|T${tStr}|L${lenBin}|${surf}|${dest}`
        : `${shapeId}|${it.mark}|${Math.round(it.lengthMm)}|${Math.round(it.widthMm)}|${Math.round(it.heightMm)}`;
    if (!groups[key]) {
      groups[key] = {
        mark: it.mark, assemblyName: it.assemblyName, category: it.category,
        profileShape: profileShape || shapeKey,
        profileDesc: profileDesc || it.profileDesc || '',
        l: it.lengthMm, w: it.widthMm, h: it.heightMm,
        shapeKey,
        sectH, sectW, sectT, sectTf, sectTw, sectD,
        sectFromPset: it.sectFromPset || false,
        weight: 0, qty: 0, marks: [],
        nestPieces: [],
        pathPointsMm: it.pathPointsMm || null,
        pathDiamMm: it.pathDiamMm || 0,
        orientation_info: it.orientation_info || null,
        best_orientation: it.best_orientation || null,
        oriented_height: it.oriented_height || null,
        oriented_width: it.oriented_width || null,
        oriented_length: it.oriented_length || null,
      };
    } else if (!groups[key].orientation_info && it.orientation_info) {
      groups[key].orientation_info = it.orientation_info;
      groups[key].best_orientation = it.best_orientation || groups[key].best_orientation;
    }
    if (!groups[key].marks.includes(it.mark)) groups[key].marks.push(it.mark);
    // Prefer largest section as the "primary" stamp for envelope estimates
    if ((sectH || 0) >= (groups[key].sectH || 0)) {
      groups[key].sectH = sectH || groups[key].sectH;
      groups[key].sectW = sectW || groups[key].sectW;
      groups[key].sectT = sectT || groups[key].sectT;
      groups[key].sectD = sectD || groups[key].sectD;
      groups[key].sectTf = sectTf || groups[key].sectTf;
      groups[key].sectTw = sectTw || groups[key].sectTw;
      groups[key].shapeKey = shapeKey || groups[key].shapeKey;
      groups[key].profileDesc = it.profileDesc || groups[key].profileDesc;
      groups[key].l = Math.max(groups[key].l, it.lengthMm);
      if (it.pathPointsMm && it.pathPointsMm.length >= 3) {
        groups[key].pathPointsMm = it.pathPointsMm;
        groups[key].pathDiamMm = it.pathDiamMm || groups[key].pathDiamMm;
      }
    }
    if (shapeId === 'z_channel' || shapeId === 'c_channel' || shapeId === 'l_angle') {
      groups[key].nestPieces.push({
        mark: it.mark,
        qty: it.qty,
        sectH: sectH || it.heightMm,
        sectW: sectW || 0,
        sectT: sectT || 0,
        sectD: sectD || 0,
        profileDesc: it.profileDesc || '',
        lengthMm: it.lengthMm,
      });
    }
    if (isNestable && groups[key].marks.length > 1) {
      groups[key].mark = groups[key].profileDesc || shapeId;
    }
    groups[key].qty += it.qty;
    groups[key].weight += it.qty * it.unitWeightKg;
  });

  function bestGrid(qty, unitW, unitH) {
    // Prefer nearly-square packs — never a 1×N tower (tubes/plates/beams)
    let bestCols = Math.max(1, Math.round(Math.sqrt(qty)));
    let bestRows = Math.ceil(qty / bestCols);
    let bestScore = Infinity;
    const maxRows = Math.max(2, Math.min(qty, Math.ceil(Math.sqrt(qty) * 1.6), 10));
    for (let cols = 1; cols <= qty; cols++) {
      const rows = Math.ceil(qty / cols);
      if (rows > maxRows && cols < qty) continue; // skip tall towers
      const w = cols * unitW;
      const h = rows * unitH;
      const aspect = Math.max(w, h) / Math.max(Math.min(w, h), 1e-6);
      let score = Math.max(w, h) * (1 + 0.2 * Math.max(0, aspect - 1.3));
      if (cols === 1 && qty > 3) score *= 4; // heavily penalize single-column towers
      if (rows === 1 && qty > 6) score *= 1.4;
      if (score < bestScore) {
        bestScore = score;
        bestCols = cols;
        bestRows = rows;
      }
    }
    return { cols: bestCols, rows: bestRows };
  }

  /** Compact nest: nearly-square columns, NEVER a 1×N tower. */
  function nestColumns(qty, unitH, step, maxH) {
    const limit = Math.min(maxH > 0 ? maxH : 2500, 900); // keep bundles low
    const maxStack = Math.max(2, Math.min(12,
      step > 0 ? Math.floor((limit - unitH) / step) + 1 : 12));
    // Prefer ~sqrt columns of modest height
    let nStack = Math.min(qty, Math.max(2, Math.min(maxStack, Math.ceil(Math.sqrt(qty)))));
    let colH = unitH + Math.max(0, nStack - 1) * step;
    if (colH > limit && step > 0) {
      nStack = Math.max(1, Math.floor((limit - unitH) / step) + 1);
      colH = unitH + Math.max(0, nStack - 1) * step;
    }
    const nCols = Math.ceil(qty / nStack);
    return { nStack, nCols, colH };
  }

  function makeBundle(g, qty) {
    const weight = g.weight * (qty / g.qty);
    // sect passthrough — always carry exact dims into the bundle so
    // makeShape/makeZPurlinBundle/makeChannelBundle use them.
    const sectPass = {
      shapeKey: g.shapeKey, sectH: g.sectH, sectW: g.sectW,
      sectT: g.sectT, sectTf: g.sectTf, sectTw: g.sectTw,
      sectD: g.sectD, sectFromPset: g.sectFromPset
    };
    const nestInfo = (typeof resolveNestingInfo === 'function')
      ? resolveNestingInfo(g)
      : (g.nestingInfo || null);
    const base = {
      mark: g.mark, assemblyName: g.assemblyName,
      category: g.category, profileShape: g.profileShape,
      marks: g.marks && g.marks.length ? [...g.marks] : [g.mark],
      nestingInfo: nestInfo || undefined,
      nestingOffsetMm: nestInfo?.nesting_offset || g.nestingOffsetMm || 0,
      nestMethod: g.nestMethod || nestInfo || undefined,
      orientation_info: g.orientation_info || undefined,
      stabilityInfo: g.stabilityInfo || undefined,
      ...sectPass
    };

    // ── Resolve SECTION dimensions for bundling math ───────────────────────
    // For thin-walled cold-formed sections (Z, C, L), the bounding-box
    // widthMm/heightMm from IFC is the ASSEMBLY BOUNDING BOX, not the
    // section profile dims. We must use sectH (web height) and sectW (flange
    // width) when available, otherwise fall back to bbox with a shape-aware
    // correction.
    const p = g.profileShape || null;

    // Resolve section HEIGHT (web height for Z/C, leg for L, overall H for I)
    let sH, sW;
    if (g.sectH > 0) {
      sH = g.sectH;
      sW = g.sectW > 0 ? g.sectW : g.sectH * 0.32;
    } else if (p === 'z_channel' || p === 'c_channel') {
      const a = Math.max(g.h || 0, g.w || 0);
      const b = Math.min(g.h || 0, g.w || 0);
      if (a > 0 && a <= 420) sH = a;
      else if (b >= 80 && b <= 420) sH = b;
      else sH = Math.min(Math.max(a || 200, 100), 300);
      sW = sH * 0.32; // never use raw bbox W as flange
    } else if (p === 'l_angle') {
      sH = g.sectH > 0 ? g.sectH : Math.max(Math.min(g.h || 50, g.w || 50), 20);
      sW = g.sectW > 0 ? g.sectW : sH;
    } else {
      sH = g.h;
      sW = g.w;
    }
    const sT = g.sectT > 0 ? g.sectT
             : (p === 'z_channel' || p === 'c_channel' ? sH * 0.012 : sH * 0.09);
    const sD = g.sectD > 0 ? g.sectD : sH * 0.085;

    // Stamp resolved section onto the unit so makeShape/_sdim stay consistent
    // across every IFC (parsed or bbox-fallback).
    if (p === 'z_channel' || p === 'c_channel' || p === 'l_angle') {
      base.sectH = base.sectH > 0 ? base.sectH : sH;
      base.sectW = base.sectW > 0 ? base.sectW : sW;
      base.sectT = base.sectT > 0 ? base.sectT : sT;
      base.sectD = base.sectD > 0 ? base.sectD : sD;
      base.shapeKey = base.shapeKey || p;
    }

    if (qty === 1) {
      // C: laid flat (opening up) → h=flange depth, w=web
      if (p === 'c_channel') {
        return { ...base, l:g.l, w:sH, h:sW, weight, qty:1, stacked:false,
                 unitWidth:sW, unitHeight:sH, channelLength:g.l,
                 cLaidFlat: true };
      }
      const thickness = (p === 'plate' || g.category === 'plate')
        ? (g.sectH > 0 ? g.sectH : Math.min(g.h, g.w))
        : sH;
      const plateW = (p === 'plate' || g.category === 'plate')
        ? (g.sectW > 0 ? g.sectW : Math.max(g.h, g.w))
        : sW;
      return { ...base, l:g.l, w:plateW, h:thickness, weight, qty:1, stacked:false,
               unitWidth:plateW, unitHeight:thickness };
    }

    // PLATES / sheets — sets of 5–6 stacked in one place (user grouping rule)
    if (p === 'plate' || (!p && g.category === 'plate')) {
      const thickness = g.sectH > 0 ? g.sectH : Math.min(g.h, g.w);
      const plateW    = g.sectW > 0 ? g.sectW : Math.max(g.h, g.w);
      const SHEET_SET = 6;
      const nStack = Math.min(qty, SHEET_SET);
      const nCols = Math.ceil(qty / nStack);
      // Step6 FLAT_STACK: offset = thickness (no clearance)
      const stepY = (nestInfo?.method === 'FLAT_STACK' && nestInfo.nesting_offset > 0)
        ? nestInfo.nesting_offset : thickness;
      const stackH = stepY * nStack;
      return { ...base, category:'plate',
        l:g.l, w:nCols * plateW, h:stackH, weight, qty,
        stacked:true, unitThickness:thickness, unitWidth:plateW,
        gridCols:nCols, gridRows:nStack, sheetSet:SHEET_SET };
    }

    // BENT SAG ROD — IFC path / dogleg; pack with path envelope
    if (p === 'bent_sag_rod') {
      const d = Math.max(
        g.pathDiamMm || 0,
        g.sectH > 0 && g.sectH <= 40 ? g.sectH : 0,
        g.sectT > 0 && g.sectT <= 40 ? g.sectT : 0,
        12
      );
      const hook = Math.max(g.h || 0, d * 8);
      const { cols, rows } = bestGrid(qty, d, d);
      const pitch = d * 1.55;
      const bundleW = Math.max(g.w || d, cols * pitch + (rows > 1 ? pitch * 0.5 : 0));
      const bundleH = Math.max(hook, d) + Math.max(0, rows - 1) * pitch * Math.sqrt(3) / 2;
      return { ...base, category: 'rod', profileShape: 'bent_sag_rod', shapeKey: 'bent_sag_rod',
        l: g.l, w: bundleW, h: bundleH, weight, qty,
        stacked: true, bundled: true, unitDiam: d, unitWidth: d, unitHeight: hook,
        gridCols: cols, gridRows: rows,
        pathPointsMm: g.pathPointsMm || null,
        pathDiamMm: g.pathDiamMm || d };
    }

    // RODS — compact hexagonal bundle (nearly square), never a 1-wide tower
    if (p === 'rod' || (!p && g.category === 'rod')) {
      const d = Math.max(g.sectH > 0 ? g.sectH : Math.max(g.w, g.h), 6);
      const { cols, rows } = bestGrid(qty, d, d * Math.sqrt(3) / 2);
      const bundleW = cols * d + d * 0.5;
      const bundleH = (rows - 1) * d * Math.sqrt(3) / 2 + d;
      return { ...base, category:'rod',
        l:g.l, w:bundleW, h:bundleH, weight, qty,
        stacked:true, bundled:true, unitDiam:d, unitWidth:d, unitHeight:d,
        gridCols:cols, gridRows:rows };
    }

    // C-CHANNELS: open+inverted offset nest (left in/right out by wall t)
    if (p === 'c_channel') {
      const t = Math.max(sT, 1.2);
      const laidH = sW + t;
      const laidW = sH + t * 7; // top nudged further right
      const nPairs = Math.ceil(qty / 2);
      const maxH = spec ? Math.min(spec.heightMm * 0.45, 900) : 900;
      const { nStack: nPairRows, nCols } = nestColumns(nPairs, laidH, laidH, maxH);
      const nestH = nPairRows * laidH;
      const gap = Math.max(sH * 0.06, t * 3, 4);
      const bundleW = nCols * laidW + Math.max(0, nCols - 1) * gap;
      return { ...base, category:'purlin',
        l:g.l, w:bundleW, h:nestH, weight, qty,
        stacked:true, nested:true, cLaidFlat:true,
        unitWidth:sW, unitHeight:sH,
        gridCols:nCols, gridRows:nPairRows,
        channelLength:g.l, channelHeight:sH,
        nestPieces: g.nestPieces || null };
    }

    // Generic purlin fallback (no profile) — treat as single grid, no fake nest
    if (!p && g.category === 'purlin') {
      const { cols, rows } = bestGrid(qty, sW, sH);
      return { ...base, category:'purlin',
        l:g.l, w:cols*sW, h:rows*sH, weight, qty,
        stacked:true, unitWidth:sW, unitHeight:sH,
        gridCols:cols, gridRows:rows };
    }

    // Z-PURLINS: nest same-length pieces; Step6 offset drives envelope (no shape change).
    if (p === 'z_channel') {
      const flat = [];
      const src = (g.nestPieces && g.nestPieces.length) ? g.nestPieces : null;
      if (src) {
        src.forEach(np => {
          const n = Math.max(1, np.qty || 1);
          for (let i = 0; i < n; i++) flat.push({ ...np, qty: 1 });
        });
      } else {
        for (let i = 0; i < qty; i++) flat.push({
          sectH: sH, sectW: sW, sectT: sT, sectD: sD, lengthMm: g.l, qty: 1
        });
      }
      // Longest outside / first; full pack-unit qty (createPackUnits sized this)
      flat.sort((a, b) => (b.lengthMm || 0) - (a.lengthMm || 0)
        || (b.sectH || 0) - (a.sectH || 0));
      const take = flat.slice(0, Math.max(1, qty));
      const ph0 = take[0]?.sectH > 0 ? take[0].sectH : sH;
      const pw0 = take[0]?.sectW > 0 ? take[0].sectW : ph0 * 0.32;
      let envL = g.l;
      take.forEach(t => { envL = Math.max(envL, t.lengthMm || 0); });

      const nInfo = nestInfo || take[0]?.nestingInfo || null;
      const method = nInfo?.method || '';
      let envH, envW;
      if (method === 'INTERLOCK_NEST'
          && typeof computeInterlockWorldYPlacements === 'function') {
        // Collision-fit envelope (true interlock — not N×static offset)
        const mark0 = take[0].mark || g.marks?.[0];
        const raw0 = (typeof rawScene !== 'undefined' && rawScene?.items)
          ? rawScene.items.find(it => it.mark === mark0) : null;
        const sample = {
          ...take[0],
          lengthMm: envL,
          sectH: ph0, sectW: pw0, sectT: sT, sectD: sD,
          crossSection: take[0].crossSection || raw0?.crossSection || null,
          csAnalysis: take[0].csAnalysis || raw0?.csAnalysis || null,
          nestingInfo: nInfo || raw0?.nestingInfo || null,
          nestMethod: g.nestMethod || raw0?.nestMethod
            || { method: 'INTERLOCK_NEST', alternate_flip: true },
        };
        const fit = computeInterlockWorldYPlacements(sample, take.length);
        envH = fit.bundle_height_mm > 0 ? fit.bundle_height_mm : ph0;
        envW = fit.bundle_width_mm > 0 ? fit.bundle_width_mm : pw0;
      } else if (nInfo && nInfo.nesting_offset > 0
          && (method === 'STACK_NEST'
              || nInfo.place_mode === 'stack_up')) {
        const bounds = (typeof computeNestBundleBounds === 'function')
          ? computeNestBundleBounds(take.length, nInfo, {
              length: envL, width: pw0, height: ph0, thickness: sT,
            })
          : null;
        envH = bounds ? bounds.bundle_height : (ph0 + (take.length - 1) * nInfo.nesting_offset);
        envW = bounds ? bounds.bundle_width : pw0;
      } else {
        const step0 = take[0] && take[0].sectT > 0 ? take[0].sectT
          : Math.max((take[0]?.sectH || sH) * 0.012, 1.2);
        envH = ph0; envW = pw0;
        for (let i = 1; i < take.length; i++) {
          const pt = take[i].sectT > 0 ? take[i].sectT : step0;
          const pw = take[i].sectW > 0 ? take[i].sectW : pw0;
          envH += pt;
          envW = Math.max(envW, pw) + pt;
        }
      }
      return { ...base, category:'purlin',
        l:envL, w:envW, h:envH, weight: weight * (take.length / Math.max(qty, 1)),
        qty: take.length,
        stacked:true, nested:true,
        unitWidth:sW, unitHeight:sH,
        gridCols:1, gridRows:take.length,
        nestPieces: take };
    }

    // L-ANGLES: nest full pack-unit
    if (p === 'l_angle') {
      const n = Math.max(1, qty);
      const t = Math.max(sT, 1.5);
      const nInfo = nestInfo;
      const step = (nInfo?.nesting_offset > 0) ? nInfo.nesting_offset : (t + 0.6);
      const stackUp = !nInfo || nInfo.place_mode === 'stack_up'
        || nInfo.method === 'INTERLOCK_NEST' || nInfo.method === 'STACK_NEST';
      const colH = stackUp ? (sH + Math.max(0, n - 1) * step) : (sH + Math.max(0, n - 1) * step);
      const colW = stackUp ? sW : (sW + Math.max(0, n - 1) * step);
      return { ...base, category:'purlin',
        l:g.l, w:colW, h:colH,
        weight, qty: n,
        stacked:true, nested:true,
        unitWidth:sW, unitHeight:sH,
        gridCols:1, gridRows:n,
        nestPieces: g.nestPieces || null };
    }

    // RHS / tubes — compact square-ish bundle (not a vertical column of tubes)
    if (p === 'rhs') {
      const { cols, rows } = bestGrid(qty, sW, sH);
      return { ...base, l:g.l, w:cols*sW, h:rows*sH, weight, qty,
        stacked:true, nested:true, bundled:true,
        unitWidth:sW, unitHeight:sH,
        gridCols:cols, gridRows:rows };
    }

    // I-BEAMS / fallback grid
    const { cols, rows } = bestGrid(qty, sW, sH);
    return { ...base, l:g.l, w:cols*sW, h:rows*sH, weight,
      qty, stacked:true, beamBundle:true, unitWidth:sW, unitHeight:sH,
      gridCols:cols, gridRows:rows };
  }

  // Does this bundle fit inside the container (dimensions, weight, AND
  // layer budget)? A bundle taller than ~40% of the container ceiling
  // is rejected here so splitIfNeeded is forced to break it into smaller
  // sub-bundles - otherwise a single tall stack blocks the middle and
  // top layers from ever forming above it.
  function bundleFits(bundle) {
    if (!spec) return true;
    if (bundle.weight > spec.maxWeightKg + 1e-6) return false;
    // Nested bundles may use almost full container height — splitting them
    // scatters identical pieces across the floor (bad).
    const maxBundleH = spec.heightMm * 0.95;
    const dims = [bundle.l, bundle.w, bundle.h];
    const cont = [spec.lengthMm, spec.widthMm, maxBundleH];
    const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    for (const [i,j,k] of perms) {
      if (dims[i] <= cont[0]+1e-6 && dims[j] <= cont[1]+1e-6 && dims[k] <= cont[2]+1e-6)
        return true;
    }
    return false;
  }

  // Only split when the FULL nest cannot fit at all (weight / length).
  // Prefer one pack of identical pieces in one place.
  // Sheets: packs of ~6. Z: packs limited by ≥80% base-support nest depth.
  function splitIfNeeded(g) {
    const p = g.profileShape || g.shapeKey || '';
    const isPlate = p === 'plate' || g.category === 'plate';
    const SHEET_SET = 6;

    // Sheets → sets of 5–6 in one place
    if (isPlate && g.qty > SHEET_SET) {
      const out = [];
      let remaining = g.qty, idx = 0;
      while (remaining > 0) {
        const n = Math.min(SHEET_SET, remaining);
        const b = makeBundle(g, n);
        if (g.qty !== n) {
          b.mark = g.mark + '-s' + (++idx);
          b.marks = g.marks ? [...g.marks] : [g.mark];
        }
        out.push(b);
        remaining -= n;
      }
      return out;
    }

    // Pack units already sized (≤12 / ≤3t). Keep nest together; split only if unfit.
    const full = makeBundle(g, g.qty);
    if (bundleFits(full)) return [full];
    if (g.qty <= 1) return [full];
    // Nested profiles: try to keep as few packs as possible (2 then 3…)
    const isNest = full.nested || full.bundled;
    if (isNest) {
      for (let packs = 2; packs <= Math.min(6, g.qty); packs++) {
        const take = Math.ceil(g.qty / packs);
        if (bundleFits(makeBundle(g, take))) {
          const out = [];
          let remaining = g.qty, idx = 0;
          while (remaining > 0) {
            const n = Math.min(take, remaining);
            const b = makeBundle(g, n);
            b.mark = g.mark + '-p' + (++idx);
            b.marks = full.marks ? [...full.marks] : [g.mark];
            out.push(b);
            remaining -= n;
          }
          return out;
        }
      }
    }

    let lo = 1, hi = g.qty - 1, best = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (bundleFits(makeBundle(g, mid))) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    const out = [];
    let remaining = g.qty;
    let idx = 0;
    while (remaining > 0) {
      const take = Math.min(best, remaining);
      const b = makeBundle(g, take);
      if (g.qty !== take) {
        b.mark = g.mark + '-p' + (++idx);
        b.marks = full.marks ? [...full.marks] : [g.mark];
      }
      out.push(b);
      remaining -= take;
    }
    return out;
  }

  Object.values(groups).forEach(g => {
    splitIfNeeded(g).forEach(b => units.push(b));
  });

  return units;
}

function layoutQuick(items, spec) {
  const units = expandUnits(items, spec);
  const oversized = units.filter(u => u.l>spec.lengthMm || u.w>spec.widthMm || u.h>spec.heightMm);
  const normal = units.filter(u => !oversized.includes(u)).sort((a,b) => b.weight - a.weight);

  const containers = [];
  normal.forEach(u => {
    let t = containers.find(c => c.weightUsed + u.weight <= spec.maxWeightKg);
    if (!t) { t = { weightUsed:0, volumeUsed:0, units:[] }; containers.push(t); }
    t.units.push(u); t.weightUsed += u.weight; t.volumeUsed += u.l*u.w*u.h;
  });

  const cv = spec.lengthMm*spec.widthMm*spec.heightMm;
  const result = containers.map((c, idx) => {
    const byCategory = {};
    c.units.forEach(u => (byCategory[u.category] = byCategory[u.category] || []).push(u));
    const catNames = Object.keys(byCategory);
    const laneWidth = spec.widthMm / catNames.length;
    const outItems = [];
    catNames.forEach((cat, laneIdx) => {
      const laneZ = -spec.widthMm/2 + laneWidth*(laneIdx + 0.5);
      const group = byCategory[cat];
      const gap = 150;
      const totalLen = group.reduce((s,u)=>s+u.l,0) + gap*Math.max(0, group.length-1);
      const fit = totalLen <= 0 ? 1 : Math.min(1, (spec.lengthMm*0.96) / totalLen);
      let cursor = 0;
      group.forEach(u => {
        const drawLen = u.l * fit;
        outItems.push({
          ...u,             // carry profileShape, gridCols/Rows, bundled, beamBundle, etc.
          lengthMm: drawLen, widthMm: u.w, heightMm: u.h,
          x: cursor + drawLen/2, y: u.h/2, z: laneZ,
          unitWeightKg: u.weight
        });
        cursor += drawLen + gap;
      });
    });
    return { containerNumber:idx+1, lengthMm:spec.lengthMm, widthMm:spec.widthMm, heightMm:spec.heightMm,
      maxWeightKg:spec.maxWeightKg, usedWeightKg:round2(c.weightUsed),
      weightUtilizationPct:round1(c.weightUsed/spec.maxWeightKg*100),
      volumeUtilizationPct:round1(c.volumeUsed/cv*100), items:outItems };
  });

  return { containers:result, oversized };
}

// ------------------------------------------------------------------
// MODE 2: OPTIMIZE PACKING - "Extreme Points" 3D bin packer.
//
// This is how a real dock worker actually thinks: place a piece, look at
// the corners of what's already down, try the next piece against each of
// those corners, put it wherever it slots in tightest.
//
// Algorithm:
//   1. Every open container tracks a set of "extreme points" - the corners
//      where a new piece could plausibly sit (starting with just (0,0,0)).
//   2. For each piece (largest volume first), we scan every extreme point
//      in every open container and every allowed orientation, checking:
//        - Does it stay inside the container walls?
//        - Does it overlap any already-placed piece? (real 3D box test)
//        - Is the weight budget still OK?
//      Among all valid placements we pick the one that goes lowest
//      (floor-first, real gravity), then leftmost, then furthest back.
//   3. When a piece is placed at (x,y,z), THREE new extreme points are
//      added: (x+l,y,z), (x,y+h,z), (x,y,z+w). Any point buried inside a
//      placed piece is dropped. This lets the next item slot into the gap
//      right beside/above/behind the one just placed - exactly the
//      "fill the leftover corner" behaviour you were describing.
//   4. A new container is opened only when a piece genuinely doesn't fit
//      in any orientation at any extreme point in any existing container.
//
// Unlike a shelf packer, this doesn't waste the huge column of empty air
// above short pieces (rods, plate stacks) - the point on top of a 20mm rod
// is a real placement candidate for the next tall column.
// ------------------------------------------------------------------
function layoutOptimized(items, spec, rotMap, opts) {
  const rotations = rotMap || userRotations || {};
  // Single container by default for Optimise & Place — leftovers ask user to rotate,
  // never pretend packing outside the wireframe is a valid load.
  const maxContainers = (opts && opts.maxContainers != null) ? opts.maxContainers : 1;
  const seedItems = (opts && opts.seedItems) ? opts.seedItems : [];
  const markOrder = (opts && opts.markOrder instanceof Map) ? opts.markOrder : null;
  // Safe-zone envelope (inset from blue-box walls) — pack inside this only
  const _env = (typeof getPackEnvelope === 'function') ? getPackEnvelope(spec) : null;
  const packMinX = _env ? _env.minXMm : 0;
  const packMaxX = _env ? _env.maxXMm : spec.lengthMm;
  const packMinZ = _env ? _env.minZMm : 0;
  const packMaxZ = _env ? _env.maxZMm : spec.widthMm;
  const packMinY = _env ? _env.minYMm : 0;
  const packMaxY = _env ? _env.maxYMm : spec.heightMm;
  const bundleGapMm = _env ? _env.bundleGapMm
    : ((typeof getLoadingRules === 'function') ? getLoadingRules().MIN_BUNDLE_GAP_MM : 20);
  const units = expandUnits(items, spec);
  const oversized = [];
  const fitsAtAll = [];

  function lookupUserRot(u) {
    if (!rotations) return null;
    if (u.mark && rotations[u.mark]) return rotations[u.mark];
    for (const m of (u.marks || [])) {
      if (m && rotations[m]) return rotations[m];
    }
    return null;
  }

  /**
   * Real world AABB (mm) of this unit with the given absolute mesh Euler.
   * Uses makeShape so plate stacks / extrudes match what the user sees.
   */
  function measureOrientedDims(u, r) {
    const item = {
      ...u,
      lengthMm: u.l, widthMm: u.w, heightMm: u.h,
      qty: u.qty || 1,
    };
    const mesh = makeShape(item, 0xffffff, 1);
    if (r) mesh.rotation.set(r.x || 0, r.y || 0, r.z || 0);
    mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    bb.getSize(size);
    mesh.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    return {
      l: Math.max(size.x / SCALE, 1),
      h: Math.max(size.y / SCALE, 1),
      w: Math.max(size.z / SCALE, 1),
    };
  }

  function getOrientations(u) {
    const [l,w,h] = [u.l, u.w, u.h];
    const orients = [];
    const seen = new Set();
    const add = (cl,cw,ch, tag, rot) => {
      const key = Math.round(cl)+','+Math.round(cw)+','+Math.round(ch)+','+(tag||'');
      if (seen.has(key)) return;
      const eL = packMaxX - packMinX, eW = packMaxZ - packMinZ, eH = packMaxY - packMinY;
      if (cl <= eL + 1e-6 && cw <= eW + 1e-6 && ch <= eH + 1e-6) {
        seen.add(key);
        const o = {l:cl, w:cw, h:ch, tag: tag || 'natural'};
        if (rot) o.rot = { x: rot.x||0, y: rot.y||0, z: rot.z||0 };
        orients.push(o);
      }
    };

    const isPlate = u.profileShape === 'plate' || u.category === 'plate';
    const userRot = lookupUserRot(u);
    const isLockedBundle = u.qty > 1 && (u.nested || u.bundled || u.beamBundle || u.stacked);

    if (userRot) {
      try {
        const dims = measureOrientedDims(u, userRot);
        add(dims.l, dims.w, dims.h, 'user', userRot);
      } catch (_) {}
      if (orients.length) return orients;
    }

    // Sheets / plates: flat on floor first (base layer), then tip on edge if needed
    if (isPlate) {
      try {
        const d0 = measureOrientedDims(u, null);
        add(d0.l, d0.w, d0.h, 'flat');
      } catch (_) {
        add(l, w, h, 'flat');
      }
      // Charichitt — stand on side so remaining floor width can be used
      const edgeRots = [
        { x: Math.PI/2, y: 0, z: 0 },
        { x: 0, y: 0, z: Math.PI/2 },
        { x: Math.PI/2, y: Math.PI/2, z: 0 },
      ];
      for (const r of edgeRots) {
        try {
          const d = measureOrientedDims(u, r);
          add(d.l, d.w, d.h, 'edge', r);
        } catch (_) {}
      }
      return orients;
    }

    if (isLockedBundle) {
      try {
        const dims = measureOrientedDims(u, null);
        add(dims.l, dims.w, dims.h, 'natural');
      } catch (_) {
        add(l, w, h, 'natural');
      }
      return orients;
    }

    // C/Z/L: always length-along-container (kidathanam) — never stand on short end
    if (u.profileShape === 'c_channel' || u.profileShape === 'z_channel' || u.profileShape === 'l_angle') {
      try {
        const dims = measureOrientedDims(u, null);
        add(dims.l, dims.w, dims.h, 'natural');
      } catch (_) {
        add(l, w, h, 'natural');
      }
      return orients;
    }

    // Assemblies / tapered: NEVER pack on a single static nesting_offset or
    // raw expandUnits box — measure real mesh AABB (haunch included).
    const tapered = !!(u.isAssembly || u.crossSection?.is_tapered
      || u.nestMethod?.method === 'PER_MARK_STACK'
      || (typeof isTaperedOrNonUniformItem === 'function' && isTaperedOrNonUniformItem(u)));
    if (tapered) {
      try {
        const dims = measureOrientedDims(u, null);
        // Station/max-width footprint when qty>1 (anti-align bundle)
        if ((u.qty || 1) > 1 && typeof taperPackFootprintMm === 'function') {
          const fp = taperPackFootprintMm(u);
          add(
            Math.max(dims.l, u.l || 1),
            Math.max(dims.w, fp.w || 1),
            Math.max(dims.h, fp.h || 1),
            'taper_station'
          );
        } else {
          add(dims.l, dims.w, dims.h, 'assembly_mesh');
        }
      } catch (_) {
        if ((u.qty || 1) > 1 && typeof taperPackFootprintMm === 'function') {
          const fp = taperPackFootprintMm(u);
          add(l, Math.max(w, fp.w), Math.max(h, fp.h), 'taper_fallback');
        } else {
          add(l, w, h, 'natural');
        }
      }
      return orients;
    }

    add(l, w, h, 'natural');
    if (u.profileShape === 'rod' || u.category === 'rod') return orients;
    if (u.profileShape === 'rhs') return orients;
    return orients;
  }

  units.forEach(u => {
    if (getOrientations(u).length === 0) oversized.push(u);
    else fitsAtAll.push(u);
  });

  // Plates/sheets FIRST → lay flat as floor base, then other shapes on top (layer 2)
  // When user picked a pack order (1,2,3…), that wins over shape priority.
  function packPriority(u) {
    const p = u.profileShape || '';
    const c = u.category || '';
    if (p === 'plate' || c === 'plate') return 0;
    if (p === 'i_beam' || c === 'beam') return 1;
    if (p === 'c_channel' || p === 'z_channel' || p === 'l_angle' || c === 'purlin') return 2;
    if (p === 'rod' || c === 'rod') return 3;
    return 2;
  }
  function shapeFamily(u) {
    return String(u.profileShape || u.shapeKey || u.category || 'other');
  }
  function userPackOrder(u) {
    if (!markOrder) return 0;
    let best = 99999;
    const marks = [u.mark, ...(u.marks || [])].filter(Boolean);
    marks.forEach(m => {
      if (markOrder.has(m)) best = Math.min(best, markOrder.get(m));
    });
    return best;
  }
  fitsAtAll.sort((a, b) =>
    userPackOrder(a) - userPackOrder(b) ||
    packPriority(a) - packPriority(b) ||
    shapeFamily(a).localeCompare(shapeFamily(b)) ||
    (b.l * b.w * b.h) - (a.l * a.w * a.h) ||
    Math.round(b.l) - Math.round(a.l)
  );

  const containers = [];

  function overlaps(a, b) {
    // Bundle-to-bundle gap on plan (XZ); vertical stack may still touch
    const g = bundleGapMm || 0;
    return a.x < b.x + b.l + g - 1e-6 && a.x + a.l + g - 1e-6 > b.x &&
           a.y < b.y + b.h - 1e-6 && a.y + a.h - 1e-6 > b.y &&
           a.z < b.z + b.w + g - 1e-6 && a.z + a.w + g - 1e-6 > b.z;
  }

  /** Highest real support under the XZ footprint (floor = 0).
   *  Rule: ≥80% of the item's base must rest on what is below — no floating /
   *  staircase overhangs on a thin edge. */
  function supportTopY(container, x, z, l, w) {
    const area = Math.max(l * w, 1);
    const longSide = Math.max(l, w);
    const shortSide = Math.min(l, w);
    const byTop = new Map();
    for (const p of container.items) {
      const b = p._box;
      const ox0 = Math.max(x, b.x);
      const ox1 = Math.min(x + l, b.x + b.l);
      const oz0 = Math.max(z, b.z);
      const oz1 = Math.min(z + w, b.z + b.w);
      if (ox1 <= ox0 + 1e-6 || oz1 <= oz0 + 1e-6) continue;
      const overlapA = (ox1 - ox0) * (oz1 - oz0);
      const coverL = (l >= w) ? (ox1 - ox0) : (oz1 - oz0);
      const coverS = (l >= w) ? (oz1 - oz0) : (ox1 - ox0);
      const yTop = b.y + b.h;
      const key = Math.round(yTop * 1000) / 1000;
      const cur = byTop.get(key) || { area: 0, longCover: 0, shortCover: 0, y: yTop };
      cur.area += overlapA;
      cur.longCover += coverL;
      cur.shortCover += coverS;
      byTop.set(key, cur);
    }
    // Only surfaces with ≥80% base support count — pick the highest valid one
    let bestY = 0;
    for (const cur of byTop.values()) {
      if (cur.area / area < 0.80) continue;
      if (cur.longCover / longSide < 0.80) continue;
      if (cur.shortCover / Math.max(shortSide, 1) < 0.50) continue;
      if (cur.y > bestY) bestY = cur.y;
    }
    return bestY;
  }

  /** Seed more floor positions so items pack tightly instead of only at EP corners. */
  function ensureFloorGrid(container, stepX, stepZ, force) {
    if (container._floorGridDone && !force) return;
    container._floorGridDone = true;
    const sx = Math.max(80, Math.min(stepX || 200, 350));
    const sz = Math.max(60, Math.min(stepZ || 120, 280));
    for (let x = packMinX; x + 1 < packMaxX; x += sx) {
      for (let z = packMinZ; z + 1 < packMaxZ; z += sz) {
        const dup = container.extremePoints.some(p =>
          Math.abs(p.x - x) < sx * 0.35 && Math.abs(p.z - z) < sz * 0.35 && Math.abs(p.y - packMinY) < 1
        );
        if (!dup) container.extremePoints.push({ x, y: packMinY, z });
      }
    }
  }

  function findPlacement(container, u, placeOpts) {
    if (container.weightUsed + u.weight > spec.maxWeightKg) return null;
    const orients = getOrientations(u);
    if (!orients.length) return null;
    const floorOnly = !!(placeOpts && placeOpts.floorOnly);
    ensureFloorGrid(container, orients[0].l * 0.28, orients[0].w * 0.28, false);
    let best = null;

    function tryAt(x, z, o) {
      if (x < packMinX - 1e-6 || z < packMinZ - 1e-6) return;
      if (x + o.l > packMaxX + 1e-6) return;
      if (z + o.w > packMaxZ + 1e-6) return;
      const settledY = supportTopY(container, x, z, o.l, o.w);
      // Layer 1: floor only. Layer 2+: require solid ≥80% support (supportTopY).
      if (floorOnly && settledY > packMinY + 1e-6) return;
      if (settledY + o.h > packMaxY + 1e-6) return;
      const testBox = { x, y:settledY, z, l:o.l, w:o.w, h:o.h };
      for (const p of container.items) {
        if (overlaps(testBox, p._box)) return;
      }
      const halfWidth = spec.widthMm / 2;
      const centerZ = z + o.w / 2;
      const rightSide = centerZ > halfWidth;
      const balanceWeight = rightSide ? container.rightWeight : container.leftWeight;
      let affinity = 1e9;
      const sk = u.profileShape || u.shapeKey || '';
      const sH = u.sectH || u.h || 0;
      const isPlate = u.profileShape === 'plate' || u.category === 'plate';
      for (const p of container.items) {
        const pk = p.profileShape || p.shapeKey || '';
        if (sk && pk === sk) {
          const dx = Math.abs((p._box.x + p._box.l/2) - (x + o.l/2));
          const dz = Math.abs((p._box.z + p._box.w/2) - (z + o.w/2));
          const pH = p.sectH || p.h || 0;
          const nestBonus = (sH > 0 && pH >= sH) ? 0 : 50;
          affinity = Math.min(affinity, dx + dz + nestBonus);
        }
      }
      // Floor first; plates: flat on base preferred, edge only if needed
      let score = settledY * 1e12 + affinity * 1e3 + balanceWeight * 1e2 + x + z * 0.01;
      if (isPlate) {
        if (o.tag === 'edge') score += 8e13;
        else if (settledY < 1) score -= 2e12;
      }
      if (!best || score < best.score) {
        best = { ep: { x, y: settledY, z }, orient: o, score };
      }
    }

    for (const ep of container.extremePoints) {
      for (const o of orients) {
        tryAt(ep.x, ep.z, o);
        const step = Math.max(40, Math.min(o.w, o.l) * 0.15);
        tryAt(ep.x + step, ep.z, o);
        tryAt(ep.x, ep.z + step, o);
        tryAt(Math.max(packMinX, ep.x - step), ep.z, o);
        tryAt(ep.x, Math.max(packMinZ, ep.z - step), o);
      }
    }

    if (!best) {
      ensureFloorGrid(container, 100, 80, true);
      for (const ep of container.extremePoints) {
        for (const o of orients) tryAt(ep.x, ep.z, o);
      }
    }
    return best;
  }

  function place(container, u, ep, o) {
    // Prefer user-applied rot; else packer-chosen edge rot for sheets
    const userRot = lookupUserRot(u) || o.rot || null;
    const keepNatural = !!(userRot || o.tag === 'natural' || o.tag === 'user' || o.tag === 'flat' || o.tag === 'edge');

    // Collision box MUST match rendered mesh (with rot)
    let boxL = o.l, boxW = o.w, boxH = o.h;
    try {
      const vis = measureOrientedDims(u, userRot);
      boxL = vis.l; boxW = vis.w; boxH = vis.h;
    } catch (_) {}

    const settledY = supportTopY(container, ep.x, ep.z, boxL, boxW);
    const box = { x: ep.x, y: settledY, z: ep.z, l: boxL, w: boxW, h: boxH };
    if (box.x < packMinX - 1e-6 || box.z < packMinZ - 1e-6) return false;
    if (box.x + box.l > packMaxX + 1e-6 || box.z + box.w > packMaxZ + 1e-6) return false;
    if (box.y + box.h > packMaxY + 1e-6) return false;

    // Resolve clash — if still overlapping, abort (do not leave dig-in)
    for (let attempt = 0; attempt < 12; attempt++) {
      let clash = null;
      for (const p of container.items) {
        if (overlaps(box, p._box)) { clash = p; break; }
      }
      if (!clash) break;
      const tryZ = box.z + Math.max(20, box.w * 0.06) * (attempt + 1);
      if (tryZ + boxW <= packMaxZ + 1e-6) {
        const y2 = supportTopY(container, box.x, tryZ, boxL, boxW);
        const b2 = { x: box.x, y: y2, z: tryZ, l: boxL, w: boxW, h: boxH };
        if (b2.y + b2.h <= packMaxY + 1e-6 &&
            !container.items.some(q => overlaps(b2, q._box))) {
          box.x = b2.x; box.y = b2.y; box.z = b2.z;
          continue;
        }
      }
      const tryX = box.x + Math.max(20, box.l * 0.06) * (attempt + 1);
      if (tryX + boxL <= packMaxX + 1e-6) {
        const y3 = supportTopY(container, tryX, box.z, boxL, boxW);
        const b3 = { x: tryX, y: y3, z: box.z, l: boxL, w: boxW, h: boxH };
        if (b3.y + b3.h <= packMaxY + 1e-6 &&
            !container.items.some(q => overlaps(b3, q._box))) {
          box.x = b3.x; box.y = b3.y; box.z = b3.z;
          continue;
        }
      }
      // Stack on top ONLY when ≥80% of this footprint is supported (supportTopY).
      // Never perch on a clash item's top edge — that creates floating staircases.
      const yOk = supportTopY(container, box.x, box.z, boxL, boxW);
      if (yOk > packMinY + 1e-6) {
        const b4 = { x: box.x, y: yOk, z: box.z, l: boxL, w: boxW, h: boxH };
        if (b4.y + b4.h <= packMaxY + 1e-6 &&
            !container.items.some(q => overlaps(b4, q._box))) {
          box.x = b4.x; box.y = b4.y; box.z = b4.z;
          continue;
        }
      }
      return false; // cannot place without overlap or without solid support
    }
    if (container.items.some(q => overlaps(box, q._box))) return false;
    if (box.y + box.h > packMaxY + 1e-6) return false;

    container.weightUsed += u.weight;
    container.volumeUsed += boxL * boxW * boxH;

    const halfWidth = spec.widthMm / 2;
    if (box.z + boxW / 2 > halfWidth) container.rightWeight += u.weight;
    else                               container.leftWeight  += u.weight;

    container.items.push({
      ...u,
      lengthMm: keepNatural ? u.l : o.l,
      widthMm:  keepNatural ? u.w : o.w,
      heightMm: keepNatural ? u.h : o.h,
      x: box.x + boxL / 2,
      y: box.y + boxH / 2,
      z: -spec.widthMm / 2 + box.z + boxW / 2,
      unitWeightKg: u.weight,
      userRot: userRot ? { ...userRot } : null,
      _box: box
    });

    container.extremePoints = container.extremePoints.filter(p => {
      if (Math.abs(p.x-ep.x)<1e-6 && Math.abs(p.y-ep.y)<1e-6 && Math.abs(p.z-ep.z)<1e-6) return false;
      if (p.x >= box.x - 1e-6 && p.x < box.x + box.l - 1e-6 &&
          p.y >= box.y - 1e-6 && p.y < box.y + box.h - 1e-6 &&
          p.z >= box.z - 1e-6 && p.z < box.z + box.w - 1e-6) return false;
      return true;
    });

    const candidates = [
      { x: box.x + box.l, y: 0, z: box.z },
      { x: box.x,         y: 0, z: box.z + box.w },
      { x: box.x + box.l, y: 0, z: box.z + box.w },
      { x: box.x,         y: box.y + box.h, z: box.z },
      { x: box.x + box.l, y: box.y + box.h, z: box.z },
      { x: box.x,         y: box.y + box.h, z: box.z + box.w },
    ];
    for (const ep2 of candidates) {
      if (ep2.x > packMaxX - 1e-6 || ep2.z > packMaxZ - 1e-6) continue;
      if (ep2.x < packMinX - 1e-6 || ep2.z < packMinZ - 1e-6) continue;
      if (ep2.y > packMaxY - 1e-6) continue;
      const dup = container.extremePoints.some(p =>
        Math.abs(p.x - ep2.x) < 1e-3 && Math.abs(p.y - ep2.y) < 1e-3 && Math.abs(p.z - ep2.z) < 1e-3
      );
      if (!dup) container.extremePoints.push(ep2);
    }
    return true;
  }

  function settleContainer(container) {
    for (let pass = 0; pass < 3; pass++) {
      const items = container.items.slice().sort((a, b) => a._box.y - b._box.y);
      let moved = false;
      for (const it of items) {
        if (it._seeded) continue; // keep already-placed poses fixed
        const b = it._box;
        const others = { items: container.items.filter(x => x !== it) };
        const y0 = supportTopY(others, b.x, b.z, b.l, b.w);
        if (y0 >= b.y - 0.5) continue;
        b.y = y0;
        it.y = b.y + b.h / 2;
        moved = true;
      }
      if (!moved) break;
    }
  }

  // Seed already-placed items so new packs fill remaining space around them
  if (seedItems.length) {
    const container = {
      weightUsed: 0, volumeUsed: 0, items: [],
      extremePoints: [{ x: packMinX, y: packMinY, z: packMinZ }],
      leftWeight: 0, rightWeight: 0
    };
    for (const it of seedItems) {
      const L = it.lengthMm || it.l || 500;
      const W = it.widthMm || it.w || 200;
      const H = it.heightMm || it.h || 200;
      const cx = it.x != null ? it.x : L / 2;
      const cy = it.y != null ? it.y : H / 2;
      const cz = it.z != null ? it.z : 0;
      const packerCx = spec.lengthMm - cx;
      const box = {
        x: Math.max(0, packerCx - L / 2),
        y: Math.max(0, cy - H / 2),
        z: Math.max(0, cz + spec.widthMm / 2 - W / 2),
        l: L, w: W, h: H
      };
      container.weightUsed += (it.unitWeightKg || it.weight || 0) * (it.qty || 1);
      container.volumeUsed += L * W * H;
      // Store packer-center X so final mirror restores render X
      container.items.push({
        ...it,
        lengthMm: L, widthMm: W, heightMm: H,
        x: packerCx, y: cy, z: cz,
        unitWeightKg: it.unitWeightKg || it.weight || 0,
        _box: box,
        _seeded: true,
      });
      [
        { x: box.x + box.l, y: 0, z: box.z },
        { x: box.x, y: 0, z: box.z + box.w },
        { x: box.x, y: box.y + box.h, z: box.z },
        { x: box.x + box.l, y: box.y + box.h, z: box.z },
      ].forEach(ep2 => {
        if (ep2.x > packMaxX - 1e-6 || ep2.z > packMaxZ - 1e-6) return;
        if (ep2.x < packMinX - 1e-6 || ep2.z < packMinZ - 1e-6) return;
        container.extremePoints.push(ep2);
      });
    }
    ensureFloorGrid(container, 150, 100, false);
    containers.push(container);
  }

  /** Try to place one unit into an existing container (or return false). */
  function tryPlaceUnit(u, floorOnly) {
    for (const container of containers) {
      const orients = getOrientations(u);
      if (!orients.length) return false;
      ensureFloorGrid(container, orients[0].l * 0.28, orients[0].w * 0.28, false);
      const tried = new Set();
      for (let attempt = 0; attempt < 40; attempt++) {
        const p = findPlacement(container, u, { floorOnly });
        if (!p) break;
        const key = `${Math.round(p.ep.x)},${Math.round(p.ep.z)},${p.orient.tag},${floorOnly ? 'F' : 'L'}`;
        if (tried.has(key)) break;
        tried.add(key);
        if (place(container, u, p.ep, p.orient)) return true;
        container.extremePoints = container.extremePoints.filter(ep =>
          !(Math.abs(ep.x - p.ep.x) < 1 && Math.abs(ep.z - p.ep.z) < 1 && Math.abs(ep.y - p.ep.y) < 1)
        );
      }
    }
    return false;
  }

  function openNewContainerAndPlace(u) {
    const orients = getOrientations(u);
    if (!orients.length) { oversized.push(u); return; }
    if (containers.length >= maxContainers) { oversized.push(u); return; }
    const o0 = orients[0];
    const eL = packMaxX - packMinX, eW = packMaxZ - packMinZ, eH = packMaxY - packMinY;
    if (o0.l > eL + 1e-6 || o0.w > eW + 1e-6 || o0.h > eH + 1e-6) {
      oversized.push(u);
      return;
    }
    const container = {
      weightUsed: 0, volumeUsed: 0, items: [],
      extremePoints: [{ x: packMinX, y: packMinY, z: packMinZ }],
      leftWeight: 0, rightWeight: 0
    };
    containers.push(container);
    if (!place(container, u, { x: packMinX, y: packMinY, z: packMinZ }, o0)) {
      containers.pop();
      oversized.push(u);
    }
  }

  // ── Layer-by-layer packing (all workflows: Place / Optimise / rotated) ──
  // Phase 1: fill the floor (y=0) completely before stacking.
  // Phase 2: stack only with ≥80% base support.
  if (!containers.length) {
    containers.push({
      weightUsed: 0, volumeUsed: 0, items: [],
      extremePoints: [{ x: packMinX, y: packMinY, z: packMinZ }],
      leftWeight: 0, rightWeight: 0
    });
  }
  const needLayer2 = [];
  fitsAtAll.forEach(u => {
    if (tryPlaceUnit(u, true)) return;
    needLayer2.push(u);
  });
  needLayer2.forEach(u => {
    if (tryPlaceUnit(u, false)) return;
    openNewContainerAndPlace(u);
  });

  containers.forEach(settleContainer);

  // Drop empty shells (e.g. unused starter container)
  const filled = containers.filter(c => c.items && c.items.length > 0);
  if (!filled.length && containers.length) filled.push(containers[0]);

  const cv = spec.lengthMm*spec.widthMm*spec.heightMm;
  const result = filled.map((c, idx) => ({
    containerNumber:idx+1,
    lengthMm:spec.lengthMm, widthMm:spec.widthMm, heightMm:spec.heightMm,
    maxWeightKg:spec.maxWeightKg,
    usedWeightKg:round2(c.weightUsed),
    weightUtilizationPct:round1(c.weightUsed/spec.maxWeightKg*100),
    volumeUtilizationPct:round1(c.volumeUsed/cv*100),
    // Back-to-front loading: a real worker starts against the back wall
    // and stacks outward toward the doors. The packer's internal x=0 is
    // treated as the back wall - mirror every X so pieces the packer laid
    // down "at x=0 first" end up rendered at the back of the container.
    items: c.items.map(it => {
      const { _box, ...clean } = it;
      clean.x = spec.lengthMm - clean.x;
      return clean;
    })
  }));

  return { containers:result, oversized };
}

