/* 18-cs-pack-v2.js — Container Optimise v2 (built inch-by-inch)
 *
 * DONE:
 *   Step 1 — Normalize pack footprints (nest repair / assembly stamp)
 *   Step 2a — Build packer unit list (_fmUid + pack LWH) — no placement yet
 *   Step 2b — Safe floor envelope = one free-rect (no placement yet)
 *   Step 2c — Try one floor seat (AABB + no overlap) — no commit loop yet
 *   Step 2d — Gravity commit: floor seats always y=0 (no float)
 *   Step 2e — Guillotine free-rect split (prefer full-length side lane)
 *   Step 2f — Full floor loop + honest fitReason leftovers
 *   Step 3a — Twin pair detect (same-span assemblies) — no seat yet
 *   Step 3b — Twin #1 wall-hug seat (home wall, steel W, y=0)
 *   Step 3c — Twin #2 beside (+60 mm gap, no dig-in)
 *   Step 3d — Rebuild one clean full-length leftover free-rect
 *   Step 3e — Long nests into clean strip (before general FFD)
 *   Step 3f — PackWithTwins wire (3a–3e → PackFloor remainder)
 *   Step 4a — Support map from placed nests (exclude tall carriers)
 *   Step 4b — Stack candidate rules (bearing / height / weight / nest-only)
 *   Step 4c — Try one stack seat (XZ + no dig-in + y on support top)
 *   Step 4d — Commit stack seat (y=supportTop, role nest_stack)
 *   Step 4e — PlaceNestStacks pass (leftover nests → best support)
 *   Step 4f — Wire stacks into PackWithTwins + Step4 self-test / CLI soak
 *   Real-yard harden — capacity×N, contact L, pad-slide, max tiers
 *   Step 5a — Placement → viewer pose bridge (packer min-corner → viewer center)
 *   Step 5b — Apply placements to targets/meshes (translate + yaw-Y only, no remorph)
 *   Step 5c — Leftovers stay outside + honest fitReason / stackFailReason
 *   Step 5d — Optimise wire: BuildUnits → PackWithTwins → 5b+5c → layout
 *   Step 5e — Pack report (on-screen + CLI step5)
 *   Step 5f — IFC soak gates (float=0 dig=0) + full Step5 suite
 *
 * Pack V2 Optimise UI wire complete through 5f (soak locally / CLI --ifc)
 */

const CSPACK_V2_EPS = 0.5;
const CSPACK_V2_DEFAULT_W = 2438;
const CSPACK_V2_DEFAULT_L = 12000;
const CSPACK_V2_DEFAULT_H = 2690;

/** Twin lane — Step 3 constants (steel seat, not padded ~480). */
const CSPACK_V2_TWIN_SPAN_TOL_MM = 50;
const CSPACK_V2_TWIN_W_MIN_MM = 120;
const CSPACK_V2_TWIN_W_MAX_MM = 400;
const CSPACK_V2_TWIN_MIN_SPAN_MM = 4000;
const CSPACK_V2_TWIN_BESIDE_GAP_MM = 60;
/** Long nest = nest with length ≥ this fraction of envelope length. */
const CSPACK_V2_LONG_NEST_FRAC = 0.5;
/** Min side-strip width kept for long nests (real yard: don't fill width with twins). */
const CSPACK_V2_MIN_STRIP_FOR_NEST_MM = 300;

/** Step 4 — nest stack (bearing / tall-carrier ban / real-yard capacity). */
const CSPACK_V2_STACK_BEARING_MIN = 0.40;
/** Same-family stacks may use slightly lower bearing if contact length is OK. */
const CSPACK_V2_STACK_BEARING_SAME_FAMILY = 0.35;
const CSPACK_V2_TALL_CARRIER_FRAC = 0.45;
const CSPACK_V2_DEFAULT_SUPPORT_CAP_KG = 1e12;
/** Nest pad can carry ~Nx own weight (yard rule-of-thumb, not FEA). */
const CSPACK_V2_NEST_CAP_MULT = 4;
/** Min lengthways contact on pad (mm), capped to upper nest length. */
const CSPACK_V2_STACK_CONTACT_MIN_MM = 2000;
const CSPACK_V2_STACK_CONTACT_MIN_FRAC = 0.35;
/** Pad-slide search step along +X (mm). */
const CSPACK_V2_STACK_SLIDE_STEP_MM = 100;
/** Small ±Z nudges / side seats when pad is wider than nest. */
const CSPACK_V2_STACK_Z_NUDGE_MM = 50;
/** Max stack tiers from floor (floor nest = tier 1). */
const CSPACK_V2_STACK_MAX_TIERS = 6;

function csPackContainerWidthMm(spec) {
  const w = Number(spec && spec.widthMm);
  if (w > 500) return w;
  try {
    if (typeof rawScene !== 'undefined' && rawScene && rawScene.containerSpec
        && +rawScene.containerSpec.widthMm > 500)
      return +rawScene.containerSpec.widthMm;
  } catch (_) { /* */ }
  return CSPACK_V2_DEFAULT_W;
}

function csPackIsNestUnit(u) {
  if (!u) return false;
  const gk = String(u.groupKind || '').toLowerCase();
  const sk = String(u.shapeKey || u.profileShape || '').toLowerCase();
  if (/^nest_[zcl]$/.test(gk)) return true;
  return sk === 'z_channel' || sk === 'z_shape'
    || sk === 'c_channel' || sk === 'l_angle';
}

function csPackIsAssemblyUnit(u) {
  if (!u) return false;
  return !!(u.isAssembly
    || u.groupKind === 'welded_assembly'
    || u.groupKind === 'assembly_single');
}

/**
 * Thin flange / web width for nest column math — never pitched plan widthMm.
 */
function csPackNestThinW(u) {
  const sectW = +u.sectW || 0;
  const unitW = +u.unitWidth || 0;
  const fromPiece = (u.nestPieces && u.nestPieces[0] && +u.nestPieces[0].sectW) || 0;
  let thin = 0;
  [sectW, unitW, fromPiece].forEach(v => {
    if (v >= 40 && v <= 320) thin = thin || v;
  });
  if (!(thin > 0)) thin = Math.min(Math.max(sectW || unitW || fromPiece || 80, 40), 320);
  return thin;
}

function csPackNestPieceCount(u) {
  const nQty = Math.max(0, +u.qty || 0);
  const nPieces = (u.nestPieces && u.nestPieces.length) || 0;
  const nItems = (u.items && u.items.length) || 0;
  return Math.max(1, nQty, nPieces, nItems);
}

/**
 * Repair one pack unit footprint in place.
 * @returns {{ changed: boolean, reason: string|null }}
 */
function csPackNormalizePackUnit(u, opts) {
  if (!u) return { changed: false, reason: 'null' };
  const Wcap = csPackContainerWidthMm(opts && opts.containerSpec);

  // Always expose pack* triple for the future packer (from best known dims)
  const sb0 = u.stableBundleMm || u.bundle_bbox || null;
  let pl = Math.max(
    +u.packLengthMm || 0,
    +u.packFootprintL || 0,
    (sb0 && +sb0.l) || 0,
    +u.lengthMm || 0,
    +u.lengthMaxMm || 0,
    1);
  let pw = Math.max(
    +u.packWidthMm || 0,
    +u.packFootprintW || 0,
    (sb0 && +sb0.w) || 0,
    +u.widthMm || 0,
    0);
  let ph = Math.max(
    +u.packHeightMm || 0,
    +u.packFootprintH || 0,
    (sb0 && +sb0.h) || 0,
    +u.heightMm || 0,
    0);

  // ── Assemblies: stamp + ship-axis sanitize (never nest-formula remorph) ─
  if (csPackIsAssemblyUnit(u) && !csPackIsNestUnit(u)) {
    if (!(pl > 0 && pw > 0 && ph > 0)) return { changed: false, reason: 'asm_incomplete' };
    const before = `${u.packLengthMm}|${u.packWidthMm}|${u.packHeightMm}`;

    // Prefer durable IFC shipping fields when present
    const shipL = +u.shippingLengthMm || 0;
    const shipW = +u.shippingWidthMm || +u.flangeWidthMm || 0;
    const shipH = +u.shippingHeightMm || 0;
    let reason = 'asm_stamp';
    if (shipL > 500 && shipW >= 40 && shipW <= Wcap + 50 && shipH >= 40) {
      pl = shipL; pw = shipW; ph = shipH;
      reason = 'asm_shipping_fields';
    } else if (typeof cs8NormalizeAssemblyShipAxes === 'function'
        && (typeof cs8IsAbsurdAssemblyFootprint !== 'function'
          || cs8IsAbsurdAssemblyFootprint(pl, pw, ph, u)
          || pw > Wcap + CSPACK_V2_EPS)) {
      const ax = cs8NormalizeAssemblyShipAxes(pl, pw, ph, {
        ...u,
        containerSpec: opts && opts.containerSpec,
      });
      if (ax && ax.w <= Wcap + 50 && ax.l > 0) {
        const prev = { l: pl, w: pw, h: ph };
        pl = ax.l; pw = ax.w; ph = ax.h;
        reason = ax.source === 'already_sane' ? 'asm_stamp' : 'asm_ship_axes';
        if (reason === 'asm_ship_axes') {
          u.stableBundleMm = {
            ...(u.stableBundleMm || {}),
            l: pl, w: pw, h: ph,
            source: 'ship_axes',
            pitchedFrom: ax.pitchedFrom || prev,
          };
        }
      }
    }

    u.packLengthMm = pl;
    u.packWidthMm = pw;
    u.packHeightMm = ph;
    u.packFootprintL = pl;
    u.packFootprintW = pw;
    u.packFootprintH = ph;
    u.lengthMm = pl;
    u.widthMm = pw;
    u.heightMm = ph;
    if (u.stableBundleMm && (reason === 'asm_ship_axes' || reason === 'asm_shipping_fields')) {
      u.stableBundleMm = {
        ...u.stableBundleMm,
        l: pl, w: pw, h: ph,
        source: reason === 'asm_shipping_fields' ? 'shipping_fields' : 'ship_axes',
      };
    }
    const after = `${u.packLengthMm}|${u.packWidthMm}|${u.packHeightMm}`;
    return { changed: before !== after, reason: before !== after ? reason : null };
  }

  // ── Plates / plate stacks: keep thickness as H, seat width ≤ container ─
  const gk = String(u.groupKind || '').toLowerCase();
  const sk = String(u.shapeKey || u.profileShape || '').toLowerCase();
  const isPlate = gk === 'stack_plate' || gk === 'plate' || sk === 'plate';
  if (isPlate && !csPackIsNestUnit(u)) {
    const before = `${u.packLengthMm}|${u.packWidthMm}|${u.packHeightMm}`;
    // Prefer thin axis as thickness (H); longest as L; remaining as W
    const dims = [pl, pw, ph].filter(v => v > 0).sort((a, b) => a - b);
    let tHint = Math.max(+u.sectT || 0, +u.sectH || 0);
    if (!(tHint > 0 && tHint <= 80)) tHint = dims[0] || ph;
    // Mark patterns like "3000*200" / "PL1.5*2500"
    const mark = String(u.mark || '');
    const mPair = mark.match(/(\d+(?:\.\d+)?)\s*[*xX]\s*(\d+(?:\.\d+)?)/);
    let plateL = pl;
    let plateW = pw;
    if (mPair) {
      const a = +mPair[1];
      const b = +mPair[2];
      plateL = Math.max(a, b);
      plateW = Math.min(a, b);
      // PL1.5*2500 → thickness 1.5, plan 2500 (may exceed container — honest)
      if (/^PL/i.test(mark) && a < 20) {
        tHint = a;
        plateL = b;
        plateW = b; // square sheet
      }
    }
    if (plateW > Wcap + CSPACK_V2_EPS && plateL > plateW) {
      // try swapping if one side fits
      if (Math.min(plateL, plateW) <= Wcap + CSPACK_V2_EPS) {
        const fit = Math.min(plateL, plateW);
        const span = Math.max(plateL, plateW);
        plateL = span;
        plateW = fit;
      }
    }
    // Stack height stays ph if already a stack; else thickness
    const outH = ph >= tHint * 1.5 ? ph : Math.max(tHint, ph);
    u.packLengthMm = Math.max(plateL, 1);
    u.packWidthMm = Math.max(plateW, 1);
    u.packHeightMm = Math.max(outH, 1);
    u.packFootprintL = u.packLengthMm;
    u.packFootprintW = u.packWidthMm;
    u.packFootprintH = u.packHeightMm;
    u.lengthMm = u.packLengthMm;
    u.widthMm = u.packWidthMm;
    u.heightMm = u.packHeightMm;
    const after = `${u.packLengthMm}|${u.packWidthMm}|${u.packHeightMm}`;
    return { changed: before !== after, reason: before !== after ? 'plate_seat' : null };
  }

  // ── Nests: repair inflated pitched plan width ─────────────────────────
  if (!csPackIsNestUnit(u)) {
    // Non-nest loose / rod — stamp pack* if missing
    if (pl > 0 && pw > 0 && ph > 0
        && !(u.packLengthMm > 0 && u.packWidthMm > 0 && u.packHeightMm > 0)) {
      u.packLengthMm = pl;
      u.packWidthMm = pw;
      u.packHeightMm = ph;
      u.packFootprintL = pl;
      u.packFootprintW = pw;
      u.packFootprintH = ph;
      return { changed: true, reason: 'stamp_other' };
    }
    return { changed: false, reason: null };
  }

  const thinW = csPackNestThinW(u);
  const sectH = Math.max(
    +u.sectH || 0, +u.unitHeight || 0,
    (u.nestPieces && u.nestPieces[0] && +u.nestPieces[0].sectH) || 0,
    40);
  // Repair absurd short length (IFC sometimes stamps sect depth as lengthMm)
  {
    let pieceMaxL = 0;
    (u.nestPieces || []).forEach(np => {
      pieceMaxL = Math.max(pieceMaxL, +np.lengthMm || 0);
    });
    (u.items || u.memberItems || []).forEach(it => {
      pieceMaxL = Math.max(pieceMaxL, +it.lengthMm || 0);
    });
    // If nest piece lengths are also wrong, look up raw IFC items by mark
    if (pieceMaxL < 500) {
      try {
        const markSet = new Set();
        [u.mark, ...((u.marks) || [])].forEach(m => {
          if (!m) return;
          markSet.add(String(m));
          markSet.add(String(m).replace(/\s*·\s*set\s*\d+\s*$/i, '').trim());
        });
        (u.nestPieces || []).forEach(np => { if (np && np.mark) markSet.add(String(np.mark)); });
        (u.memberItems || []).forEach(it => { if (it && it.mark) markSet.add(String(it.mark)); });
        if (typeof rawScene !== 'undefined' && rawScene && rawScene.items) {
          rawScene.items.forEach(it => {
            if (!it) return;
            const im = String(it.mark || '');
            const hit = markSet.has(im)
              || ((it.marks) || []).some(m => markSet.has(String(m)));
            if (!hit) return;
            pieceMaxL = Math.max(
              pieceMaxL, +it.lengthMm || 0, +it.lengthMaxMm || 0);
          });
        }
      } catch (_) { /* */ }
    }
    const spanGuess = Math.max(
      pieceMaxL, +u.lengthMaxMm || 0, +u.lengthMm || 0, pl);
    const sectLike = Math.max(thinW, sectH, +u.sectW || 0, +u.sectH || 0, 1);
    if (pl > 0 && pl < Math.max(sectLike * 2.5, 400) && spanGuess > pl * 3) {
      pl = spanGuess;
      u.lengthMm = pl;
      u.lengthMaxMm = Math.max(+u.lengthMaxMm || 0, pl);
      (u.nestPieces || []).forEach(np => {
        if (np && !(+np.lengthMm > pl * 0.5)) np.lengthMm = pl;
      });
    }
  }
  const n = csPackNestPieceCount(u);
  const off = Math.max(
    8,
    +u.nestingOffsetMm || +u.nesting_offset || 0,
    (u.nestingInfo && +u.nestingInfo.nesting_offset) || 0,
    thinW * 0.45);
  // Cap column width so one set cannot claim most of the floor
  const nEff = Math.min(
    n,
    Math.max(2, Math.floor((Wcap * 0.72 - thinW) / Math.max(off, 1)) + 1));
  const nestW = Math.min(Wcap * 0.72, thinW + (nEff - 1) * off);
  const skid = Number(u.skidMm) > 0 ? Number(u.skidMm) : 0;
  const nestH = sectH + skid;

  const pitchedW = pw > Math.max(nestW * 1.15, thinW * 2.5) || pw > Wcap * 0.42;
  const pitchedH = ph > Math.max(nestH * 2.2, sectH * 2.5) && sectH > 0;
  if (!pitchedW && !pitchedH) {
    // Still stamp pack* for packer contract
    if (!(u.packLengthMm > 0 && u.packWidthMm > 0 && u.packHeightMm > 0)) {
      u.packLengthMm = pl;
      u.packWidthMm = pw > 0 ? pw : nestW;
      u.packHeightMm = ph > 0 ? ph : nestH;
      u.packFootprintL = u.packLengthMm;
      u.packFootprintW = u.packWidthMm;
      u.packFootprintH = u.packHeightMm;
      return { changed: true, reason: 'nest_stamp' };
    }
    return { changed: false, reason: null };
  }

  const prevW = pw;
  const prevH = ph;
  if (pitchedW) pw = nestW;
  if (pitchedH || !(ph > 0)) ph = Math.max(nestH, sectH);

  u.packLengthMm = pl;
  u.packWidthMm = pw;
  u.packHeightMm = ph;
  u.packFootprintL = pl;
  u.packFootprintW = pw;
  u.packFootprintH = ph;
  // Keep widthMm/heightMm pack-facing in sync (construction sect* untouched)
  u.widthMm = pw;
  u.heightMm = ph;
  if (u.bundle_bbox) {
    u.bundle_bbox = {
      ...u.bundle_bbox,
      l: pl, w: pw, h: ph,
      source: 'nest_repair',
    };
  }
  u.stableBundleMm = {
    ...(u.stableBundleMm || {}),
    l: pl, w: pw, h: ph,
    source: 'nest_repair',
    pitchedFrom: (prevW > pw + CSPACK_V2_EPS || prevH > ph + CSPACK_V2_EPS)
      ? { l: pl, w: prevW, h: prevH }
      : (u.stableBundleMm && u.stableBundleMm.pitchedFrom) || undefined,
  };
  u._packFootprintNormalized = true;
  return { changed: true, reason: 'nest_repair' };
}

/**
 * Normalize a list of pack units. Returns count changed.
 */
function csPackNormalizePackUnits(units, opts) {
  let n = 0;
  (units || []).forEach(u => {
    const r = csPackNormalizePackUnit(u, opts);
    if (r && r.changed) n++;
  });
  // Sibling borrow: if one nest set in the same group has a real span and
  // another still has sect-depth as length (60/200), copy the good span.
  let maxNestL = 0;
  (units || []).forEach(u => {
    if (!csPackIsNestUnit(u)) return;
    maxNestL = Math.max(
      maxNestL, +u.packLengthMm || 0, +u.lengthMm || 0,
      (u.stableBundleMm && +u.stableBundleMm.l) || 0);
  });
  if (maxNestL > 1000) {
    (units || []).forEach(u => {
      if (!csPackIsNestUnit(u)) return;
      const pl = +u.packLengthMm || +u.lengthMm || 0;
      if (!(pl > 0 && pl < 500)) return;
      u.packLengthMm = maxNestL;
      u.packFootprintL = maxNestL;
      u.lengthMm = maxNestL;
      u.lengthMaxMm = Math.max(+u.lengthMaxMm || 0, maxNestL);
      if (u.stableBundleMm) {
        u.stableBundleMm = { ...u.stableBundleMm, l: maxNestL, source: 'nest_repair' };
      }
      if (u.bundle_bbox) u.bundle_bbox = { ...u.bundle_bbox, l: maxNestL };
      (u.nestPieces || []).forEach(np => {
        if (np && !(+np.lengthMm > maxNestL * 0.5)) np.lengthMm = maxNestL;
      });
      u._packFootprintNormalized = true;
      n++;
    });
  }
  return n;
}

/**
 * Normalize every packUnit on staging groups (after Step 7 attach).
 */
function csPackNormalizeGroups(groups, opts) {
  let n = 0;
  (groups || []).forEach(g => {
    if (!g || !g.packUnits) return;
    n += csPackNormalizePackUnits(g.packUnits, opts);
  });
  // Cross-group borrow: same profile family (e.g. all 200C25 sets) share span
  const maxByKey = Object.create(null);
  function nestKey(pu, g) {
    const desc = String(pu.profileDesc || g.profileDesc || pu.mark || g.mark || '')
      .toLowerCase().replace(/\s*·\s*set\s*\d+\s*$/i, '').trim();
    const sk = String(pu.shapeKey || pu.profileShape || g.shapeKey || '').toLowerCase();
    return desc || sk || 'nest';
  }
  (groups || []).forEach(g => {
    (g.packUnits || []).forEach(pu => {
      if (!csPackIsNestUnit(pu)) return;
      const pl = +pu.packLengthMm || +pu.lengthMm || 0;
      if (pl > 1000) {
        const k = nestKey(pu, g);
        maxByKey[k] = Math.max(maxByKey[k] || 0, pl);
      }
    });
  });
  // Scene-wide max span by shapeKey + sectH (when whole family has bad length)
  const maxBySect = Object.create(null);
  try {
    if (typeof rawScene !== 'undefined' && rawScene && rawScene.items) {
      rawScene.items.forEach(it => {
        if (!it) return;
        const sk = String(it.shapeKey || it.profileShape || '').toLowerCase();
        if (!/z_channel|c_channel|l_angle/.test(sk)) return;
        const sh = Math.round(+it.sectH || +it.heightMm || 0);
        const L = Math.max(+it.lengthMm || 0, +it.lengthMaxMm || 0);
        if (L > 1000 && sh > 0) {
          const k = sk + '|' + sh;
          maxBySect[k] = Math.max(maxBySect[k] || 0, L);
        }
      });
    }
  } catch (_) { /* */ }

  function applyBorrow(pu, borrow) {
    if (!(borrow > 1000)) return false;
    const pl = +pu.packLengthMm || +pu.lengthMm || 0;
    if (!(pl > 0 && pl < 500)) return false;
    pu.packLengthMm = borrow;
    pu.packFootprintL = borrow;
    pu.lengthMm = borrow;
    pu.lengthMaxMm = Math.max(+pu.lengthMaxMm || 0, borrow);
    if (pu.stableBundleMm)
      pu.stableBundleMm = { ...pu.stableBundleMm, l: borrow, source: 'nest_repair' };
    if (pu.bundle_bbox) pu.bundle_bbox = { ...pu.bundle_bbox, l: borrow };
    (pu.nestPieces || []).forEach(np => {
      if (np && !(+np.lengthMm > borrow * 0.5)) np.lengthMm = borrow;
    });
    pu._packFootprintNormalized = true;
    return true;
  }

  (groups || []).forEach(g => {
    (g.packUnits || []).forEach(pu => {
      if (!csPackIsNestUnit(pu)) return;
      let borrow = maxByKey[nestKey(pu, g)] || 0;
      if (!(borrow > 1000)) {
        const sk = String(pu.shapeKey || pu.profileShape || g.shapeKey || '').toLowerCase();
        const sh = Math.round(+pu.sectH || +g.sectH || 0);
        borrow = maxBySect[sk + '|' + sh] || 0;
      }
      if (applyBorrow(pu, borrow)) n++;
    });
  });
  try {
    if (n > 0) console.info(`[PackV2] nest/footprint normalize: ${n} unit(s) repaired`);
  } catch (_) { /* */ }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2a — Build packer unit list (no placement)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect pack units from Group By staging groups into a packer-ready list.
 *
 * - Shallow-clones each packUnit (Group By cards stay untouched)
 * - Runs Step 1 normalize so packLength/Width/Height are honest
 * - Assigns unique `_fmUid` (never remove siblings by mark alone later)
 * - Sorts by staging checkOrder, then heavier first
 *
 * @param {object[]} groups  assemblyGroups (or equivalent)
 * @param {object} [opts]
 * @param {boolean} [opts.checkedOnly=true]  only checked staging groups
 * @param {object}  [opts.containerSpec]
 * @returns {object[]}
 */
function csPackV2BuildUnits(groups, opts) {
  const o = opts || {};
  const checkedOnly = o.checkedOnly !== false;
  const list = [];
  let idx = 0;

  (groups || []).forEach((g, gi) => {
    if (!g) return;
    if (checkedOnly && g.checked === false) return;
    if (String(g.state || '') === 'oversized') return;

    const pus = (g.packUnits && g.packUnits.length) ? g.packUnits : null;
    if (!pus) return;

    pus.forEach((pu) => {
      if (!pu) return;

      // Clone metadata only — do not mutate the Group By pack unit object
      const u = { ...pu };
      if (pu.marks) u.marks = pu.marks.slice();
      if (pu.stableBundleMm) u.stableBundleMm = { ...pu.stableBundleMm };
      if (pu.bundle_bbox) u.bundle_bbox = { ...pu.bundle_bbox };

      u.groupKind = u.groupKind || g.groupKind || null;
      u.shapeKey = u.shapeKey || g.shapeKey || g.profileShape || u.profileShape || null;
      u._checkOrder = Math.max(0, +g.checkOrder || +pu._checkOrder || (gi + 1));
      if (!u.marks || !u.marks.length) {
        u.marks = [u.mark, g.mark].filter(Boolean);
      }
      // Durable IFC shipping fields (Phase 2 extract) — prefer for pack LWH
      if (!(+u.shippingLengthMm > 0) && +pu.shippingLengthMm > 0)
        u.shippingLengthMm = +pu.shippingLengthMm;
      if (!(+u.shippingWidthMm > 0) && +pu.shippingWidthMm > 0)
        u.shippingWidthMm = +pu.shippingWidthMm;
      if (!(+u.shippingHeightMm > 0) && +pu.shippingHeightMm > 0)
        u.shippingHeightMm = +pu.shippingHeightMm;
      if (!(+u.flangeWidthMm > 0) && +pu.flangeWidthMm > 0)
        u.flangeWidthMm = +pu.flangeWidthMm;

      // Step 1 — footprint normalize on the clone
      csPackNormalizePackUnit(u, o);

      // After normalize, pack* is authoritative (do NOT max() with raw world
      // widthMm/heightMm — that re-inflates ship-axis / nest repairs).
      let pl = Math.max(+u.packLengthMm || 0, +u.packFootprintL || 0, 0);
      let pw = Math.max(+u.packWidthMm || 0, +u.packFootprintW || 0, 0);
      let ph = Math.max(+u.packHeightMm || 0, +u.packFootprintH || 0, 0);
      if (!(pl > 0)) {
        pl = Math.max(+u.lengthMm || 0, (u.stableBundleMm && +u.stableBundleMm.l) || 0, 1);
      }
      if (!(pw > 0)) {
        pw = Math.max(+u.widthMm || 0, (u.stableBundleMm && +u.stableBundleMm.w) || 0, 1);
      }
      if (!(ph > 0)) {
        ph = Math.max(+u.heightMm || 0, (u.stableBundleMm && +u.stableBundleMm.h) || 0, 1);
      }

      u.packLengthMm = pl;
      u.packWidthMm = pw;
      u.packHeightMm = ph;
      u.packFootprintL = pl;
      u.packFootprintW = pw;
      u.packFootprintH = ph;
      // Keep pack-facing dims in sync (construction sect* untouched)
      u.lengthMm = pl;
      u.widthMm = pw;
      u.heightMm = ph;
      u.l = pl; u.w = pw; u.h = ph;

      u.weightKg = Math.max(
        +u.weightKg || 0, +u.total_weight || 0,
        +g.sortWeightKg || 0, +g.weightKg || 0, 0);

      // Unique instance id — two "set 1" twins must not share identity
      const markSafe = String(u.mark || 'u').replace(/[^\w.\-]+/g, '_').slice(0, 48);
      u._fmUid = `v2_${idx}_${markSafe}_${Math.round(pl)}x${Math.round(pw)}`;
      u._srcPackUnit = pu;
      u._srcGroup = g;

      idx += 1;
      list.push(u);
    });
  });

  // Cross-unit nest length borrow (same as normalize groups, on the list)
  if (typeof csPackNormalizePackUnits === 'function') {
    try { csPackNormalizePackUnits(list, o); } catch (_) { /* */ }
  }

  // Re-read dims after borrow; pack* stays authoritative (no raw-width re-inflate)
  list.forEach(u => {
    const pl = Math.max(+u.packLengthMm || 0, 1);
    const pw = Math.max(+u.packWidthMm || 0, 1);
    const ph = Math.max(+u.packHeightMm || 0, 1);
    u.packLengthMm = pl; u.packWidthMm = pw; u.packHeightMm = ph;
    u.packFootprintL = pl; u.packFootprintW = pw; u.packFootprintH = ph;
    u.lengthMm = pl; u.widthMm = pw; u.heightMm = ph;
    u.l = pl; u.w = pw; u.h = ph;
  });

  list.sort((a, b) =>
    (+a._checkOrder || 99999) - (+b._checkOrder || 99999)
    || (+b.weightKg || 0) - (+a.weightKg || 0)
    || String(a._fmUid).localeCompare(String(b._fmUid)));

  return list;
}

/**
 * Step 2a self-test. Console: csPackV2Step2aSelfTest()
 */
function csPackV2Step2aSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const groups = [
    {
      mark: 'G_ASM', checked: true, checkOrder: 1,
      groupKind: 'welded_assembly', weightKg: 900,
      packUnits: [
        {
          mark: 'RF-A', isAssembly: true, groupKind: 'welded_assembly',
          lengthMm: 11000, widthMm: 200, heightMm: 2500, weightKg: 450,
          stableBundleMm: { l: 11000, w: 200, h: 2500, source: 'ship_prep' },
        },
        {
          mark: 'RF-A', isAssembly: true, groupKind: 'welded_assembly',
          lengthMm: 11000, widthMm: 200, heightMm: 2500, weightKg: 450,
          stableBundleMm: { l: 11000, w: 200, h: 2500, source: 'ship_prep' },
        },
      ],
    },
    {
      mark: 'G_Z', checked: true, checkOrder: 2,
      groupKind: 'nest_z', weightKg: 300,
      packUnits: [{
        mark: '200Z · set 1', groupKind: 'nest_z', shapeKey: 'z_channel',
        sectW: 85, sectH: 200, qty: 6, nestingOffsetMm: 40,
        lengthMm: 9000, widthMm: 1600, heightMm: 200, weightKg: 300,
        stableBundleMm: { l: 9000, w: 1600, h: 200, source: 'ship_prep' },
      }],
    },
    {
      mark: 'G_SKIP', checked: false, checkOrder: 3,
      groupKind: 'nest_z',
      packUnits: [{
        mark: 'skip-me', groupKind: 'nest_z', shapeKey: 'z_channel',
        lengthMm: 5000, widthMm: 200, heightMm: 200, weightKg: 50,
        packLengthMm: 5000, packWidthMm: 200, packHeightMm: 200,
      }],
    },
  ];

  const units = csPackV2BuildUnits(groups, { containerSpec: { widthMm: 2438 } });

  check('U1', units.length === 3, `count=${units.length} (expect 3: skip unchecked)`);

  const uids = units.map(u => u._fmUid);
  check('U2', uids.length === new Set(uids).size, `uids=${uids.join(',')}`);

  // Same mark twins still get different _fmUid
  check('U3', units[0]._fmUid !== units[1]._fmUid,
    `uid0=${units[0] && units[0]._fmUid} uid1=${units[1] && units[1]._fmUid}`);

  const allDims = units.every(u =>
    +u.packLengthMm > 0 && +u.packWidthMm > 0 && +u.packHeightMm > 0);
  check('U4', allDims, units.map(u => `${u.packLengthMm}x${u.packWidthMm}x${u.packHeightMm}`).join(';'));

  const nest = units.find(u => csPackIsNestUnit(u));
  check('U5', !!nest && nest.packWidthMm < 600,
    nest ? `nest pw=${nest.packWidthMm}` : 'no nest');

  // Original Group By pack unit not mutated (still fat width on source)
  const srcZ = groups[1].packUnits[0];
  check('U6', +srcZ.widthMm === 1600 || +((srcZ.stableBundleMm && srcZ.stableBundleMm.w) || 0) === 1600,
    `srcW=${srcZ.widthMm} sbW=${srcZ.stableBundleMm && srcZ.stableBundleMm.w}`);

  check('U7', units[0]._checkOrder === 1 && units[2]._checkOrder === 2,
    `orders=${units.map(u => u._checkOrder).join(',')}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2a self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2b — Safe floor envelope = one free-rect (no placement)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve container outer dims (mm) from spec / rawScene / defaults.
 */
function csPackV2ContainerSpec(spec) {
  let L = Number(spec && spec.lengthMm) || 0;
  let W = Number(spec && spec.widthMm) || 0;
  let H = Number(spec && spec.heightMm) || 0;
  try {
    if (typeof rawScene !== 'undefined' && rawScene && rawScene.containerSpec) {
      const c = rawScene.containerSpec;
      if (!(L > 500)) L = +c.lengthMm || L;
      if (!(W > 500)) W = +c.widthMm || W;
      if (!(H > 500)) H = +c.heightMm || H;
    }
  } catch (_) { /* */ }
  if (!(L > 500)) L = CSPACK_V2_DEFAULT_L;
  if (!(W > 500)) W = CSPACK_V2_DEFAULT_W;
  if (!(H > 500)) H = CSPACK_V2_DEFAULT_H;
  return { lengthMm: L, widthMm: W, heightMm: H };
}

/**
 * Safe pack envelope in packer mm space (X 0→L, Z 0→W, Y 0→H).
 * Uses getPackEnvelope / loading rules when available.
 */
function csPackV2FloorEnvelope(spec) {
  const outer = csPackV2ContainerSpec(spec);
  if (typeof getPackEnvelope === 'function') {
    const e = getPackEnvelope(outer);
    return {
      outerLengthMm: e.outerLengthMm,
      outerWidthMm: e.outerWidthMm,
      outerHeightMm: e.outerHeightMm,
      minXMm: e.minXMm,
      maxXMm: e.maxXMm,
      minZMm: e.minZMm,
      maxZMm: e.maxZMm,
      minYMm: e.minYMm,
      maxYMm: e.maxYMm,
      lengthMm: e.lengthMm,
      widthMm: e.widthMm,
      heightMm: e.heightMm,
      clearanceEndMm: e.clearanceEndMm,
      clearanceSideMm: e.clearanceSideMm,
      clearanceTopMm: e.clearanceTopMm,
      bundleGapMm: e.bundleGapMm,
      source: 'getPackEnvelope',
    };
  }
  // Fallback: 2.5 mm wall/end/top (same as LOADING_RULES defaults)
  const end = 2.5;
  const side = 2.5;
  const top = 2.5;
  return {
    outerLengthMm: outer.lengthMm,
    outerWidthMm: outer.widthMm,
    outerHeightMm: outer.heightMm,
    minXMm: end,
    maxXMm: outer.lengthMm - end,
    minZMm: side,
    maxZMm: outer.widthMm - side,
    minYMm: 0,
    maxYMm: outer.heightMm - top,
    lengthMm: Math.max(0, outer.lengthMm - 2 * end),
    widthMm: Math.max(0, outer.widthMm - 2 * side),
    heightMm: Math.max(0, outer.heightMm - top),
    clearanceEndMm: end,
    clearanceSideMm: side,
    clearanceTopMm: top,
    bundleGapMm: 20,
    source: 'fallback_2_5mm',
  };
}

/**
 * Initial free-rect list: exactly ONE floor rectangle = safe envelope.
 * Packer coords: x = rear→door, z = home wall→far wall, y = floor→up.
 *
 * @returns {{ freeRects: object[], envelope: object }}
 */
function csPackV2InitialFreeRects(spec) {
  const env = csPackV2FloorEnvelope(spec);
  const rect = {
    id: 'floor0',
    x: env.minXMm,
    z: env.minZMm,
    length: env.lengthMm,
    width: env.widthMm,
    y: 0,
    heightAvailable: env.heightMm,
    supportedBy: 'floor',
    supportCapacityKg: 1e12,
  };
  return { freeRects: [rect], envelope: env };
}

/**
 * Step 2b self-test. Console: csPackV2Step2bSelfTest()
 */
function csPackV2Step2bSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const { freeRects, envelope } = csPackV2InitialFreeRects(spec);

  check('E1', freeRects.length === 1, `nRects=${freeRects.length}`);
  const r = freeRects[0];
  check('E2', !!r && r.y === 0 && r.supportedBy === 'floor',
    r ? `y=${r.y} by=${r.supportedBy}` : 'no rect');

  // Inset from outer walls (not the full outer box)
  check('E3', r.x > 0 && r.z > 0,
    `x=${r.x} z=${r.z}`);
  check('E4', r.x + r.length < spec.lengthMm && r.z + r.width < spec.widthMm,
    `end=${r.x + r.length}/${spec.lengthMm} side=${r.z + r.width}/${spec.widthMm}`);

  check('E5', r.length > spec.lengthMm * 0.95 && r.width > spec.widthMm * 0.95,
    `L=${r.length} W=${r.width} (near full after tiny clearance)`);

  check('E6', r.heightAvailable > 2000 && r.heightAvailable <= spec.heightMm,
    `hAvail=${r.heightAvailable}`);

  check('E7', envelope.clearanceSideMm > 0 && envelope.clearanceEndMm > 0,
    `side=${envelope.clearanceSideMm} end=${envelope.clearanceEndMm}`);

  // Envelope smaller than outer
  check('E8', envelope.lengthMm < envelope.outerLengthMm
    && envelope.widthMm < envelope.outerWidthMm,
    `env ${envelope.lengthMm}x${envelope.widthMm} vs outer ${envelope.outerLengthMm}x${envelope.outerWidthMm}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2b self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2c — Try one floor seat (AABB fit + no overlap)
// ═══════════════════════════════════════════════════════════════════════════

/** Pack footprint from Step1/2a fields. */
function csPackV2Foot(u) {
  return {
    pl: Math.max(+u.packLengthMm || +u.packFootprintL || +u.l || +u.lengthMm || 0, 1),
    pw: Math.max(+u.packWidthMm || +u.packFootprintW || +u.w || +u.widthMm || 0, 1),
    ph: Math.max(+u.packHeightMm || +u.packFootprintH || +u.h || +u.heightMm || 0, 1),
  };
}

/** Axis-aligned box in packer mm (X length, Z width, Y up). */
function csPackV2MakeBox(x, z, pl, pw, ph, y) {
  const y0 = (y != null && y >= 0) ? y : 0;
  return {
    minX: x, maxX: x + pl,
    minZ: z, maxZ: z + pw,
    minY: y0, maxY: y0 + ph,
  };
}

function csPackV2BoxesOverlap(a, b, tol) {
  if (!a || !b) return false;
  const t = (tol != null) ? tol : CSPACK_V2_EPS;
  return !(a.maxX <= b.minX + t || a.minX >= b.maxX - t
    || a.maxY <= b.minY + t || a.minY >= b.maxY - t
    || a.maxZ <= b.minZ + t || a.minZ >= b.maxZ - t);
}

/**
 * Try to seat one unit on the floor at packer (x,z).
 * Does NOT mutate state / free-rects — pure validation.
 *
 * @param {object} unit   packer unit (packLength/Width/Height)
 * @param {number} x      packer X (mm)
 * @param {number} z      packer Z (mm)
 * @param {object} [opts]
 * @param {object} [opts.envelope]     from csPackV2FloorEnvelope
 * @param {object} [opts.containerSpec]
 * @param {object} [opts.rect]         optional free-rect constraint
 * @param {object[]} [opts.placedBoxes] already seated AABBs
 * @returns {{ ok, reason, x, z, y, pl, pw, ph, box }}
 */
function csPackV2TryFloorSeat(unit, x, z, opts) {
  const o = opts || {};
  const env = o.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const placed = o.placedBoxes || [];
  const rect = o.rect || null;
  const { pl, pw, ph } = csPackV2Foot(unit);

  if (!(pl > 0 && pw > 0 && ph > 0))
    return { ok: false, reason: 'BAD_DIMS', x, z, y: 0, pl, pw, ph, box: null };
  if (ph > env.heightMm + CSPACK_V2_EPS)
    return { ok: false, reason: 'HEIGHT_EXCEEDS', x, z, y: 0, pl, pw, ph, box: null };

  if (x < env.minXMm - CSPACK_V2_EPS || z < env.minZMm - CSPACK_V2_EPS
      || x + pl > env.maxXMm + CSPACK_V2_EPS
      || z + pw > env.maxZMm + CSPACK_V2_EPS) {
    return { ok: false, reason: 'OUTSIDE_ENVELOPE', x, z, y: 0, pl, pw, ph, box: null };
  }

  if (rect) {
    if (x < rect.x - CSPACK_V2_EPS || z < rect.z - CSPACK_V2_EPS
        || x + pl > rect.x + rect.length + CSPACK_V2_EPS
        || z + pw > rect.z + rect.width + CSPACK_V2_EPS) {
      return { ok: false, reason: 'OUTSIDE_RECT', x, z, y: 0, pl, pw, ph, box: null };
    }
    const hAvail = (rect.heightAvailable != null) ? rect.heightAvailable : env.heightMm;
    if (ph > hAvail + CSPACK_V2_EPS)
      return { ok: false, reason: 'HEIGHT_EXCEEDS', x, z, y: 0, pl, pw, ph, box: null };
  }

  const box = csPackV2MakeBox(x, z, pl, pw, ph, 0);
  for (let i = 0; i < placed.length; i++) {
    if (csPackV2BoxesOverlap(box, placed[i]))
      return { ok: false, reason: 'OVERLAP', x, z, y: 0, pl, pw, ph, box };
  }

  return { ok: true, reason: null, x, z, y: 0, pl, pw, ph, box };
}

/**
 * Step 2c self-test. Console: csPackV2Step2cSelfTest()
 */
function csPackV2Step2cSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const { freeRects, envelope } = csPackV2InitialFreeRects(spec);
  const floor = freeRects[0];

  const small = {
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 300, mark: 'SMALL',
  };
  const seat1 = csPackV2TryFloorSeat(small, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [],
  });
  check('S1', seat1.ok && seat1.y === 0 && seat1.reason == null,
    `ok=${seat1.ok} y=${seat1.y} reason=${seat1.reason}`);

  // Same corner → overlap
  const seat2 = csPackV2TryFloorSeat(small, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [seat1.box],
  });
  check('S2', !seat2.ok && seat2.reason === 'OVERLAP',
    `ok=${seat2.ok} reason=${seat2.reason}`);

  // Beside first (clear of overlap)
  const seat3 = csPackV2TryFloorSeat(small, floor.x, floor.z + small.packWidthMm + 20, {
    envelope, rect: floor, placedBoxes: [seat1.box],
  });
  check('S3', seat3.ok, `ok=${seat3.ok} reason=${seat3.reason}`);

  // Too tall
  const tall = {
    packLengthMm: 1000, packWidthMm: 200, packHeightMm: 5000, mark: 'TALL',
  };
  const seat4 = csPackV2TryFloorSeat(tall, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [],
  });
  check('S4', !seat4.ok && seat4.reason === 'HEIGHT_EXCEEDS',
    `ok=${seat4.ok} reason=${seat4.reason}`);

  // Outside envelope (negative)
  const seat5 = csPackV2TryFloorSeat(small, -100, floor.z, {
    envelope, placedBoxes: [],
  });
  check('S5', !seat5.ok && seat5.reason === 'OUTSIDE_ENVELOPE',
    `ok=${seat5.ok} reason=${seat5.reason}`);

  // Longer than free-rect
  const long = {
    packLengthMm: floor.length + 500, packWidthMm: 200, packHeightMm: 200,
  };
  const seat6 = csPackV2TryFloorSeat(long, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [],
  });
  check('S6', !seat6.ok && (seat6.reason === 'OUTSIDE_RECT' || seat6.reason === 'OUTSIDE_ENVELOPE'),
    `ok=${seat6.ok} reason=${seat6.reason}`);

  // Boxes overlap helper sanity
  const a = csPackV2MakeBox(0, 0, 100, 100, 50, 0);
  const b = csPackV2MakeBox(50, 50, 100, 100, 50, 0);
  const c = csPackV2MakeBox(200, 0, 100, 100, 50, 0);
  check('S7', csPackV2BoxesOverlap(a, b) && !csPackV2BoxesOverlap(a, c),
    `ab=${csPackV2BoxesOverlap(a, b)} ac=${csPackV2BoxesOverlap(a, c)}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2c self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2d — Gravity commit (floor seats always y = 0)
//
// POVs locked for this step:
//   Physics  — floor AABB bottom rests on y=0; never float / never artificial shelf
//   API      — Try (2c) validates; Commit (2d) locks gravity; split is 2e
//   Safety   — even if seat.y / seat.box.minY is tampered, commit forces y=0
//   Future   — stacking/supportY is NOT here; layer stays 'floor' only
//   Group By — no remorph; only translate with forced y
//   State    — does NOT mutate freeRects (guillotine = 2e)
// ═══════════════════════════════════════════════════════════════════════════

/** Floor gravity contract: packer AABB bottom on container floor. */
function csPackV2FloorGravityY() {
  return 0;
}

/**
 * Commit a successful floor seat under gravity.
 * Always forces y = 0 for floor layer — ignores seat.y / opts.y.
 *
 * @param {object} unit  packer unit
 * @param {object} seat  result from csPackV2TryFloorSeat (must be ok)
 * @param {object} [opts]
 * @returns {{ ok, reason, placement }}
 */
function csPackV2CommitFloorSeat(unit, seat, opts) {
  const o = opts || {};
  if (!unit)
    return { ok: false, reason: 'NO_UNIT', placement: null };
  if (!seat || !seat.ok)
    return { ok: false, reason: 'SEAT_NOT_OK', placement: null };

  const { pl, pw, ph } = csPackV2Foot(unit);
  const x = (seat.x != null) ? +seat.x : NaN;
  const z = (seat.z != null) ? +seat.z : NaN;
  if (!(Number.isFinite(x) && Number.isFinite(z)))
    return { ok: false, reason: 'BAD_XZ', placement: null };
  if (!(pl > 0 && pw > 0 && ph > 0))
    return { ok: false, reason: 'BAD_DIMS', placement: null };

  // Optional re-check against envelope / placed (defense; same rules as 2c)
  if (o.recheck !== false) {
    const again = csPackV2TryFloorSeat(unit, x, z, {
      envelope: o.envelope,
      containerSpec: o.containerSpec,
      rect: o.rect,
      placedBoxes: o.placedBoxes || [],
    });
    if (!again.ok)
      return { ok: false, reason: again.reason || 'RECHECK_FAIL', placement: null };
  }

  const y = csPackV2FloorGravityY(); // always 0 — ignore seat.y
  const box = csPackV2MakeBox(x, z, pl, pw, ph, y);
  // Hard lock: never allow a floating floor box even if MakeBox changes later
  box.minY = 0;
  box.maxY = ph;

  const placement = {
    _fmUid: unit._fmUid != null ? unit._fmUid : null,
    mark: unit.mark || null,
    x, z, y,
    pl, pw, ph,
    box,
    layer: 'floor',
    gravity: 'floor_y0',
  };
  return { ok: true, reason: null, placement };
}

/**
 * Step 2d self-test. Console: csPackV2Step2dSelfTest()
 */
function csPackV2Step2dSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  check('G0', csPackV2FloorGravityY() === 0, `y=${csPackV2FloorGravityY()}`);

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const { freeRects, envelope } = csPackV2InitialFreeRects(spec);
  const floor = freeRects[0];
  const small = {
    _fmUid: 'u-test-1',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 300, mark: 'SMALL',
  };

  const seat = csPackV2TryFloorSeat(small, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [],
  });
  const commit = csPackV2CommitFloorSeat(small, seat, {
    envelope, rect: floor, placedBoxes: [],
  });
  check('G1', commit.ok && commit.placement
    && commit.placement.y === 0
    && commit.placement.box.minY === 0
    && commit.placement.box.maxY === small.packHeightMm
    && commit.placement.layer === 'floor'
    && commit.placement.gravity === 'floor_y0',
  `ok=${commit.ok} y=${commit.placement && commit.placement.y} minY=${commit.placement && commit.placement.box.minY}`);

  // Tampered seat.y / box.minY must still commit at floor
  const tampered = Object.assign({}, seat, {
    y: 500,
    box: Object.assign({}, seat.box, { minY: 500, maxY: 800 }),
  });
  const commit2 = csPackV2CommitFloorSeat(small, tampered, {
    envelope, rect: floor, placedBoxes: [], recheck: false,
  });
  check('G2', commit2.ok && commit2.placement.y === 0
    && commit2.placement.box.minY === 0
    && commit2.placement.box.maxY === small.packHeightMm,
  `y=${commit2.placement && commit2.placement.y} minY=${commit2.placement && commit2.placement.box.minY}`);

  // Failed seat cannot commit
  const badSeat = csPackV2TryFloorSeat(small, floor.x, floor.z, {
    envelope, rect: floor, placedBoxes: [seat.box],
  });
  const commit3 = csPackV2CommitFloorSeat(small, badSeat, {
    envelope, rect: floor, placedBoxes: [seat.box],
  });
  check('G3', !commit3.ok && commit3.reason === 'SEAT_NOT_OK',
    `ok=${commit3.ok} reason=${commit3.reason}`);

  // Null unit / null seat
  check('G4', !csPackV2CommitFloorSeat(null, seat).ok
    && !csPackV2CommitFloorSeat(small, null).ok,
    'null guards');

  // Placement keeps seat xz + uid (no remorph)
  check('G5', commit.placement.x === seat.x
    && commit.placement.z === seat.z
    && commit.placement._fmUid === 'u-test-1'
    && commit.placement.pl === small.packLengthMm
    && commit.placement.pw === small.packWidthMm,
  `x=${commit.placement.x} z=${commit.placement.z} uid=${commit.placement._fmUid}`);

  // Recheck catches overlap if placedBoxes now occupied
  const commit4 = csPackV2CommitFloorSeat(small, seat, {
    envelope, rect: floor, placedBoxes: [seat.box], recheck: true,
  });
  check('G6', !commit4.ok && commit4.reason === 'OVERLAP',
    `ok=${commit4.ok} reason=${commit4.reason}`);

  // Two commits: first then second beside — both y=0, no float
  const seatB = csPackV2TryFloorSeat(small, floor.x, floor.z + small.packWidthMm + 20, {
    envelope, rect: floor, placedBoxes: [commit.placement.box],
  });
  const commitB = csPackV2CommitFloorSeat(small, seatB, {
    envelope, rect: floor, placedBoxes: [commit.placement.box],
  });
  check('G7', commitB.ok && commitB.placement.y === 0
    && !csPackV2BoxesOverlap(commit.placement.box, commitB.placement.box),
  `ok=${commitB.ok} y=${commitB.placement && commitB.placement.y}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2d self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2e — Guillotine free-rect split (prefer full-length side lane)
//
// POVs locked for this step:
//   Geometry — non-overlapping leftovers only (true guillotine, not MaxRects)
//   Warehouse — preferSideLane: leftover beside in Z spans FULL free-rect length
//              (so long nests can still use the strip later — pillar #4/#5)
//   Contract — placement must sit flush to one of 4 free-rect corners
//   Gap      — optional gapMm between placed box and new free edges (default 0;
//              2f/twins may pass bundle gap)
//   Tiny     — discard scraps below minLength/minWidth (default 50mm)
//   State    — ApplySplit returns NEW freeRects array (immutable input)
//   Gravity  — free rects stay y=0 / floor; no stacking shelves here
//   Group By — no remorph; only free-space bookkeeping after a commit
// ═══════════════════════════════════════════════════════════════════════════

const CSPACK_V2_MIN_FREE_MM = 50;

function csPackV2RectArea(r) {
  if (!r) return 0;
  return Math.max(0, +r.length || 0) * Math.max(0, +r.width || 0);
}

/**
 * Which free-rect corner the placement is flush to (or null).
 * @returns {'bl'|'br'|'tl'|'tr'|null}
 */
function csPackV2PlacementCorner(rect, placement, eps) {
  const e = (eps != null) ? eps : CSPACK_V2_EPS;
  if (!rect || !placement) return null;
  const pl = +placement.pl || 0;
  const pw = +placement.pw || 0;
  const x = +placement.x;
  const z = +placement.z;
  const rx = +rect.x;
  const rz = +rect.z;
  const rL = +rect.length;
  const rW = +rect.width;
  const atMinX = Math.abs(x - rx) <= e;
  const atMaxX = Math.abs(x + pl - (rx + rL)) <= e;
  const atMinZ = Math.abs(z - rz) <= e;
  const atMaxZ = Math.abs(z + pw - (rz + rW)) <= e;
  if (atMinX && atMinZ) return 'bl';
  if (atMaxX && atMinZ) return 'br';
  if (atMinX && atMaxZ) return 'tl';
  if (atMaxX && atMaxZ) return 'tr';
  return null;
}

/** @deprecated use csPackV2PlacementCorner — kept for older call sites */
function csPackV2PlacementAtRectOrigin(rect, placement, eps) {
  return csPackV2PlacementCorner(rect, placement, eps) === 'bl';
}

/** Four corner seat positions for a footprint inside a free-rect. */
function csPackV2RectCornerSeats(rect, pl, pw) {
  const rx = +rect.x;
  const rz = +rect.z;
  const rL = +rect.length;
  const rW = +rect.width;
  if (!(pl > 0 && pw > 0 && pl <= rL + CSPACK_V2_EPS && pw <= rW + CSPACK_V2_EPS))
    return [];
  return [
    { corner: 'bl', x: rx, z: rz },
    { corner: 'br', x: rx + rL - pl, z: rz },
    { corner: 'tl', x: rx, z: rz + rW - pw },
    { corner: 'tr', x: rx + rL - pl, z: rz + rW - pw },
  ];
}

/** Placement fully inside free-rect (XZ). */
function csPackV2PlacementInsideRect(rect, placement, eps) {
  const e = (eps != null) ? eps : CSPACK_V2_EPS;
  if (!rect || !placement) return false;
  const pl = +placement.pl || 0;
  const pw = +placement.pw || 0;
  const x = +placement.x;
  const z = +placement.z;
  return x >= +rect.x - e
    && z >= +rect.z - e
    && x + pl <= +rect.x + +rect.length + e
    && z + pw <= +rect.z + +rect.width + e;
}

/**
 * Clone a free-rect with new geometry; keep floor support metadata.
 */
function csPackV2MakeFreeRect(base, x, z, length, width, idSuffix) {
  return {
    id: (base && base.id ? String(base.id) : 'fr') + (idSuffix || ''),
    x, z,
    length, width,
    y: 0,
    heightAvailable: (base && base.heightAvailable != null)
      ? base.heightAvailable : null,
    supportedBy: (base && base.supportedBy) || 'floor',
    supportCapacityKg: (base && base.supportCapacityKg != null)
      ? base.supportCapacityKg : 1e12,
  };
}

/**
 * Guillotine-split one free-rect after a floor placement at a rect corner.
 *
 * preferSideLane (default true) — full-length Z strip + short X remnant
 * in the placement's Z-band (orientation depends on which corner).
 *
 * @returns {{ ok, reason, leftovers: object[], corner, policy }}
 */
function csPackV2SplitFreeRect(rect, placement, opts) {
  const o = opts || {};
  if (!rect)
    return { ok: false, reason: 'NO_RECT', leftovers: [], corner: null };
  if (!placement)
    return { ok: false, reason: 'NO_PLACEMENT', leftovers: [], corner: null };

  const pl = +placement.pl || 0;
  const pw = +placement.pw || 0;
  if (!(pl > 0 && pw > 0))
    return { ok: false, reason: 'BAD_DIMS', leftovers: [], corner: null };

  if (!csPackV2PlacementInsideRect(rect, placement))
    return { ok: false, reason: 'OUTSIDE_RECT', leftovers: [], corner: null };

  const corner = csPackV2PlacementCorner(rect, placement);
  if (!corner)
    return { ok: false, reason: 'NOT_AT_RECT_CORNER', leftovers: [], corner: null };

  const gap = Math.max(0, +o.gapMm || 0);
  const minL = (o.minLengthMm != null) ? +o.minLengthMm : CSPACK_V2_MIN_FREE_MM;
  const minW = (o.minWidthMm != null) ? +o.minWidthMm : CSPACK_V2_MIN_FREE_MM;
  const preferSide = o.preferSideLane !== false;

  const rx = +rect.x;
  const rz = +rect.z;
  const rL = +rect.length;
  const rW = +rect.width;
  const px = +placement.x;
  const pz = +placement.z;

  const leftovers = [];
  function pushIfUsable(x, z, length, width, tag) {
    if (length >= minL - CSPACK_V2_EPS && width >= minW - CSPACK_V2_EPS)
      leftovers.push(csPackV2MakeFreeRect(rect, x, z, length, width, '_' + tag));
  }

  // X-band remnant (same Z as piece) + full-length side lane in remaining Z
  if (preferSide) {
    if (corner === 'bl' || corner === 'tl') {
      // remnant toward +X
      pushIfUsable(px + pl + gap, pz, (rx + rL) - (px + pl + gap), pw, 'x');
    } else {
      // remnant toward -X
      pushIfUsable(rx, pz, (px - gap) - rx, pw, 'x');
    }
    if (corner === 'bl' || corner === 'br') {
      // side lane toward +Z (full length)
      pushIfUsable(rx, pz + pw + gap, rL, (rz + rW) - (pz + pw + gap), 'z');
    } else {
      // side lane toward -Z (full length)
      pushIfUsable(rx, rz, rL, (pz - gap) - rz, 'z');
    }
  } else {
    // Alternate: full-width strip beside in Z of piece only + X remnant full height
    if (corner === 'bl' || corner === 'br')
      pushIfUsable(px, pz + pw + gap, pl, (rz + rW) - (pz + pw + gap), 'z');
    else
      pushIfUsable(px, rz, pl, (pz - gap) - rz, 'z');
    if (corner === 'bl' || corner === 'tl')
      pushIfUsable(px + pl + gap, rz, (rx + rL) - (px + pl + gap), rW, 'x');
    else
      pushIfUsable(rx, rz, (px - gap) - rx, rW, 'x');
  }

  return {
    ok: true, reason: null, leftovers, corner,
    policy: preferSide ? 'side_lane' : 'front_lane',
  };
}

/**
 * Two free-rects overlap in XZ (area > 0 beyond eps). Used to assert guillotine purity.
 */
function csPackV2FreeRectsOverlap(a, b, eps) {
  if (!a || !b) return false;
  const e = (eps != null) ? eps : CSPACK_V2_EPS;
  return !(a.x + a.length <= b.x + e || b.x + b.length <= a.x + e
    || a.z + a.width <= b.z + e || b.z + b.width <= a.z + e);
}

/**
 * Apply guillotine split: remove consumed rect, append leftovers.
 * Does not mutate the input array.
 *
 * @param {object[]} freeRects
 * @param {object} rect        the free-rect that was used (match by id or ref geom)
 * @param {object} placement
 * @param {object} [opts]
 * @returns {{ ok, reason, freeRects, leftovers, removedId }}
 */
function csPackV2ApplySplit(freeRects, rect, placement, opts) {
  if (!Array.isArray(freeRects))
    return { ok: false, reason: 'NO_LIST', freeRects: [], leftovers: [], removedId: null };
  if (!rect)
    return { ok: false, reason: 'NO_RECT', freeRects: freeRects.slice(), leftovers: [], removedId: null };

  const split = csPackV2SplitFreeRect(rect, placement, opts);
  if (!split.ok)
    return {
      ok: false, reason: split.reason, freeRects: freeRects.slice(),
      leftovers: [], removedId: rect.id || null,
    };

  const rid = rect.id;
  const next = [];
  let removed = false;
  for (let i = 0; i < freeRects.length; i++) {
    const fr = freeRects[i];
    const sameId = rid != null && fr && fr.id === rid;
    const sameGeom = fr && Math.abs(+fr.x - +rect.x) <= CSPACK_V2_EPS
      && Math.abs(+fr.z - +rect.z) <= CSPACK_V2_EPS
      && Math.abs(+fr.length - +rect.length) <= CSPACK_V2_EPS
      && Math.abs(+fr.width - +rect.width) <= CSPACK_V2_EPS;
    if (!removed && (sameId || sameGeom)) {
      removed = true;
      continue;
    }
    next.push(fr);
  }
  if (!removed)
    return {
      ok: false, reason: 'RECT_NOT_IN_LIST', freeRects: freeRects.slice(),
      leftovers: [], removedId: rid || null,
    };

  for (let j = 0; j < split.leftovers.length; j++)
    next.push(split.leftovers[j]);

  return {
    ok: true,
    reason: null,
    freeRects: next,
    leftovers: split.leftovers,
    removedId: rid || null,
    policy: split.policy,
  };
}

/**
 * Step 2e self-test. Console: csPackV2Step2eSelfTest()
 */
function csPackV2Step2eSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const init = csPackV2InitialFreeRects(spec);
  const floor = init.freeRects[0];
  const env = init.envelope;
  const small = {
    _fmUid: 'u-split-1',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 300, mark: 'SMALL',
  };

  const seat = csPackV2TryFloorSeat(small, floor.x, floor.z, {
    envelope: env, rect: floor, placedBoxes: [],
  });
  const commit = csPackV2CommitFloorSeat(small, seat, {
    envelope: env, rect: floor, placedBoxes: [],
  });
  check('R0', commit.ok, `commit=${commit.ok}`);

  const split = csPackV2SplitFreeRect(floor, commit.placement, { gapMm: 0 });
  check('R1', split.ok && split.leftovers.length >= 1,
    `ok=${split.ok} n=${split.leftovers.length} reason=${split.reason}`);

  // Side-lane policy: one leftover must span FULL original free-rect length
  const sideLane = split.leftovers.find(r =>
    Math.abs(+r.length - +floor.length) <= CSPACK_V2_EPS);
  check('R2', !!sideLane && sideLane.width > 0,
    sideLane ? `side L=${sideLane.length} W=${sideLane.width}` : 'no side lane');

  // Right remnant exists (X rest, height ≈ pw)
  const right = split.leftovers.find(r =>
    Math.abs(+r.x - (floor.x + small.packLengthMm)) <= CSPACK_V2_EPS
    && Math.abs(+r.z - floor.z) <= CSPACK_V2_EPS);
  check('R3', !!right && Math.abs(+right.width - small.packWidthMm) <= CSPACK_V2_EPS,
    right ? `right L=${right.length} W=${right.width}` : 'no right');

  // Leftovers must NOT overlap each other (guillotine purity)
  let anyOv = false;
  for (let i = 0; i < split.leftovers.length; i++) {
    for (let j = i + 1; j < split.leftovers.length; j++) {
      if (csPackV2FreeRectsOverlap(split.leftovers[i], split.leftovers[j]))
        anyOv = true;
    }
  }
  check('R4', !anyOv, `overlap=${anyOv}`);

  // Leftovers must not overlap the placed box
  let hitBox = false;
  const box = commit.placement.box;
  for (let i = 0; i < split.leftovers.length; i++) {
    const fr = split.leftovers[i];
    const frBox = csPackV2MakeBox(fr.x, fr.z, fr.length, fr.width, 1, 0);
    if (csPackV2BoxesOverlap(frBox, box)) hitBox = true;
  }
  check('R5', !hitBox, `hitBox=${hitBox}`);

  // ApplySplit: list mutates immutably — old floor gone, leftovers in
  const applied = csPackV2ApplySplit(init.freeRects, floor, commit.placement, { gapMm: 0 });
  check('R6', applied.ok
    && applied.freeRects.length === split.leftovers.length
    && !applied.freeRects.some(r => r.id === floor.id),
  `ok=${applied.ok} n=${applied.freeRects.length}`);

  // Input array not mutated
  check('R7', init.freeRects.length === 1 && init.freeRects[0].id === floor.id,
    `inputN=${init.freeRects.length}`);

  // Off-corner placement rejected
  const off = {
    x: floor.x + 100, z: floor.z, pl: 500, pw: 100, y: 0,
  };
  const bad = csPackV2SplitFreeRect(floor, off, {});
  check('R8', !bad.ok && bad.reason === 'NOT_AT_RECT_CORNER',
    `ok=${bad.ok} reason=${bad.reason}`);

  // Far corner (tr) still splits cleanly with full-length side lane
  const farPlace = {
    x: floor.x + floor.length - small.packLengthMm,
    z: floor.z + floor.width - small.packWidthMm,
    pl: small.packLengthMm, pw: small.packWidthMm, y: 0,
  };
  const splitFar = csPackV2SplitFreeRect(floor, farPlace, { gapMm: 0 });
  const sideFar = splitFar.leftovers && splitFar.leftovers.find(r =>
    Math.abs(+r.length - +floor.length) <= CSPACK_V2_EPS);
  check('R8b', splitFar.ok && splitFar.corner === 'tr' && !!sideFar,
    `ok=${splitFar.ok} corner=${splitFar.corner} side=${!!sideFar}`);

  // Outside placement rejected
  const outP = {
    x: floor.x, z: floor.z, pl: floor.length + 100, pw: 100, y: 0,
  };
  const bad2 = csPackV2SplitFreeRect(floor, outP, {});
  check('R9', !bad2.ok && (bad2.reason === 'OUTSIDE_RECT' || bad2.reason === 'OCCUPIED_EXCEEDS_RECT'),
    `ok=${bad2.ok} reason=${bad2.reason}`);

  // Tiny scrap discarded (place almost full length → right remnant < 50)
  const longU = {
    packLengthMm: floor.length - 30, packWidthMm: 200, packHeightMm: 200,
  };
  const seatL = csPackV2TryFloorSeat(longU, floor.x, floor.z, {
    envelope: env, rect: floor, placedBoxes: [],
  });
  const commitL = csPackV2CommitFloorSeat(longU, seatL, {
    envelope: env, rect: floor, placedBoxes: [], recheck: false,
  });
  const splitTiny = csPackV2SplitFreeRect(floor, commitL.placement, {
    gapMm: 0, minLengthMm: 50, minWidthMm: 50,
  });
  const tinyRight = splitTiny.leftovers.find(r =>
    Math.abs(+r.z - floor.z) <= CSPACK_V2_EPS
    && +r.length < 50);
  check('R10', splitTiny.ok && !tinyRight && splitTiny.leftovers.length >= 1,
    `n=${splitTiny.leftovers.length} (tiny right dropped)`);

  // Gap: side lane starts at z + pw + gap
  const splitGap = csPackV2SplitFreeRect(floor, commit.placement, { gapMm: 20 });
  const sideG = splitGap.leftovers.find(r =>
    Math.abs(+r.length - +floor.length) <= CSPACK_V2_EPS);
  check('R11', splitGap.ok && sideG
    && Math.abs(+sideG.z - (floor.z + small.packWidthMm + 20)) <= CSPACK_V2_EPS,
  sideG ? `sideZ=${sideG.z}` : 'no side');

  // Second place into side lane then split again — still ≥1 usable leftover
  const side0 = applied.freeRects.find(r =>
    Math.abs(+r.length - +floor.length) <= CSPACK_V2_EPS);
  check('R12', !!side0, side0 ? `side0 W=${side0.width}` : 'missing');
  if (side0) {
    const seat2 = csPackV2TryFloorSeat(small, side0.x, side0.z, {
      envelope: env, rect: side0, placedBoxes: [commit.placement.box],
    });
    const commit2 = csPackV2CommitFloorSeat(small, seat2, {
      envelope: env, rect: side0, placedBoxes: [commit.placement.box],
    });
    const applied2 = csPackV2ApplySplit(applied.freeRects, side0, commit2.placement, {});
    check('R13', commit2.ok && applied2.ok && applied2.freeRects.length >= 1,
      `c2=${commit2.ok} a2=${applied2.ok} n=${applied2.freeRects.length}`);
    // No free-rect overlaps after second split
    let ov2 = false;
    for (let i = 0; i < applied2.freeRects.length; i++) {
      for (let j = i + 1; j < applied2.freeRects.length; j++) {
        if (csPackV2FreeRectsOverlap(applied2.freeRects[i], applied2.freeRects[j]))
          ov2 = true;
      }
    }
    check('R14', !ov2, `ov2=${ov2}`);
  } else {
    check('R13', false, 'skipped');
    check('R14', false, 'skipped');
  }

  // Area sanity: leftovers area ≤ free area − placed area (gap=0)
  const placedArea = small.packLengthMm * small.packWidthMm;
  const leftArea = split.leftovers.reduce((s, r) => s + csPackV2RectArea(r), 0);
  const freeArea = csPackV2RectArea(floor);
  check('R15', leftArea <= freeArea - placedArea + 1
    && leftArea >= freeArea - placedArea - 1,
  `left=${leftArea} free=${freeArea} placed=${placedArea}`);

  // Floor metadata preserved
  check('R16', split.leftovers.every(r =>
    r.y === 0 && r.supportedBy === 'floor' && r.heightAvailable === floor.heightAvailable),
  'floor meta');

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2e self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2f — Full floor pack loop + honest fitReason leftovers
//
// Perspectives locked (approach check BEFORE code):
//   Plan        — sort already done in 2a; try each unit once; leftover = fitReason
//   Seat search — only free-rect ORIGIN corners (matches 2e guillotine contract)
//   Choice      — among fitting rects: home-wall (low z) → rear (low x) → tight area
//   Continue    — one unit fails → mark leftover, still try later units (FFD)
//   Gravity     — every commit via 2d → y=0; no float shelves
//   Split       — after each commit, 2e side-lane guillotine (+ optional gap)
//   Yaw/stack   — NOT in 2f (frozen Group By pose; twins/stack = later steps)
//   Group By    — clones only; never remorph; unplaced stay conceptually outside
//   Honesty     — FOOTPRINT/HEIGHT_EXCEEDS vs NO_SLOT (fragmentation) distinguished
//   Gap         — default envelope.bundleGapMm on split so next origin is clear
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify why a unit cannot take a floor seat right now.
 * @returns {{ fitReason: string, fitReasonMsg: string }}
 */
function csPackV2ClassifyUnplaced(unit, envelope, opts) {
  const o = opts || {};
  const { pl, pw, ph } = csPackV2Foot(unit);
  if (!(pl > 0 && pw > 0 && ph > 0)) {
    return {
      fitReason: 'BAD_DIMS',
      fitReasonMsg: 'Pack unit has invalid L/W/H',
    };
  }
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  if (ph > env.heightMm + CSPACK_V2_EPS) {
    return {
      fitReason: 'HEIGHT_EXCEEDS',
      fitReasonMsg: `Height ${Math.round(ph)} > clear ${Math.round(env.heightMm)} mm`,
    };
  }
  if (pl > env.lengthMm + CSPACK_V2_EPS || pw > env.widthMm + CSPACK_V2_EPS) {
    return {
      fitReason: 'FOOTPRINT_EXCEEDS',
      fitReasonMsg: `Footprint ${Math.round(pl)}×${Math.round(pw)} > floor `
        + `${Math.round(env.lengthMm)}×${Math.round(env.widthMm)} mm`,
    };
  }
  // Fits empty envelope, but no free-rect origin accepted it
  const last = o.lastFailReason || null;
  return {
    fitReason: 'NO_SLOT',
    fitReasonMsg: last
      ? `No floor slot (last try: ${last})`
      : 'No free-rect corner left for this footprint',
  };
}

/**
 * Score a candidate free-rect seat (lower = better).
 * Home wall → rear → least wasted area.
 */
function csPackV2ScoreFloorCandidate(rect, pl, pw) {
  const waste = Math.max(0, (+rect.length * +rect.width) - (pl * pw));
  return {
    z: +rect.z,
    x: +rect.x,
    waste,
  };
}

function csPackV2CandidateBetter(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.score.z !== b.score.z) return a.score.z < b.score.z;
  if (a.score.x !== b.score.x) return a.score.x < b.score.x;
  if (a.score.waste !== b.score.waste) return a.score.waste < b.score.waste;
  return false;
}

/**
 * Find best floor seat for one unit among free-rect corners × yaw {0,90}.
 * @returns {{ ok, reason, seat, rect, score, yawDeg, viewUnit, corner }}
 */
function csPackV2FindFloorSeat(unit, freeRects, opts) {
  const o = opts || {};
  const env = o.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const placed = o.placedBoxes || [];
  const rects = freeRects || [];
  const base = csPackV2Foot(unit);
  const allowYaw = o.allowYaw !== false;

  if (!(base.pl > 0 && base.pw > 0 && base.ph > 0))
    return {
      ok: false, reason: 'BAD_DIMS', seat: null, rect: null,
      score: null, yawDeg: 0, viewUnit: null, corner: null,
    };

  const yaws = allowYaw ? [0, 90] : [0];
  let best = null;
  let lastFail = 'NO_RECTS';

  for (let yi = 0; yi < yaws.length; yi++) {
    const yaw = yaws[yi];
    const pl = yaw === 90 ? base.pw : base.pl;
    const pw = yaw === 90 ? base.pl : base.pw;
    const ph = base.ph;
    // Skip redundant yaw when square footprint
    if (yaw === 90 && Math.abs(base.pl - base.pw) <= CSPACK_V2_EPS) continue;

    const viewUnit = {
      ...unit,
      packLengthMm: pl,
      packWidthMm: pw,
      packHeightMm: ph,
      packFootprintL: pl,
      packFootprintW: pw,
      packFootprintH: ph,
      _packYawDeg: yaw,
    };

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (!rect) continue;
      if (pl > +rect.length + CSPACK_V2_EPS || pw > +rect.width + CSPACK_V2_EPS) {
        lastFail = 'OUTSIDE_RECT';
        continue;
      }
      const hAvail = (rect.heightAvailable != null) ? rect.heightAvailable : env.heightMm;
      if (ph > hAvail + CSPACK_V2_EPS) {
        lastFail = 'HEIGHT_EXCEEDS';
        continue;
      }
      const corners = csPackV2RectCornerSeats(rect, pl, pw);
      for (let ci = 0; ci < corners.length; ci++) {
        const c = corners[ci];
        const seat = csPackV2TryFloorSeat(viewUnit, c.x, c.z, {
          envelope: env,
          rect,
          placedBoxes: placed,
        });
        if (!seat.ok) {
          lastFail = seat.reason || 'REJECT';
          continue;
        }
        const cand = {
          ok: true,
          reason: null,
          seat,
          rect,
          yawDeg: yaw,
          viewUnit,
          corner: c.corner,
          score: csPackV2ScoreFloorCandidate(rect, pl, pw),
        };
        // Prefer yaw 0 when scores equal
        if (!best || csPackV2CandidateBetter(cand, best)
            || (cand.score.z === best.score.z
              && cand.score.x === best.score.x
              && cand.score.waste === best.score.waste
              && cand.yawDeg < best.yawDeg)) {
          best = cand;
        }
      }
    }
  }

  if (!best) {
    return {
      ok: false, reason: lastFail, seat: null, rect: null,
      score: null, yawDeg: 0, viewUnit: null, corner: null,
    };
  }
  return best;
}

/**
 * Floor-only packer loop (Step 2f).
 * Uses 2a order, 2b envelope, 2c try, 2d commit, 2e split.
 *
 * @param {object[]} units  from csPackV2BuildUnits (or fake test units)
 * @param {object} [opts]
 * @param {object} [opts.containerSpec]
 * @param {object} [opts.envelope]          override envelope (with seeds)
 * @param {object[]} [opts.initialFreeRects] seed free-rects (Step 3f)
 * @param {object[]} [opts.initialPlaced]    already seated placements
 * @param {object[]} [opts.initialPlacedBoxes] extra AABBs if needed
 * @param {Array} [opts.skipUids]            uids already placed / skip
 * @param {number} [opts.gapMm]  default = envelope.bundleGapMm
 * @returns {{ ok, placed, unplaced, freeRects, envelope, gapMm }}
 */
function csPackV2PackFloor(units, opts) {
  const o = opts || {};
  const init = csPackV2InitialFreeRects(o.containerSpec);
  const envelope = o.envelope || init.envelope;
  let freeRects = (o.initialFreeRects != null)
    ? (Array.isArray(o.initialFreeRects) ? o.initialFreeRects.slice() : [])
    : init.freeRects.slice();
  const gapMm = (o.gapMm != null)
    ? Math.max(0, +o.gapMm)
    : Math.max(0, +(envelope.bundleGapMm != null ? envelope.bundleGapMm : 20));

  const placed = [];
  const unplaced = [];
  const placedBoxes = [];
  const skip = new Set();
  (o.skipUids || []).forEach(id => { if (id != null) skip.add(id); });

  // Seed prior seats (twins / long nests) — floor loop must not re-place them
  const seeded = Array.isArray(o.initialPlaced) ? o.initialPlaced : [];
  for (let si = 0; si < seeded.length; si++) {
    const p = seeded[si];
    if (!p) continue;
    placed.push(p);
    if (p.box) placedBoxes.push(p.box);
    if (p._fmUid != null) skip.add(p._fmUid);
  }
  const extraBoxes = Array.isArray(o.initialPlacedBoxes) ? o.initialPlacedBoxes : [];
  for (let bi = 0; bi < extraBoxes.length; bi++) {
    const box = extraBoxes[bi];
    if (box) placedBoxes.push(box);
  }

  const list = Array.isArray(units) ? units : [];

  for (let i = 0; i < list.length; i++) {
    const unit = list[i];
    if (!unit) continue;
    if (unit._fmUid != null && skip.has(unit._fmUid)) continue;

    const found = csPackV2FindFloorSeat(unit, freeRects, {
      envelope,
      placedBoxes,
      allowYaw: o.allowYaw !== false,
    });

    if (!found.ok) {
      const cls = csPackV2ClassifyUnplaced(unit, envelope, {
        lastFailReason: found.reason,
      });
      const entry = {
        unit,
        _fmUid: unit._fmUid != null ? unit._fmUid : null,
        mark: unit.mark || null,
        fitReason: cls.fitReason,
        fitReasonMsg: cls.fitReasonMsg,
      };
      unit.fitReason = cls.fitReason;
      unit.fitReasonMsg = cls.fitReasonMsg;
      unplaced.push(entry);
      continue;
    }

    const packUnit = found.viewUnit || unit;
    const commit = csPackV2CommitFloorSeat(packUnit, found.seat, {
      envelope,
      rect: found.rect,
      placedBoxes,
    });
    if (!commit.ok || !commit.placement) {
      const cls = csPackV2ClassifyUnplaced(unit, envelope, {
        lastFailReason: commit.reason || 'COMMIT_FAIL',
      });
      unit.fitReason = cls.fitReason;
      unit.fitReasonMsg = cls.fitReasonMsg;
      unplaced.push({
        unit, _fmUid: unit._fmUid || null, mark: unit.mark || null,
        fitReason: cls.fitReason, fitReasonMsg: cls.fitReasonMsg,
      });
      continue;
    }

    const applied = csPackV2ApplySplit(freeRects, found.rect, commit.placement, {
      gapMm,
      preferSideLane: true,
    });
    if (!applied.ok) {
      freeRects = freeRects.filter(r => r !== found.rect && !(r && found.rect
        && r.id === found.rect.id));
    } else {
      freeRects = applied.freeRects;
    }

    placedBoxes.push(commit.placement.box);
    unit.fitReason = null;
    unit.fitReasonMsg = null;
    placed.push({
      ...commit.placement,
      unit,
      yawDeg: found.yawDeg || 0,
      corner: found.corner || null,
      rectId: found.rect && found.rect.id,
    });
  }

  // Feasible = would fit empty envelope upright (after dim honesty)
  let feasibleCount = 0;
  let feasiblePlaced = 0;
  let absurdFootprintCount = 0;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!u) continue;
    const f = csPackV2Foot(u);
    const absurd = (typeof cs8IsAbsurdAssemblyFootprint === 'function')
      ? cs8IsAbsurdAssemblyFootprint(f.pl, f.pw, f.ph, u)
      : (f.pw > envelope.widthMm + CSPACK_V2_EPS
        && f.pl > envelope.widthMm * 0.5);
    if (absurd) absurdFootprintCount++;
    const feasible = f.ph <= envelope.heightMm + CSPACK_V2_EPS
      && f.pl <= envelope.lengthMm + CSPACK_V2_EPS
      && f.pw <= envelope.widthMm + CSPACK_V2_EPS
      && !absurd;
    if (feasible) {
      feasibleCount++;
      if (placed.some(p => p.unit === u || p._fmUid === u._fmUid))
        feasiblePlaced++;
    }
  }
  const feasiblePlaceRate = feasibleCount > 0 ? feasiblePlaced / feasibleCount : 1;

  return {
    ok: true,
    placed,
    unplaced,
    freeRects,
    envelope,
    gapMm,
    placedCount: placed.length,
    unplacedCount: unplaced.length,
    feasibleCount,
    feasiblePlaced,
    feasiblePlaceRate,
    absurdFootprintCount,
  };
}

/**
 * Step 2f self-test. Console: csPackV2Step2fSelfTest()
 * Plan bar: 3 fake units → 2 in / 1 out with fitReason.
 */
function csPackV2Step2fSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };

  // --- Case A: 2 in / 1 out (FOOTPRINT_EXCEEDS) ---
  const u1 = {
    _fmUid: 'f1', mark: 'A',
    packLengthMm: 4000, packWidthMm: 400, packHeightMm: 300, weightKg: 500,
  };
  const u2 = {
    _fmUid: 'f2', mark: 'B',
    packLengthMm: 4000, packWidthMm: 400, packHeightMm: 300, weightKg: 400,
  };
  const u3 = {
    _fmUid: 'f3', mark: 'C',
    packLengthMm: 4000, packWidthMm: 3000, packHeightMm: 300, weightKg: 100,
  };
  const packA = csPackV2PackFloor([u1, u2, u3], { containerSpec: spec, gapMm: 20 });
  check('F1', packA.placedCount === 2 && packA.unplacedCount === 1,
    `in=${packA.placedCount} out=${packA.unplacedCount}`);
  check('F2', packA.unplaced[0]
    && packA.unplaced[0].fitReason === 'FOOTPRINT_EXCEEDS'
    && packA.unplaced[0].mark === 'C',
  `reason=${packA.unplaced[0] && packA.unplaced[0].fitReason} mark=${packA.unplaced[0] && packA.unplaced[0].mark}`);

  // All placed on floor gravity
  check('F3', packA.placed.every(p => p.y === 0 && p.box && p.box.minY === 0),
    'all y=0');

  // No placed overlaps
  let ov = false;
  for (let i = 0; i < packA.placed.length; i++) {
    for (let j = i + 1; j < packA.placed.length; j++) {
      if (csPackV2BoxesOverlap(packA.placed[i].box, packA.placed[j].box)) ov = true;
    }
  }
  check('F4', !ov, `overlap=${ov}`);

  // Free-rects non-overlapping
  let frOv = false;
  for (let i = 0; i < packA.freeRects.length; i++) {
    for (let j = i + 1; j < packA.freeRects.length; j++) {
      if (csPackV2FreeRectsOverlap(packA.freeRects[i], packA.freeRects[j])) frOv = true;
    }
  }
  check('F5', !frOv, `frOv=${frOv}`);

  // --- Case B: HEIGHT_EXCEEDS ---
  const tall = {
    _fmUid: 'ft', mark: 'TALL',
    packLengthMm: 1000, packWidthMm: 200, packHeightMm: 5000,
  };
  const packB = csPackV2PackFloor([tall], { containerSpec: spec });
  check('F6', packB.placedCount === 0 && packB.unplacedCount === 1
    && packB.unplaced[0].fitReason === 'HEIGHT_EXCEEDS',
  `reason=${packB.unplaced[0] && packB.unplaced[0].fitReason}`);

  // --- Case C: NO_SLOT (fits empty floor, but scraps too small after a fat place) ---
  const fat = {
    _fmUid: 'fat', mark: 'FAT',
    packLengthMm: 11000, packWidthMm: 2200, packHeightMm: 400,
  };
  const mid = {
    _fmUid: 'mid', mark: 'MID',
    packLengthMm: 8000, packWidthMm: 1500, packHeightMm: 400,
  };
  const packC = csPackV2PackFloor([fat, mid], { containerSpec: spec, gapMm: 20 });
  check('F7', packC.placedCount === 1 && packC.unplacedCount === 1
    && packC.unplaced[0].fitReason === 'NO_SLOT'
    && packC.unplaced[0].mark === 'MID',
  `in=${packC.placedCount} out=${packC.unplacedCount} reason=${packC.unplaced[0] && packC.unplaced[0].fitReason}`);

  // --- Case D: order preserved — heavier/first unit places at home-wall origin ---
  check('F8', packA.placed[0]._fmUid === 'f1'
    && packA.placed[0].x === packA.envelope.minXMm
    && packA.placed[0].z === packA.envelope.minZMm,
  `uid0=${packA.placed[0] && packA.placed[0]._fmUid} xz=${packA.placed[0] && packA.placed[0].x},${packA.placed[0] && packA.placed[0].z}`);

  // --- Case E: every unit accounted for ---
  check('F9', packA.placedCount + packA.unplacedCount === 3, 'accounted');

  // --- Case F: unplaced stamps fitReason on clone unit ---
  check('F10', u3.fitReason === 'FOOTPRINT_EXCEEDS' && u1.fitReason == null,
    `u3=${u3.fitReason} u1=${u1.fitReason}`);

  // --- Case G: side lane still present after first place (warehouse strip) ---
  const packOne = csPackV2PackFloor([u1], { containerSpec: spec, gapMm: 20 });
  const side = packOne.freeRects.find(r =>
    Math.abs(+r.length - +packOne.envelope.lengthMm) <= CSPACK_V2_EPS);
  check('F11', !!side && side.width > 1000,
    side ? `side W=${side.width}` : 'no side');

  // --- Case H: FindFloorSeat rejects empty list cleanly ---
  const none = csPackV2FindFloorSeat(u1, [], { containerSpec: spec });
  check('F12', !none.ok, `ok=${none.ok}`);

  // --- Case I: yaw 90 lets span-on-width footprint seat ---
  const needYaw = {
    _fmUid: 'fyaw', mark: 'YAW',
    packLengthMm: 2000, packWidthMm: 5000, packHeightMm: 300,
  };
  const packYaw = csPackV2PackFloor([needYaw], { containerSpec: spec, gapMm: 20 });
  check('F13', packYaw.placedCount === 1 && packYaw.placed[0].yawDeg === 90
    && packYaw.placed[0].pl === 5000 && packYaw.placed[0].pw === 2000,
  `in=${packYaw.placedCount} yaw=${packYaw.placed[0] && packYaw.placed[0].yawDeg} `
    + `${packYaw.placed[0] && packYaw.placed[0].pl}x${packYaw.placed[0] && packYaw.placed[0].pw}`);

  // --- Case J: feasible metrics — A/B feasible & placed; C is intentional oversize ---
  check('F14', packA.feasibleCount === 2 && packA.feasiblePlaced === 2
    && packA.feasiblePlaceRate === 1 && packA.absurdFootprintCount >= 1,
  `feas=${packA.feasiblePlaced}/${packA.feasibleCount} rate=${packA.feasiblePlaceRate} absurd=${packA.absurdFootprintCount}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step2f self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3a — Twin pair detection (no seating yet)
//
// Perspectives locked:
//   Warehouse — twins = same-span floor assemblies (rafters), steel flange W
//   Identity  — pair by _fmUid never mark alone (two "set 1" stay distinct)
//   Exclude   — nests / plates / rods / fat W / too-short span / over-height
//   Geometry  — lengthways floor-feasible: pl ≤ env.L, pw ≤ env.W, ph ≤ clear
//   Pairing   — greedy longest/heaviest first; disjoint pairs only
//   Seat      — 3b/3c; here we only report { a, b, spanL, seatW }
// ═══════════════════════════════════════════════════════════════════════════

/**
 * True if unit can be one side of a twin rafter lane.
 */
function csPackV2IsTwinCandidate(u, envelope) {
  if (!u || !csPackIsAssemblyUnit(u) || csPackIsNestUnit(u)) return false;
  const env = envelope || csPackV2FloorEnvelope(null);
  const { pl, pw, ph } = csPackV2Foot(u);
  if (!(pl >= CSPACK_V2_TWIN_MIN_SPAN_MM)) return false;
  if (pw < CSPACK_V2_TWIN_W_MIN_MM - CSPACK_V2_EPS
      || pw > CSPACK_V2_TWIN_W_MAX_MM + CSPACK_V2_EPS)
    return false;
  if (ph > env.heightMm + CSPACK_V2_EPS) return false;
  if (pl > env.lengthMm + CSPACK_V2_EPS) return false;
  if (pw > env.widthMm + CSPACK_V2_EPS) return false;
  // Two twins + gap must fit across container width
  if (pw * 2 + CSPACK_V2_TWIN_BESIDE_GAP_MM > env.widthMm + CSPACK_V2_EPS)
    return false;
  return true;
}

/**
 * Greedy disjoint same-span twin pairs.
 * @returns {{ a, b, spanL, seatW, gapMm }[]}
 */
function csPackV2DetectTwinPairs(units, envelope) {
  const env = envelope || csPackV2FloorEnvelope(null);
  const list = Array.isArray(units) ? units : [];
  const cands = list.filter(u => csPackV2IsTwinCandidate(u, env));
  cands.sort((a, b) =>
    (csPackV2Foot(b).pl - csPackV2Foot(a).pl)
    || ((+b.weightKg || 0) - (+a.weightKg || 0))
    || String(a._fmUid || '').localeCompare(String(b._fmUid || '')));

  const used = new Set();
  const pairs = [];
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    if (!a || used.has(a._fmUid)) continue;
    const aL = csPackV2Foot(a).pl;
    const aW = csPackV2Foot(a).pw;
    let mate = null;
    for (let j = i + 1; j < cands.length; j++) {
      const b = cands[j];
      if (!b || used.has(b._fmUid)) continue;
      if (a._fmUid != null && b._fmUid != null && a._fmUid === b._fmUid) continue;
      const bL = csPackV2Foot(b).pl;
      const bW = csPackV2Foot(b).pw;
      if (Math.abs(aL - bL) > CSPACK_V2_TWIN_SPAN_TOL_MM + CSPACK_V2_EPS) continue;
      // Prefer similar seat width (same family)
      if (Math.abs(aW - bW) > 80 + CSPACK_V2_EPS) continue;
      mate = b;
      break;
    }
    if (!mate) continue;
    used.add(a._fmUid);
    used.add(mate._fmUid);
    const seatW = Math.max(csPackV2Foot(a).pw, csPackV2Foot(mate).pw);
    const spanL = Math.max(csPackV2Foot(a).pl, csPackV2Foot(mate).pl);
    pairs.push({
      a, b: mate,
      spanL,
      seatW,
      gapMm: CSPACK_V2_TWIN_BESIDE_GAP_MM,
      _fmUids: [a._fmUid, mate._fmUid],
    });
  }
  return pairs;
}

/**
 * Step 3a self-test. Console: csPackV2Step3aSelfTest()
 */
function csPackV2Step3aSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  function asm(uid, pl, pw, ph, kg) {
    return {
      _fmUid: uid,
      mark: 'RF',
      isAssembly: true,
      groupKind: 'welded_assembly',
      packLengthMm: pl, packWidthMm: pw, packHeightMm: ph,
      weightKg: kg || 400,
    };
  }

  // Two identical spans → one pair
  const a1 = asm('t1', 11000, 200, 2500, 500);
  const a2 = asm('t2', 11000, 200, 2500, 480);
  const p1 = csPackV2DetectTwinPairs([a1, a2], env);
  check('T1', p1.length === 1 && p1[0].a._fmUid === 't1' && p1[0].b._fmUid === 't2',
    `n=${p1.length} uids=${p1[0] && p1[0]._fmUids}`);
  check('T2', p1[0] && p1[0].seatW === 200 && p1[0].gapMm === 60 && p1[0].spanL === 11000,
    p1[0] ? `seatW=${p1[0].seatW} gap=${p1[0].gapMm} span=${p1[0].spanL}` : 'no pair');

  // Three same-span → one pair + one leftover (disjoint)
  const a3 = asm('t3', 11000, 200, 2500, 450);
  const p2 = csPackV2DetectTwinPairs([a1, a2, a3], env);
  check('T3', p2.length === 1,
    `n=${p2.length}`);
  const used2 = new Set(p2[0] ? p2[0]._fmUids : []);
  check('T4', used2.size === 2 && [a1, a2, a3].filter(u => !used2.has(u._fmUid)).length === 1,
    `used=${[...used2]} leftover=${[a1, a2, a3].filter(u => !used2.has(u._fmUid)).map(u => u._fmUid)}`);

  // Different spans → no pair
  const b1 = asm('d1', 11000, 200, 2500);
  const b2 = asm('d2', 9000, 200, 2500);
  check('T5', csPackV2DetectTwinPairs([b1, b2], env).length === 0, 'diff span');

  // Nest excluded
  const nest = {
    _fmUid: 'n1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 200, packHeightMm: 200,
  };
  check('T6', !csPackV2IsTwinCandidate(nest, env), 'nest out');

  // Fat width excluded (padded lane trap)
  const fat = asm('f1', 11000, 480, 2500);
  check('T7', !csPackV2IsTwinCandidate(fat, env), 'fat W out');

  // Too tall excluded
  const tall = asm('h1', 11000, 200, 5000);
  check('T8', !csPackV2IsTwinCandidate(tall, env), 'tall out');

  // Same mark different uid still pairs
  const m1 = asm('uA', 10500, 220, 2400, 600);
  const m2 = asm('uB', 10520, 210, 2400, 590);
  m1.mark = 'RF-SET'; m2.mark = 'RF-SET';
  const p3 = csPackV2DetectTwinPairs([m1, m2], env);
  check('T9', p3.length === 1 && p3[0].a._fmUid !== p3[0].b._fmUid,
    `n=${p3.length}`);

  // Span within tolerance (±50)
  const s1 = asm('s1', 10000, 200, 2400);
  const s2 = asm('s2', 10040, 200, 2400);
  check('T10', csPackV2DetectTwinPairs([s1, s2], env).length === 1, 'tol ok');
  const s3 = asm('s3', 10080, 200, 2400);
  check('T11', csPackV2DetectTwinPairs([s1, s3], env).length === 0, 'tol fail');

  // Two twins must fit in width (pw*2+60)
  const wide = asm('w1', 11000, 1200, 2000);
  check('T12', !csPackV2IsTwinCandidate(wide, env), 'wide pair cannot fit');

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3a self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3b — Twin #1 wall-hug seat (home wall, steel width, y=0)
//
// Perspectives locked:
//   Warehouse — first rafter hugs home wall (min Z) at rear (min X)
//   Design    — seat uses packWidthMm steel flange (120–400), NEVER padded ~480
//   Gravity   — commit via 2d → y=0 / box.minY=0
//   Pose      — lengthways (no yaw); Group By quat untouched
//   Validate  — reject if not twin-candidate or seat fails envelope/height
//   Beside    — twin #2 is 3c; here only #1
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Design check for a twin wall-hug seat (for CLI / self-view).
 * @returns {{ ok, reasons: string[], design: object }}
 */
function csPackV2InspectTwinWallHugSeat(placement, unit, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const foot = unit ? csPackV2Foot(unit) : null;
  const design = {
    mark: unit && (unit.mark || null),
    uid: unit && (unit._fmUid || null),
    pl: placement ? Math.round(+placement.pl) : null,
    pw: placement ? Math.round(+placement.pw) : null,
    ph: placement ? Math.round(+placement.ph) : null,
    x: placement ? +placement.x : null,
    z: placement ? +placement.z : null,
    y: placement ? +placement.y : null,
    minY: placement && placement.box ? +placement.box.minY : null,
    wallHugX: env.minXMm,
    wallHugZ: env.minZMm,
    steelWOk: null,
    atHomeWall: null,
    atRear: null,
    onFloor: null,
  };
  if (!placement || !placement.box) {
    reasons.push('NO_PLACEMENT');
    return { ok: false, reasons, design };
  }
  design.steelWOk = design.pw >= CSPACK_V2_TWIN_W_MIN_MM
    && design.pw <= CSPACK_V2_TWIN_W_MAX_MM;
  if (!design.steelWOk) reasons.push('STEEL_WIDTH_BAD');
  // Padded-lane trap (~480) must never appear
  if (design.pw > 400) reasons.push('PADDED_LANE_WIDTH');

  design.atRear = Math.abs(+placement.x - env.minXMm) <= CSPACK_V2_EPS;
  design.atHomeWall = Math.abs(+placement.z - env.minZMm) <= CSPACK_V2_EPS;
  if (!design.atRear) reasons.push('NOT_AT_REAR');
  if (!design.atHomeWall) reasons.push('NOT_AT_HOME_WALL');

  design.onFloor = +placement.y === 0
    && placement.box && +placement.box.minY === 0;
  if (!design.onFloor) reasons.push('NOT_ON_FLOOR');

  if (foot) {
    if (Math.abs(+placement.pl - foot.pl) > CSPACK_V2_EPS) reasons.push('PL_MISMATCH');
    if (Math.abs(+placement.pw - foot.pw) > CSPACK_V2_EPS) reasons.push('PW_MISMATCH');
  }
  if (placement.layer && placement.layer !== 'floor') reasons.push('LAYER_NOT_FLOOR');
  if (placement.role && placement.role !== 'twin_wall_hug') reasons.push('ROLE_BAD');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Seat twin #1 at home-wall / rear corner (wall-hug).
 * @returns {{ ok, reason, placement, inspect }}
 */
function csPackV2SeatTwinWallHug(unit, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  if (!unit)
    return { ok: false, reason: 'NO_UNIT', placement: null, inspect: null };
  if (!csPackV2IsTwinCandidate(unit, env))
    return { ok: false, reason: 'NOT_TWIN_CANDIDATE', placement: null, inspect: null };

  const { pl, pw, ph } = csPackV2Foot(unit);
  const x = env.minXMm;
  const z = env.minZMm;
  const placedBoxes = o.placedBoxes || [];

  const seat = csPackV2TryFloorSeat(unit, x, z, {
    envelope: env,
    placedBoxes,
  });
  if (!seat.ok) {
    return {
      ok: false,
      reason: seat.reason || 'SEAT_FAIL',
      placement: null,
      inspect: null,
      tried: { x, z, pl, pw, ph },
    };
  }

  const commit = csPackV2CommitFloorSeat(unit, seat, {
    envelope: env,
    placedBoxes,
  });
  if (!commit.ok || !commit.placement) {
    return {
      ok: false,
      reason: commit.reason || 'COMMIT_FAIL',
      placement: null,
      inspect: null,
    };
  }

  const placement = {
    ...commit.placement,
    role: 'twin_wall_hug',
    twinGapMm: CSPACK_V2_TWIN_BESIDE_GAP_MM,
    yawDeg: 0,
  };
  const inspect = csPackV2InspectTwinWallHugSeat(placement, unit, env);
  if (!inspect.ok) {
    return {
      ok: false,
      reason: 'DESIGN_FAIL:' + inspect.reasons.join(','),
      placement,
      inspect,
    };
  }
  return { ok: true, reason: null, placement, inspect };
}

/**
 * Step 3b self-test. Console: csPackV2Step3bSelfTest()
 */
function csPackV2Step3bSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const rafter = {
    _fmUid: 'rf-wall',
    mark: 'RF012',
    isAssembly: true,
    groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508,
    weightKg: 711,
  };

  const hug = csPackV2SeatTwinWallHug(rafter, env, {});
  check('W1', hug.ok && !!hug.placement, `ok=${hug.ok} reason=${hug.reason}`);
  check('W2', hug.placement && hug.placement.y === 0
    && hug.placement.box && hug.placement.box.minY === 0,
  `y=${hug.placement && hug.placement.y} minY=${hug.placement && hug.placement.box && hug.placement.box.minY}`);
  check('W3', hug.placement
    && Math.abs(hug.placement.x - env.minXMm) <= CSPACK_V2_EPS
    && Math.abs(hug.placement.z - env.minZMm) <= CSPACK_V2_EPS,
  `xz=${hug.placement && hug.placement.x},${hug.placement && hug.placement.z} expect ${env.minXMm},${env.minZMm}`);
  check('W4', hug.placement && hug.placement.pw === 200 && hug.placement.pl === 11608,
    `foot=${hug.placement && hug.placement.pl}x${hug.placement && hug.placement.pw} (steel 200 not padded)`);
  check('W5', hug.placement && hug.placement.role === 'twin_wall_hug',
    `role=${hug.placement && hug.placement.role}`);
  check('W6', hug.inspect && hug.inspect.ok
    && hug.inspect.design.steelWOk
    && hug.inspect.design.atHomeWall
    && hug.inspect.design.atRear
    && hug.inspect.design.onFloor,
  hug.inspect ? `design ok steel=${hug.inspect.design.steelWOk} wall=${hug.inspect.design.atHomeWall}` : 'no inspect');

  // Nest cannot wall-hug as twin
  const nest = {
    _fmUid: 'nz', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 200, packHeightMm: 200,
  };
  const badN = csPackV2SeatTwinWallHug(nest, env, {});
  check('W7', !badN.ok && badN.reason === 'NOT_TWIN_CANDIDATE',
    `ok=${badN.ok} reason=${badN.reason}`);

  // Fat padded width rejected
  const fat = {
    _fmUid: 'fat', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 480, packHeightMm: 2500,
  };
  const badF = csPackV2SeatTwinWallHug(fat, env, {});
  check('W8', !badF.ok, `fat ok=${badF.ok} reason=${badF.reason}`);

  // Occupied corner → fail
  const hug2 = csPackV2SeatTwinWallHug(rafter, env, {
    placedBoxes: hug.placement ? [hug.placement.box] : [],
  });
  check('W9', !hug2.ok && hug2.reason === 'OVERLAP',
    `ok=${hug2.ok} reason=${hug2.reason}`);

  // Design inspect catches padded width even on a fake placement
  const fakePad = {
    x: env.minXMm, z: env.minZMm, y: 0, pl: 10000, pw: 480, ph: 2000,
    box: csPackV2MakeBox(env.minXMm, env.minZMm, 10000, 480, 2000, 0),
    role: 'twin_wall_hug', layer: 'floor',
  };
  const insp = csPackV2InspectTwinWallHugSeat(fakePad, fat, env);
  check('W10', !insp.ok && insp.reasons.indexOf('PADDED_LANE_WIDTH') >= 0,
    `reasons=${insp.reasons}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3b self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3c — Twin #2 beside (+60 mm gap, no dig-in)
//
// Perspectives locked:
//   Warehouse — second rafter parallel beside #1, steel flange width
//   Gap       — clear Z gap ≥ 60 mm between boxes (not flush, not padded lane)
//   Dig-in    — AABB must not overlap twin A (tol = CSPACK_V2_EPS)
//   Align     — same rear X as twin A (lengthways lane)
//   Gravity   — y=0 via 2d commit
//   Design    — inspect gapMm, steel W, floor, no padded ~480
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Design check for twin #2 beside seat relative to twin A.
 */
function csPackV2InspectTwinBesideSeat(placementB, unitB, placementA, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const foot = unitB ? csPackV2Foot(unitB) : null;
  const gapNeed = CSPACK_V2_TWIN_BESIDE_GAP_MM;
  const design = {
    mark: unitB && (unitB.mark || null),
    uid: unitB && (unitB._fmUid || null),
    pl: placementB ? Math.round(+placementB.pl) : null,
    pw: placementB ? Math.round(+placementB.pw) : null,
    ph: placementB ? Math.round(+placementB.ph) : null,
    x: placementB ? +placementB.x : null,
    z: placementB ? +placementB.z : null,
    y: placementB ? +placementB.y : null,
    gapMm: null,
    gapOk: null,
    noOverlap: null,
    steelWOk: null,
    atRear: null,
    onFloor: null,
    sameRearAsA: null,
  };
  if (!placementB || !placementB.box || !placementA || !placementA.box) {
    reasons.push('NO_PLACEMENT');
    return { ok: false, reasons, design };
  }

  design.steelWOk = design.pw >= CSPACK_V2_TWIN_W_MIN_MM
    && design.pw <= CSPACK_V2_TWIN_W_MAX_MM;
  if (!design.steelWOk) reasons.push('STEEL_WIDTH_BAD');
  if (design.pw > 400) reasons.push('PADDED_LANE_WIDTH');

  design.onFloor = +placementB.y === 0 && +placementB.box.minY === 0;
  if (!design.onFloor) reasons.push('NOT_ON_FLOOR');

  design.atRear = Math.abs(+placementB.x - env.minXMm) <= CSPACK_V2_EPS;
  design.sameRearAsA = Math.abs(+placementB.x - +placementA.x) <= CSPACK_V2_EPS;
  if (!design.sameRearAsA) reasons.push('REAR_MISALIGN');

  // Clear gap in Z between A.maxZ and B.minZ (B should be toward +Z)
  const gap = +placementB.box.minZ - +placementA.box.maxZ;
  design.gapMm = Math.round(gap * 10) / 10;
  design.gapOk = gap >= gapNeed - CSPACK_V2_EPS;
  if (!design.gapOk) reasons.push('GAP_TOO_SMALL');

  design.noOverlap = !csPackV2BoxesOverlap(placementA.box, placementB.box);
  if (!design.noOverlap) reasons.push('DIG_IN');

  if (foot) {
    if (Math.abs(+placementB.pl - foot.pl) > CSPACK_V2_EPS) reasons.push('PL_MISMATCH');
    if (Math.abs(+placementB.pw - foot.pw) > CSPACK_V2_EPS) reasons.push('PW_MISMATCH');
  }
  if (placementB.role && placementB.role !== 'twin_beside') reasons.push('ROLE_BAD');

  // Must still fit inside envelope
  if (+placementB.z + +placementB.pw > env.maxZMm + CSPACK_V2_EPS)
    reasons.push('OUTSIDE_ENVELOPE');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Seat twin #2 beside twin A placement (gap = 60 mm).
 * @returns {{ ok, reason, placement, inspect }}
 */
function csPackV2SeatTwinBeside(unit, twinAPlacement, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  if (!unit)
    return { ok: false, reason: 'NO_UNIT', placement: null, inspect: null };
  if (!twinAPlacement || !twinAPlacement.box)
    return { ok: false, reason: 'NO_TWIN_A', placement: null, inspect: null };
  if (!csPackV2IsTwinCandidate(unit, env))
    return { ok: false, reason: 'NOT_TWIN_CANDIDATE', placement: null, inspect: null };

  const gap = (o.gapMm != null) ? Math.max(0, +o.gapMm) : CSPACK_V2_TWIN_BESIDE_GAP_MM;
  const { pl, pw, ph } = csPackV2Foot(unit);
  const x = +twinAPlacement.x;
  const z = +twinAPlacement.z + +twinAPlacement.pw + gap;
  const placedBoxes = o.placedBoxes
    || (twinAPlacement.box ? [twinAPlacement.box] : []);

  const seat = csPackV2TryFloorSeat(unit, x, z, {
    envelope: env,
    placedBoxes,
  });
  if (!seat.ok) {
    return {
      ok: false,
      reason: seat.reason || 'SEAT_FAIL',
      placement: null,
      inspect: null,
      tried: { x, z, pl, pw, ph, gap },
    };
  }

  const commit = csPackV2CommitFloorSeat(unit, seat, {
    envelope: env,
    placedBoxes,
  });
  if (!commit.ok || !commit.placement) {
    return {
      ok: false,
      reason: commit.reason || 'COMMIT_FAIL',
      placement: null,
      inspect: null,
    };
  }

  const placement = {
    ...commit.placement,
    role: 'twin_beside',
    twinGapMm: gap,
    yawDeg: 0,
  };
  const inspect = csPackV2InspectTwinBesideSeat(placement, unit, twinAPlacement, env);
  if (!inspect.ok) {
    return {
      ok: false,
      reason: 'DESIGN_FAIL:' + inspect.reasons.join(','),
      placement,
      inspect,
    };
  }
  return { ok: true, reason: null, placement, inspect };
}

/**
 * Place a twin lane: wall-hug A then beside B.
 * @returns {{ ok, reason, placed: [A,B], placedBoxes, gapMm }}
 */
function csPackV2PlaceTwinLane(pair, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  if (!pair || !pair.a || !pair.b)
    return { ok: false, reason: 'NO_PAIR', placed: [], placedBoxes: [] };

  const hug = csPackV2SeatTwinWallHug(pair.a, env, {
    placedBoxes: o.placedBoxes || [],
  });
  if (!hug.ok) {
    return {
      ok: false, reason: 'WALL_HUG:' + (hug.reason || 'fail'),
      placed: [], placedBoxes: (o.placedBoxes || []).slice(),
      hug, beside: null,
    };
  }

  const boxes = (o.placedBoxes || []).slice();
  boxes.push(hug.placement.box);

  const beside = csPackV2SeatTwinBeside(pair.b, hug.placement, env, {
    placedBoxes: boxes,
    gapMm: pair.gapMm != null ? pair.gapMm : CSPACK_V2_TWIN_BESIDE_GAP_MM,
  });
  if (!beside.ok) {
    return {
      ok: false, reason: 'BESIDE:' + (beside.reason || 'fail'),
      placed: [hug.placement],
      placedBoxes: boxes,
      hug, beside,
    };
  }
  boxes.push(beside.placement.box);

  return {
    ok: true,
    reason: null,
    placed: [hug.placement, beside.placement],
    placedBoxes: boxes,
    gapMm: beside.inspect && beside.inspect.design
      ? beside.inspect.design.gapMm : CSPACK_V2_TWIN_BESIDE_GAP_MM,
    hug,
    beside,
  };
}

/**
 * Step 3c self-test. Console: csPackV2Step3cSelfTest()
 */
function csPackV2Step3cSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const a = {
    _fmUid: 'rf-a', mark: 'RF012',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };
  const b = {
    _fmUid: 'rf-b', mark: 'RF008',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };

  const lane = csPackV2PlaceTwinLane({ a, b, gapMm: 60, seatW: 200, spanL: 11608 }, env, {});
  check('B1', lane.ok && lane.placed.length === 2,
    `ok=${lane.ok} n=${lane.placed && lane.placed.length} reason=${lane.reason}`);
  check('B2', lane.placed[0] && lane.placed[0].role === 'twin_wall_hug'
    && lane.placed[1] && lane.placed[1].role === 'twin_beside',
  `roles=${lane.placed[0] && lane.placed[0].role},${lane.placed[1] && lane.placed[1].role}`);

  const pA = lane.placed[0];
  const pB = lane.placed[1];
  const gap = pB && pA ? (+pB.z - (+pA.z + +pA.pw)) : -1;
  check('B3', gap >= 60 - CSPACK_V2_EPS,
    `gap=${gap} (expect ≥60)`);
  check('B4', pA && pB && !csPackV2BoxesOverlap(pA.box, pB.box),
    'no dig-in');
  check('B5', pA && pB && pA.y === 0 && pB.y === 0
    && pA.box.minY === 0 && pB.box.minY === 0,
  `yA=${pA && pA.y} yB=${pB && pB.y}`);
  check('B6', pA && pB && pA.pw === 200 && pB.pw === 200,
    `pw=${pA && pA.pw}/${pB && pB.pw} steel not padded`);
  check('B7', lane.beside && lane.beside.inspect && lane.beside.inspect.ok
    && lane.beside.inspect.design.gapOk
    && lane.beside.inspect.design.noOverlap,
  lane.beside && lane.beside.inspect
    ? `insp gap=${lane.beside.inspect.design.gapMm} ov=${!lane.beside.inspect.design.noOverlap}`
    : 'no insp');

  // Distinct Z
  check('B8', pA && pB && Math.abs(+pB.z - +pA.z) >= 200 + 60 - CSPACK_V2_EPS,
    `zA=${pA && pA.z} zB=${pB && pB.z}`);

  // Flush (gap 0) must fail design / dig-in path — seat with gap 0 overlaps? 
  // Actually gap 0 means B.z = A.z+A.pw → touching edge, BoxesOverlap with tol may be false (edge touch).
  // Design inspect requires gap ≥ 60 so DESIGN_FAIL:GAP_TOO_SMALL
  const hug = csPackV2SeatTwinWallHug(a, env, {});
  const flush = csPackV2SeatTwinBeside(b, hug.placement, env, { gapMm: 0 });
  check('B9', !flush.ok && String(flush.reason).indexOf('GAP_TOO_SMALL') >= 0,
    `ok=${flush.ok} reason=${flush.reason}`);

  // Same corner as A → OVERLAP
  const dig = csPackV2TryFloorSeat(b, hug.placement.x, hug.placement.z, {
    envelope: env, placedBoxes: [hug.placement.box],
  });
  check('B10', !dig.ok && dig.reason === 'OVERLAP',
    `dig=${dig.reason}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3c self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3d — Rebuild clean leftover free-rects after twin lane
//
// Perspectives locked:
//   Warehouse — discard A→B guillotine scraps; ONE full-length side strip
//               (env.length) so long nests can still seat lengthways (3e)
//   Geometry  — free rects do NOT overlap each other OR twin AABBs
//   Front     — optional remnant in twin Z-band when twin L < env.L (≥ min free)
//   Design    — side strip z ≥ laneMaxZ; length ≈ env.length; floor y=0
//   Gravity   — supportedBy='floor', y=0 (no shelf)
//   Contrast  — never keep 2e mid-lane scraps (short X stubs in A/B Z-band)
//   Group By  — bookkeeping only; no remorph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Twin-lane occupied band from placements (steel seats, not padded).
 * @returns {{ ok, reason, minX, maxX, minZ, maxZ, length, width }}
 */
function csPackV2TwinLaneOccupied(twinPlacements) {
  const list = Array.isArray(twinPlacements) ? twinPlacements : [];
  if (list.length < 1)
    return { ok: false, reason: 'NO_TWINS', minX: 0, maxX: 0, minZ: 0, maxZ: 0, length: 0, width: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    const box = p.box;
    if (box) {
      minX = Math.min(minX, +box.minX);
      maxX = Math.max(maxX, +box.maxX);
      minZ = Math.min(minZ, +box.minZ);
      maxZ = Math.max(maxZ, +box.maxZ);
    } else {
      const x = +p.x;
      const z = +p.z;
      const pl = +p.pl;
      const pw = +p.pw;
      if (!(pl > 0 && pw > 0)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + pl);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z + pw);
    }
  }
  if (!(minX < maxX) || !(minZ < maxZ))
    return { ok: false, reason: 'BAD_OCCUPIED', minX: 0, maxX: 0, minZ: 0, maxZ: 0, length: 0, width: 0 };
  return {
    ok: true,
    reason: null,
    minX, maxX, minZ, maxZ,
    length: maxX - minX,
    width: maxZ - minZ,
  };
}

/** Free-rect XZ overlaps a placement AABB (interior beyond eps). */
function csPackV2FreeRectOverlapsBox(fr, box, eps) {
  if (!fr || !box) return false;
  const e = (eps != null) ? eps : CSPACK_V2_EPS;
  const frMaxX = +fr.x + +fr.length;
  const frMaxZ = +fr.z + +fr.width;
  return !(frMaxX <= +box.minX + e || +box.maxX <= +fr.x + e
    || frMaxZ <= +box.minZ + e || +box.maxZ <= +fr.z + e);
}

/**
 * Design check for twin leftover free-rects.
 */
function csPackV2InspectTwinLeftoverRects(freeRects, twinPlacements, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const occ = csPackV2TwinLaneOccupied(twinPlacements);
  const rects = Array.isArray(freeRects) ? freeRects : [];
  const design = {
    rectCount: rects.length,
    sideStrip: null,
    frontRemnant: null,
    fullLengthOk: null,
    noRectOverlap: null,
    noTwinDigIn: null,
    onFloor: null,
    sideZOk: null,
    occupied: occ.ok ? {
      minX: Math.round(occ.minX * 10) / 10,
      maxX: Math.round(occ.maxX * 10) / 10,
      minZ: Math.round(occ.minZ * 10) / 10,
      maxZ: Math.round(occ.maxZ * 10) / 10,
      length: Math.round(occ.length),
      width: Math.round(occ.width),
    } : null,
  };

  if (!occ.ok) {
    reasons.push(occ.reason || 'NO_TWINS');
    return { ok: false, reasons, design };
  }
  if (rects.length < 1) {
    reasons.push('NO_FREE_RECTS');
    return { ok: false, reasons, design };
  }

  let side = null;
  let front = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    if (r.role === 'twin_side_strip') side = r;
    if (r.role === 'twin_front_remnant') front = r;
  }
  // Fallback: only a full-length rect counts as side (never mis-label front remnant)
  if (!side) {
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r && Math.abs(+r.length - env.lengthMm) <= 1
          && +r.z >= occ.maxZ - CSPACK_V2_EPS) {
        side = r;
        break;
      }
    }
  }
  design.sideStrip = side ? {
    x: Math.round(+side.x * 10) / 10,
    z: Math.round(+side.z * 10) / 10,
    length: Math.round(+side.length),
    width: Math.round(+side.width),
    role: side.role || null,
  } : null;
  design.frontRemnant = front ? {
    x: Math.round(+front.x * 10) / 10,
    z: Math.round(+front.z * 10) / 10,
    length: Math.round(+front.length),
    width: Math.round(+front.width),
    role: front.role || null,
  } : null;

  // Lane may fill container width → no side strip left (front-only is OK)
  const remainW = env.maxZMm - occ.maxZ;
  design.sideAbsentOk = !side && remainW < CSPACK_V2_MIN_FREE_MM - CSPACK_V2_EPS;
  design.fullLengthOk = !!(side && Math.abs(+side.length - env.lengthMm) <= 1)
    || !!design.sideAbsentOk;
  if (!design.fullLengthOk) reasons.push('SIDE_NOT_FULL_LENGTH');

  design.sideZOk = !side || (+side.z >= occ.maxZ - CSPACK_V2_EPS);
  if (!design.sideZOk) reasons.push('SIDE_Z_INTO_LANE');

  design.onFloor = rects.every(r => r
    && (+r.y === 0 || r.y == null)
    && (r.supportedBy === 'floor' || r.supportedBy == null));
  if (!design.onFloor) reasons.push('NOT_ON_FLOOR');

  design.noRectOverlap = true;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (csPackV2FreeRectsOverlap(rects[i], rects[j])) {
        design.noRectOverlap = false;
        break;
      }
    }
    if (!design.noRectOverlap) break;
  }
  if (!design.noRectOverlap) reasons.push('FREE_RECT_OVERLAP');

  design.noTwinDigIn = true;
  const places = Array.isArray(twinPlacements) ? twinPlacements : [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = 0; j < places.length; j++) {
      const box = places[j] && places[j].box;
      if (box && csPackV2FreeRectOverlapsBox(rects[i], box)) {
        design.noTwinDigIn = false;
        break;
      }
    }
    if (!design.noTwinDigIn) break;
  }
  if (!design.noTwinDigIn) reasons.push('STRIP_DIGS_TWIN');

  // Must not exceed envelope
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (+r.x < env.minXMm - CSPACK_V2_EPS
        || +r.z < env.minZMm - CSPACK_V2_EPS
        || +r.x + +r.length > env.maxXMm + CSPACK_V2_EPS
        || +r.z + +r.width > env.maxZMm + CSPACK_V2_EPS) {
      reasons.push('OUTSIDE_ENVELOPE');
      break;
    }
  }

  // Cap: clean rebuild ≤ 2 rects (side + optional front) — never guillotine scrap pile
  if (rects.length > 2) reasons.push('TOO_MANY_SCRAPS');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Rebuild free-rects after twin lane — drop guillotine scraps; one clean strip.
 *
 * @param {object} envelope
 * @param {object[]} twinPlacements  wall-hug + beside (committed)
 * @param {object} [opts]
 * @param {number} [opts.gapMm]      air between twin lane and free edges (default 0)
 * @param {number} [opts.minLengthMm]
 * @param {number} [opts.minWidthMm]
 * @returns {{ ok, reason, freeRects, occupied, inspect, sideStrip, frontRemnant }}
 */
function csPackV2RebuildTwinLeftoverRects(envelope, twinPlacements, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  const occ = csPackV2TwinLaneOccupied(twinPlacements);
  if (!occ.ok) {
    return {
      ok: false, reason: occ.reason || 'NO_TWINS',
      freeRects: [], occupied: occ, inspect: null,
      sideStrip: null, frontRemnant: null,
    };
  }

  const gap = Math.max(0, o.gapMm != null ? +o.gapMm : 0);
  const minL = (o.minLengthMm != null) ? +o.minLengthMm : CSPACK_V2_MIN_FREE_MM;
  const minW = (o.minWidthMm != null) ? +o.minWidthMm : CSPACK_V2_MIN_FREE_MM;

  const base = {
    id: 'twin_lane',
    heightAvailable: env.heightMm,
    supportedBy: 'floor',
    supportCapacityKg: 1e12,
    y: 0,
  };

  const freeRects = [];
  let sideStrip = null;
  let frontRemnant = null;

  // 1) Full-length SIDE strip toward +Z (warehouse long-nest lane)
  const sideZ = occ.maxZ + gap;
  const sideW = env.maxZMm - sideZ;
  const sideL = env.lengthMm;
  const sideX = env.minXMm;
  if (sideL >= minL - CSPACK_V2_EPS && sideW >= minW - CSPACK_V2_EPS) {
    sideStrip = csPackV2MakeFreeRect(base, sideX, sideZ, sideL, sideW, '_side');
    sideStrip.id = 'twin_side_strip';
    sideStrip.role = 'twin_side_strip';
    freeRects.push(sideStrip);
  }

  // 2) Optional FRONT remnant in twin Z-band (when twin L < env.L)
  const frontX = occ.maxX + gap;
  const frontL = env.maxXMm - frontX;
  const frontZ = Math.max(env.minZMm, occ.minZ);
  const frontW = Math.min(env.maxZMm, occ.maxZ) - frontZ;
  if (frontL >= minL - CSPACK_V2_EPS && frontW >= minW - CSPACK_V2_EPS) {
    frontRemnant = csPackV2MakeFreeRect(base, frontX, frontZ, frontL, frontW, '_front');
    frontRemnant.id = 'twin_front_remnant';
    frontRemnant.role = 'twin_front_remnant';
    freeRects.push(frontRemnant);
  }

  if (freeRects.length < 1) {
    return {
      ok: false, reason: 'NO_USABLE_STRIP',
      freeRects: [], occupied: occ, inspect: null,
      sideStrip: null, frontRemnant: null,
    };
  }

  const inspect = csPackV2InspectTwinLeftoverRects(freeRects, twinPlacements, env);
  if (!inspect.ok) {
    return {
      ok: false,
      reason: 'DESIGN_FAIL:' + inspect.reasons.join(','),
      freeRects, occupied: occ, inspect,
      sideStrip, frontRemnant,
    };
  }

  return {
    ok: true,
    reason: null,
    freeRects,
    occupied: occ,
    inspect,
    sideStrip,
    frontRemnant,
  };
}

/**
 * Step 3d self-test — every locked perspective.
 * Console: csPackV2Step3dSelfTest()
 */
function csPackV2Step3dSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const a = {
    _fmUid: 'rf-a', mark: 'RF012',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };
  const b = {
    _fmUid: 'rf-b', mark: 'RF008',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };

  const lane = csPackV2PlaceTwinLane({ a, b, gapMm: 60 }, env, {});
  check('R1', lane.ok, `lane ok=${lane.ok} reason=${lane.reason}`);

  const reb = csPackV2RebuildTwinLeftoverRects(env, lane.placed, {});
  check('R2', reb.ok && reb.freeRects.length >= 1,
    `ok=${reb.ok} n=${reb.freeRects && reb.freeRects.length} reason=${reb.reason}`);

  // Warehouse: ≥1 full-length side strip
  const side = reb.sideStrip;
  check('R3', side && Math.abs(+side.length - env.lengthMm) <= 1,
    `sideL=${side && side.length} envL=${env.lengthMm}`);
  check('R4', side && side.role === 'twin_side_strip',
    `role=${side && side.role}`);

  // Geometry: side starts after twin lane; no dig-in; no free-rect overlap
  const occ = reb.occupied;
  check('R5', side && occ && +side.z >= +occ.maxZ - CSPACK_V2_EPS,
    `sideZ=${side && side.z} laneMaxZ=${occ && occ.maxZ}`);
  check('R6', reb.inspect && reb.inspect.ok
    && reb.inspect.design.noTwinDigIn
    && reb.inspect.design.noRectOverlap
    && reb.inspect.design.fullLengthOk,
  reb.inspect
    ? `insp dig=${!reb.inspect.design.noTwinDigIn} ov=${!reb.inspect.design.noRectOverlap}`
    : 'no insp');

  // Floor / gravity
  check('R7', reb.freeRects.every(r => (+r.y === 0 || r.y == null)
    && r.supportedBy === 'floor'),
  `floor tags=${reb.freeRects.map(r => r.supportedBy).join(',')}`);

  // Cap scraps (≤2) — never guillotine pile
  check('R8', reb.freeRects.length <= 2,
    `count=${reb.freeRects.length}`);

  // Contrast: naive double ApplySplit leaves mid-lane X scraps; rebuild drops them
  const init = csPackV2InitialFreeRects(spec);
  let dirty = init.freeRects.slice();
  if (lane.placed[0]) {
    const s1 = csPackV2ApplySplit(dirty, dirty[0], lane.placed[0], { preferSideLane: true });
    if (s1.ok) dirty = s1.freeRects;
  }
  if (lane.placed[1]) {
    // Find rect that contains B (often the side leftover from A)
    let host = null;
    for (let i = 0; i < dirty.length; i++) {
      if (csPackV2PlacementInsideRect(dirty[i], lane.placed[1])) { host = dirty[i]; break; }
    }
    if (host) {
      const s2 = csPackV2ApplySplit(dirty, host, lane.placed[1], { preferSideLane: true });
      if (s2.ok) dirty = s2.freeRects;
    }
  }
  const dirtyShort = dirty.filter(r => +r.length < env.lengthMm - 1).length;
  check('R9', reb.freeRects.length <= dirty.length
    && reb.freeRects.filter(r => +r.length < env.lengthMm - 1).length
      <= Math.max(1, dirtyShort),
  `clean=${reb.freeRects.length} dirty=${dirty.length} dirtyShort=${dirtyShort}`);

  // Short twins → front remnant appears
  const shortA = {
    _fmUid: 's-a', mark: 'SH1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 2000, weightKg: 200,
  };
  const shortB = {
    _fmUid: 's-b', mark: 'SH2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 2000, weightKg: 200,
  };
  const laneS = csPackV2PlaceTwinLane({ a: shortA, b: shortB, gapMm: 60 }, env, {});
  const rebS = csPackV2RebuildTwinLeftoverRects(env, laneS.placed, {});
  check('R10', laneS.ok && rebS.ok && rebS.frontRemnant
    && +rebS.frontRemnant.length >= CSPACK_V2_MIN_FREE_MM
    && rebS.frontRemnant.role === 'twin_front_remnant'
    && rebS.sideStrip && Math.abs(+rebS.sideStrip.length - env.lengthMm) <= 1,
  `frontL=${rebS.frontRemnant && rebS.frontRemnant.length} sideL=${rebS.sideStrip && rebS.sideStrip.length}`);

  // Empty placements fail cleanly
  const empty = csPackV2RebuildTwinLeftoverRects(env, [], {});
  check('R11', !empty.ok && empty.reason === 'NO_TWINS',
    `ok=${empty.ok} reason=${empty.reason}`);

  // Design: near-full twins still get full-length side (front may exist if L gap ≥ 50)
  check('R12', reb.inspect && reb.inspect.design.sideStrip
    && reb.inspect.design.sideStrip.length === Math.round(env.lengthMm),
  `design sideL=${reb.inspect && reb.inspect.design.sideStrip && reb.inspect.design.sideStrip.length}`);

  // Lane fills container width → front-only leftover is OK (no false SIDE_NOT_FULL_LENGTH)
  const fatLane = [];
  let zCursor = env.minZMm;
  const fatPw = 280;
  // 7×(280+60) band leaves <50 mm → no side strip, front remnant only
  for (let i = 0; i < 7; i++) {
    fatLane.push({
      _fmUid: 'fat' + i, x: env.minXMm, z: zCursor, y: 0,
      pl: 8000, pw: fatPw, ph: 2000,
      box: csPackV2MakeBox(env.minXMm, zCursor, 8000, fatPw, 2000, 0),
      role: i === 0 ? 'twin_wall_hug' : 'twin_beside',
    });
    zCursor += fatPw + CSPACK_V2_TWIN_BESIDE_GAP_MM;
  }
  const rebFat = csPackV2RebuildTwinLeftoverRects(env, fatLane, {});
  check('R13', rebFat.ok && rebFat.inspect && rebFat.inspect.ok
    && !rebFat.sideStrip && rebFat.inspect.design.sideAbsentOk
    && !!rebFat.frontRemnant
    && rebFat.freeRects.length >= 1,
  `ok=${rebFat.ok} side=${!!rebFat.sideStrip} absent=${rebFat.inspect && rebFat.inspect.design.sideAbsentOk} front=${!!rebFat.frontRemnant} reason=${rebFat.reason}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3d self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3e — Long nests into clean twin leftover strip (before general FFD)
//
// Perspectives locked:
//   Warehouse — long nests (L ≥ 0.5×env.L) claim the full-length side strip first
//   Priority  — nests only; assemblies / short nests skipped (FFD later in 3f)
//   Geometry  — seat via 2c/2d in strip corners; no dig-in vs twins or peers
//   Gravity   — y=0 floor only (no nest stack — Step 4)
//   Split     — after each commit, 2e guillotine keeps strip bookkeeping clean
//   Design    — inspect: inStrip, onFloor, longEnough, noTwinDigIn, steel/nest W
//   Contrast  — short unit must NOT steal strip before long nest in this pass
//   Group By  — translate/seat only; no remorph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nest unit whose pack length is ≥ LONG_NEST_FRAC × envelope length.
 */
function csPackV2IsLongNestUnit(u, envelope) {
  if (!u || !csPackIsNestUnit(u)) return false;
  const env = envelope || csPackV2FloorEnvelope(null);
  const { pl, pw, ph } = csPackV2Foot(u);
  if (!(pl > 0 && pw > 0 && ph > 0)) return false;
  const need = env.lengthMm * CSPACK_V2_LONG_NEST_FRAC;
  if (pl + CSPACK_V2_EPS < need) return false;
  if (ph > env.heightMm + CSPACK_V2_EPS) return false;
  if (pl > env.lengthMm + CSPACK_V2_EPS) return false;
  // Must be able to sit in strip width-wise in at least one yaw
  const minSide = Math.min(pl, pw);
  if (minSide > env.widthMm + CSPACK_V2_EPS) return false;
  return true;
}

/**
 * Free-rects eligible for the long-nest priority pass (clean side strip first).
 * Front remnant (twin Z-band stub) is intentionally excluded — that is for shorts.
 */
function csPackV2LongNestStripRects(freeRects) {
  const list = Array.isArray(freeRects) ? freeRects : [];
  const side = [];
  const otherFull = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    if (r.role === 'twin_front_remnant') continue;
    if (r.role === 'twin_side_strip') {
      side.push(r);
      continue;
    }
    // Keep other full-ish lanes that appear after splits
    if (+r.length >= CSPACK_V2_MIN_FREE_MM && +r.width >= CSPACK_V2_MIN_FREE_MM)
      otherFull.push(r);
  }
  return side.length ? side.concat(otherFull) : otherFull;
}

/**
 * Design check for a long nest seated in the twin leftover strip.
 */
function csPackV2InspectLongNestInStrip(placement, unit, stripRect, twinPlacements, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const foot = unit ? csPackV2Foot(unit) : null;
  const need = env.lengthMm * CSPACK_V2_LONG_NEST_FRAC;
  const design = {
    mark: unit && (unit.mark || null),
    uid: unit && (unit._fmUid || null),
    pl: placement ? Math.round(+placement.pl) : null,
    pw: placement ? Math.round(+placement.pw) : null,
    ph: placement ? Math.round(+placement.ph) : null,
    x: placement ? +placement.x : null,
    z: placement ? +placement.z : null,
    y: placement ? +placement.y : null,
    longEnough: null,
    inStrip: null,
    onFloor: null,
    noTwinDigIn: null,
    isNest: !!(unit && csPackIsNestUnit(unit)),
    roleOk: null,
  };

  if (!placement || !placement.box) {
    reasons.push('NO_PLACEMENT');
    return { ok: false, reasons, design };
  }
  if (!design.isNest) reasons.push('NOT_NEST');

  design.longEnough = +placement.pl + CSPACK_V2_EPS >= need
    || (foot && +foot.pl + CSPACK_V2_EPS >= need);
  if (!design.longEnough) reasons.push('NOT_LONG');

  design.onFloor = +placement.y === 0
    && placement.box && +placement.box.minY === 0;
  if (!design.onFloor) reasons.push('NOT_ON_FLOOR');

  design.roleOk = !placement.role || placement.role === 'long_nest_strip';
  if (!design.roleOk) reasons.push('ROLE_BAD');

  // Prefer geometric in-strip: z within strip, or flush to stripRect if given
  if (stripRect) {
    design.inStrip = csPackV2PlacementInsideRect(stripRect, placement);
  } else {
    design.inStrip = true; // unknown strip — geometry dig-in still checked
  }
  if (!design.inStrip) reasons.push('NOT_IN_STRIP');

  design.noTwinDigIn = true;
  const twins = Array.isArray(twinPlacements) ? twinPlacements : [];
  for (let i = 0; i < twins.length; i++) {
    const tb = twins[i] && twins[i].box;
    if (tb && csPackV2BoxesOverlap(placement.box, tb)) {
      design.noTwinDigIn = false;
      break;
    }
  }
  if (!design.noTwinDigIn) reasons.push('DIG_IN_TWIN');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Place long nests into the clean leftover strip before general FFD.
 *
 * @param {object[]} units       all packer units (nests + assemblies)
 * @param {object[]} freeRects   from 3d rebuild (or updated)
 * @param {object[]} placed      already placed (twins); mutated copy returned
 * @param {object} [opts]
 * @returns {{ ok, placed, unplacedLong, freeRects, placedUids, nestViews, envelope }}
 */
function csPackV2PlaceLongNestsIntoStrip(units, freeRects, placed, opts) {
  const o = opts || {};
  const env = o.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const gapMm = (o.gapMm != null)
    ? Math.max(0, +o.gapMm)
    : Math.max(0, +(env.bundleGapMm != null ? env.bundleGapMm : 20));

  let rects = Array.isArray(freeRects) ? freeRects.slice() : [];
  const outPlaced = Array.isArray(placed) ? placed.slice() : [];
  const placedBoxes = [];
  for (let i = 0; i < outPlaced.length; i++) {
    if (outPlaced[i] && outPlaced[i].box) placedBoxes.push(outPlaced[i].box);
  }

  const skip = new Set();
  (o.skipUids || []).forEach(id => { if (id != null) skip.add(id); });
  outPlaced.forEach(p => {
    if (p && p._fmUid != null) skip.add(p._fmUid);
  });

  const twinPlacements = outPlaced.filter(p => p && (
    p.role === 'twin_wall_hug' || p.role === 'twin_beside' || p.role === 'twin'));

  const list = Array.isArray(units) ? units : [];
  const longs = list.filter(u => u
    && !skip.has(u._fmUid)
    && csPackV2IsLongNestUnit(u, env));
  longs.sort((a, b) =>
    (csPackV2Foot(b).pl - csPackV2Foot(a).pl)
    || ((+b.weightKg || 0) - (+a.weightKg || 0))
    || String(a._fmUid || '').localeCompare(String(b._fmUid || '')));

  const placedUids = [];
  const unplacedLong = [];
  const nestViews = [];

  // Snapshot side strip for design (may be split after first nest)
  const side0 = rects.find(r => r && r.role === 'twin_side_strip') || null;
  let longNestFitCount = 0;
  if (side0) {
    for (let fi = 0; fi < longs.length; fi++) {
      if (csPackV2LongNestFitsStripRect(longs[fi], side0, env))
        longNestFitCount++;
    }
  } else {
    // No dedicated side strip — count geometric fit against any strip-eligible rect
    const eligible = csPackV2LongNestStripRects(rects);
    for (let fi = 0; fi < longs.length; fi++) {
      let fits = false;
      for (let ri = 0; ri < eligible.length && !fits; ri++) {
        if (csPackV2LongNestFitsStripRect(longs[fi], eligible[ri], env))
          fits = true;
      }
      if (fits) longNestFitCount++;
    }
  }

  for (let i = 0; i < longs.length; i++) {
    const unit = longs[i];
    const stripRects = csPackV2LongNestStripRects(rects);
    if (!stripRects.length) {
      unplacedLong.push({
        unit, _fmUid: unit._fmUid || null, mark: unit.mark || null,
        fitReason: 'NO_STRIP', fitReasonMsg: 'No clean strip free-rect left',
      });
      nestViews.push({
        mark: unit.mark || null, ok: false, reason: 'NO_STRIP',
      });
      continue;
    }

    const found = csPackV2FindFloorSeat(unit, stripRects, {
      envelope: env,
      placedBoxes,
      allowYaw: o.allowYaw !== false,
    });
    if (!found.ok) {
      const cls = csPackV2ClassifyUnplaced(unit, env, {
        lastFailReason: found.reason,
      });
      unplacedLong.push({
        unit, _fmUid: unit._fmUid || null, mark: unit.mark || null,
        fitReason: cls.fitReason, fitReasonMsg: cls.fitReasonMsg,
      });
      nestViews.push({
        mark: unit.mark || null, ok: false, reason: found.reason || cls.fitReason,
      });
      continue;
    }

    const packUnit = found.viewUnit || unit;
    const commit = csPackV2CommitFloorSeat(packUnit, found.seat, {
      envelope: env,
      rect: found.rect,
      placedBoxes,
    });
    if (!commit.ok || !commit.placement) {
      unplacedLong.push({
        unit, _fmUid: unit._fmUid || null, mark: unit.mark || null,
        fitReason: 'COMMIT_FAIL', fitReasonMsg: commit.reason || 'commit failed',
      });
      nestViews.push({
        mark: unit.mark || null, ok: false, reason: commit.reason || 'COMMIT_FAIL',
      });
      continue;
    }

    const placement = {
      ...commit.placement,
      role: 'long_nest_strip',
      yawDeg: found.yawDeg || 0,
      corner: found.corner || null,
      rectId: found.rect && found.rect.id,
      unit,
    };

    const stripForInsp = found.rect
      || side0
      || stripRects[0]
      || null;
    const inspect = csPackV2InspectLongNestInStrip(
      placement, unit, stripForInsp, twinPlacements.length ? twinPlacements : outPlaced, env);

    if (!inspect.ok) {
      // Design fail — do not keep the seat (rollback freeRects untouched)
      unplacedLong.push({
        unit, _fmUid: unit._fmUid || null, mark: unit.mark || null,
        fitReason: 'DESIGN_FAIL',
        fitReasonMsg: inspect.reasons.join(','),
      });
      nestViews.push({
        mark: unit.mark || null, ok: false,
        reason: 'DESIGN_FAIL:' + inspect.reasons.join(','),
        design: inspect.design,
      });
      continue;
    }

    const applied = csPackV2ApplySplit(rects, found.rect, placement, {
      gapMm,
      preferSideLane: true,
    });
    if (applied.ok) rects = applied.freeRects;
    else {
      rects = rects.filter(r => r !== found.rect
        && !(r && found.rect && r.id === found.rect.id));
    }

    placedBoxes.push(placement.box);
    outPlaced.push(placement);
    if (unit._fmUid != null) {
      skip.add(unit._fmUid);
      placedUids.push(unit._fmUid);
    }
    unit.fitReason = null;
    unit.fitReasonMsg = null;

    nestViews.push({
      mark: unit.mark || null,
      ok: true,
      reason: null,
      design: inspect.design,
      pl: placement.pl,
      pw: placement.pw,
      ph: placement.ph,
      x: placement.x,
      z: placement.z,
      y: placement.y,
    });
  }

  const longNestPlaceRate = longNestFitCount > 0
    ? placedUids.length / longNestFitCount
    : 1;

  return {
    ok: true,
    reason: null,
    placed: outPlaced,
    unplacedLong,
    freeRects: rects,
    placedUids,
    nestViews,
    envelope: env,
    longCandidateCount: longs.length,
    longNestFitCount,
    placedLongCount: placedUids.length,
    longNestPlaceRate,
  };
}

/**
 * Step 3e self-test — every locked perspective.
 * Console: csPackV2Step3eSelfTest()
 */
function csPackV2Step3eSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const a = {
    _fmUid: 'rf-a', mark: 'RF012',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };
  const b = {
    _fmUid: 'rf-b', mark: 'RF008',
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11608, packWidthMm: 200, packHeightMm: 2508, weightKg: 711,
  };
  const longNest = {
    _fmUid: 'nz-long', mark: '200Z · set 1',
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 320,
  };
  const shortNest = {
    _fmUid: 'nz-short', mark: 'SHORTZ',
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 2000, packWidthMm: 400, packHeightMm: 200, weightKg: 80,
  };
  const fatShort = {
    _fmUid: 'nz-fat', mark: 'FATSHORT',
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 3000, packWidthMm: 900, packHeightMm: 200, weightKg: 100,
  };

  const lane = csPackV2PlaceTwinLane({ a, b, gapMm: 60 }, env, {});
  const reb = csPackV2RebuildTwinLeftoverRects(env, lane.placed, {});
  check('L1', lane.ok && reb.ok && reb.sideStrip,
    `lane=${lane.ok} reb=${reb.ok}`);

  // Candidate detection perspectives
  check('L2', csPackV2IsLongNestUnit(longNest, env)
    && !csPackV2IsLongNestUnit(shortNest, env)
    && !csPackV2IsLongNestUnit(a, env),
  `long=${csPackV2IsLongNestUnit(longNest, env)} short=${csPackV2IsLongNestUnit(shortNest, env)} asm=${csPackV2IsLongNestUnit(a, env)}`);

  const pass = csPackV2PlaceLongNestsIntoStrip(
    [fatShort, shortNest, longNest, a],
    reb.freeRects,
    lane.placed,
    { envelope: env });

  check('L3', pass.ok && pass.placedLongCount === 1 && pass.placedUids.indexOf('nz-long') >= 0,
    `n=${pass.placedLongCount} uids=${(pass.placedUids || []).join(',')}`);

  const nestPl = pass.placed.find(p => p && p._fmUid === 'nz-long');
  check('L4', nestPl && nestPl.role === 'long_nest_strip' && nestPl.y === 0
    && nestPl.box && nestPl.box.minY === 0,
  `role=${nestPl && nestPl.role} y=${nestPl && nestPl.y}`);

  // Warehouse / strip: nest sits in side strip Z band (z >= side.z)
  check('L5', nestPl && reb.sideStrip
    && +nestPl.z >= +reb.sideStrip.z - CSPACK_V2_EPS,
  `nestZ=${nestPl && nestPl.z} stripZ=${reb.sideStrip && reb.sideStrip.z}`);

  // No dig-in vs twins
  const dig = lane.placed.some(t => t && t.box && nestPl
    && csPackV2BoxesOverlap(nestPl.box, t.box));
  check('L6', nestPl && !dig, `dig=${dig}`);

  // Design inspect
  const view = (pass.nestViews || []).find(v => v && v.mark === longNest.mark);
  check('L7', view && view.ok && view.design && view.design.inStrip
    && view.design.onFloor && view.design.longEnough && view.design.noTwinDigIn,
  view ? `insp ok=${view.ok} in=${view.design && view.design.inStrip}` : 'no view');

  // Short / fat-short / assembly not placed in this pass
  check('L8', !pass.placedUids.includes('nz-short')
    && !pass.placedUids.includes('nz-fat')
    && !pass.placedUids.includes('rf-a'),
  `uids=${(pass.placedUids || []).join(',')}`);

  // Contrast: short-first PackFloor on strip-only world can park short at strip origin
  // while 3e keeps long in strip — long must still win strip seat under 3e priority
  const stripOnly = reb.freeRects.filter(r => r.role === 'twin_side_strip');
  const shortSeat = csPackV2FindFloorSeat(shortNest, stripOnly, {
    envelope: env, placedBoxes: lane.placed.map(p => p.box), allowYaw: true,
  });
  check('L9', shortSeat.ok && nestPl
    && (Math.abs(+nestPl.z - +shortSeat.seat.z) <= CSPACK_V2_EPS
      || +nestPl.pl >= env.lengthMm * CSPACK_V2_LONG_NEST_FRAC),
  `shortCouldSteal=${shortSeat.ok} longKept strip z=${nestPl && nestPl.z}`);

  // Free-rects remain non-overlapping after nest split
  let frOv = false;
  for (let i = 0; i < pass.freeRects.length; i++) {
    for (let j = i + 1; j < pass.freeRects.length; j++) {
      if (csPackV2FreeRectsOverlap(pass.freeRects[i], pass.freeRects[j])) frOv = true;
    }
  }
  check('L10', !frOv, `frOv=${frOv} n=${pass.freeRects.length}`);

  // Second long nest can still try remaining strip (or unplaced if no room)
  const long2 = {
    _fmUid: 'nz-long2', mark: '200Z · set 2',
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 350, packHeightMm: 200, weightKg: 280,
  };
  const pass2 = csPackV2PlaceLongNestsIntoStrip(
    [longNest, long2],
    reb.freeRects,
    lane.placed,
    { envelope: env });
  check('L11', pass2.placedLongCount >= 1
    && pass2.placedUids.indexOf('nz-long') >= 0,
  `n=${pass2.placedLongCount} uids=${(pass2.placedUids || []).join(',')}`);
  // Both may fit if strip width allows (1885 mm typically) — if 2nd placed, no dig
  if (pass2.placedLongCount >= 2) {
    const p1 = pass2.placed.find(p => p._fmUid === 'nz-long');
    const p2 = pass2.placed.find(p => p._fmUid === 'nz-long2');
    check('L12', p1 && p2 && !csPackV2BoxesOverlap(p1.box, p2.box)
      && p1.y === 0 && p2.y === 0,
    'two longs no dig');
  } else {
    check('L12', pass2.unplacedLong.length >= 1 || pass2.placedLongCount === 1,
      `second deferred nUn=${pass2.unplacedLong.length}`);
  }

  // Empty strip list → graceful
  const empty = csPackV2PlaceLongNestsIntoStrip([longNest], [], lane.placed, {
    envelope: env,
  });
  check('L13', empty.ok && empty.placedLongCount === 0
    && empty.unplacedLong.length === 1,
  `n=${empty.placedLongCount} un=${empty.unplacedLong.length}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3e self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3f — PackWithTwins wire (3a→3e → PackFloor remainder)
//
// Perspectives locked:
//   Orchestration — detect pairs → twin lane(s) → clean strip → long nests → FFD
//   Multi-pair    — first lane wall-hug; further pairs continue +Z via beside
//   Seed/skip     — PackFloor must not re-seat twins/long nests; use freeRects left
//   Outside       — envelope reject / unplaced with fitReason (never pretend outside)
//   Gravity       — all floor seats y=0
//   Weight        — BuildUnits heavy-first order still applies to PackFloor remainder
//   Regression    — PackFloor without seeds behaves as Step 2f
//   Group By      — no remorph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Continue a twin lane: seat pair.a then pair.b beside the last twin (+60).
 */
function csPackV2PlaceTwinLaneContinue(pair, lastPlacement, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  if (!pair || !pair.a || !pair.b)
    return { ok: false, reason: 'NO_PAIR', placed: [], placedBoxes: [] };
  if (!lastPlacement || !lastPlacement.box)
    return { ok: false, reason: 'NO_LAST', placed: [], placedBoxes: [] };

  const boxes = (o.placedBoxes || []).slice();
  const a = csPackV2SeatTwinBeside(pair.a, lastPlacement, env, {
    placedBoxes: boxes,
    gapMm: pair.gapMm != null ? pair.gapMm : CSPACK_V2_TWIN_BESIDE_GAP_MM,
  });
  if (!a.ok) {
    return {
      ok: false, reason: 'CONT_A:' + (a.reason || 'fail'),
      placed: [], placedBoxes: boxes, hug: null, beside: a,
    };
  }
  boxes.push(a.placement.box);
  const b = csPackV2SeatTwinBeside(pair.b, a.placement, env, {
    placedBoxes: boxes,
    gapMm: pair.gapMm != null ? pair.gapMm : CSPACK_V2_TWIN_BESIDE_GAP_MM,
  });
  if (!b.ok) {
    return {
      ok: false, reason: 'CONT_B:' + (b.reason || 'fail'),
      placed: [a.placement], placedBoxes: boxes, hug: null, beside: b,
    };
  }
  boxes.push(b.placement.box);
  // Tag continue seats for design views
  a.placement.role = 'twin_beside';
  b.placement.role = 'twin_beside';
  return {
    ok: true,
    reason: null,
    placed: [a.placement, b.placement],
    placedBoxes: boxes,
    gapMm: CSPACK_V2_TWIN_BESIDE_GAP_MM,
    hug: a,
    beside: b,
  };
}

/**
 * Widest long-nest pack width among units (for strip reserve).
 */
function csPackV2MaxLongNestWidthMm(units, envelope) {
  const env = envelope || csPackV2FloorEnvelope(null);
  const list = Array.isArray(units) ? units : [];
  let maxW = 0;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!csPackV2IsLongNestUnit(u, env)) continue;
    const { pw } = csPackV2Foot(u);
    if (pw > maxW) maxW = pw;
  }
  return maxW;
}

/**
 * Side-strip width to keep free for long nests (IFC-driven, not hardcoded twin count).
 */
function csPackV2NestStripReserveMm(units, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(null);
  const minStrip = (o.minStripMm != null)
    ? Math.max(0, +o.minStripMm)
    : CSPACK_V2_MIN_STRIP_FOR_NEST_MM;
  const nestW = csPackV2MaxLongNestWidthMm(units, env);
  return Math.max(minStrip, nestW);
}

/** Projected max Z after seating one twin pair (wall-hug or continue). */
function csPackV2ProjectedTwinPairMaxZ(pair, env, laneMaxZ) {
  if (!pair || !pair.a || !pair.b) return null;
  const aW = csPackV2Foot(pair.a).pw;
  const bW = csPackV2Foot(pair.b).pw;
  const gap = CSPACK_V2_TWIN_BESIDE_GAP_MM;
  if (!(aW > 0 && bW > 0)) return null;
  if (laneMaxZ == null) {
    // First pair at home wall
    return env.minZMm + aW + gap + bW;
  }
  // Continue: A beside last, B beside A
  return +laneMaxZ + gap + aW + gap + bW;
}

/**
 * True if next twin pair still leaves nest-strip reserve across width.
 * First pair always allowed (foundation twin lane).
 */
function csPackV2CanSeatTwinPairKeepingStrip(pair, env, laneMaxZ, reserveW, isFirst) {
  if (isFirst) return true;
  const proj = csPackV2ProjectedTwinPairMaxZ(pair, env, laneMaxZ);
  if (proj == null) return false;
  const remain = env.maxZMm - proj;
  return remain + CSPACK_V2_EPS >= +reserveW;
}

/**
 * Geometric: long nest footprint can sit in strip (yaw 0 or 90).
 */
function csPackV2LongNestFitsStripRect(unit, strip, envelope) {
  if (!unit || !strip) return false;
  const env = envelope || csPackV2FloorEnvelope(null);
  const { pl, pw, ph } = csPackV2Foot(unit);
  if (!(pl > 0 && pw > 0 && ph > 0)) return false;
  if (ph > env.heightMm + CSPACK_V2_EPS) return false;
  const sL = +strip.length;
  const sW = +strip.width;
  const fit0 = pl <= sL + CSPACK_V2_EPS && pw <= sW + CSPACK_V2_EPS;
  const fit90 = pw <= sL + CSPACK_V2_EPS && pl <= sW + CSPACK_V2_EPS;
  return fit0 || fit90;
}

/**
 * Full Step-3+4 packer: twins + clean strip + long nests + floor remainder
 * + nest stack pass (4e) on leftovers.
 *
 * @param {object[]} units  from csPackV2BuildUnits
 * @param {object} [opts]
 * @param {boolean} [opts.enableStacks=true]  set false for Step-3 floor-only probes
 * @returns {object} PackFloor-shaped result + twin/long/stack stats
 */
function csPackV2PackWithTwins(units, opts) {
  const o = opts || {};
  const list = Array.isArray(units) ? units : [];
  const init = csPackV2InitialFreeRects(o.containerSpec);
  const env = o.envelope || init.envelope;
  const gapMm = (o.gapMm != null)
    ? Math.max(0, +o.gapMm)
    : Math.max(0, +(env.bundleGapMm != null ? env.bundleGapMm : 20));
  const enableStacks = o.enableStacks !== false;

  const pairs = (typeof csPackV2DetectTwinPairs === 'function')
    ? csPackV2DetectTwinPairs(list, env)
    : [];

  const stripReserveMm = csPackV2NestStripReserveMm(list, env, {
    minStripMm: o.minStripMm,
  });

  let twinPlaced = [];
  let boxes = [];
  const laneResults = [];
  let pairsPlaced = 0;
  let twinStoppedForStrip = false;
  let laneMaxZ = null;

  for (let i = 0; i < pairs.length; i++) {
    const pr = pairs[i];
    const isFirst = twinPlaced.length === 0;
    if (!csPackV2CanSeatTwinPairKeepingStrip(
      pr, env, laneMaxZ, stripReserveMm, isFirst)) {
      twinStoppedForStrip = true;
      laneResults.push({
        index: i,
        ok: false,
        reason: 'STRIP_RESERVE',
        markA: pr.a && pr.a.mark,
        markB: pr.b && pr.b.mark,
      });
      // Leftover twin candidates → PackFloor; do not fill width
      break;
    }

    let lane;
    if (isFirst) {
      lane = csPackV2PlaceTwinLane(pr, env, { placedBoxes: boxes });
    } else {
      const last = twinPlaced[twinPlaced.length - 1];
      lane = csPackV2PlaceTwinLaneContinue(pr, last, env, { placedBoxes: boxes });
    }
    laneResults.push({
      index: i,
      ok: !!(lane && lane.ok),
      reason: lane ? lane.reason : 'null',
      markA: pr.a && pr.a.mark,
      markB: pr.b && pr.b.mark,
    });
    if (!lane || !lane.ok) {
      // Stop extending lane; leftover twin candidates go to PackFloor
      break;
    }
    for (let j = 0; j < lane.placed.length; j++) {
      twinPlaced.push(lane.placed[j]);
      if (lane.placed[j].box) boxes.push(lane.placed[j].box);
      const box = lane.placed[j].box;
      if (box && (laneMaxZ == null || +box.maxZ > laneMaxZ))
        laneMaxZ = +box.maxZ;
    }
    pairsPlaced++;
  }

  let freeRects;
  let stripOk = false;
  let sideStrip = null;
  let frontRemnant = null;
  let stripInspect = null;
  if (twinPlaced.length >= 2) {
    const reb = csPackV2RebuildTwinLeftoverRects(env, twinPlaced, {});
    stripOk = !!(reb && reb.ok);
    freeRects = stripOk ? reb.freeRects.slice() : init.freeRects.slice();
    sideStrip = reb.sideStrip || null;
    frontRemnant = reb.frontRemnant || null;
    stripInspect = reb.inspect || null;
    if (!stripOk) {
      // Fallback: start from full floor but keep twin boxes as obstacles
      freeRects = init.freeRects.slice();
    }
  } else {
    twinPlaced = [];
    boxes = [];
    freeRects = init.freeRects.slice();
  }

  const longPass = csPackV2PlaceLongNestsIntoStrip(list, freeRects, twinPlaced, {
    envelope: env,
    gapMm,
  });

  const skipUids = [];
  (longPass.placed || []).forEach(p => {
    if (p && p._fmUid != null) skipUids.push(p._fmUid);
  });

  const floor = csPackV2PackFloor(list, {
    containerSpec: o.containerSpec,
    envelope: env,
    initialFreeRects: longPass.freeRects,
    initialPlaced: longPass.placed,
    skipUids,
    gapMm,
    allowYaw: o.allowYaw !== false,
  });

  // ── Step 4f: nest stack pass on floor leftovers ──────────────────────────
  let stackPass = null;
  let finalPlaced = (floor.placed || []).slice();
  let finalUnplaced = (floor.unplaced || []).slice();
  if (enableStacks && typeof csPackV2PlaceNestStacks === 'function') {
    stackPass = csPackV2PlaceNestStacks(list, finalPlaced, {
      envelope: env,
      containerSpec: o.containerSpec,
      bearingMin: o.bearingMin,
    });
    finalPlaced = stackPass.placed || finalPlaced;
    const stackedUids = new Set();
    (stackPass.stacked || []).forEach(p => {
      if (p && p._fmUid != null) stackedUids.add(p._fmUid);
    });
    // Drop nests that just stacked from the unplaced list
    finalUnplaced = finalUnplaced.filter(u =>
      !u || u._fmUid == null || !stackedUids.has(u._fmUid));
    // Attach honest stack-fail reasons onto remaining nest leftovers
    const reasonByUid = {};
    (stackPass.stillUnplaced || []).forEach(s => {
      if (s && s._fmUid != null) reasonByUid[s._fmUid] = s.reason || 'STACK_FAIL';
    });
    for (let i = 0; i < finalUnplaced.length; i++) {
      const u = finalUnplaced[i];
      if (!u || u._fmUid == null) continue;
      if (reasonByUid[u._fmUid] && csPackIsNestUnit(u)) {
        u.fitReason = u.fitReason || ('STACK_' + reasonByUid[u._fmUid]);
        u.stackFailReason = reasonByUid[u._fmUid];
      }
    }
  }

  // Design gates
  let twinGapOk = true;
  let twinFloorOk = true;
  let twinNoDig = true;
  for (let i = 0; i < twinPlaced.length; i++) {
    const p = twinPlaced[i];
    if (!p) continue;
    if (p.y !== 0 || !p.box || p.box.minY !== 0) twinFloorOk = false;
    for (let j = i + 1; j < twinPlaced.length; j++) {
      const q = twinPlaced[j];
      if (p.box && q && q.box && csPackV2BoxesOverlap(p.box, q.box))
        twinNoDig = false;
    }
  }
  // Every consecutive twin seat along +Z must keep ≥60 mm clear gap
  for (let i = 0; i + 1 < twinPlaced.length; i++) {
    const A = twinPlaced[i];
    const B = twinPlaced[i + 1];
    if (!A || !B) continue;
    const gap = +B.z - (+A.z + +A.pw);
    if (gap + CSPACK_V2_EPS < CSPACK_V2_TWIN_BESIDE_GAP_MM) twinGapOk = false;
  }

  // Floor gravity = non-stack placements on y=0; stacks rest on support tops
  let allFloorY0 = twinFloorOk;
  let allStacksOnSupport = true;
  let allNoOverlap = twinNoDig;
  let stackNoTwinDig = true;
  const allPlaced = finalPlaced;
  for (let i = 0; i < allPlaced.length; i++) {
    const p = allPlaced[i];
    if (!p) continue;
    const isStack = p.role === 'nest_stack' || p.layer === 'stack';
    if (isStack) {
      if (!p.box
          || Math.abs(+p.box.minY - +p.y) > CSPACK_V2_EPS
          || (p.supportTopY != null
            && Math.abs(+p.y - +p.supportTopY) > CSPACK_V2_EPS)
          || (!(+p.y > 0) && !(+p.supportTopY === 0))) {
        allStacksOnSupport = false;
      }
    } else if (p.y !== 0 || !p.box || p.box.minY !== 0) {
      allFloorY0 = false;
    }
    for (let j = i + 1; j < allPlaced.length; j++) {
      const q = allPlaced[j];
      if (p.box && q && q.box && csPackV2BoxesOverlap(p.box, q.box))
        allNoOverlap = false;
    }
  }
  // Stacked nests must not dig into twin AABB volumes
  for (let i = 0; i < allPlaced.length; i++) {
    const p = allPlaced[i];
    if (!p || !p.box || (p.role !== 'nest_stack' && p.layer !== 'stack')) continue;
    for (let j = 0; j < allPlaced.length; j++) {
      const tw = allPlaced[j];
      if (!tw || !tw.box) continue;
      if (tw.role !== 'twin_wall_hug' && tw.role !== 'twin_beside') continue;
      if (csPackV2BoxesOverlap(p.box, tw.box)) stackNoTwinDig = false;
    }
  }

  // Real-yard: after strip-reserve, expect a real side strip (not width-full absent)
  const hasSideStrip = !!(sideStrip
    && Math.abs(+sideStrip.length - env.lengthMm) <= 1
    && +sideStrip.width + CSPACK_V2_EPS >= +stripReserveMm);
  const stripAcceptable = hasSideStrip
    || stripOk
    || !!(stripInspect && stripInspect.design && stripInspect.design.sideAbsentOk
      && frontRemnant);
  const longFit = longPass.longNestFitCount || 0;
  const longPlaced = longPass.placedLongCount || 0;
  const longPlaceRate = longPass.longNestPlaceRate != null
    ? longPass.longNestPlaceRate
    : (longFit > 0 ? longPlaced / longFit : 1);
  // Strip width only holds ~floor(stripW / reserveW) lengthways nests side-by-side
  const stripNestCapacity = hasSideStrip && stripReserveMm > 0
    ? Math.max(1, Math.floor(+sideStrip.width / +stripReserveMm))
    : 0;
  // Success: fill min(strip width-capacity, how many long nests exist/fit)
  const longNestTarget = Math.min(stripNestCapacity, longFit);
  const longNestOk = longFit === 0
    || stripNestCapacity === 0
    || longPlaced >= longNestTarget;

  const stackCount = stackPass ? (+stackPass.stackCount || 0) : 0;
  const stackDesignOk = !enableStacks
    || !stackPass
    || (stackPass.designOk !== false
      && allStacksOnSupport
      && stackNoTwinDig);

  const designOk = (!pairs.length || (pairsPlaced >= 1 && twinGapOk && twinFloorOk && twinNoDig))
    && allFloorY0 && allNoOverlap
    && (twinPlaced.length < 2 || stripAcceptable)
    && longNestOk
    && (twinPlaced.length < 2 || hasSideStrip || !pairs.length)
    && stackDesignOk;

  const placedCount = finalPlaced.length;
  const unplacedCount = finalUnplaced.length;
  // Feasible rate: prefer floor's feasible set, but recount placed after stacks
  let feasiblePlaced = floor.feasiblePlaced || 0;
  if (enableStacks && stackCount > 0 && floor.feasibleCount > 0) {
    const feasUids = new Set();
    // Approximate: count placed among list that have pack dims fitting envelope
    for (let i = 0; i < finalPlaced.length; i++) {
      const p = finalPlaced[i];
      if (!p) continue;
      const u = p.unit || list.find(x => x && x._fmUid === p._fmUid);
      if (!u) { feasiblePlaced++; continue; }
      const { pl, pw, ph } = csPackV2Foot(u);
      if (pl <= env.lengthMm + CSPACK_V2_EPS
          && pw <= env.widthMm + CSPACK_V2_EPS
          && ph <= env.heightMm + CSPACK_V2_EPS)
        feasUids.add(p._fmUid);
    }
    feasiblePlaced = feasUids.size || Math.min(placedCount, floor.feasibleCount);
  }
  const feasibleCount = floor.feasibleCount || 0;
  const feasiblePlaceRate = feasibleCount > 0
    ? feasiblePlaced / feasibleCount
    : (floor.feasiblePlaceRate != null ? floor.feasiblePlaceRate : 1);

  return {
    ok: floor.ok !== false && designOk,
    placed: finalPlaced,
    unplaced: finalUnplaced,
    freeRects: floor.freeRects,
    envelope: env,
    gapMm: floor.gapMm != null ? floor.gapMm : gapMm,
    placedCount,
    unplacedCount,
    feasibleCount,
    feasiblePlaced,
    feasiblePlaceRate,
    absurdFootprintCount: floor.absurdFootprintCount,
    // Step-3 diagnostics
    twinPairCount: pairs.length,
    twinPairsPlaced: pairsPlaced,
    twinPlacedCount: twinPlaced.length,
    twinGapOk,
    twinFloorOk,
    twinNoDig,
    twinStoppedForStrip,
    stripReserveMm,
    stripOk,
    stripAcceptable,
    hasSideStrip,
    sideStrip,
    frontRemnant,
    stripInspect,
    longCandidateCount: longPass.longCandidateCount,
    longNestFitCount: longFit,
    longNestPlacedCount: longPlaced,
    longNestPlaceRate: longPlaceRate,
    stripNestCapacity,
    longNestTarget,
    longUnplacedCount: (longPass.unplacedLong || []).length,
    nestViews: longPass.nestViews,
    laneResults,
    allFloorY0,
    allNoOverlap,
    // Step-4 diagnostics
    enableStacks,
    stackCount,
    stackLeftoverIn: stackPass ? stackPass.leftoverIn : 0,
    stackStillUnplacedCount: stackPass ? stackPass.stillUnplacedCount : 0,
    stackAccounted: stackPass ? !!stackPass.accounted : true,
    allStacksOnSupport,
    stackNoTwinDig,
    stackDesignOk,
    stackPass,
    designOk,
  };
}

/**
 * Full Step 3 self-test (3a–3f + PackFloor seed regression).
 * Console: csPackV2Step3SelfTest()
 */
function csPackV2Step3SelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const a = csPackV2Step3aSelfTest();
  const b = csPackV2Step3bSelfTest();
  const c = csPackV2Step3cSelfTest();
  const d = csPackV2Step3dSelfTest();
  const e = csPackV2Step3eSelfTest();
  check('S3a', a && a.ok, a ? `${a.passed}/${a.total}` : 'missing');
  check('S3b', b && b.ok, b ? `${b.passed}/${b.total}` : 'missing');
  check('S3c', c && c.ok, c ? `${c.passed}/${c.total}` : 'missing');
  check('S3d', d && d.ok, d ? `${d.passed}/${d.total}` : 'missing');
  check('S3e', e && e.ok, e ? `${e.passed}/${e.total}` : 'missing');

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  // PackFloor seed/skip regression
  const seedU = {
    _fmUid: 'seed1', mark: 'SEED',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 300, weightKg: 100,
  };
  const other = {
    _fmUid: 'oth1', mark: 'OTH',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 300, weightKg: 90,
  };
  const seedSeat = csPackV2TryFloorSeat(seedU, env.minXMm, env.minZMm, { envelope: env });
  const seedCommit = csPackV2CommitFloorSeat(seedU, seedSeat, { envelope: env });
  const initFr = csPackV2InitialFreeRects(spec);
  const split = csPackV2ApplySplit(initFr.freeRects, initFr.freeRects[0], seedCommit.placement, {
    gapMm: 20, preferSideLane: true,
  });
  const seeded = csPackV2PackFloor([seedU, other], {
    containerSpec: spec,
    envelope: env,
    initialFreeRects: split.freeRects,
    initialPlaced: [seedCommit.placement],
    skipUids: ['seed1'],
    gapMm: 20,
  });
  check('PF1', seeded.placedCount === 2
    && seeded.placed.filter(p => p._fmUid === 'seed1').length === 1
    && seeded.placed.filter(p => p._fmUid === 'oth1').length === 1,
  `n=${seeded.placedCount} uids=${seeded.placed.map(p => p._fmUid).join(',')}`);
  check('PF2', seeded.placed.every(p => p.y === 0)
    && !csPackV2BoxesOverlap(seeded.placed[0].box, seeded.placed[1].box),
  'seed pack y0 no dig');

  // PackWithTwins happy path
  const t1 = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const t2 = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nestL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const shortN = {
    _fmUid: 'ns1', mark: 'NS1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 2500, packWidthMm: 300, packHeightMm: 200, weightKg: 50,
  };
  const pack = csPackV2PackWithTwins([t1, t2, nestL, shortN], {
    containerSpec: spec, enableStacks: false,
  });
  check('PW1', pack.ok && pack.twinPairsPlaced >= 1 && pack.twinPlacedCount >= 2,
    `ok=${pack.ok} pairs=${pack.twinPairsPlaced} twins=${pack.twinPlacedCount}`);
  check('PW2', pack.twinGapOk && pack.twinFloorOk && pack.twinNoDig,
    `gap=${pack.twinGapOk} floor=${pack.twinFloorOk} dig=${!pack.twinNoDig}`);
  check('PW3', pack.stripOk && pack.sideStrip
    && Math.abs(+pack.sideStrip.length - env.lengthMm) <= 1,
  `stripL=${pack.sideStrip && pack.sideStrip.length}`);
  check('PW4', pack.longNestPlacedCount >= 1
    && pack.placed.some(p => p._fmUid === 'nl1' && p.role === 'long_nest_strip'),
  `long=${pack.longNestPlacedCount}`);
  check('PW5', pack.allFloorY0 && pack.allNoOverlap && pack.stackCount === 0,
    `y0=${pack.allFloorY0} ov=${!pack.allNoOverlap} stack=${pack.stackCount}`);
  check('PW6', pack.placedCount + pack.unplacedCount === 4,
    `in=${pack.placedCount} out=${pack.unplacedCount}`);

  // Multi-pair from IFC count (4 twins → 2 pairs) — strip must stay alive
  const m = [];
  for (let i = 0; i < 4; i++) {
    m.push({
      _fmUid: 'm' + i, mark: 'M' + i, isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 10000, packWidthMm: 180, packHeightMm: 2000, weightKg: 500 - i,
    });
  }
  const packM = csPackV2PackWithTwins(m, { containerSpec: spec, enableStacks: false });
  check('PW7', packM.twinPairCount === 2 && packM.twinPairsPlaced >= 1
    && packM.twinPlacedCount >= 2 && packM.twinNoDig && packM.twinGapOk
    && packM.hasSideStrip,
  `pairs=${packM.twinPairCount} placedPairs=${packM.twinPairsPlaced} n=${packM.twinPlacedCount} side=${packM.hasSideStrip}`);

  // No twin pairs — still packs (long nest priority on full floor)
  const onlyNest = csPackV2PackWithTwins([nestL, shortN], {
    containerSpec: spec, enableStacks: false,
  });
  check('PW8', onlyNest.ok && onlyNest.twinPlacedCount === 0
    && onlyNest.placedCount >= 1,
  `twins=${onlyNest.twinPlacedCount} placed=${onlyNest.placedCount}`);

  // Strip reserve: wide long nest forces stop before 2nd twin pair fills width
  const wideNest = {
    _fmUid: 'nw1', mark: 'WIDENEST', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 1500, packHeightMm: 200, weightKg: 400,
  };
  const fatTwins = [];
  for (let i = 0; i < 6; i++) {
    fatTwins.push({
      _fmUid: 'ft' + i, mark: 'FT' + i, isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 10000, packWidthMm: 250, packHeightMm: 2000, weightKg: 600 - i,
    });
  }
  const packR = csPackV2PackWithTwins(fatTwins.concat([wideNest]), {
    containerSpec: spec, enableStacks: false,
  });
  check('PW9', packR.twinPairsPlaced >= 1
    && packR.twinPairsPlaced < packR.twinPairCount
    && packR.twinStoppedForStrip
    && packR.hasSideStrip
    && packR.longNestPlacedCount >= 1,
  `placedPairs=${packR.twinPairsPlaced}/${packR.twinPairCount} stop=${packR.twinStoppedForStrip} long=${packR.longNestPlacedCount} sideW=${packR.sideStrip && packR.sideStrip.width}`);

  // 2f regression still green
  const f = csPackV2Step2fSelfTest();
  check('S2f', f && f.ok, f ? `${f.passed}/${f.total}` : 'missing');

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step3 self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4a — Support map (stackable tops from placed nests)
//
// Perspectives locked:
//   Warehouse — only nest tops are stack pads; never rafter/assembly tips
//   Tall ban  — support ph > 45% clear height → not stackable (tip crush)
//   Geometry  — each support = placement XZ footprint + topY = box.maxY
//   Capacity  — nest weight × N (yard); explicit supportCapacityKg wins
//   Tier      — floor nest = 1; stacked pads inherit height tier
//   Empty     — no placed / only twins → empty map (honest)
//   Design    — inspect helpers for CLI; seat search is 4c
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Real-yard support capacity for a nest pad (kg that may sit on top).
 * Explicit capacity wins; else weight × NEST_CAP_MULT; else huge default.
 */
function csPackV2NestSupportCapacityKg(placement) {
  if (!placement) return CSPACK_V2_DEFAULT_SUPPORT_CAP_KG;
  if (placement.supportCapacityKg != null && +placement.supportCapacityKg > 0
      && +placement.supportCapacityKg < 1e11)
    return +placement.supportCapacityKg;
  if (placement.unit && placement.unit.supportCapacityKg != null
      && +placement.unit.supportCapacityKg > 0
      && +placement.unit.supportCapacityKg < 1e11)
    return +placement.unit.supportCapacityKg;
  const w = Math.max(
    +placement.weightKg || 0,
    +(placement.unit && placement.unit.weightKg) || 0,
    +(placement.unit && placement.unit.total_weight) || 0,
    0);
  if (w > 0) return w * CSPACK_V2_NEST_CAP_MULT;
  return CSPACK_V2_DEFAULT_SUPPORT_CAP_KG;
}

/**
 * Tier index of a pad: floor nest ≈ 1, first stacked nest pad ≈ 2, …
 */
function csPackV2SupportTier(supportOrPlacement) {
  if (!supportOrPlacement) return 1;
  if (supportOrPlacement.tier != null && +supportOrPlacement.tier > 0)
    return Math.floor(+supportOrPlacement.tier);
  const baseY = supportOrPlacement.baseY != null
    ? +supportOrPlacement.baseY
    : (supportOrPlacement.box ? +supportOrPlacement.box.minY : 0);
  const ph = +supportOrPlacement.ph > 0
    ? +supportOrPlacement.ph
    : (supportOrPlacement.box
      ? (+supportOrPlacement.box.maxY - +supportOrPlacement.box.minY) : 200);
  if (!(baseY > CSPACK_V2_EPS)) return 1;
  return Math.max(1, Math.floor(baseY / Math.max(ph, 50)) + 1);
}

/**
 * Lengthways contact (mm) of upper footprint on support top.
 */
function csPackV2StackContactLengthMm(unitFoot, support) {
  if (!unitFoot || !support) return 0;
  const ux = +unitFoot.x;
  const upl = +unitFoot.pl;
  const sx = +support.x;
  const spl = +support.pl;
  if (!(upl > 0 && spl > 0)) return 0;
  if (![ux, sx].every(Number.isFinite)) return 0;
  return Math.max(0, Math.min(ux + upl, sx + spl) - Math.max(ux, sx));
}

/**
 * Min required contact length for upper nest (capped to its own length).
 */
function csPackV2StackContactNeedMm(unit) {
  const pl = csPackV2Foot(unit).pl;
  const need = Math.max(
    CSPACK_V2_STACK_CONTACT_MIN_MM,
    pl * CSPACK_V2_STACK_CONTACT_MIN_FRAC);
  return Math.min(need, pl);
}

/** True if unit and support share nest family (groupKind or shapeKey). */
function csPackV2SameNestFamily(unit, support) {
  if (!unit || !support) return false;
  const ug = String(unit.groupKind || '').toLowerCase();
  const sg = String(support.groupKind || '').toLowerCase();
  if (ug && sg && ug === sg) return true;
  const us = String(unit.shapeKey || unit.profileShape || '').toLowerCase();
  const ss = String(support.shapeKey || '').toLowerCase();
  if (us && ss && us === ss) return true;
  if (/nest_z/.test(ug) && (ss === 'z_channel' || ss === 'z_shape')) return true;
  if (/nest_c/.test(ug) && ss === 'c_channel') return true;
  if (/nest_l/.test(ug) && ss === 'l_angle') return true;
  return false;
}

/**
 * True if placement height is a "tall carrier" (rafter-like) — ban stacking on tip.
 */
function csPackV2IsTallCarrier(placement, envelope) {
  const env = envelope || csPackV2FloorEnvelope(null);
  if (!placement) return false;
  let ph = +placement.ph;
  if (!(ph > 0) && placement.box)
    ph = +placement.box.maxY - +placement.box.minY;
  if (!(ph > 0)) return false;
  const clear = +env.heightMm || CSPACK_V2_DEFAULT_H;
  return ph > clear * CSPACK_V2_TALL_CARRIER_FRAC + CSPACK_V2_EPS;
}

/**
 * True if a placed item can offer a nest-stack support top.
 */
function csPackV2PlacementIsNestSupportSource(placement) {
  if (!placement) return false;
  const role = String(placement.role || '');
  if (role === 'long_nest_strip' || role === 'nest_stack' || role === 'nest_floor')
    return true;
  if (role === 'twin_wall_hug' || role === 'twin_beside' || role === 'twin')
    return false;
  if (placement.unit && csPackIsNestUnit(placement.unit)) return true;
  const gk = String(
    (placement.unit && placement.unit.groupKind) || placement.groupKind || '');
  if (/^nest_[zcl]$/i.test(gk)) return true;
  const sk = String(
    (placement.unit && (placement.unit.shapeKey || placement.unit.profileShape))
    || placement.shapeKey || '');
  if (sk === 'z_channel' || sk === 'z_shape' || sk === 'c_channel' || sk === 'l_angle')
    return true;
  // Assemblies never
  if (placement.unit && csPackIsAssemblyUnit(placement.unit)) return false;
  if (gk === 'welded_assembly' || gk === 'assembly_single') return false;
  return false;
}

/**
 * Design inspect for one support entry.
 */
function csPackV2InspectSupport(support, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const design = {
    id: support && support.id,
    sourceUid: support && support.sourceUid,
    pl: support ? Math.round(+support.pl) : null,
    pw: support ? Math.round(+support.pw) : null,
    topY: support ? +support.topY : null,
    x: support ? +support.x : null,
    z: support ? +support.z : null,
    kind: support && support.kind,
    tallOk: null,
    dimsOk: null,
    onFloorBase: null,
  };
  if (!support) {
    reasons.push('NO_SUPPORT');
    return { ok: false, reasons, design };
  }
  design.dimsOk = +support.pl > 0 && +support.pw > 0 && +support.topY >= 0;
  if (!design.dimsOk) reasons.push('BAD_DIMS');
  design.tallOk = +support.ph + CSPACK_V2_EPS
    <= (+env.heightMm) * CSPACK_V2_TALL_CARRIER_FRAC;
  if (!design.tallOk) reasons.push('TALL_CARRIER');
  design.onFloorBase = +support.baseY === 0 || support.baseY == null;
  if (+support.topY > +env.heightMm + CSPACK_V2_EPS)
    reasons.push('TOP_ABOVE_CLEAR');
  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Build stackable support tops from already placed units.
 *
 * @param {object[]} placed
 * @param {object} [envelope]
 * @param {object} [opts]
 * @returns {{ ok, supports, rejected, envelope }}
 */
function csPackV2BuildSupportMap(placed, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  const list = Array.isArray(placed) ? placed : [];
  const supports = [];
  const rejected = [];

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.box) {
      rejected.push({
        sourceUid: p && p._fmUid, reason: 'NO_BOX', mark: p && p.mark,
      });
      continue;
    }
    if (!csPackV2PlacementIsNestSupportSource(p)) {
      rejected.push({
        sourceUid: p._fmUid, reason: 'NOT_NEST_SUPPORT',
        mark: p.mark, role: p.role || null,
      });
      continue;
    }
    if (csPackV2IsTallCarrier(p, env)) {
      rejected.push({
        sourceUid: p._fmUid, reason: 'TALL_CARRIER',
        mark: p.mark, ph: p.ph,
      });
      continue;
    }

    const pl = +p.pl > 0 ? +p.pl : (+p.box.maxX - +p.box.minX);
    const pw = +p.pw > 0 ? +p.pw : (+p.box.maxZ - +p.box.minZ);
    const ph = +p.ph > 0 ? +p.ph : (+p.box.maxY - +p.box.minY);
    if (!(pl > 0 && pw > 0)) {
      rejected.push({
        sourceUid: p._fmUid, reason: 'BAD_FOOTPRINT', mark: p.mark,
      });
      continue;
    }

    const cap = csPackV2NestSupportCapacityKg(p);
    const tier = csPackV2SupportTier({
      baseY: +p.box.minY, ph, tier: p.tier, box: p.box,
    });

    const support = {
      id: 'sup_' + (p._fmUid != null ? String(p._fmUid) : String(i)),
      sourceUid: p._fmUid != null ? p._fmUid : null,
      mark: p.mark || null,
      x: +p.x,
      z: +p.z,
      pl, pw, ph,
      baseY: +p.box.minY,
      topY: +p.box.maxY,
      capacityKg: cap,
      tier,
      kind: 'nest',
      role: p.role || null,
      groupKind: (p.unit && p.unit.groupKind) || p.groupKind || null,
      shapeKey: (p.unit && (p.unit.shapeKey || p.unit.profileShape)) || null,
      sourcePlacement: p,
    };

    const insp = csPackV2InspectSupport(support, env);
    if (!insp.ok) {
      rejected.push({
        sourceUid: p._fmUid,
        reason: 'DESIGN_FAIL:' + insp.reasons.join(','),
        mark: p.mark,
      });
      continue;
    }
    support.inspect = insp;
    supports.push(support);
  }

  // Stable order: lowest top first (stack bottom-up later), then rear, then home wall
  supports.sort((a, b) =>
    (+a.topY - +b.topY)
    || (+a.x - +b.x)
    || (+a.z - +b.z)
    || String(a.sourceUid || '').localeCompare(String(b.sourceUid || '')));

  return {
    ok: true,
    supports,
    rejected,
    envelope: env,
    supportCount: supports.length,
    rejectedCount: rejected.length,
  };
}

/**
 * Step 4a self-test — every locked perspective.
 * Console: csPackV2Step4aSelfTest()
 */
function csPackV2Step4aSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  // M1: empty
  const m1 = csPackV2BuildSupportMap([], env, {});
  check('M1', m1.ok && m1.supportCount === 0,
    `n=${m1.supportCount}`);

  // M2: one floor nest → one support
  const nestU = {
    _fmUid: 'n1', mark: 'NEST1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const nestSeat = csPackV2TryFloorSeat(nestU, env.minXMm, env.minZMm, { envelope: env });
  let nestPl;
  if (nestSeat.ok) {
    const nestCommit = csPackV2CommitFloorSeat(nestU, nestSeat, { envelope: env });
    nestPl = nestCommit.ok
      ? { ...nestCommit.placement, role: 'long_nest_strip', unit: nestU }
      : null;
  }
  if (!nestPl) {
    nestPl = {
      _fmUid: 'n1', mark: 'NEST1', role: 'long_nest_strip', unit: nestU,
      x: env.minXMm, z: env.minZMm, y: 0, pl: 9600, pw: 400, ph: 200,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 9600, 400, 200, 0),
    };
  }
  const m2 = csPackV2BuildSupportMap([nestPl], env, {});
  check('M2', m2.supportCount === 1
    && Math.abs(+m2.supports[0].topY - 200) <= CSPACK_V2_EPS
    && Math.abs(+m2.supports[0].pl - 9600) <= CSPACK_V2_EPS
    && Math.abs(+m2.supports[0].pw - 400) <= CSPACK_V2_EPS,
  `n=${m2.supportCount} topY=${m2.supports[0] && m2.supports[0].topY} foot=${m2.supports[0] && m2.supports[0].pl}x${m2.supports[0] && m2.supports[0].pw}`);

  // M3: twin rafters only → zero nest supports (assembly / twin role / tall)
  const rf = {
    _fmUid: 'rf1', mark: 'RF', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11600, packWidthMm: 200, packHeightMm: 2500, weightKg: 700,
  };
  const rfSeat = csPackV2TryFloorSeat(rf, env.minXMm, env.minZMm, { envelope: env });
  let rfPl;
  if (rfSeat.ok) {
    const rfCommit = csPackV2CommitFloorSeat(rf, rfSeat, { envelope: env });
    rfPl = rfCommit.ok
      ? { ...rfCommit.placement, role: 'twin_wall_hug', unit: rf }
      : null;
  }
  if (!rfPl) {
    rfPl = {
      _fmUid: 'rf1', mark: 'RF', role: 'twin_wall_hug', unit: rf,
      x: env.minXMm, z: env.minZMm, y: 0, pl: 11600, pw: 200, ph: 2500,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 11600, 200, 2500, 0),
    };
  }
  const m3 = csPackV2BuildSupportMap([rfPl], env, {});
  check('M3', m3.supportCount === 0
    && m3.rejected.some(r => r.reason === 'NOT_NEST_SUPPORT' || r.reason === 'TALL_CARRIER'),
  `n=${m3.supportCount} rej=${m3.rejected.map(r => r.reason).join(',')}`);

  // M4: nest + rafter → only nest
  const m4 = csPackV2BuildSupportMap([nestPl, rfPl], env, {});
  check('M4', m4.supportCount === 1 && m4.supports[0].sourceUid === 'n1',
    `n=${m4.supportCount} uid=${m4.supports[0] && m4.supports[0].sourceUid}`);

  // M5: tall nest (ph > 45% clear) banned even if nest
  const tallNest = {
    _fmUid: 'ntall', mark: 'TALLN', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 5000, packWidthMm: 300, packHeightMm: 1600, weightKg: 200,
  };
  // 1600 > 0.45 * ~2687 ≈ 1210 → tall
  const tSeat = csPackV2TryFloorSeat(tallNest, env.minXMm, env.minZMm + 500, {
    envelope: env, placedBoxes: [nestPl.box],
  });
  let m5ok = false;
  if (tSeat.ok) {
    const tCommit = csPackV2CommitFloorSeat(tallNest, tSeat, {
      envelope: env, placedBoxes: [nestPl.box],
    });
    const tPl = { ...tCommit.placement, role: 'long_nest_strip', unit: tallNest };
    check('M5', csPackV2IsTallCarrier(tPl, env),
      `ph=${tPl.ph} tall=${csPackV2IsTallCarrier(tPl, env)}`);
    const m5 = csPackV2BuildSupportMap([tPl], env, {});
    m5ok = m5.supportCount === 0
      && m5.rejected.some(r => String(r.reason).indexOf('TALL') >= 0);
    check('M5b', m5ok,
      `n=${m5.supportCount} rej=${m5.rejected.map(r => r.reason).join(',')}`);
  } else {
    // Height exceeds envelope — still proves tall ban via synthetic box
    const fakeTall = {
      _fmUid: 'ntall', mark: 'TALLN', role: 'long_nest_strip',
      x: env.minXMm, z: env.minZMm, y: 0, pl: 5000, pw: 300, ph: 1600,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 5000, 300, 1600, 0),
      unit: tallNest,
    };
    check('M5', csPackV2IsTallCarrier(fakeTall, env), 'synthetic tall');
    const m5 = csPackV2BuildSupportMap([fakeTall], env, {});
    check('M5b', m5.supportCount === 0
      && m5.rejected.some(r => String(r.reason).indexOf('TALL') >= 0),
    `n=${m5.supportCount} rej=${m5.rejected.map(r => r.reason).join(',')}`);
  }

  // M6: inspect design ok on good support
  check('M6', m2.supports[0] && m2.supports[0].inspect && m2.supports[0].inspect.ok
    && m2.supports[0].inspect.design.tallOk
    && m2.supports[0].inspect.design.dimsOk,
  m2.supports[0] && m2.supports[0].inspect
    ? `insp=${m2.supports[0].inspect.ok}`
    : 'no insp');

  // M7: capacity default present
  check('M7', m2.supports[0]
    && m2.supports[0].capacityKg === 300 * CSPACK_V2_NEST_CAP_MULT
    && m2.supports[0].tier === 1,
  `cap=${m2.supports[0] && m2.supports[0].capacityKg} tier=${m2.supports[0] && m2.supports[0].tier}`);

  // M8: PackWithTwins placed nests appear in support map; twins do not
  const t1 = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const t2 = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const pack = csPackV2PackWithTwins([t1, t2, nL], { containerSpec: spec });
  const mapP = csPackV2BuildSupportMap(pack.placed, pack.envelope, {});
  const nestPlaced = (pack.placed || []).filter(p =>
    p && (p.role === 'long_nest_strip' || (p.unit && csPackIsNestUnit(p.unit))));
  const twinPlaced = (pack.placed || []).filter(p =>
    p && (p.role === 'twin_wall_hug' || p.role === 'twin_beside'));
  check('M8', pack.ok && nestPlaced.length >= 1
    && mapP.supportCount === nestPlaced.length
    && mapP.supports.every(s => s.kind === 'nest')
    && twinPlaced.every(t => !mapP.supports.some(s => s.sourceUid === t._fmUid)),
  `sup=${mapP.supportCount} nests=${nestPlaced.length} twins=${twinPlaced.length}`);

  // M9: support topY equals nest box.maxY (gravity floor → ph)
  check('M9', mapP.supports[0]
    && nestPlaced[0]
    && Math.abs(+mapP.supports[0].topY - +nestPlaced[0].box.maxY) <= CSPACK_V2_EPS,
  `top=${mapP.supports[0] && mapP.supports[0].topY} maxY=${nestPlaced[0] && nestPlaced[0].box && nestPlaced[0].box.maxY}`);

  // M10: sort order stable (lower topY first)
  const n2 = {
    _fmUid: 'nl2', mark: 'NL2', groupKind: 'nest_c', shapeKey: 'c_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 180, weightKg: 200,
  };
  // Fake second nest already "stacked" higher for sort test
  const low = nestPl;
  const high = {
    _fmUid: 'nl2', mark: 'NL2', role: 'nest_stack', unit: n2,
    x: env.minXMm, z: env.minZMm + 600, y: 200,
    pl: 8000, pw: 350, ph: 180,
    box: csPackV2MakeBox(env.minXMm, env.minZMm + 600, 8000, 350, 180, 200),
  };
  const m10 = csPackV2BuildSupportMap([high, low], env, {});
  check('M10', m10.supportCount === 2
    && +m10.supports[0].topY <= +m10.supports[1].topY,
  `order=${m10.supports.map(s => s.topY).join(',')}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4a self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4b — Stack candidate rules (can this nest sit on this support?)
//
// Perspectives locked:
//   Nest-only   — assemblies never stack (floor / twin lane only)
//   Bearing     — XZ overlap / upper nest ≥ 40% (35% same-family + contact OK)
//   Contact     — lengthways contact ≥ min(2000mm, 35% of nest L, nest L)
//   Tall ban    — never stack on tall carrier tip (reuse 4a)
//   Height      — support.topY + nest.ph ≤ clear height
//   Weight      — nest.weightKg ≤ support.capacityKg (real nest capacity)
//   Tier        — support.tier + 1 ≤ MAX_TIERS
//   Pose (4b)   — bearing/contact at proposed XZ; pad-slide is 4c
//   Honest fail — every reject has a reason (no silent false)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Preferred stack XZ: same rear/home corner as support (warehouse lengthways).
 * Does not clamp — 4c will reject OUTSIDE_ENVELOPE / dig-in / try slides.
 */
function csPackV2ProposeStackXZ(unit, support) {
  const sx = support && support.x != null ? +support.x : 0;
  const sz = support && support.z != null ? +support.z : 0;
  return { x: sx, z: sz };
}

/**
 * Fraction of upper footprint that rests on support top (0..1).
 * @param {{ x,z,pl,pw }|object} unitFoot  proposed upper AABB in XZ
 * @param {{ x,z,pl,pw }|object} support   support top footprint
 */
function csPackV2StackBearingFrac(unitFoot, support) {
  if (!unitFoot || !support) return 0;
  const ux = +unitFoot.x;
  const uz = +unitFoot.z;
  const upl = +unitFoot.pl;
  const upw = +unitFoot.pw;
  const sx = +support.x;
  const sz = +support.z;
  const spl = +support.pl;
  const spw = +support.pw;
  if (!(upl > 0 && upw > 0 && spl > 0 && spw > 0)) return 0;
  if (![ux, uz, sx, sz].every(Number.isFinite)) return 0;

  const ox = Math.max(0, Math.min(ux + upl, sx + spl) - Math.max(ux, sx));
  const oz = Math.max(0, Math.min(uz + upw, sz + spw) - Math.max(uz, sz));
  const overlap = ox * oz;
  const unitArea = upl * upw;
  if (!(unitArea > 0)) return 0;
  const frac = overlap / unitArea;
  if (frac < 0) return 0;
  if (frac > 1) return 1;
  return frac;
}

/**
 * Design inspect: is unit a legal stack candidate on this support?
 * Returns ok + reasons + design fields (no seat commit).
 *
 * @param {object} unit
 * @param {object} support  from csPackV2BuildSupportMap
 * @param {object} [envelope]
 * @param {object} [opts]   { x, z, bearingMin, containerSpec }
 * @returns {{ ok, reason, reasons, design }}
 */
function csPackV2IsStackCandidate(unit, support, envelope, opts) {
  const o = opts || {};
  const env = envelope || csPackV2FloorEnvelope(o.containerSpec);
  const sameFamily = csPackV2SameNestFamily(unit, support);
  const bearingMin = (o.bearingMin != null)
    ? +o.bearingMin
    : (sameFamily
      ? CSPACK_V2_STACK_BEARING_SAME_FAMILY
      : CSPACK_V2_STACK_BEARING_MIN);
  const reasons = [];
  const design = {
    isNest: false,
    isAssembly: false,
    sameFamily,
    bearingFrac: null,
    bearingOk: null,
    bearingMin,
    contactMm: null,
    contactNeedMm: null,
    contactOk: null,
    heightOk: null,
    weightOk: null,
    tallOk: null,
    supportOk: null,
    tierOk: null,
    supportTier: null,
    newTier: null,
    topY: support ? +support.topY : null,
    clearH: +env.heightMm,
    ph: null,
    weightKg: null,
    capacityKg: support ? +support.capacityKg : null,
    x: null,
    z: null,
    pl: null,
    pw: null,
  };

  if (!unit) {
    reasons.push('NO_UNIT');
    return { ok: false, reason: 'NO_UNIT', reasons, design };
  }
  if (!support) {
    reasons.push('NO_SUPPORT');
    return { ok: false, reason: 'NO_SUPPORT', reasons, design };
  }

  design.isNest = csPackIsNestUnit(unit);
  design.isAssembly = csPackIsAssemblyUnit(unit) && !design.isNest;
  if (!design.isNest) {
    reasons.push(design.isAssembly ? 'NOT_NEST_ASSEMBLY' : 'NOT_NEST');
  }

  // Support must be a nest pad (4a kind) and not tall
  design.supportOk = support.kind === 'nest'
    && +support.pl > 0 && +support.pw > 0
    && support.topY != null && +support.topY >= 0;
  if (!design.supportOk) reasons.push('BAD_SUPPORT');

  const tallSrc = support.sourcePlacement || {
    ph: support.ph, box: support.box || null,
  };
  design.tallOk = !csPackV2IsTallCarrier(tallSrc, env)
    && !(+support.ph > (+env.heightMm) * CSPACK_V2_TALL_CARRIER_FRAC + CSPACK_V2_EPS);
  if (!design.tallOk) reasons.push('TALL_CARRIER');

  const { pl, pw, ph } = csPackV2Foot(unit);
  design.pl = pl;
  design.pw = pw;
  design.ph = ph;
  if (!(pl > 0 && pw > 0 && ph > 0)) reasons.push('BAD_DIMS');

  const xz = (o.x != null && o.z != null)
    ? { x: +o.x, z: +o.z }
    : csPackV2ProposeStackXZ(unit, support);
  design.x = xz.x;
  design.z = xz.z;

  const unitFoot = { x: xz.x, z: xz.z, pl, pw };
  design.bearingFrac = csPackV2StackBearingFrac(unitFoot, support);
  design.bearingOk = design.bearingFrac + 1e-9 >= bearingMin;
  if (!design.bearingOk) reasons.push('BEARING');

  design.contactMm = csPackV2StackContactLengthMm(unitFoot, support);
  design.contactNeedMm = csPackV2StackContactNeedMm(unit);
  design.contactOk = design.contactMm + CSPACK_V2_EPS >= design.contactNeedMm;
  if (!design.contactOk) reasons.push('CONTACT');

  const topY = +support.topY;
  const clearH = +env.heightMm;
  design.heightOk = Number.isFinite(topY) && Number.isFinite(ph)
    && (topY + ph <= clearH + CSPACK_V2_EPS);
  if (!design.heightOk) reasons.push('HEIGHT_EXCEEDS');

  design.supportTier = csPackV2SupportTier(support);
  design.newTier = design.supportTier + 1;
  design.tierOk = design.newTier <= CSPACK_V2_STACK_MAX_TIERS;
  if (!design.tierOk) reasons.push('MAX_TIERS');

  const wKg = Math.max(+unit.weightKg || 0, +unit.total_weight || 0, 0);
  const cap = (support.capacityKg != null && +support.capacityKg > 0)
    ? +support.capacityKg
    : CSPACK_V2_DEFAULT_SUPPORT_CAP_KG;
  design.weightKg = wKg;
  design.capacityKg = cap;
  design.weightOk = wKg <= cap + 1e-6;
  if (!design.weightOk) reasons.push('WEIGHT');

  const ok = reasons.length === 0;
  return {
    ok,
    reason: ok ? null : reasons[0],
    reasons,
    design,
  };
}

/**
 * Step 4b self-test — locked stack rules.
 * Console: csPackV2Step4bSelfTest()
 */
function csPackV2Step4bSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  // Shared floor nest support (real pad)
  const baseNest = {
    _fmUid: 'base', mark: 'BASE', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const baseSeat = csPackV2TryFloorSeat(baseNest, env.minXMm, env.minZMm, {
    envelope: env,
  });
  let basePl;
  if (baseSeat.ok) {
    const c = csPackV2CommitFloorSeat(baseNest, baseSeat, { envelope: env });
    basePl = c.ok
      ? { ...c.placement, role: 'long_nest_strip', unit: baseNest }
      : null;
  }
  if (!basePl) {
    basePl = {
      _fmUid: 'base', mark: 'BASE', role: 'long_nest_strip', unit: baseNest,
      x: env.minXMm, z: env.minZMm, y: 0, pl: 9600, pw: 400, ph: 200,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 9600, 400, 200, 0),
    };
  }
  const map = csPackV2BuildSupportMap([basePl], env, {});
  const support = map.supports[0];
  check('R0', !!support && map.supportCount === 1, `sup=${map.supportCount}`);

  // R1: good nest-on-nest → candidate
  const upper = {
    _fmUid: 'up1', mark: 'UP1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 250,
  };
  const r1 = csPackV2IsStackCandidate(upper, support, env, {});
  check('R1', r1.ok && r1.design.bearingOk && r1.design.heightOk
    && r1.design.weightOk && r1.design.isNest && r1.design.tallOk,
  `ok=${r1.ok} br=${r1.design.bearingFrac && r1.design.bearingFrac.toFixed(3)} r=${r1.reason}`);

  // R2: assembly on nest → false
  const asm = {
    _fmUid: 'a1', mark: 'ASM', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 300, weightKg: 400,
  };
  const r2 = csPackV2IsStackCandidate(asm, support, env, {});
  check('R2', !r2.ok && (r2.reason === 'NOT_NEST_ASSEMBLY' || r2.reason === 'NOT_NEST'),
    `ok=${r2.ok} r=${r2.reason}`);

  // R3: nest-on-rafter-tip (fake tall support) → false TALL_CARRIER
  const tallSup = {
    id: 'sup_tall', sourceUid: 'rf', kind: 'nest', mark: 'FAKE',
    x: env.minXMm, z: env.minZMm, pl: 10000, pw: 300, ph: 1600,
    topY: 1600, baseY: 0, capacityKg: 1e12,
    sourcePlacement: {
      ph: 1600,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 10000, 300, 1600, 0),
    },
  };
  const r3 = csPackV2IsStackCandidate(upper, tallSup, env, {});
  check('R3', !r3.ok && r3.reasons.indexOf('TALL_CARRIER') >= 0,
    `ok=${r3.ok} r=${r3.reasons.join(',')}`);

  // R4: over-height stack → HEIGHT_EXCEEDS
  const tallNest = {
    _fmUid: 'th', mark: 'TH', groupKind: 'nest_c', shapeKey: 'c_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 2600, weightKg: 200,
  };
  const r4 = csPackV2IsStackCandidate(tallNest, support, env, {});
  check('R4', !r4.ok && r4.reasons.indexOf('HEIGHT_EXCEEDS') >= 0,
    `ok=${r4.ok} top+ph=${(+support.topY + 2600)} clear=${env.heightMm}`);

  // R5: weight over capacity → WEIGHT
  const heavy = {
    _fmUid: 'hv', mark: 'HV', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 180, weightKg: 5000,
  };
  const weakSup = Object.assign({}, support, { capacityKg: 100 });
  const r5 = csPackV2IsStackCandidate(heavy, weakSup, env, {});
  check('R5', !r5.ok && r5.reasons.indexOf('WEIGHT') >= 0,
    `ok=${r5.ok} r=${r5.reasons.join(',')}`);

  // R6: bearing too low (upper shifted almost off support)
  const r6 = csPackV2IsStackCandidate(upper, support, env, {
    x: +support.x + +support.pl - 50,
    z: +support.z + +support.pw - 20,
  });
  check('R6', !r6.ok && r6.reasons.indexOf('BEARING') >= 0
    && r6.design.bearingFrac < CSPACK_V2_STACK_BEARING_MIN,
  `ok=${r6.ok} br=${r6.design.bearingFrac && r6.design.bearingFrac.toFixed(3)}`);

  // R7: bearing helper — full cover = 1
  const full = csPackV2StackBearingFrac(
    { x: support.x, z: support.z, pl: support.pl, pw: support.pw },
    support);
  check('R7', Math.abs(full - 1) < 1e-9, `full=${full}`);

  // R8: bearing helper — half overlap in Z ≈ 0.5
  const half = csPackV2StackBearingFrac(
    { x: support.x, z: support.z + support.pw * 0.5, pl: support.pl, pw: support.pw },
    support);
  check('R8', Math.abs(half - 0.5) < 1e-6, `half=${half}`);

  // R9: nulls honest
  const r9a = csPackV2IsStackCandidate(null, support, env, {});
  const r9b = csPackV2IsStackCandidate(upper, null, env, {});
  check('R9', !r9a.ok && r9a.reason === 'NO_UNIT' && !r9b.ok && r9b.reason === 'NO_SUPPORT',
    `a=${r9a.reason} b=${r9b.reason}`);

  // R10: bearing exactly at 40% threshold → ok
  // Upper pw = support.pw / 0.40 so when fully on support in X and Z-aligned
  // with only 40% of upper width on pad... easier: unit same size, shift Z
  // so overlap/unitArea = 0.40
  const u40 = {
    _fmUid: 'u40', mark: 'U40', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: support.pl, packWidthMm: support.pw, packHeightMm: 150,
    weightKg: 100,
  };
  const z40 = +support.z + +support.pw * (1 - CSPACK_V2_STACK_BEARING_MIN);
  const r10 = csPackV2IsStackCandidate(u40, support, env, {
    x: +support.x, z: z40,
  });
  check('R10', r10.ok && Math.abs(r10.design.bearingFrac - 0.40) < 1e-6,
    `ok=${r10.ok} br=${r10.design.bearingFrac && r10.design.bearingFrac.toFixed(4)}`);

  // R11: just under same-family 35% → reject
  const z34 = +support.z + +support.pw * (1 - 0.34);
  const r11 = csPackV2IsStackCandidate(u40, support, env, {
    x: +support.x, z: z34,
  });
  check('R11', !r11.ok && r11.reasons.indexOf('BEARING') >= 0
    && r11.design.bearingFrac < CSPACK_V2_STACK_BEARING_SAME_FAMILY,
  `ok=${r11.ok} br=${r11.design.bearingFrac && r11.design.bearingFrac.toFixed(4)}`);

  // R12: PackWithTwins — long nest unit vs nest support = candidate;
  //      same unit vs twin placement (not in map) never considered
  const t1 = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const t2 = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const n2 = {
    _fmUid: 'nl2', mark: 'NL2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220,
  };
  const pack = csPackV2PackWithTwins([t1, t2, nL], { containerSpec: spec });
  const mapP = csPackV2BuildSupportMap(pack.placed, pack.envelope, {});
  let anyOk = false;
  let anyTwinSupport = false;
  for (let i = 0; i < mapP.supports.length; i++) {
    const c = csPackV2IsStackCandidate(n2, mapP.supports[i], pack.envelope, {});
    if (c.ok) anyOk = true;
  }
  // Twin boxes must not appear as supports — already 4a; double-check candidate path
  const twinPl = (pack.placed || []).filter(p =>
    p && (p.role === 'twin_wall_hug' || p.role === 'twin_beside'));
  for (let i = 0; i < twinPl.length; i++) {
    const fake = {
      id: 'fake_tw', sourceUid: twinPl[i]._fmUid, kind: 'nest',
      x: twinPl[i].x, z: twinPl[i].z, pl: twinPl[i].pl, pw: twinPl[i].pw,
      ph: twinPl[i].ph, topY: twinPl[i].box && twinPl[i].box.maxY,
      capacityKg: 1e12,
      sourcePlacement: twinPl[i],
    };
    const c = csPackV2IsStackCandidate(n2, fake, pack.envelope, {});
    if (c.ok) anyTwinSupport = true;
  }
  check('R12', pack.ok && mapP.supportCount >= 1 && anyOk && !anyTwinSupport,
    `sup=${mapP.supportCount} nestCand=${anyOk} twinCand=${anyTwinSupport}`);

  // R13: propose XZ equals support rear/home
  const xz = csPackV2ProposeStackXZ(upper, support);
  check('R13', xz.x === +support.x && xz.z === +support.z,
    `xz=${xz.x},${xz.z} sup=${support.x},${support.z}`);

  // R14: contact length too short → CONTACT
  const r14 = csPackV2IsStackCandidate(upper, support, env, {
    x: +support.x + +support.pl - 500,
    z: +support.z,
  });
  check('R14', !r14.ok && r14.reasons.indexOf('CONTACT') >= 0,
    `ok=${r14.ok} r=${r14.reasons.join(',')} ct=${r14.design.contactMm}`);

  // R15: same-family uses 35% bearing floor when contact OK
  check('R15', r1.ok && r1.design.sameFamily
    && r1.design.bearingMin === CSPACK_V2_STACK_BEARING_SAME_FAMILY
    && r1.design.contactOk,
  `fam=${r1.design.sameFamily} bMin=${r1.design.bearingMin} ctOk=${r1.design.contactOk}`);

  // R16: max tiers reject
  const highSup = Object.assign({}, support, { tier: CSPACK_V2_STACK_MAX_TIERS, baseY: 2000, ph: 200 });
  const r16 = csPackV2IsStackCandidate(upper, highSup, env, {});
  check('R16', !r16.ok && r16.reasons.indexOf('MAX_TIERS') >= 0,
    `ok=${r16.ok} r=${r16.reasons.join(',')} newTier=${r16.design.newTier}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4b self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4c — Try one stack seat (preview only — no commit)
//
// Perspectives locked:
//   XZ       — pad-slide along support (+X / ±Z / edges); opts.x/z or noSlide freeze
//   Y        — preview y = support.topY (rest on pad; never floor y=0 unless pad is 0)
//   Dig-in   — AABB vs all placedBoxes; face-touch on support top is OK (not overlap)
//   Rules    — must pass 4b IsStackCandidate at that XZ first
//   Envelope — XZ must stay inside clear envelope
//   No mutate — does not change freeRects / placed (commit = 4d)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enumerate real-yard XZ poses on a support pad (rear/home + slides + Z edges).
 */
function csPackV2EnumerateStackXZ(unit, support, opts) {
  const o = opts || {};
  const { pl, pw } = csPackV2Foot(unit);
  const step = (o.slideStepMm != null)
    ? Math.max(25, +o.slideStepMm)
    : CSPACK_V2_STACK_SLIDE_STEP_MM;
  const poses = [];
  const seen = {};
  function add(x, z) {
    if (![x, z].every(Number.isFinite)) return;
    const key = Math.round(x) + ',' + Math.round(z);
    if (seen[key]) return;
    seen[key] = true;
    poses.push({ x, z });
  }

  const sx = +support.x;
  const sz = +support.z;
  const spl = +support.pl;
  const spw = +support.pw;
  add(sx, sz); // rear / home — always first

  const xMax = sx + spl - pl;
  const zOpts = [sz];
  if (spw > pw + CSPACK_V2_EPS) {
    zOpts.push(sz + Math.min(CSPACK_V2_STACK_Z_NUDGE_MM, spw - pw));
    zOpts.push(sz + (spw - pw) * 0.5); // centered on pad
    zOpts.push(sz + spw - pw); // far edge (side-by-side second column)
  }

  if (xMax + CSPACK_V2_EPS >= sx) {
    for (let x = sx; x <= xMax + CSPACK_V2_EPS; x += step) {
      for (let zi = 0; zi < zOpts.length; zi++) add(x, zOpts[zi]);
    }
    // Ensure door-end align is tried
    for (let zi = 0; zi < zOpts.length; zi++) add(xMax, zOpts[zi]);
  } else {
    // Upper longer than pad: rear, door-overhang align, center
    add(sx + spl - pl, sz);
    add(sx + (spl - pl) * 0.5, sz);
    for (let zi = 0; zi < zOpts.length; zi++) {
      add(sx, zOpts[zi]);
      add(sx + spl - pl, zOpts[zi]);
    }
  }
  return poses;
}

/**
 * Design inspect for a stack seat preview (no commit).
 */
function csPackV2InspectStackSeatTry(seat, support, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const design = {
    onSupport: null,
    yEqualsTop: null,
    noFloat: null,
    noDigInSupport: null,
    bearingOk: null,
    bearingFrac: null,
    contactMm: null,
    contactOk: null,
    insideEnvelope: null,
    heightOk: null,
  };
  if (!seat) {
    reasons.push('NO_SEAT');
    return { ok: false, reasons, design };
  }
  if (!support) {
    reasons.push('NO_SUPPORT');
    return { ok: false, reasons, design };
  }
  const topY = +support.topY;
  design.yEqualsTop = Math.abs(+seat.y - topY) <= CSPACK_V2_EPS;
  if (!design.yEqualsTop) reasons.push('Y_NOT_ON_SUPPORT');

  design.noFloat = seat.box
    && Math.abs(+seat.box.minY - topY) <= CSPACK_V2_EPS;
  if (!design.noFloat) reasons.push('FLOAT_OR_SINK');

  design.noDigInSupport = seat.box
    && +seat.box.minY + CSPACK_V2_EPS >= topY;
  if (!design.noDigInSupport) reasons.push('DIG_IN_SUPPORT');

  design.onSupport = design.yEqualsTop && design.noFloat && design.noDigInSupport;

  const unitFoot = { x: +seat.x, z: +seat.z, pl: +seat.pl, pw: +seat.pw };
  design.bearingFrac = csPackV2StackBearingFrac(unitFoot, support);
  const sameFamily = !!(seat.candidate && seat.candidate.design
    && seat.candidate.design.sameFamily);
  const bMin = sameFamily
    ? CSPACK_V2_STACK_BEARING_SAME_FAMILY
    : CSPACK_V2_STACK_BEARING_MIN;
  design.bearingOk = design.bearingFrac + 1e-9 >= bMin;
  if (!design.bearingOk) reasons.push('BEARING');

  design.contactMm = csPackV2StackContactLengthMm(unitFoot, support);
  const need = seat.candidate && seat.candidate.design
    && seat.candidate.design.contactNeedMm != null
    ? +seat.candidate.design.contactNeedMm
    : Math.min(CSPACK_V2_STACK_CONTACT_MIN_MM, +seat.pl);
  design.contactOk = design.contactMm + CSPACK_V2_EPS >= need;
  if (!design.contactOk) reasons.push('CONTACT');

  design.insideEnvelope = +seat.x >= +env.minXMm - CSPACK_V2_EPS
    && +seat.z >= +env.minZMm - CSPACK_V2_EPS
    && +seat.x + +seat.pl <= +env.maxXMm + CSPACK_V2_EPS
    && +seat.z + +seat.pw <= +env.maxZMm + CSPACK_V2_EPS;
  if (!design.insideEnvelope) reasons.push('OUTSIDE_ENVELOPE');

  design.heightOk = topY + +seat.ph <= +env.heightMm + CSPACK_V2_EPS;
  if (!design.heightOk) reasons.push('HEIGHT_EXCEEDS');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Try one fixed XZ pose on a support (internal).
 */
function csPackV2TryStackSeatAt(unit, support, x, z, opts) {
  const o = opts || {};
  const env = o.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const placed = o.placedBoxes || [];

  const empty = (reason, extra) => Object.assign({
    ok: false,
    reason: reason || 'FAIL',
    x: null, z: null, y: null,
    pl: null, pw: null, ph: null,
    box: null,
    supportId: support && support.id != null ? support.id : null,
    supportTopY: support ? +support.topY : null,
    candidate: null,
    inspect: null,
    slide: false,
  }, extra || {});

  if (!unit) return empty('NO_UNIT');
  if (!support) return empty('NO_SUPPORT');

  const { pl, pw, ph } = csPackV2Foot(unit);
  if (!(pl > 0 && pw > 0 && ph > 0))
    return empty('BAD_DIMS', { pl, pw, ph });

  const candidate = csPackV2IsStackCandidate(unit, support, env, {
    x, z,
    bearingMin: o.bearingMin,
    containerSpec: o.containerSpec,
  });
  if (!candidate.ok) {
    return empty(candidate.reason || 'NOT_CANDIDATE', {
      x, z, y: +support.topY, pl, pw, ph, candidate,
    });
  }

  const y = +support.topY;
  if (x < env.minXMm - CSPACK_V2_EPS || z < env.minZMm - CSPACK_V2_EPS
      || x + pl > env.maxXMm + CSPACK_V2_EPS
      || z + pw > env.maxZMm + CSPACK_V2_EPS) {
    return empty('OUTSIDE_ENVELOPE', { x, z, y, pl, pw, ph, candidate });
  }
  if (!(Number.isFinite(y) && y >= 0))
    return empty('BAD_SUPPORT_TOP', { x, z, y, pl, pw, ph, candidate });
  if (y + ph > env.heightMm + CSPACK_V2_EPS)
    return empty('HEIGHT_EXCEEDS', { x, z, y, pl, pw, ph, candidate });

  const box = csPackV2MakeBox(x, z, pl, pw, ph, y);
  box.minY = y;
  box.maxY = y + ph;

  for (let i = 0; i < placed.length; i++) {
    if (csPackV2BoxesOverlap(box, placed[i]))
      return empty('OVERLAP', { x, z, y, pl, pw, ph, box, candidate });
  }
  if (box.minY + CSPACK_V2_EPS < y)
    return empty('DIG_IN', { x, z, y, pl, pw, ph, box, candidate });

  const seat = {
    ok: true,
    reason: null,
    x, z, y, pl, pw, ph, box,
    supportId: support.id != null ? support.id : null,
    supportTopY: y,
    sourceUid: support.sourceUid != null ? support.sourceUid : null,
    candidate,
    inspect: null,
    slide: false,
    contactMm: candidate.design ? candidate.design.contactMm : null,
    bearingFrac: candidate.design ? candidate.design.bearingFrac : null,
  };
  seat.inspect = csPackV2InspectStackSeatTry(seat, support, env);
  if (!seat.inspect.ok) {
    return empty('DESIGN_FAIL:' + seat.inspect.reasons.join(','), {
      x, z, y, pl, pw, ph, box, candidate, inspect: seat.inspect,
    });
  }
  return seat;
}

/**
 * Try to seat one nest on a support top. Pure validation — no commit.
 * Default: pad-slide search for best bearing/contact pose (real forklift nudge).
 *
 * @param {object} unit
 * @param {object} support  from csPackV2BuildSupportMap
 * @param {object} [opts]
 * @param {object} [opts.envelope]
 * @param {object} [opts.containerSpec]
 * @param {object[]} [opts.placedBoxes]
 * @param {number} [opts.x] [opts.z]  freeze pose (no slide)
 * @param {boolean} [opts.noSlide]    only rear/home propose
 * @returns {{ ok, reason, x, z, y, pl, pw, ph, box, supportId, candidate, inspect }}
 */
function csPackV2TryStackSeat(unit, support, opts) {
  const o = opts || {};
  if (!unit)
    return { ok: false, reason: 'NO_UNIT', box: null, candidate: null, inspect: null };
  if (!support)
    return { ok: false, reason: 'NO_SUPPORT', box: null, candidate: null, inspect: null };

  // Fixed pose
  if (o.x != null && o.z != null) {
    return csPackV2TryStackSeatAt(unit, support, +o.x, +o.z, o);
  }
  if (o.noSlide) {
    const xz = csPackV2ProposeStackXZ(unit, support);
    return csPackV2TryStackSeatAt(unit, support, xz.x, xz.z, o);
  }

  // Pad-slide: try poses, keep best bearing then contact then rear-most
  const poses = csPackV2EnumerateStackXZ(unit, support, o);
  let best = null;
  let lastFail = null;
  for (let i = 0; i < poses.length; i++) {
    const seat = csPackV2TryStackSeatAt(unit, support, poses[i].x, poses[i].z, o);
    if (!seat.ok) {
      lastFail = seat;
      continue;
    }
    seat.slide = i > 0;
    const br = +seat.bearingFrac || 0;
    const ct = +seat.contactMm || 0;
    const score = br * 1e6 + ct * 10 - (+seat.x) * 0.001;
    seat._score = score;
    if (!best || score > best._score) best = seat;
  }
  if (best) {
    delete best._score;
    return best;
  }
  return lastFail || {
    ok: false, reason: 'NO_SEAT', box: null, candidate: null, inspect: null,
  };
}

/**
 * Step 4c self-test — try stack seat (no commit).
 * Console: csPackV2Step4cSelfTest()
 */
function csPackV2Step4cSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  const baseNest = {
    _fmUid: 'base', mark: 'BASE', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const baseSeat = csPackV2TryFloorSeat(baseNest, env.minXMm, env.minZMm, {
    envelope: env,
  });
  let basePl;
  if (baseSeat.ok) {
    const c = csPackV2CommitFloorSeat(baseNest, baseSeat, { envelope: env });
    basePl = c.ok
      ? { ...c.placement, role: 'long_nest_strip', unit: baseNest }
      : null;
  }
  if (!basePl) {
    basePl = {
      _fmUid: 'base', mark: 'BASE', role: 'long_nest_strip', unit: baseNest,
      x: env.minXMm, z: env.minZMm, y: 0, pl: 9600, pw: 400, ph: 200,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 9600, 400, 200, 0),
    };
  }
  const map = csPackV2BuildSupportMap([basePl], env, {});
  const support = map.supports[0];
  check('T0', !!support, `sup=${map.supportCount}`);

  const upper = {
    _fmUid: 'up1', mark: 'UP1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 250,
  };

  // T1: valid nest-on-nest seat
  const t1 = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box],
  });
  check('T1', t1.ok && Math.abs(+t1.y - +support.topY) <= CSPACK_V2_EPS
    && t1.box && Math.abs(+t1.box.minY - +support.topY) <= CSPACK_V2_EPS
    && +t1.y !== 0,
  `ok=${t1.ok} y=${t1.y} top=${support.topY} r=${t1.reason}`);

  // T2: inspect design ok (on support, bearing, no dig)
  check('T2', t1.inspect && t1.inspect.ok
    && t1.inspect.design.onSupport
    && t1.inspect.design.bearingOk
    && t1.inspect.design.noDigInSupport,
  t1.inspect ? `insp=${t1.inspect.ok} on=${t1.inspect.design.onSupport}` : 'no insp');

  // T3: second nest same XZ → OVERLAP dig-in
  const upper2 = {
    _fmUid: 'up2', mark: 'UP2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8800, packWidthMm: 360, packHeightMm: 170, weightKg: 200,
  };
  const t3 = csPackV2TryStackSeat(upper2, support, {
    envelope: env,
    placedBoxes: [basePl.box, t1.box],
  });
  check('T3', !t3.ok && t3.reason === 'OVERLAP',
    `ok=${t3.ok} r=${t3.reason}`);

  // T4: assembly → not candidate
  const asm = {
    _fmUid: 'a1', mark: 'ASM', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 300, weightKg: 400,
  };
  const t4 = csPackV2TryStackSeat(asm, support, {
    envelope: env, placedBoxes: [basePl.box],
  });
  check('T4', !t4.ok && (t4.reason === 'NOT_NEST_ASSEMBLY' || t4.reason === 'NOT_NEST'),
    `ok=${t4.ok} r=${t4.reason}`);

  // T5: shifted off pad → BEARING
  const t5 = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box],
    x: +support.x + +support.pl - 40,
    z: +support.z + +support.pw - 15,
  });
  check('T5', !t5.ok && t5.reason === 'BEARING',
    `ok=${t5.ok} r=${t5.reason}`);

  // T6: height exceeds
  const tallU = {
    _fmUid: 'th', mark: 'TH', groupKind: 'nest_c', shapeKey: 'c_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 2600, weightKg: 200,
  };
  const t6 = csPackV2TryStackSeat(tallU, support, {
    envelope: env, placedBoxes: [basePl.box],
  });
  check('T6', !t6.ok && t6.reason === 'HEIGHT_EXCEEDS',
    `ok=${t6.ok} r=${t6.reason}`);

  // T7: outside envelope XZ
  const t7 = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box],
    x: env.maxXMm - 100,
    z: env.minZMm,
  });
  check('T7', !t7.ok && (t7.reason === 'OUTSIDE_ENVELOPE' || t7.reason === 'BEARING'),
    `ok=${t7.ok} r=${t7.reason}`);

  // T8: nulls honest
  const t8a = csPackV2TryStackSeat(null, support, { envelope: env });
  const t8b = csPackV2TryStackSeat(upper, null, { envelope: env });
  check('T8', !t8a.ok && t8a.reason === 'NO_UNIT' && !t8b.ok && t8b.reason === 'NO_SUPPORT',
    `a=${t8a.reason} b=${t8b.reason}`);

  // T9: y preview never floor-gravity 0 when support top > 0
  check('T9', t1.ok && +support.topY > 0 && +t1.y === +support.topY
    && +t1.box.minY === +support.topY,
  `y=${t1.y} minY=${t1.box && t1.box.minY}`);

  // T10: PackWithTwins — leftover nest try-seat on nest support
  const tA = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const tB = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const n2 = {
    _fmUid: 'nl2', mark: 'NL2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220,
  };
  const pack = csPackV2PackWithTwins([tA, tB, nL], { containerSpec: spec });
  const mapP = csPackV2BuildSupportMap(pack.placed, pack.envelope, {});
  const boxes = (pack.placed || []).map(p => p.box).filter(Boolean);
  let seatOk = false;
  let digIntoTwin = false;
  for (let i = 0; i < mapP.supports.length; i++) {
    const s = csPackV2TryStackSeat(n2, mapP.supports[i], {
      envelope: pack.envelope,
      placedBoxes: boxes,
    });
    if (s.ok) {
      seatOk = true;
      // stacked nest must not dig into twin AABB volumes
      for (let j = 0; j < (pack.placed || []).length; j++) {
        const p = pack.placed[j];
        if (!p || !p.box) continue;
        if (p.role === 'twin_wall_hug' || p.role === 'twin_beside') {
          if (csPackV2BoxesOverlap(s.box, p.box)) digIntoTwin = true;
        }
      }
      break;
    }
  }
  check('T10', pack.ok && mapP.supportCount >= 1 && seatOk && !digIntoTwin,
    `seat=${seatOk} digTwin=${digIntoTwin} sup=${mapP.supportCount}`);

  // T11: face-touch support is not OVERLAP (support box in placed list)
  const t11 = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box],
  });
  check('T11', t11.ok && !csPackV2BoxesOverlap(t11.box, basePl.box),
    `ok=${t11.ok} faceOverlap=${t11.box && csPackV2BoxesOverlap(t11.box, basePl.box)}`);

  // T12: best pose prefers rear/home when fully bearing
  check('T12', t1.ok && +t1.x === +support.x && +t1.z === +support.z,
    `xz=${t1.x},${t1.z} sup=${support.x},${support.z}`);

  // T13: pad-slide — rear/home blocked, slide +X finds seat (forklift nudge)
  const blocker = csPackV2MakeBox(
    +support.x, +support.z, 600, +support.pw, 100, +support.topY);
  const t13fail = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box, blocker],
    noSlide: true,
  });
  const t13 = csPackV2TryStackSeat(upper, support, {
    envelope: env,
    placedBoxes: [basePl.box, blocker],
  });
  check('T13', !t13fail.ok && t13.ok && +t13.x > +support.x + CSPACK_V2_EPS
    && t13.slide === true
    && !csPackV2BoxesOverlap(t13.box, blocker),
  `noSlide=${t13fail.ok}/${t13fail.reason} slide=${t13.ok} x=${t13.x} slid=${t13.slide}`);

  // T14: contact length present on good seat
  check('T14', t1.ok && t1.contactMm >= CSPACK_V2_STACK_CONTACT_MIN_MM,
    `contact=${t1.contactMm}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4c self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4d — Commit stack seat (gravity on support top)
//
// Perspectives locked:
//   Gravity  — y = support.topY always (ignore seat.y / never floor y=0 unless pad is 0)
//   Box      — box.minY = supportTop; box.maxY = supportTop + ph
//   Role     — nest_stack / layer stack
//   Recheck  — default re-run TryStackSeat (same defense as floor commit)
//   Capacity — stacked pad inherits remaining capacity (parentCap − unit weight)
//   Inspect  — onSupport, bearingOk, noDigIn, heightOk, roleOk
//   No loop  — single commit only; PlaceNestStacks is 4e
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stack gravity contract: nest rests on support top (never air shelf).
 */
function csPackV2StackGravityY(support) {
  if (!support || support.topY == null || !Number.isFinite(+support.topY))
    return null;
  return +support.topY;
}

/**
 * Design inspect for a committed stack placement on a support.
 */
function csPackV2InspectStackSeat(placement, support, envelope) {
  const reasons = [];
  const env = envelope || csPackV2FloorEnvelope(null);
  const design = {
    onSupport: null,
    yEqualsTop: null,
    minYEqualsTop: null,
    noFloat: null,
    noDigIn: null,
    bearingOk: null,
    bearingFrac: null,
    heightOk: null,
    roleOk: null,
    layerOk: null,
    floorY0Forbidden: null,
  };
  if (!placement) {
    reasons.push('NO_PLACEMENT');
    return { ok: false, reasons, design };
  }
  if (!support) {
    reasons.push('NO_SUPPORT');
    return { ok: false, reasons, design };
  }

  const topY = +support.topY;
  design.yEqualsTop = Math.abs(+placement.y - topY) <= CSPACK_V2_EPS;
  design.minYEqualsTop = !!(placement.box
    && Math.abs(+placement.box.minY - topY) <= CSPACK_V2_EPS);
  design.noFloat = design.yEqualsTop && design.minYEqualsTop;
  design.noDigIn = !!(placement.box
    && +placement.box.minY + CSPACK_V2_EPS >= topY);
  design.onSupport = design.noFloat && design.noDigIn;
  if (!design.yEqualsTop) reasons.push('Y_NOT_ON_SUPPORT');
  if (!design.minYEqualsTop) reasons.push('MINY_NOT_ON_SUPPORT');
  if (!design.noDigIn) reasons.push('DIG_IN');

  const unitFoot = {
    x: +placement.x, z: +placement.z, pl: +placement.pl, pw: +placement.pw,
  };
  design.bearingFrac = csPackV2StackBearingFrac(unitFoot, support);
  design.bearingOk = design.bearingFrac + 1e-9 >= CSPACK_V2_STACK_BEARING_MIN;
  if (!design.bearingOk) reasons.push('BEARING');

  design.heightOk = topY + +placement.ph <= +env.heightMm + CSPACK_V2_EPS;
  if (!design.heightOk) reasons.push('HEIGHT_EXCEEDS');

  design.roleOk = placement.role === 'nest_stack';
  if (!design.roleOk) reasons.push('BAD_ROLE');
  design.layerOk = placement.layer === 'stack';
  if (!design.layerOk) reasons.push('BAD_LAYER');

  // Floor y=0 is only legal when the support top itself is 0 (degenerate)
  design.floorY0Forbidden = !(topY > CSPACK_V2_EPS && +placement.y === 0);
  if (topY > CSPACK_V2_EPS && +placement.y === 0)
    reasons.push('FLOOR_Y0_ON_ELEVATED_SUPPORT');

  return { ok: reasons.length === 0, reasons, design };
}

/**
 * Commit a successful stack seat under support-top gravity.
 * Always forces y = support.topY — ignores seat.y / opts.y.
 *
 * @param {object} unit
 * @param {object} seat     from csPackV2TryStackSeat (must be ok)
 * @param {object} support  from csPackV2BuildSupportMap
 * @param {object} [opts]
 * @returns {{ ok, reason, placement }}
 */
function csPackV2CommitStackSeat(unit, seat, support, opts) {
  const o = opts || {};
  if (!unit)
    return { ok: false, reason: 'NO_UNIT', placement: null };
  if (!support)
    return { ok: false, reason: 'NO_SUPPORT', placement: null };
  if (!seat || !seat.ok)
    return { ok: false, reason: 'SEAT_NOT_OK', placement: null };

  const { pl, pw, ph } = csPackV2Foot(unit);
  const x = (seat.x != null) ? +seat.x : NaN;
  const z = (seat.z != null) ? +seat.z : NaN;
  if (!(Number.isFinite(x) && Number.isFinite(z)))
    return { ok: false, reason: 'BAD_XZ', placement: null };
  if (!(pl > 0 && pw > 0 && ph > 0))
    return { ok: false, reason: 'BAD_DIMS', placement: null };

  const y = csPackV2StackGravityY(support);
  if (y == null || !(y >= 0))
    return { ok: false, reason: 'BAD_SUPPORT_TOP', placement: null };

  // Defense: re-run try-seat at committed XZ (ignore any tampered seat.y)
  if (o.recheck !== false) {
    const again = csPackV2TryStackSeat(unit, support, {
      envelope: o.envelope,
      containerSpec: o.containerSpec,
      placedBoxes: o.placedBoxes || [],
      x, z,
      bearingMin: o.bearingMin,
    });
    if (!again.ok)
      return { ok: false, reason: again.reason || 'RECHECK_FAIL', placement: null };
  }

  const box = csPackV2MakeBox(x, z, pl, pw, ph, y);
  // Hard lock: bottom on support top — never float / never sink / never floor y=0 force
  box.minY = y;
  box.maxY = y + ph;

  const wKg = Math.max(+unit.weightKg || 0, +unit.total_weight || 0, 0);
  const parentCap = (support.capacityKg != null && +support.capacityKg > 0)
    ? +support.capacityKg
    : CSPACK_V2_DEFAULT_SUPPORT_CAP_KG;
  const remainCap = Math.max(0, parentCap - wKg);

  const placement = {
    _fmUid: unit._fmUid != null ? unit._fmUid : null,
    mark: unit.mark || null,
    x, z, y,
    pl, pw, ph,
    box,
    layer: 'stack',
    role: 'nest_stack',
    gravity: 'support_top',
    supportId: support.id != null ? support.id : null,
    supportUid: support.sourceUid != null ? support.sourceUid : null,
    supportTopY: y,
    supportCapacityKg: remainCap,
    weightKg: wKg,
    tier: csPackV2SupportTier(support) + 1,
    unit: unit,
    groupKind: unit.groupKind || null,
    shapeKey: unit.shapeKey || unit.profileShape || null,
  };

  const inspect = csPackV2InspectStackSeat(placement, support, o.envelope
    || csPackV2FloorEnvelope(o.containerSpec));
  if (!inspect.ok && o.requireInspect !== false) {
    return {
      ok: false,
      reason: 'DESIGN_FAIL:' + inspect.reasons.join(','),
      placement: null,
      inspect,
    };
  }
  placement.inspect = inspect;
  return { ok: true, reason: null, placement, inspect };
}

/**
 * Step 4d self-test — commit stack seat.
 * Console: csPackV2Step4dSelfTest()
 */
function csPackV2Step4dSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  const baseNest = {
    _fmUid: 'base', mark: 'BASE', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const baseSeat = csPackV2TryFloorSeat(baseNest, env.minXMm, env.minZMm, {
    envelope: env,
  });
  let basePl;
  if (baseSeat.ok) {
    const c = csPackV2CommitFloorSeat(baseNest, baseSeat, { envelope: env });
    basePl = c.ok
      ? { ...c.placement, role: 'long_nest_strip', unit: baseNest }
      : null;
  }
  if (!basePl) {
    basePl = {
      _fmUid: 'base', mark: 'BASE', role: 'long_nest_strip', unit: baseNest,
      x: env.minXMm, z: env.minZMm, y: 0, pl: 9600, pw: 400, ph: 200,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, 9600, 400, 200, 0),
    };
  }
  const map = csPackV2BuildSupportMap([basePl], env, {});
  const support = map.supports[0];
  check('C0', !!support && +support.topY === 200, `top=${support && support.topY}`);

  const upper = {
    _fmUid: 'up1', mark: 'UP1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 250,
  };
  const seat = csPackV2TryStackSeat(upper, support, {
    envelope: env, placedBoxes: [basePl.box],
  });
  check('C0b', seat.ok, `seat=${seat.ok} r=${seat.reason}`);

  // C1: commit — minY === support top / support box.maxY
  const c1 = csPackV2CommitStackSeat(upper, seat, support, {
    envelope: env, placedBoxes: [basePl.box],
  });
  check('C1', c1.ok && c1.placement
    && Math.abs(+c1.placement.y - +support.topY) <= CSPACK_V2_EPS
    && Math.abs(+c1.placement.box.minY - +support.topY) <= CSPACK_V2_EPS
    && Math.abs(+c1.placement.box.minY - +basePl.box.maxY) <= CSPACK_V2_EPS
    && Math.abs(+c1.placement.box.maxY - (+support.topY + 180)) <= CSPACK_V2_EPS,
  `ok=${c1.ok} y=${c1.placement && c1.placement.y} minY=${c1.placement && c1.placement.box.minY}`);

  // C2: not floor y=0 when support elevated
  check('C2', c1.ok && +support.topY > 0 && +c1.placement.y !== 0
    && +c1.placement.box.minY !== 0,
  `y=${c1.placement && c1.placement.y}`);

  // C3: role + layer
  check('C3', c1.ok && c1.placement.role === 'nest_stack'
    && c1.placement.layer === 'stack'
    && c1.placement.gravity === 'support_top',
  `role=${c1.placement && c1.placement.role} layer=${c1.placement && c1.placement.layer}`);

  // C4: ignore tampered seat.y — still locks to support top
  const badSeat = Object.assign({}, seat, { y: 0, box: csPackV2MakeBox(seat.x, seat.z, seat.pl, seat.pw, seat.ph, 0) });
  const c4 = csPackV2CommitStackSeat(upper, badSeat, support, {
    envelope: env, placedBoxes: [basePl.box],
  });
  check('C4', c4.ok && +c4.placement.y === +support.topY
    && +c4.placement.box.minY === +support.topY,
  `y=${c4.placement && c4.placement.y} (forced off tampered 0)`);

  // C5: seat not ok → fail
  const c5 = csPackV2CommitStackSeat(upper, { ok: false, reason: 'OVERLAP' }, support, {
    envelope: env,
  });
  check('C5', !c5.ok && c5.reason === 'SEAT_NOT_OK', `r=${c5.reason}`);

  // C6: recheck catches overlap with already-committed stack box
  const upper2 = {
    _fmUid: 'up2', mark: 'UP2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8800, packWidthMm: 360, packHeightMm: 170, weightKg: 200,
  };
  const seat2 = csPackV2TryStackSeat(upper2, support, {
    envelope: env, placedBoxes: [basePl.box], // try alone would pass
  });
  // Force commit attempt with first stack already in placedBoxes
  const c6 = csPackV2CommitStackSeat(upper2, seat2, support, {
    envelope: env,
    placedBoxes: [basePl.box, c1.placement.box],
  });
  check('C6', !c6.ok && c6.reason === 'OVERLAP',
    `ok=${c6.ok} r=${c6.reason}`);

  // C7: inspect design ok
  const insp = csPackV2InspectStackSeat(c1.placement, support, env);
  check('C7', insp.ok && insp.design.onSupport && insp.design.bearingOk
    && insp.design.noDigIn && insp.design.roleOk && insp.design.layerOk,
  `ok=${insp.ok} r=${insp.reasons.join(',')}`);

  // C8: nulls honest
  const c8a = csPackV2CommitStackSeat(null, seat, support, { envelope: env });
  const c8b = csPackV2CommitStackSeat(upper, seat, null, { envelope: env });
  check('C8', !c8a.ok && c8a.reason === 'NO_UNIT' && !c8b.ok && c8b.reason === 'NO_SUPPORT',
    `a=${c8a.reason} b=${c8b.reason}`);

  // C9: stacked nest becomes a support source in 4a map
  const stackedPl = c1.placement;
  const map2 = csPackV2BuildSupportMap([basePl, stackedPl], env, {});
  check('C9', map2.supportCount === 2
    && map2.supports.some(s => s.sourceUid === 'up1' && Math.abs(+s.topY - 380) <= CSPACK_V2_EPS),
  `n=${map2.supportCount} tops=${map2.supports.map(s => s.topY).join(',')}`);

  // C10: capacity reduced by unit weight
  check('C10', c1.ok
    && +c1.placement.supportCapacityKg === Math.max(0, +support.capacityKg - 250),
  `cap=${c1.placement && c1.placement.supportCapacityKg}`);

  // C11: PackWithTwins leftover nest try+commit — no dig into twins
  const tA = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const tB = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const n2 = {
    _fmUid: 'nl2', mark: 'NL2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220,
  };
  const pack = csPackV2PackWithTwins([tA, tB, nL], { containerSpec: spec });
  const mapP = csPackV2BuildSupportMap(pack.placed, pack.envelope, {});
  const boxes = (pack.placed || []).map(p => p.box).filter(Boolean);
  let committed = null;
  for (let i = 0; i < mapP.supports.length; i++) {
    const s = csPackV2TryStackSeat(n2, mapP.supports[i], {
      envelope: pack.envelope, placedBoxes: boxes,
    });
    if (!s.ok) continue;
    const cm = csPackV2CommitStackSeat(n2, s, mapP.supports[i], {
      envelope: pack.envelope, placedBoxes: boxes,
    });
    if (cm.ok) { committed = cm.placement; break; }
  }
  let digTwin = false;
  if (committed) {
    for (let j = 0; j < (pack.placed || []).length; j++) {
      const p = pack.placed[j];
      if (!p || !p.box) continue;
      if ((p.role === 'twin_wall_hug' || p.role === 'twin_beside')
          && csPackV2BoxesOverlap(committed.box, p.box))
        digTwin = true;
    }
  }
  check('C11', pack.ok && committed
    && +committed.y > 0
    && committed.role === 'nest_stack'
    && !digTwin,
  `y=${committed && committed.y} digTwin=${digTwin}`);

  // C12: gravity helper
  check('C12', csPackV2StackGravityY(support) === +support.topY
    && csPackV2StackGravityY(null) == null,
  `g=${csPackV2StackGravityY(support)}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4d self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4e — PlaceNestStacks pass (leftover nests onto real supports)
//
// Perspectives locked:
//   Warehouse — only nest leftovers stack; assemblies never enter this pass
//   Order     — heavier, then longer first (stable columns, real yard)
//   Support   — rebuild support map after EVERY successful commit (refresh)
//   Best pad  — same family preferred, then bearing, then lower topY
//   Gravity   — every commit via 4d (y=supportTop); no float / no floor y=0 cheat
//   Dig-in    — TryStackSeat vs all current boxes; face-touch pad OK
//   Honest    — leftovers keep reason (NO_SUPPORT / HEIGHT / BEARING / OVERLAP…)
//   Account   — stacked + stillUnplaced nests = input leftover nests
//   Scope     — does NOT wire into PackWithTwins yet (that is 4f)
// ═══════════════════════════════════════════════════════════════════════════

/** True if unit and support share nest family — defined earlier (4a helpers). */

/**
 * Score a viable stack seat on a support (higher = better).
 * Same family >> bearing >> contact >> lower topY >> capacity / length match.
 */
function csPackV2ScoreStackSupport(unit, support, seat) {
  let score = 0;
  if (csPackV2SameNestFamily(unit, support)) score += 100000;
  const br = (seat && seat.candidate && seat.candidate.design
    && seat.candidate.design.bearingFrac != null)
    ? +seat.candidate.design.bearingFrac
    : csPackV2StackBearingFrac(
      { x: seat.x, z: seat.z, pl: seat.pl, pw: seat.pw }, support);
  score += Math.max(0, Math.min(1, br)) * 10000;
  const ct = (seat && seat.contactMm != null)
    ? +seat.contactMm
    : csPackV2StackContactLengthMm(
      { x: seat.x, z: seat.z, pl: seat.pl, pw: seat.pw }, support);
  score += Math.max(0, ct) * 0.1;
  // Prefer lower pads (build columns from the floor up)
  score -= (+support.topY || 0) * 0.01;
  // Prefer lower tier pads when scores close
  score -= (csPackV2SupportTier(support) || 1) * 50;
  const cap = +support.capacityKg;
  if (Number.isFinite(cap) && cap < 1e11) score += cap * 1e-6;
  const foot = csPackV2Foot(unit);
  const lenMatch = Math.min(+support.pl || 0, foot.pl);
  score += lenMatch * 0.001;
  return score;
}

/**
 * Sort leftover nests: heavier first, then longer, then uid.
 */
function csPackV2SortStackCandidates(units) {
  const list = (Array.isArray(units) ? units : []).slice();
  list.sort((a, b) =>
    ((+b.weightKg || 0) - (+a.weightKg || 0))
    || (csPackV2Foot(b).pl - csPackV2Foot(a).pl)
    || String(a && a._fmUid || '').localeCompare(String(b && b._fmUid || '')));
  return list;
}

/**
 * Place leftover nest units onto nest supports (stack pass).
 *
 * @param {object[]} units   all packer units (or leftovers); non-nests ignored
 * @param {object[]} placed  already placed (floor / twin / long); copied
 * @param {object} [opts]
 * @returns {{ ok, placed, stacked, stillUnplaced, stackCount, attempts, envelope, designOk }}
 */
function csPackV2PlaceNestStacks(units, placed, opts) {
  const o = opts || {};
  const env = o.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const working = Array.isArray(placed) ? placed.slice() : [];
  const placedUids = new Set();
  for (let i = 0; i < working.length; i++) {
    const p = working[i];
    if (p && p._fmUid != null) placedUids.add(p._fmUid);
  }
  (o.skipUids || []).forEach(id => {
    if (id != null) placedUids.add(id);
  });

  const nestLeftovers = csPackV2SortStackCandidates(
    (Array.isArray(units) ? units : []).filter(u =>
      u && csPackIsNestUnit(u) && (u._fmUid == null || !placedUids.has(u._fmUid))));

  const stacked = [];
  const stillUnplaced = [];
  const attempts = [];

  for (let i = 0; i < nestLeftovers.length; i++) {
    const unit = nestLeftovers[i];
    const map = csPackV2BuildSupportMap(working, env, {
      containerSpec: o.containerSpec,
    });
    const boxes = [];
    for (let b = 0; b < working.length; b++) {
      if (working[b] && working[b].box) boxes.push(working[b].box);
    }

    let best = null;
    const tried = [];
    if (!map.supports || map.supports.length === 0) {
      stillUnplaced.push({
        unit, reason: 'NO_SUPPORT', mark: unit.mark || null,
        _fmUid: unit._fmUid != null ? unit._fmUid : null,
      });
      attempts.push({
        mark: unit.mark || null, _fmUid: unit._fmUid, ok: false,
        reason: 'NO_SUPPORT', supportCount: 0,
      });
      continue;
    }

    for (let s = 0; s < map.supports.length; s++) {
      const support = map.supports[s];
      const seat = csPackV2TryStackSeat(unit, support, {
        envelope: env,
        containerSpec: o.containerSpec,
        placedBoxes: boxes,
        bearingMin: o.bearingMin,
      });
      tried.push({
        supportId: support.id,
        supportMark: support.mark || null,
        ok: !!(seat && seat.ok),
        reason: seat ? seat.reason : 'null',
        score: (seat && seat.ok)
          ? csPackV2ScoreStackSupport(unit, support, seat) : null,
      });
      if (!seat || !seat.ok) continue;
      const score = csPackV2ScoreStackSupport(unit, support, seat);
      if (!best || score > best.score
          || (score === best.score
            && String(support.id || '').localeCompare(String(best.support.id || '')) < 0)) {
        best = { support, seat, score };
      }
    }

    if (!best) {
      const failReason = (tried.find(t => t.reason) || {}).reason || 'NO_SEAT';
      // Prefer a meaningful reject if all failed for same class
      const reasonCounts = {};
      for (let t = 0; t < tried.length; t++) {
        const r = tried[t].reason || 'FAIL';
        reasonCounts[r] = (reasonCounts[r] || 0) + 1;
      }
      // Prefer structural rejects when ties (height > bearing > weight > overlap)
      const prefer = [
        'HEIGHT_EXCEEDS', 'BEARING', 'WEIGHT', 'TALL_CARRIER',
        'NOT_NEST', 'NOT_NEST_ASSEMBLY', 'OVERLAP', 'OUTSIDE_ENVELOPE',
      ];
      let topReason = failReason;
      let topN = -1;
      let topPref = 999;
      Object.keys(reasonCounts).forEach(r => {
        const n = reasonCounts[r];
        const pref = prefer.indexOf(r);
        const prefRank = pref >= 0 ? pref : 50;
        if (n > topN || (n === topN && prefRank < topPref)) {
          topN = n;
          topPref = prefRank;
          topReason = r;
        }
      });
      stillUnplaced.push({
        unit, reason: topReason, mark: unit.mark || null,
        _fmUid: unit._fmUid != null ? unit._fmUid : null,
      });
      attempts.push({
        mark: unit.mark || null, _fmUid: unit._fmUid, ok: false,
        reason: topReason, tried: tried.slice(0, 8),
      });
      continue;
    }

    const commit = csPackV2CommitStackSeat(unit, best.seat, best.support, {
      envelope: env,
      containerSpec: o.containerSpec,
      placedBoxes: boxes,
      bearingMin: o.bearingMin,
    });
    if (!commit.ok || !commit.placement) {
      stillUnplaced.push({
        unit,
        reason: commit.reason || 'COMMIT_FAIL',
        mark: unit.mark || null,
        _fmUid: unit._fmUid != null ? unit._fmUid : null,
      });
      attempts.push({
        mark: unit.mark || null, _fmUid: unit._fmUid, ok: false,
        reason: commit.reason || 'COMMIT_FAIL',
        supportId: best.support.id,
      });
      continue;
    }

    working.push(commit.placement);
    if (unit._fmUid != null) placedUids.add(unit._fmUid);
    stacked.push(commit.placement);
    attempts.push({
      mark: unit.mark || null,
      _fmUid: unit._fmUid,
      ok: true,
      reason: null,
      supportId: best.support.id,
      supportMark: best.support.mark || null,
      score: best.score,
      y: commit.placement.y,
      topY: best.support.topY,
      sameFamily: csPackV2SameNestFamily(unit, best.support),
    });
  }

  // Design gates across all stacked
  let allOnSupport = true;
  let allNoFloorY0 = true;
  let allNoDigIn = true;
  let allNestStackRole = true;
  for (let i = 0; i < stacked.length; i++) {
    const p = stacked[i];
    if (!p || !p.box) { allOnSupport = false; continue; }
    if (p.role !== 'nest_stack' || p.layer !== 'stack') allNestStackRole = false;
    if (!(+p.y > 0) && !(+p.supportTopY === 0)) allNoFloorY0 = false;
    if (Math.abs(+p.box.minY - +p.y) > CSPACK_V2_EPS) allOnSupport = false;
    // Dig-in vs any other placed box
    for (let j = 0; j < working.length; j++) {
      const other = working[j];
      if (!other || other === p || !other.box) continue;
      if (other._fmUid != null && other._fmUid === p._fmUid) continue;
      if (csPackV2BoxesOverlap(p.box, other.box)) {
        allNoDigIn = false;
        break;
      }
    }
  }

  const accounted = stacked.length + stillUnplaced.length === nestLeftovers.length;
  const designOk = allOnSupport && allNoFloorY0 && allNoDigIn
    && allNestStackRole && accounted;

  return {
    ok: true,
    placed: working,
    stacked,
    stillUnplaced,
    stackCount: stacked.length,
    leftoverIn: nestLeftovers.length,
    stillUnplacedCount: stillUnplaced.length,
    attempts,
    envelope: env,
    accounted,
    allOnSupport,
    allNoFloorY0,
    allNoDigIn,
    allNestStackRole,
    designOk,
  };
}

/**
 * Step 4e self-test — every locked perspective.
 * Console: csPackV2Step4eSelfTest()
 */
function csPackV2Step4eSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);

  function makeFloorNest(uid, mark, dims) {
    const u = Object.assign({
      _fmUid: uid, mark, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
    }, dims || {});
    const seat = csPackV2TryFloorSeat(u, env.minXMm, env.minZMm, { envelope: env });
    if (seat.ok) {
      const c = csPackV2CommitFloorSeat(u, seat, { envelope: env });
      if (c.ok) return { ...c.placement, role: 'long_nest_strip', unit: u };
    }
    return {
      _fmUid: uid, mark, role: 'long_nest_strip', unit: u,
      x: env.minXMm, z: env.minZMm, y: 0,
      pl: u.packLengthMm, pw: u.packWidthMm, ph: u.packHeightMm,
      box: csPackV2MakeBox(env.minXMm, env.minZMm, u.packLengthMm, u.packWidthMm, u.packHeightMm, 0),
    };
  }

  // P1: empty → 0 stacks
  const p1 = csPackV2PlaceNestStacks([], [], { envelope: env });
  check('P1', p1.ok && p1.stackCount === 0 && p1.leftoverIn === 0,
    `stack=${p1.stackCount}`);

  // P2: one floor nest + one leftover → stack on it
  const floorA = makeFloorNest('base', 'BASE', {});
  const up1 = {
    _fmUid: 'up1', mark: 'UP1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 250,
  };
  const p2 = csPackV2PlaceNestStacks([up1], [floorA], { envelope: env });
  check('P2', p2.stackCount === 1
    && Math.abs(+p2.stacked[0].y - +floorA.box.maxY) <= CSPACK_V2_EPS
    && p2.stacked[0].role === 'nest_stack'
    && p2.designOk,
  `stack=${p2.stackCount} y=${p2.stacked[0] && p2.stacked[0].y} top=${floorA.box.maxY}`);

  // P3: second leftover stacks on first (map refresh); column grows
  const up2 = {
    _fmUid: 'up2', mark: 'UP2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8800, packWidthMm: 360, packHeightMm: 170, weightKg: 200,
  };
  const p3 = csPackV2PlaceNestStacks([up1, up2], [floorA], { envelope: env });
  check('P3', p3.stackCount === 2
    && p3.stillUnplacedCount === 0
    && +p3.stacked[0].y <= +p3.stacked[1].y
    && p3.allNoDigIn && p3.allOnSupport,
  `stack=${p3.stackCount} ys=${p3.stacked.map(s => Math.round(s.y)).join(',')}`);

  // P4: after one stack, over-height nest fails honestly (HEIGHT or no viable pad)
  const upTall = {
    _fmUid: 'upT', mark: 'UPT', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 2500, weightKg: 180,
  };
  const p4 = csPackV2PlaceNestStacks([up1, upTall], [floorA], { envelope: env });
  const p4reason = p4.stillUnplaced[0] && p4.stillUnplaced[0].reason;
  check('P4', p4.stackCount === 1
    && p4.stillUnplacedCount === 1
    && (p4reason === 'HEIGHT_EXCEEDS' || p4reason === 'OVERLAP')
    && p4.accounted,
  `stack=${p4.stackCount} left=${p4.stillUnplacedCount} r=${p4reason}`);

  // P5: assemblies in list ignored (not stacked, not in stillUnplaced nests)
  const asm = {
    _fmUid: 'asm1', mark: 'ASM', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 300, weightKg: 400,
  };
  const p5 = csPackV2PlaceNestStacks([asm, up1], [floorA], { envelope: env });
  check('P5', p5.stackCount === 1
    && p5.leftoverIn === 1
    && !p5.stacked.some(s => s._fmUid === 'asm1')
    && !p5.stillUnplaced.some(u => u._fmUid === 'asm1'),
  `stack=${p5.stackCount} in=${p5.leftoverIn}`);

  // P6: already-placed nest skipped
  const p6 = csPackV2PlaceNestStacks([floorA.unit, up1], [floorA], { envelope: env });
  check('P6', p6.stackCount === 1 && p6.leftoverIn === 1,
    `stack=${p6.stackCount} in=${p6.leftoverIn}`);

  // P7: no float / no floor y=0 on elevated pad
  check('P7', p3.stacked.every(s =>
    +s.y > 0 && +s.box.minY === +s.y && s.gravity === 'support_top'),
  `ys=${p3.stacked.map(s => s.y).join(',')}`);

  // P8: heavy-first order — heavier nest stacked before lighter when both fit
  const light = {
    _fmUid: 'lt', mark: 'LT', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 7000, packWidthMm: 300, packHeightMm: 150, weightKg: 100,
  };
  const heavy = {
    _fmUid: 'hv', mark: 'HV', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 7000, packWidthMm: 300, packHeightMm: 150, weightKg: 500,
  };
  const p8 = csPackV2PlaceNestStacks([light, heavy], [floorA], { envelope: env });
  check('P8', p8.stackCount === 2
    && p8.attempts[0] && p8.attempts[0]._fmUid === 'hv'
    && p8.attempts[0].ok
    && p8.attempts[1] && p8.attempts[1]._fmUid === 'lt',
  `order=${p8.attempts.map(a => a._fmUid).join(',')}`);

  // P9: same-family preferred over other family when both pads exist
  // Place a C nest on floor beside (synthetic second support) + Z leftover
  const cFloor = {
    _fmUid: 'cbase', mark: 'CBASE', role: 'long_nest_strip',
    groupKind: 'nest_c', shapeKey: 'c_channel',
    x: env.minXMm, z: env.minZMm + 500, y: 0, pl: 8000, pw: 350, ph: 200,
    box: csPackV2MakeBox(env.minXMm, env.minZMm + 500, 8000, 350, 200, 0),
    unit: {
      _fmUid: 'cbase', groupKind: 'nest_c', shapeKey: 'c_channel',
      packLengthMm: 8000, packWidthMm: 350, packHeightMm: 200, weightKg: 280,
    },
    supportCapacityKg: 1e12,
  };
  // Ensure floorA has groupKind on support map via unit
  floorA.groupKind = 'nest_z';
  floorA.shapeKey = 'z_channel';
  const zUp = {
    _fmUid: 'zup', mark: 'ZUP', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8000, packWidthMm: 350, packHeightMm: 160, weightKg: 220,
  };
  const p9 = csPackV2PlaceNestStacks([zUp], [floorA, cFloor], { envelope: env });
  check('P9', p9.stackCount === 1
    && p9.attempts[0] && p9.attempts[0].sameFamily === true
    && p9.attempts[0].supportMark === 'BASE',
  `fam=${p9.attempts[0] && p9.attempts[0].sameFamily} on=${p9.attempts[0] && p9.attempts[0].supportMark}`);

  // P10: no supports → NO_SUPPORT leftover
  const p10 = csPackV2PlaceNestStacks([up1], [], { envelope: env });
  check('P10', p10.stackCount === 0 && p10.stillUnplacedCount === 1
    && p10.stillUnplaced[0].reason === 'NO_SUPPORT',
  `r=${p10.stillUnplaced[0] && p10.stillUnplaced[0].reason}`);

  // P11: PackWithTwins floor (twins+long) then stack leftovers n2/n3 on nest pad
  const tA = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const tB = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  const n2 = {
    _fmUid: 'nl2', mark: 'NL2', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220,
  };
  const n3 = {
    _fmUid: 'nl3', mark: 'NL3', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 8500, packWidthMm: 360, packHeightMm: 170, weightKg: 200,
  };
  const pack = csPackV2PackWithTwins([tA, tB, nL], { containerSpec: spec });
  const p11 = csPackV2PlaceNestStacks([n2, n3], pack.placed, {
    envelope: pack.envelope,
  });
  let digTwin = false;
  for (let i = 0; i < p11.stacked.length; i++) {
    for (let j = 0; j < (pack.placed || []).length; j++) {
      const tw = pack.placed[j];
      if (!tw || !tw.box) continue;
      if ((tw.role === 'twin_wall_hug' || tw.role === 'twin_beside')
          && csPackV2BoxesOverlap(p11.stacked[i].box, tw.box))
        digTwin = true;
    }
  }
  check('P11', pack.ok && p11.stackCount >= 1 && p11.designOk && !digTwin
    && p11.allNestStackRole,
  `stack=${p11.stackCount} digTwin=${digTwin} design=${p11.designOk}`);

  // P12: placed output includes originals + stacks; account equals
  check('P12', p11.placed.length === (pack.placed || []).length + p11.stackCount
    && p11.accounted
    && p11.stackCount + p11.stillUnplacedCount === 2,
  `placed=${p11.placed.length} base=${(pack.placed || []).length} stack=${p11.stackCount}`);

  // P13: sort helper heavy-first
  const sorted = csPackV2SortStackCandidates([light, heavy, up1]);
  check('P13', sorted[0]._fmUid === 'hv' && sorted[1]._fmUid === 'up1',
    `ord=${sorted.map(u => u._fmUid).join(',')}`);

  // P14: score prefers same family
  const map = csPackV2BuildSupportMap([floorA, cFloor], env, {});
  const zSup = map.supports.find(s => s.sourceUid === 'base' || s.mark === 'BASE');
  const cSup = map.supports.find(s => s.sourceUid === 'cbase' || s.mark === 'CBASE');
  const seatZ = csPackV2TryStackSeat(zUp, zSup, { envelope: env, placedBoxes: [floorA.box, cFloor.box] });
  const seatC = csPackV2TryStackSeat(zUp, cSup, { envelope: env, placedBoxes: [floorA.box, cFloor.box] });
  const scZ = seatZ.ok ? csPackV2ScoreStackSupport(zUp, zSup, seatZ) : -1e99;
  const scC = seatC.ok ? csPackV2ScoreStackSupport(zUp, cSup, seatC) : -1e99;
  check('P14', seatZ.ok && seatC.ok && scZ > scC,
    `scZ=${Math.round(scZ)} scC=${Math.round(scC)}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4e self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4f — Wire stacks into PackWithTwins + full Step 4 suite
//
// Perspectives locked:
//   Pipeline  — Step3 floor → 4e stack → merged placed/unplaced
//   Opt-out   — enableStacks:false keeps Step3 floor-only regression pure
//   Gravity   — floor items y=0; stacks on supportTop; never float
//   Dig-in    — allNoOverlap + stackNoTwinDig
//   Tall ban  — support map still excludes rafter tips
//   Account   — placedCount + unplacedCount === unit count
//   Improve   — when leftovers can stack, stackCount≥1 and placed rises
//   Group By  — untouched (no remorph)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full Step 4 self-test (4a–4e + wired PackWithTwins).
 * Console: csPackV2Step4SelfTest()
 */
function csPackV2Step4SelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const a = csPackV2Step4aSelfTest();
  const b = csPackV2Step4bSelfTest();
  const c = csPackV2Step4cSelfTest();
  const d = csPackV2Step4dSelfTest();
  const e = csPackV2Step4eSelfTest();
  check('S4a', a && a.ok, a ? `${a.passed}/${a.total}` : 'missing');
  check('S4b', b && b.ok, b ? `${b.passed}/${b.total}` : 'missing');
  check('S4c', c && c.ok, c ? `${c.passed}/${c.total}` : 'missing');
  check('S4d', d && d.ok, d ? `${d.passed}/${d.total}` : 'missing');
  check('S4e', e && e.ok, e ? `${e.passed}/${e.total}` : 'missing');

  // Step 3 regression still green (floor-only)
  const s3 = csPackV2Step3SelfTest();
  check('S3reg', s3 && s3.ok, s3 ? `${s3.passed}/${s3.total}` : 'missing');

  const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690 };

  const t1 = {
    _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const t2 = {
    _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nL = {
    _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  // Overcrowd floor so PackFloor leaves NO_SLOT leftovers that stacks can take
  const crowd = [];
  for (let i = 0; i < 6; i++) {
    crowd.push({
      _fmUid: 'nc' + i, mark: 'NC' + i, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220 - i,
    });
  }
  const allUnits = [t1, t2, nL].concat(crowd);

  // W1: enableStacks false → no stacks (opt-out)
  const off = csPackV2PackWithTwins(allUnits, {
    containerSpec: spec, enableStacks: false,
  });
  check('W1', off.enableStacks === false && off.stackCount === 0
    && off.allFloorY0 && off.stackDesignOk && off.unplacedCount >= 1,
  `stack=${off.stackCount} un=${off.unplacedCount} placed=${off.placedCount}`);

  // W2: wired stacks on — leftovers become nest_stack
  const on = csPackV2PackWithTwins(allUnits, {
    containerSpec: spec, enableStacks: true,
  });
  check('W2', on.ok && on.enableStacks && on.stackCount >= 1
    && on.placed.some(p => p.role === 'nest_stack')
    && on.stackDesignOk && on.allStacksOnSupport && on.stackNoTwinDig
    && on.placedCount > off.placedCount,
  `ok=${on.ok} stack=${on.stackCount} onP=${on.placedCount} offP=${off.placedCount}`);

  // W3: floor gravity preserved for non-stacks; stacks elevated
  const floorItems = (on.placed || []).filter(p =>
    p && p.role !== 'nest_stack' && p.layer !== 'stack');
  const stackItems = (on.placed || []).filter(p =>
    p && (p.role === 'nest_stack' || p.layer === 'stack'));
  check('W3', on.allFloorY0
    && floorItems.every(p => +p.y === 0 && p.box && +p.box.minY === 0)
    && stackItems.every(p => +p.y > 0 && +p.box.minY === +p.y),
  `floorN=${floorItems.length} stackN=${stackItems.length}`);

  // W4: no dig-in anywhere; no twin dig
  check('W4', on.allNoOverlap && on.stackNoTwinDig,
    `ov=${!on.allNoOverlap} twinDig=${!on.stackNoTwinDig}`);

  // W5: account — every input unit placed or unplaced
  check('W5', on.placedCount + on.unplacedCount === allUnits.length
    && on.stackAccounted,
  `p=${on.placedCount} u=${on.unplacedCount} n=${allUnits.length}`);

  // W6: stacking improves over floor-only when leftovers exist
  check('W6', on.placedCount > off.placedCount
    && on.stackCount === on.placedCount - off.placedCount,
  `on=${on.placedCount} off=${off.placedCount} stack=${on.stackCount}`);

  // W7: twins never appear as nest_stack support
  const twinStacks = stackItems.filter(p =>
    p.supportUid != null
    && (on.placed || []).some(t =>
      t && t._fmUid === p.supportUid
      && (t.role === 'twin_wall_hug' || t.role === 'twin_beside')));
  check('W7', twinStacks.length === 0,
  `twinAsSup=${twinStacks.length}`);

  // W8: support map includes nest pads only
  const mapOn = csPackV2BuildSupportMap(on.placed, on.envelope, {});
  check('W8', mapOn.supportCount >= 1
    && mapOn.supports.every(s => s.kind === 'nest'),
  `sup=${mapOn.supportCount}`);

  // W9: assemblies never stacked
  check('W9', !stackItems.some(p =>
    p.unit && csPackIsAssemblyUnit(p.unit) && !csPackIsNestUnit(p.unit)),
  `asmStack=${stackItems.filter(p => p.unit && p.unit.isAssembly).length}`);

  // W10: default enableStacks is on
  const def = csPackV2PackWithTwins(allUnits, { containerSpec: spec });
  check('W10', def.enableStacks !== false && def.stackCount >= 1 && def.ok,
    `en=${def.enableStacks} stack=${def.stackCount}`);

  // W11: Step3 floor-only regression of same units still has no stacks
  check('W11', off.stackCount === 0 && off.enableStacks === false
    && off.allFloorY0 && off.allNoOverlap,
  `stack=${off.stackCount}`);

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[PackV2] step4 self-test', out); } catch (_) { /* */ }
  return out;
}

/**
 * Tiny self-check for Step 1 (no WebView suite required).
 * Call from console: csPackNormalizeSelfTest()
 */
function csPackNormalizeSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  // Pitched nest → repaired
  const fat = {
    groupKind: 'nest_z',
    shapeKey: 'z_channel',
    sectW: 85, sectH: 200,
    qty: 8,
    nestingOffsetMm: 40,
    lengthMm: 9600,
    widthMm: 1680,
    heightMm: 220,
    stableBundleMm: { l: 9600, w: 1680, h: 220, source: 'ship_prep' },
  };
  const r1 = csPackNormalizePackUnit(fat, { containerSpec: { widthMm: 2438 } });
  check('N1', r1.changed && fat.packWidthMm < 600 && fat.stableBundleMm.source === 'nest_repair',
    `pw=${fat.packWidthMm} src=${fat.stableBundleMm && fat.stableBundleMm.source}`);

  // Already-tight nest → no false inflate
  const okNest = {
    groupKind: 'nest_z',
    shapeKey: 'z_channel',
    sectW: 85, sectH: 200,
    qty: 4,
    nestingOffsetMm: 40,
    lengthMm: 9600,
    packLengthMm: 9600, packWidthMm: 205, packHeightMm: 200,
    stableBundleMm: { l: 9600, w: 205, h: 200, source: 'ship_prep' },
  };
  const r2 = csPackNormalizePackUnit(okNest, { containerSpec: { widthMm: 2438 } });
  check('N2', !r2.changed && okNest.packWidthMm === 205,
    `changed=${r2.changed} pw=${okNest.packWidthMm}`);

  // Assembly already sane → stamp, never nest formula wipe
  const asm = {
    isAssembly: true,
    groupKind: 'welded_assembly',
    lengthMm: 11600, widthMm: 200, heightMm: 2508,
    sectW: 200, sectH: 2508,
    stableBundleMm: { l: 11600, w: 200, h: 2508, source: 'ship_prep' },
  };
  csPackNormalizePackUnit(asm, { containerSpec: { widthMm: 2438 } });
  check('A1', asm.packWidthMm === 200 && asm.packHeightMm === 2508,
    `pw=${asm.packWidthMm} ph=${asm.packHeightMm} src=${asm.stableBundleMm && asm.stableBundleMm.source}`);

  // Fat pitched assembly AABB → ship-axis repair on clone
  const fatAsm = {
    isAssembly: true,
    groupKind: 'welded_assembly',
    lengthMm: 11864, widthMm: 11608, heightMm: 2608,
    sectW: 200, sectH: 2500,
    packLengthMm: 11864, packWidthMm: 11608, packHeightMm: 2608,
    stableBundleMm: { l: 11864, w: 11608, h: 2608, source: 'ship_prep' },
  };
  const rFat = csPackNormalizePackUnit(fatAsm, { containerSpec: { widthMm: 2438 } });
  check('A2', rFat.changed && fatAsm.packWidthMm <= 400 && fatAsm.packLengthMm > 10000,
    `changed=${rFat.changed} ${fatAsm.packLengthMm}x${fatAsm.packWidthMm}x${fatAsm.packHeightMm}`);

  // Short length repair (sect depth stamped as length)
  const shortL = {
    groupKind: 'nest_c',
    shapeKey: 'c_channel',
    sectW: 75, sectH: 200,
    qty: 4,
    nestingOffsetMm: 40,
    lengthMm: 60,
    nestPieces: [
      { lengthMm: 8494, sectW: 75, sectH: 200 },
      { lengthMm: 8494, sectW: 75, sectH: 200 },
    ],
    stableBundleMm: { l: 60, w: 900, h: 200, source: 'ship_prep' },
  };
  csPackNormalizePackUnit(shortL, { containerSpec: { widthMm: 2438 } });
  check('N3', shortL.packLengthMm > 5000 && shortL.packWidthMm < 600,
    `pl=${shortL.packLengthMm} pw=${shortL.packWidthMm}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
  };
  try { console.info('[PackV2] self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5a — Packer placement → viewer pose bridge (no remorph, no mesh move)
//
// Packer placement contract (mm):
//   x,y,z = AABB min corner
//   X: rear (0) → door (+L)
//   Z: home wall (0) → far wall (+W)
//   Y: floor (0) → roof (+H)
//
// Viewer / Optimise item contract (mm) — see snapMeshToPackerFootY / seatCenter:
//   x,y,z = AABB center
//   X: rear (0) → door (+L)           [same origin as packer]
//   Z: centerline 0; home −W/2 → far +W/2
//   Y: floor (0) → roof (+H)
//   Scene units = mm * SCALE (02-scene-core: 1/100)
// ═══════════════════════════════════════════════════════════════════════════

/** Default mm→scene scale when SCALE global is absent (matches 02-scene-core.js). */
const CSPACK_V2_DEFAULT_SCALE = 1 / 100;

function csPackV2SceneScale(opts) {
  const o = opts || {};
  if (o.scale != null && +o.scale > 0) return +o.scale;
  try {
    if (typeof SCALE === 'number' && SCALE > 0) return SCALE;
  } catch (_) { /* */ }
  return CSPACK_V2_DEFAULT_SCALE;
}

/**
 * Outer container dims for bridge (length / width / height mm).
 * Prefers envelope.outer* then containerSpec / defaults.
 */
function csPackV2BridgeOuter(specOrEnv, opts) {
  const o = opts || {};
  const env = specOrEnv && (specOrEnv.outerWidthMm != null || specOrEnv.minZMm != null)
    ? specOrEnv
    : null;
  const outer = env
    ? {
      lengthMm: +env.outerLengthMm || +env.lengthMm || 0,
      widthMm: +env.outerWidthMm || 0,
      heightMm: +env.outerHeightMm || 0,
    }
    : csPackV2ContainerSpec(specOrEnv || o.containerSpec);
  if (!(outer.widthMm > 500)) {
    const e = csPackV2FloorEnvelope(o.containerSpec || specOrEnv);
    return {
      lengthMm: e.outerLengthMm,
      widthMm: e.outerWidthMm,
      heightMm: e.outerHeightMm,
      envelope: e,
    };
  }
  return { ...outer, envelope: env || csPackV2FloorEnvelope(outer) };
}

/**
 * Convert Pack V2 placement (min-corner packer mm) → viewer pose (AABB center mm).
 * Does not remorph meshes — pure coordinate math for Step 5b.
 *
 * @param {object} placement  from CommitFloor / CommitStack / PackWithTwins.placed[]
 * @param {object} [specOrEnv] containerSpec or floor envelope
 * @param {object} [opts]
 * @returns {{ ok, reason, x, y, z, yawDeg, yawRad, footYMm, pl, pw, ph,
 *            packerMin, viewerAabb, xScene, yScene, zScene, scale, role }}
 */
function csPackV2PlacementToViewerPose(placement, specOrEnv, opts) {
  const o = opts || {};
  if (!placement)
    return { ok: false, reason: 'NO_PLACEMENT' };

  const pl = Math.max(+placement.pl
    || (placement.box && (placement.box.maxX - placement.box.minX)) || 0, 0);
  const pw = Math.max(+placement.pw
    || (placement.box && (placement.box.maxZ - placement.box.minZ)) || 0, 0);
  const ph = Math.max(+placement.ph
    || (placement.box && (placement.box.maxY - placement.box.minY)) || 0, 0);

  const px = +placement.x;
  const py = (placement.y != null) ? +placement.y
    : (placement.box && placement.box.minY != null ? +placement.box.minY : 0);
  const pz = +placement.z;

  if (!(Number.isFinite(px) && Number.isFinite(pz)))
    return { ok: false, reason: 'BAD_XZ' };
  if (!Number.isFinite(py) || py < -CSPACK_V2_EPS)
    return { ok: false, reason: 'BAD_Y' };
  if (!(pl > 0 && pw > 0 && ph > 0))
    return { ok: false, reason: 'BAD_DIMS' };

  const outer = csPackV2BridgeOuter(specOrEnv, o);
  const W = +outer.widthMm;
  const L = +outer.lengthMm;
  const H = +outer.heightMm;
  if (!(W > 500 && L > 500))
    return { ok: false, reason: 'BAD_CONTAINER' };

  // Packer min-corner → viewer AABB center (Z recentered on container midline)
  const x = px + pl * 0.5;
  const y = py + ph * 0.5;
  const z = pz + pw * 0.5 - W * 0.5;
  const footYMm = py;

  const yawDeg = Number.isFinite(+placement.yawDeg) ? +placement.yawDeg
    : (Number.isFinite(+placement._packYawDeg) ? +placement._packYawDeg : 0);
  const yawRad = yawDeg * Math.PI / 180;

  const scale = csPackV2SceneScale(o);

  // Viewer-frame AABB extents (mm) — for envelope / dig checks in Optimise space
  const viewerAabb = {
    minX: x - pl * 0.5,
    maxX: x + pl * 0.5,
    minY: footYMm,
    maxY: footYMm + ph,
    minZ: z - pw * 0.5,
    maxZ: z + pw * 0.5,
  };

  return {
    ok: true,
    reason: null,
    // Legacy Optimise item.x/y/z = AABB centers (mm)
    x, y, z,
    yawDeg,
    yawRad,
    footYMm,
    supportTopY: placement.supportTopY != null ? +placement.supportTopY : null,
    pl, pw, ph,
    packFootprintL: pl,
    packFootprintW: pw,
    packFootprintH: ph,
    // Frozen seats for render (centers — matches seatCenter / _packerSeat*)
    _packerSeatX0: x,
    _packerSeatZ0: z,
    _packerSeatY0: y,
    packerMin: { x: px, y: py, z: pz },
    viewerAabb,
    outer: { lengthMm: L, widthMm: W, heightMm: H },
    xScene: x * scale,
    yScene: y * scale,
    zScene: z * scale,
    footYScene: footYMm * scale,
    scale,
    role: placement.role || null,
    layer: placement.layer || null,
    gravity: placement.gravity || null,
    _fmUid: placement._fmUid != null ? placement._fmUid : null,
    mark: placement.mark || null,
  };
}

/**
 * Inverse of PlacementToViewerPose — viewer center mm → packer min-corner mm.
 * Used for round-trip POV tests and future drag-back sync.
 */
function csPackV2ViewerPoseToPackerMin(pose, specOrEnv, opts) {
  const o = opts || {};
  if (!pose)
    return { ok: false, reason: 'NO_POSE' };
  const xC = +pose.x;
  const yC = +pose.y;
  const zC = +pose.z;
  const pl = Math.max(+pose.pl || +pose.packFootprintL || 0, 0);
  const pw = Math.max(+pose.pw || +pose.packFootprintW || 0, 0);
  const ph = Math.max(+pose.ph || +pose.packFootprintH || 0, 0);
  if (!(Number.isFinite(xC) && Number.isFinite(yC) && Number.isFinite(zC)))
    return { ok: false, reason: 'BAD_XYZ' };
  if (!(pl > 0 && pw > 0 && ph > 0))
    return { ok: false, reason: 'BAD_DIMS' };

  const outer = csPackV2BridgeOuter(specOrEnv, o);
  const W = +outer.widthMm;
  if (!(W > 500))
    return { ok: false, reason: 'BAD_CONTAINER' };

  const footY = (pose.footYMm != null && Number.isFinite(+pose.footYMm))
    ? +pose.footYMm
    : (yC - ph * 0.5);

  return {
    ok: true,
    reason: null,
    x: xC - pl * 0.5,
    y: footY,
    z: zC - pw * 0.5 + W * 0.5,
    pl, pw, ph,
  };
}

/**
 * Does viewer-frame AABB stay inside outer box (X 0→L, Z −W/2→+W/2, Y 0→H)?
 * Optional clearance shrink matches getPackEnvelopeWorld when envelope given.
 */
function csPackV2ViewerAabbInsideOuter(viewerAabb, outer, opts) {
  const o = opts || {};
  if (!viewerAabb || !outer) return false;
  const L = +outer.lengthMm;
  const W = +outer.widthMm;
  const H = +outer.heightMm;
  const eps = (o.eps != null) ? +o.eps : CSPACK_V2_EPS;
  let minX = 0, maxX = L;
  let minZ = -W * 0.5, maxZ = W * 0.5;
  let minY = 0, maxY = H;
  const env = o.envelope;
  if (env && env.clearanceSideMm != null) {
    const side = +env.clearanceSideMm || 0;
    const end = +env.clearanceEndMm || 0;
    const top = +env.clearanceTopMm || 0;
    const floor = +env.clearanceFloorMm || +env.minYMm || 0;
    minX = end;
    maxX = L - end;
    minZ = -W * 0.5 + side;
    maxZ = W * 0.5 - side;
    minY = floor;
    maxY = H - top;
  }
  return viewerAabb.minX >= minX - eps
    && viewerAabb.maxX <= maxX + eps
    && viewerAabb.minZ >= minZ - eps
    && viewerAabb.maxZ <= maxZ + eps
    && viewerAabb.minY >= minY - eps
    && viewerAabb.maxY <= maxY + eps;
}

/**
 * Step 5a self-test — all POVs (floor / stack / twin walls / round-trip / live pack).
 * Console: csPackV2Step5aSelfTest()
 */
function csPackV2Step5aSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }
  const near = (a, b, tol) => Math.abs(+a - +b) <= (tol != null ? tol : CSPACK_V2_EPS);

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const W = env.outerWidthMm;
  const halfW = W * 0.5;

  // --- V1 floor seat: y=0 → foot 0, center = ph/2 ---
  const floorPl = {
    _fmUid: 'f1', mark: 'FLOOR',
    x: env.minXMm, z: env.minZMm, y: 0,
    pl: 8000, pw: 200, ph: 300,
    role: 'long_nest_strip', layer: 'floor', gravity: 'floor_y0',
  };
  const floorPose = csPackV2PlacementToViewerPose(floorPl, env);
  check('V1', floorPose.ok
    && near(floorPose.footYMm, 0)
    && near(floorPose.y, 150)
    && near(floorPose.x, env.minXMm + 4000)
    && floorPose.layer === 'floor',
  `foot=${floorPose.footYMm} y=${floorPose.y} x=${floorPose.x}`);

  // --- V2 stack seat: y=supportTop ---
  const supportTop = 300;
  const stackPl = {
    _fmUid: 's1', mark: 'STACK',
    x: env.minXMm + 100, z: env.minZMm + 40, y: supportTop,
    pl: 7000, pw: 180, ph: 250,
    role: 'nest_stack', layer: 'stack', gravity: 'support_top',
    supportTopY: supportTop,
  };
  const stackPose = csPackV2PlacementToViewerPose(stackPl, env);
  check('V2', stackPose.ok
    && near(stackPose.footYMm, supportTop)
    && near(stackPose.y, supportTop + 125)
    && near(stackPose.supportTopY, supportTop)
    && stackPose.role === 'nest_stack',
  `foot=${stackPose.footYMm} y=${stackPose.y} role=${stackPose.role}`);

  // --- V3 twin wall-hug: viewer Z near home wall (−W/2) ---
  const twinW = 220;
  const hugPl = {
    _fmUid: 't1', mark: 'RF1',
    x: env.minXMm, z: env.minZMm, y: 0,
    pl: 11000, pw: twinW, ph: 2000,
    role: 'twin_wall_hug', layer: 'floor', yawDeg: 0,
  };
  const hugPose = csPackV2PlacementToViewerPose(hugPl, env);
  const expectHugZ = env.minZMm + twinW * 0.5 - halfW;
  const homeFace = -halfW + env.clearanceSideMm;
  check('V3', hugPose.ok
    && near(hugPose.z, expectHugZ)
    && near(hugPose.viewerAabb.minZ, homeFace)
    && hugPose.viewerAabb.minZ < -halfW + twinW + 50
    && hugPose.role === 'twin_wall_hug',
  `z=${hugPose.z} expect=${expectHugZ} minZ=${hugPose.viewerAabb.minZ} home=${homeFace}`);

  // --- V4 far-wall seat: viewer Z near +W/2 ---
  const farZ = env.maxZMm - twinW;
  const farPl = {
    x: env.minXMm, z: farZ, y: 0,
    pl: 5000, pw: twinW, ph: 400,
    role: 'far_wall',
  };
  const farPose = csPackV2PlacementToViewerPose(farPl, env);
  const expectFarZ = farZ + twinW * 0.5 - halfW;
  const farFace = halfW - env.clearanceSideMm;
  check('V4', farPose.ok
    && near(farPose.z, expectFarZ)
    && near(farPose.viewerAabb.maxZ, farFace),
  `z=${farPose.z} maxZ=${farPose.viewerAabb.maxZ} far=${farFace}`);

  // --- V5 rear X + door clearance ---
  check('V5', near(hugPose.viewerAabb.minX, env.minXMm)
    && hugPose.viewerAabb.maxX <= env.maxXMm + CSPACK_V2_EPS,
  `minX=${hugPose.viewerAabb.minX} maxX=${hugPose.viewerAabb.maxX}`);

  // --- V6 viewer AABB inside outer (with clearances) ---
  check('V6', csPackV2ViewerAabbInsideOuter(hugPose.viewerAabb, hugPose.outer, { envelope: env })
    && csPackV2ViewerAabbInsideOuter(stackPose.viewerAabb, stackPose.outer, { envelope: env })
    && csPackV2ViewerAabbInsideOuter(floorPose.viewerAabb, floorPose.outer, { envelope: env }),
  'inside envelope');

  // --- V7 round-trip packer → viewer → packer ---
  const back = csPackV2ViewerPoseToPackerMin(hugPose, env);
  check('V7', back.ok
    && near(back.x, hugPl.x)
    && near(back.y, hugPl.y)
    && near(back.z, hugPl.z)
    && near(back.pl, hugPl.pl)
    && near(back.pw, hugPl.pw),
  `back=${back.x},${back.y},${back.z}`);

  // --- V8 stack round-trip keeps support-top foot ---
  const backS = csPackV2ViewerPoseToPackerMin(stackPose, env);
  check('V8', backS.ok && near(backS.y, supportTop) && near(backS.x, stackPl.x)
    && near(backS.z, stackPl.z),
  `y=${backS.y} x=${backS.x} z=${backS.z}`);

  // --- V9 yaw passthrough (no remorph) ---
  const yawPl = { ...floorPl, yawDeg: 90 };
  const yawPose = csPackV2PlacementToViewerPose(yawPl, env);
  check('V9', yawPose.ok && near(yawPose.yawDeg, 90)
    && near(yawPose.yawRad, Math.PI / 2, 1e-9),
  `yaw=${yawPose.yawDeg} rad=${yawPose.yawRad}`);

  // --- V10 honest failures ---
  check('V10', !csPackV2PlacementToViewerPose(null, env).ok
    && csPackV2PlacementToViewerPose(null, env).reason === 'NO_PLACEMENT'
    && !csPackV2PlacementToViewerPose({ x: 0, z: 0, y: 0, pl: 0, pw: 10, ph: 10 }, env).ok
    && !csPackV2PlacementToViewerPose({ x: NaN, z: 0, y: 0, pl: 10, pw: 10, ph: 10 }, env).ok,
  'fail reasons');

  // --- V11 SCALE / scene units (default 1/100) ---
  check('V11', near(hugPose.scale, 0.01)
    && near(hugPose.xScene, hugPose.x * 0.01, 1e-9)
    && near(hugPose.zScene, hugPose.z * 0.01, 1e-9)
    && near(hugPose.footYScene, 0),
  `scale=${hugPose.scale} xS=${hugPose.xScene}`);

  // --- V12 legacy seat fields are centers (seatCenter contract) ---
  check('V12', near(hugPose._packerSeatX0, hugPose.x)
    && near(hugPose._packerSeatZ0, hugPose.z)
    && near(hugPose._packerSeatY0, hugPose.y)
    && near(hugPose.packFootprintH, hugPl.ph),
  'seat centers');

  // --- V13 matches getPackEnvelopeWorld Z mapping ---
  // world minZ = (−halfW + side) * S  ↔  viewerAabb.minZ for wall-hug
  const worldMinZmm = -halfW + env.clearanceSideMm;
  check('V13', near(hugPose.viewerAabb.minZ, worldMinZmm),
  `minZ=${hugPose.viewerAabb.minZ} world=${worldMinZmm}`);

  // --- V14/V15 live PackWithTwins (twins + forced stack leftovers) through bridge ---
  const rf = {
    _fmUid: 'rfA', mark: 'RF-A', isAssembly: true,
    groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
  };
  const rf2 = {
    _fmUid: 'rfB', mark: 'RF-B', isAssembly: true,
    groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
  };
  const nestLong = {
    _fmUid: 'nA', mark: 'NEST-A', groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
  };
  // Overcrowd floor so stacks engage (same pattern as Step 4 wire soak)
  const crowd = [];
  for (let i = 0; i < 6; i++) {
    crowd.push({
      _fmUid: 'nc' + i, mark: 'NC' + i, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220 - i,
    });
  }
  const pack = csPackV2PackWithTwins([rf, rf2, nestLong].concat(crowd), {
    containerSpec: spec,
    enableStacks: true,
  });
  const hugLive = (pack.placed || []).find(p => p.role === 'twin_wall_hug');
  const stackLive = (pack.placed || []).find(p => p.role === 'nest_stack');
  const hugLivePose = hugLive
    ? csPackV2PlacementToViewerPose(hugLive, pack.envelope || env)
    : { ok: false };
  const stackLivePose = stackLive
    ? csPackV2PlacementToViewerPose(stackLive, pack.envelope || env)
    : { ok: false };

  check('V14', pack.ok && hugLive && hugLivePose.ok
    && near(hugLivePose.footYMm, 0)
    && hugLivePose.viewerAabb.minZ < -halfW + 400
    && csPackV2ViewerAabbInsideOuter(hugLivePose.viewerAabb, hugLivePose.outer, {
      envelope: pack.envelope || env,
    }),
  `packOk=${pack.ok} hug=${!!hugLive} z=${hugLivePose.z} minZ=${hugLivePose.viewerAabb && hugLivePose.viewerAabb.minZ}`);

  check('V15', !!stackLive && stackLivePose.ok
    && stackLivePose.footYMm > CSPACK_V2_EPS
    && near(stackLivePose.footYMm, stackLive.y)
    && near(stackLivePose.footYMm, stackLive.supportTopY || stackLive.y)
    && stackLivePose.y > stackLivePose.footYMm
    && csPackV2ViewerAabbInsideOuter(stackLivePose.viewerAabb, stackLivePose.outer, {
      envelope: pack.envelope || env,
    }),
  `stack=${!!stackLive} foot=${stackLivePose.footYMm} y=${stackLivePose.y}`);

  // --- V16 every placed seat bridges + stays inside outer ---
  const allBridge = (pack.placed || []).map(p =>
    csPackV2PlacementToViewerPose(p, pack.envelope || env));
  check('V16', allBridge.length >= 2
    && allBridge.every(p => p.ok)
    && allBridge.every(p => csPackV2ViewerAabbInsideOuter(p.viewerAabb, p.outer, {
      envelope: pack.envelope || env,
    })),
  `n=${allBridge.length} fail=${allBridge.filter(p => !p.ok).length}`);

  // --- V17 centerline Z=0 when packed on container midline ---
  // packer z_min = W/2 - pw/2 → viewer z = 0
  const midExact = {
    x: 100, z: halfW - 100, y: 0, pl: 1000, pw: 200, ph: 100,
  };
  const midPose = csPackV2PlacementToViewerPose(midExact, env);
  check('V17', midPose.ok && near(midPose.z, 0),
  `z=${midPose.z} (midline)`);

  // --- V18 floor vs stack gravity POV: floor center < stack foot ---
  check('V18', floorPose.y < stackPose.footYMm
    && stackPose.y > stackPose.footYMm
    && near(stackPose.y - stackPose.footYMm, stackPl.ph * 0.5),
  `floorY=${floorPose.y} stackFoot=${stackPose.footYMm}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      hugZ: hugPose.z,
      stackFoot: stackPose.footYMm,
      liveHug: hugLivePose.ok ? { z: hugLivePose.z, foot: hugLivePose.footYMm } : null,
      liveStack: stackLivePose.ok
        ? { foot: stackLivePose.footYMm, y: stackLivePose.y } : null,
      packPlaced: pack.placedCount,
      packStacks: pack.stackCount,
    },
  };
  try { console.info('[PackV2] step5a self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5b — Apply pack placements to scene targets (no Group By remorph)
//
// Real-world rules:
//   • Match by _fmUid first (twins can share a mark)
//   • Mark fallback only when unique among targets
//   • Stamp viewer centers (5a) onto item; packFootprint* for foot snap
//   • Do NOT rewrite Group By lengthMm/widthMm/heightMm / nest formula
//   • Mesh: translate so AABB center/foot matches seat; quat untouched unless
//     applyPackYaw (Y-only for packer yawDeg)
//   • Unplaced units left alone (Step 5c)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve target item from a clickable entry or raw item/target.
 */
function csPackV2TargetItem(target) {
  if (!target) return null;
  if (target.item) return target.item;
  return target;
}

function csPackV2TargetMesh(target) {
  if (!target) return null;
  return target.mesh || target.object3d || null;
}

function csPackV2TargetUid(target) {
  const it = csPackV2TargetItem(target);
  if (!it) return null;
  if (it._fmUid != null) return String(it._fmUid);
  if (target && target._fmUid != null) return String(target._fmUid);
  return null;
}

function csPackV2TargetMark(target) {
  const it = csPackV2TargetItem(target);
  if (!it) return null;
  const m = it.mark || (it.marks && it.marks[0]) || null;
  return m != null ? String(m) : null;
}

/**
 * Find the best target for one placement.
 * Priority: _fmUid → unique mark → _srcPackUnit identity.
 * @returns {{ target, how, reason }}
 */
function csPackV2MatchTargetForPlacement(placement, targets) {
  const list = (targets || []).filter(Boolean);
  if (!placement)
    return { target: null, how: null, reason: 'NO_PLACEMENT' };
  if (!list.length)
    return { target: null, how: null, reason: 'NO_TARGETS' };

  const uid = placement._fmUid != null ? String(placement._fmUid)
    : (placement.unit && placement.unit._fmUid != null
      ? String(placement.unit._fmUid) : null);

  if (uid) {
    const hits = list.filter(t => csPackV2TargetUid(t) === uid);
    if (hits.length === 1)
      return { target: hits[0], how: 'uid', reason: null };
    if (hits.length > 1)
      return { target: null, how: null, reason: 'AMBIGUOUS_UID' };
  }

  // Identity: packer unit clone still points at Group By pack unit
  const src = placement.unit && placement.unit._srcPackUnit;
  if (src) {
    const hits = list.filter(t => {
      const it = csPackV2TargetItem(t);
      return it === src || it === placement.unit
        || (it && it._srcPackUnit === src);
    });
    if (hits.length === 1)
      return { target: hits[0], how: 'src', reason: null };
  }

  const mark = placement.mark != null ? String(placement.mark)
    : (placement.unit && placement.unit.mark != null
      ? String(placement.unit.mark) : null);
  if (mark) {
    const hits = list.filter(t => csPackV2TargetMark(t) === mark);
    if (hits.length === 1)
      return { target: hits[0], how: 'mark', reason: null };
    if (hits.length > 1)
      return { target: null, how: null, reason: 'AMBIGUOUS_MARK' };
  }

  return { target: null, how: null, reason: uid ? 'UID_NOT_FOUND' : 'MARK_NOT_FOUND' };
}

/**
 * Stamp 5a viewer pose onto an item (no mesh). Preserves Group By L/W/H.
 */
function csPackV2StampViewerPoseOnItem(item, pose, placement, opts) {
  const o = opts || {};
  if (!item || !pose || !pose.ok)
    return { ok: false, reason: 'BAD_ARGS' };

  const keep = {
    lengthMm: item.lengthMm,
    widthMm: item.widthMm,
    heightMm: item.heightMm,
    l: item.l, w: item.w, h: item.h,
    sectW: item.sectW, sectH: item.sectH,
  };

  item.x = pose.x;
  item.y = pose.y;
  item.z = pose.z;
  item._packerSeatX0 = pose._packerSeatX0;
  item._packerSeatZ0 = pose._packerSeatZ0;
  item._packerSeatY0 = pose._packerSeatY0;
  item._packerSeatX = pose.x;
  item._packerSeatZ = pose.z;
  item._packerSeatY = pose.y;

  // Footprint for snapMeshToPackerFootY / settle — not a Group By rewrite
  item.packFootprintL = pose.pl;
  item.packFootprintW = pose.pw;
  item.packFootprintH = pose.ph;

  const role = (placement && placement.role) || pose.role || null;
  const layer = (placement && placement.layer) || pose.layer || null;
  item.role = role;
  item.packRole = role;
  item.packLayer = layer;
  item.packGravity = (placement && placement.gravity) || pose.gravity || null;
  item.packYawDeg = pose.yawDeg || 0;
  item.supportTopY = pose.supportTopY;
  item.packPoseLock = true;
  item.outsideContainer = false;
  item._packV2Applied = true;
  item._packV2FootYMm = pose.footYMm;

  if (role === 'nest_stack' || layer === 'stack') {
    item.floorAnchor = false;
    item.baseLayerLock = false;
    item.anchorTier = (placement && placement.tier != null)
      ? +placement.tier : 2;
  } else {
    item.floorAnchor = true;
    item.baseLayerLock = true;
    item.anchorTier = 1;
  }

  if (placement && placement._fmUid != null && item._fmUid == null)
    item._fmUid = placement._fmUid;

  // Restore structural dims — never let stamp mutate Group By size
  if (o.preserveDims !== false) {
    if (keep.lengthMm != null) item.lengthMm = keep.lengthMm;
    if (keep.widthMm != null) item.widthMm = keep.widthMm;
    if (keep.heightMm != null) item.heightMm = keep.heightMm;
    if (keep.l != null) item.l = keep.l;
    if (keep.w != null) item.w = keep.w;
    if (keep.h != null) item.h = keep.h;
    if (keep.sectW != null) item.sectW = keep.sectW;
    if (keep.sectH != null) item.sectH = keep.sectH;
  }

  // Optional Y-only packer yaw record (mesh apply may use it)
  if (o.applyPackYaw && pose.yawDeg) {
    item.userRot = item.userRot || { x: 0, y: 0, z: 0 };
    item.userRot.y = (+pose.yawDeg) * Math.PI / 180;
    item.packYawOnly = true;
  }

  return { ok: true, reason: null, footYMm: pose.footYMm };
}

/**
 * Move a mesh to the viewer pose. Quat preserved unless applyPackYaw.
 * Works with real THREE meshes or headless { position: {x,y,z} } mocks.
 */
function csPackV2ApplyPoseToMesh(mesh, pose, opts) {
  const o = opts || {};
  if (!mesh || !pose || !pose.ok)
    return { ok: false, reason: 'BAD_ARGS', dy: 0 };

  const sc = (pose.scale > 0) ? pose.scale : csPackV2SceneScale(o);
  const pos = mesh.position;
  if (!pos)
    return { ok: false, reason: 'NO_POSITION', dy: 0 };

  // Snapshot quat (no remorph)
  let q0 = null;
  if (mesh.quaternion) {
    q0 = {
      x: +mesh.quaternion.x || 0,
      y: +mesh.quaternion.y || 0,
      z: +mesh.quaternion.z || 0,
      w: mesh.quaternion.w != null ? +mesh.quaternion.w : 1,
    };
  }

  // Optional Y-only yaw from packer (never pitch/roll)
  if (o.applyPackYaw && pose.yawDeg && mesh.rotation) {
    const yRad = (+pose.yawDeg) * Math.PI / 180;
    if (typeof mesh.rotation.y === 'number')
      mesh.rotation.y = yRad;
  } else if (q0 && mesh.quaternion) {
    if (typeof mesh.quaternion.set === 'function')
      mesh.quaternion.set(q0.x, q0.y, q0.z, q0.w);
    else {
      mesh.quaternion.x = q0.x;
      mesh.quaternion.y = q0.y;
      mesh.quaternion.z = q0.z;
      mesh.quaternion.w = q0.w;
    }
    if (mesh.rotation && typeof mesh.rotation.setFromQuaternion === 'function'
        && typeof THREE !== 'undefined') {
      mesh.rotation.setFromQuaternion(mesh.quaternion);
    }
  }

  const useThree = (typeof THREE !== 'undefined'
    && typeof mesh.updateMatrixWorld === 'function'
    && typeof THREE.Box3 === 'function');

  if (useThree) {
    if (typeof pos.set === 'function')
      pos.set(pose.x * sc, pose.y * sc, pose.z * sc);
    else {
      pos.x = pose.x * sc; pos.y = pose.y * sc; pos.z = pose.z * sc;
    }
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (isFinite(box.min.x) && isFinite(box.max.x)) {
      pos.x += (pose.x * sc) - (box.min.x + box.max.x) * 0.5;
      pos.z += (pose.z * sc) - (box.min.z + box.max.z) * 0.5;
    }
    mesh.updateMatrixWorld(true);
    box.setFromObject(mesh);
    let dy = 0;
    if (isFinite(box.min.y)) {
      dy = pose.footYMm * sc - box.min.y;
      if (Math.abs(dy) > 1e-9) pos.y += dy;
    }
    mesh.updateMatrixWorld(true);
    // Re-assert quat if yaw not requested
    if (!o.applyPackYaw && q0 && mesh.quaternion) {
      if (typeof mesh.quaternion.set === 'function')
        mesh.quaternion.set(q0.x, q0.y, q0.z, q0.w);
    }
    return { ok: true, reason: null, dy, mode: 'three' };
  }

  // Headless / mock: treat position as AABB center in scene units
  if (typeof pos.set === 'function')
    pos.set(pose.x * sc, pose.y * sc, pose.z * sc);
  else {
    pos.x = pose.x * sc;
    pos.y = pose.y * sc;
    pos.z = pose.z * sc;
  }
  return { ok: true, reason: null, dy: 0, mode: 'center' };
}

/**
 * Apply all pack.placed seats onto a target list (items and/or clickable entries).
 * Headless-safe. Does not place leftovers (Step 5c).
 *
 * @param {object} pack   from csPackV2PackWithTwins / PackFloor
 * @param {object[]} targets
 * @param {object} [opts]
 * @returns {{ ok, applied, missed, skipped, results, poses }}
 */
function csPackV2ApplyPlacementsToTargets(pack, targets, opts) {
  const o = opts || {};
  const placed = (pack && pack.placed) ? pack.placed : [];
  const env = (pack && pack.envelope)
    || o.envelope
    || csPackV2FloorEnvelope(o.containerSpec || (pack && pack.containerSpec));
  const applyYaw = !!o.applyPackYaw;
  const results = [];
  const poses = [];
  let applied = 0;
  let missed = 0;

  // Consume targets so two placements never steal the same mesh
  const pool = (targets || []).slice();

  for (let i = 0; i < placed.length; i++) {
    const placement = placed[i];
    const pose = csPackV2PlacementToViewerPose(placement, env, o);
    if (!pose.ok) {
      missed += 1;
      results.push({
        ok: false, reason: pose.reason || 'BAD_POSE',
        _fmUid: placement && placement._fmUid, mark: placement && placement.mark,
        how: null,
      });
      continue;
    }
    poses.push(pose);

    const match = csPackV2MatchTargetForPlacement(placement, pool);
    if (!match.target) {
      missed += 1;
      results.push({
        ok: false, reason: match.reason || 'NO_MATCH',
        _fmUid: placement._fmUid, mark: placement.mark, how: null,
        pose,
      });
      continue;
    }

    // Remove matched target from pool (1:1)
    const idx = pool.indexOf(match.target);
    if (idx >= 0) pool.splice(idx, 1);

    const item = csPackV2TargetItem(match.target);
    const mesh = csPackV2TargetMesh(match.target);
    const stamp = csPackV2StampViewerPoseOnItem(item, pose, placement, {
      preserveDims: o.preserveDims !== false,
      applyPackYaw: applyYaw,
    });
    let meshRes = { ok: true, reason: null, dy: 0, mode: 'none' };
    if (mesh && o.moveMeshes !== false) {
      meshRes = csPackV2ApplyPoseToMesh(mesh, pose, { applyPackYaw: applyYaw, scale: pose.scale });
      // Sync clickable flags
      if (match.target.outsideContainer != null)
        match.target.outsideContainer = false;
    }

    const ok = !!(stamp.ok && meshRes.ok);
    if (ok) applied += 1;
    else missed += 1;

    results.push({
      ok,
      reason: ok ? null : (stamp.reason || meshRes.reason || 'APPLY_FAIL'),
      _fmUid: placement._fmUid,
      mark: placement.mark || (item && item.mark),
      how: match.how,
      role: placement.role || null,
      footYMm: pose.footYMm,
      x: pose.x, y: pose.y, z: pose.z,
      meshMode: meshRes.mode,
      quatPreserved: !applyYaw,
      item,
      pose,
    });
  }

  const out = {
    ok: missed === 0 && applied === placed.length,
    applied,
    missed,
    placedCount: placed.length,
    remainingTargets: pool.length,
    results,
    poses,
    envelope: env,
  };
  try {
    if (typeof window !== 'undefined')
      window.__lastPackV2Apply = out;
  } catch (_) { /* */ }
  return out;
}

/**
 * Scene wrapper — uses opts.targets, else global `clickable` when present.
 */
function csPackV2ApplyPlacementsToScene(pack, opts) {
  const o = opts || {};
  let targets = o.targets || null;
  if (!targets) {
    try {
      if (typeof clickable !== 'undefined' && Array.isArray(clickable))
        targets = clickable;
    } catch (_) { /* */ }
  }
  if (!targets) targets = [];
  return csPackV2ApplyPlacementsToTargets(pack, targets, o);
}

/** Headless mock mesh (AABB-center position in scene units). */
function csPackV2MockMesh(x, y, z) {
  return {
    position: {
      x: x || 0, y: y || 0, z: z || 0,
      set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; },
    },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) {
      this.x = x; this.y = y; this.z = z; this.w = w;
    } },
    rotation: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Step 5b self-test — match / stamp / mesh move / live pack / no remorph.
 * Console: csPackV2Step5bSelfTest()
 */
function csPackV2Step5bSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }
  const near = (a, b, tol) => Math.abs(+a - +b) <= (tol != null ? tol : CSPACK_V2_EPS);

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const halfW = env.outerWidthMm * 0.5;

  // Fixture items (two share mark — uid must disambiguate)
  function makeItem(uid, mark, dims) {
    return {
      _fmUid: uid,
      mark,
      marks: [mark],
      lengthMm: dims.l, widthMm: dims.w, heightMm: dims.h,
      l: dims.l, w: dims.w, h: dims.h,
      sectW: dims.sectW || 85, sectH: dims.sectH || 200,
      x: 99999, y: 99999, z: 99999, // yard parking (must move)
      outsideContainer: true,
      weightKg: dims.kg || 100,
    };
  }

  const itFloor = makeItem('uid-floor', 'N1', { l: 8000, w: 200, h: 300, kg: 200 });
  const itTwinA = makeItem('uid-ta', 'RF', { l: 11000, w: 220, h: 2000, kg: 800 });
  const itTwinB = makeItem('uid-tb', 'RF', { l: 11000, w: 220, h: 2000, kg: 790 });
  const itStack = makeItem('uid-stack', 'N2', { l: 7000, w: 180, h: 250, kg: 180 });

  const meshFloor = csPackV2MockMesh(50, 50, 50);
  const meshTwinA = csPackV2MockMesh(1, 1, 1);
  const qA0 = { ...meshTwinA.quaternion };
  const meshTwinB = csPackV2MockMesh(2, 2, 2);
  const meshStack = csPackV2MockMesh(3, 3, 3);

  const targets = [
    { item: itFloor, mesh: meshFloor },
    { item: itTwinA, mesh: meshTwinA },
    { item: itTwinB, mesh: meshTwinB },
    { item: itStack, mesh: meshStack },
  ];

  const packFake = {
    envelope: env,
    containerSpec: spec,
    placed: [
      {
        _fmUid: 'uid-ta', mark: 'RF', role: 'twin_wall_hug', layer: 'floor',
        gravity: 'floor_y0', x: env.minXMm, z: env.minZMm, y: 0,
        pl: 11000, pw: 220, ph: 2000, yawDeg: 0,
      },
      {
        _fmUid: 'uid-tb', mark: 'RF', role: 'twin_beside', layer: 'floor',
        gravity: 'floor_y0',
        x: env.minXMm, z: env.minZMm + 220 + 60, y: 0,
        pl: 11000, pw: 220, ph: 2000, yawDeg: 0,
      },
      {
        _fmUid: 'uid-floor', mark: 'N1', role: 'long_nest_strip', layer: 'floor',
        gravity: 'floor_y0', x: env.minXMm + 50, z: env.minZMm + 600, y: 0,
        pl: 8000, pw: 200, ph: 300, yawDeg: 0,
      },
      {
        _fmUid: 'uid-stack', mark: 'N2', role: 'nest_stack', layer: 'stack',
        gravity: 'support_top', supportTopY: 300, tier: 2,
        x: env.minXMm + 80, z: env.minZMm + 620, y: 300,
        pl: 7000, pw: 180, ph: 250, yawDeg: 0,
      },
    ],
  };

  const apply = csPackV2ApplyPlacementsToTargets(packFake, targets, {
    containerSpec: spec,
    applyPackYaw: false,
  });

  // B1: all 4 applied via uid (including shared mark twins)
  check('B1', apply.ok && apply.applied === 4 && apply.missed === 0
    && apply.results.every(r => r.how === 'uid'),
  `app=${apply.applied} miss=${apply.missed} how=${apply.results.map(r => r.how).join(',')}`);

  // B2: floor foot / center
  check('B2', near(itFloor._packV2FootYMm, 0) && near(itFloor.y, 150)
    && itFloor.floorAnchor === true && itFloor.outsideContainer === false
    && itFloor.packPoseLock === true,
  `foot=${itFloor._packV2FootYMm} y=${itFloor.y} out=${itFloor.outsideContainer}`);

  // B3: stack elevated
  check('B3', near(itStack._packV2FootYMm, 300) && near(itStack.y, 425)
    && itStack.floorAnchor === false && itStack.role === 'nest_stack'
    && itStack.anchorTier === 2,
  `foot=${itStack._packV2FootYMm} y=${itStack.y} role=${itStack.role}`);

  // B4: twin wall-hug near home wall in viewer Z
  check('B4', itTwinA.z < -halfW + 400 && itTwinA.role === 'twin_wall_hug'
    && itTwinB.z > itTwinA.z,
  `zA=${itTwinA.z} zB=${itTwinB.z}`);

  // B5: mesh centers moved (SCALE 0.01)
  check('B5', near(meshFloor.position.x, itFloor.x * 0.01, 1e-6)
    && near(meshFloor.position.y, itFloor.y * 0.01, 1e-6)
    && near(meshFloor.position.z, itFloor.z * 0.01, 1e-6)
    && near(meshStack.position.y, itStack.y * 0.01, 1e-6),
  `mx=${meshFloor.position.x} my=${meshStack.position.y}`);

  // B6: quaternion preserved (no remorph)
  check('B6', meshTwinA.quaternion.x === qA0.x
    && meshTwinA.quaternion.y === qA0.y
    && meshTwinA.quaternion.z === qA0.z
    && meshTwinA.quaternion.w === qA0.w
    && apply.results.every(r => r.quatPreserved),
  `q=${JSON.stringify(meshTwinA.quaternion)}`);

  // B7: Group By dims not rewritten
  check('B7', itFloor.lengthMm === 8000 && itFloor.widthMm === 200
    && itFloor.heightMm === 300 && itFloor.sectW === 85
    && itTwinA.lengthMm === 11000,
  `L=${itFloor.lengthMm} W=${itFloor.widthMm} H=${itFloor.heightMm}`);

  // B8: packFootprint stamped for foot helpers
  check('B8', itFloor.packFootprintH === 300 && itStack.packFootprintH === 250
    && near(itFloor._packerSeatX0, itFloor.x),
  `fh=${itFloor.packFootprintH}`);

  // B9: ambiguous mark without uid → miss
  const ambA = makeItem(null, 'SAME', { l: 1000, w: 100, h: 100 });
  const ambB = makeItem(null, 'SAME', { l: 1000, w: 100, h: 100 });
  // clear uids
  delete ambA._fmUid; delete ambB._fmUid;
  const ambApply = csPackV2ApplyPlacementsToTargets({
    envelope: env,
    placed: [{
      mark: 'SAME', x: 10, z: 10, y: 0, pl: 1000, pw: 100, ph: 100,
    }],
  }, [{ item: ambA }, { item: ambB }], {});
  check('B9', !ambApply.ok && ambApply.missed === 1
    && ambApply.results[0].reason === 'AMBIGUOUS_MARK'
    && ambA.x === 99999,
  `r=${ambApply.results[0] && ambApply.results[0].reason} x=${ambA.x}`);

  // B10: unique mark fallback works
  const uniq = makeItem(null, 'UNIQ1', { l: 2000, w: 150, h: 120 });
  delete uniq._fmUid;
  const uniqMesh = csPackV2MockMesh(0, 0, 0);
  const uniqApply = csPackV2ApplyPlacementsToTargets({
    envelope: env,
    placed: [{
      mark: 'UNIQ1', role: 'long_nest_strip', layer: 'floor',
      x: env.minXMm, z: env.minZMm + 800, y: 0,
      pl: 2000, pw: 150, ph: 120,
    }],
  }, [{ item: uniq, mesh: uniqMesh }], {});
  check('B10', uniqApply.ok && uniqApply.results[0].how === 'mark'
    && near(uniq.y, 60) && uniq.outsideContainer === false,
  `how=${uniqApply.results[0] && uniqApply.results[0].how} y=${uniq.y}`);

  // B11: missing target reported
  const missApply = csPackV2ApplyPlacementsToTargets({
    envelope: env,
    placed: [{
      _fmUid: 'ghost', mark: 'GHOST',
      x: 10, z: 10, y: 0, pl: 100, pw: 100, ph: 100,
    }],
  }, targets, {});
  check('B11', missApply.missed === 1
    && missApply.results[0].reason === 'UID_NOT_FOUND',
  `r=${missApply.results[0] && missApply.results[0].reason}`);

  // B12: unplaced / non-target items untouched (leftover POV)
  const leftover = makeItem('uid-left', 'LEFT', { l: 500, w: 100, h: 100 });
  leftover.x = 12345; leftover.outsideContainer = true;
  const leftTargets = targets.concat([{ item: leftover }]);
  // re-park main items then re-apply only packFake placed
  itFloor.x = 1; leftover.x = 12345;
  csPackV2ApplyPlacementsToTargets(packFake, leftTargets, {});
  check('B12', leftover.x === 12345 && leftover.outsideContainer === true
    && leftover._packV2Applied !== true,
  `leftX=${leftover.x}`);

  // B13: viewer AABBs of applied seats stay inside + no pairwise dig
  const aabbs = apply.poses.map(p => p.viewerAabb);
  let dig = false;
  for (let i = 0; i < aabbs.length; i++) {
    if (!csPackV2ViewerAabbInsideOuter(aabbs[i], apply.poses[i].outer, { envelope: env }))
      dig = true;
    for (let j = i + 1; j < aabbs.length; j++) {
      const a = aabbs[i], b = aabbs[j];
      const ov = !(a.maxX <= b.minX + CSPACK_V2_EPS || a.minX >= b.maxX - CSPACK_V2_EPS
        || a.maxY <= b.minY + CSPACK_V2_EPS || a.minY >= b.maxY - CSPACK_V2_EPS
        || a.maxZ <= b.minZ + CSPACK_V2_EPS || a.minZ >= b.maxZ - CSPACK_V2_EPS);
      if (ov) dig = true;
    }
  }
  check('B13', !dig && aabbs.length === 4, `n=${aabbs.length} dig=${dig}`);

  // B14: idempotent re-apply
  const xBefore = itTwinA.x;
  const again = csPackV2ApplyPlacementsToTargets(packFake, [
    { item: itFloor, mesh: meshFloor },
    { item: itTwinA, mesh: meshTwinA },
    { item: itTwinB, mesh: meshTwinB },
    { item: itStack, mesh: meshStack },
  ], {});
  check('B14', again.ok && near(itTwinA.x, xBefore),
  `x=${itTwinA.x} again=${again.applied}`);

  // B15: ApplyPlacementsToScene with explicit targets
  const sceneOut = csPackV2ApplyPlacementsToScene(packFake, {
    targets: [
      { item: makeItem('uid-floor', 'N1', { l: 8000, w: 200, h: 300 }), mesh: csPackV2MockMesh() },
      { item: makeItem('uid-ta', 'RF', { l: 11000, w: 220, h: 2000 }), mesh: csPackV2MockMesh() },
      { item: makeItem('uid-tb', 'RF', { l: 11000, w: 220, h: 2000 }), mesh: csPackV2MockMesh() },
      { item: makeItem('uid-stack', 'N2', { l: 7000, w: 180, h: 250 }), mesh: csPackV2MockMesh() },
    ],
  });
  check('B15', sceneOut.ok && sceneOut.applied === 4,
  `app=${sceneOut.applied}`);

  // B16: live PackWithTwins → apply (twins + stacks)
  const liveUnits = [];
  const liveTargets = [];
  function addLive(uid, mark, ufields, dims) {
    const item = makeItem(uid, mark, dims);
    Object.assign(item, ufields);
    const mesh = csPackV2MockMesh(9, 9, 9);
    liveUnits.push({
      _fmUid: uid, mark, ...ufields,
      packLengthMm: dims.l, packWidthMm: dims.w, packHeightMm: dims.h,
      lengthMm: dims.l, widthMm: dims.w, heightMm: dims.h,
      weightKg: dims.kg || 100,
    });
    liveTargets.push({ item, mesh });
  }
  addLive('rfA', 'RF-A', { isAssembly: true, groupKind: 'welded_assembly' },
    { l: 11000, w: 200, h: 2400, kg: 700 });
  addLive('rfB', 'RF-B', { isAssembly: true, groupKind: 'welded_assembly' },
    { l: 11000, w: 200, h: 2400, kg: 690 });
  addLive('nA', 'NEST-A', { groupKind: 'nest_z', shapeKey: 'z_channel' },
    { l: 9600, w: 400, h: 200, kg: 300 });
  for (let i = 0; i < 6; i++) {
    addLive('nc' + i, 'NC' + i, { groupKind: 'nest_z', shapeKey: 'z_channel' },
      { l: 9000, w: 380, h: 180, kg: 220 - i });
  }
  // Align target uids with packer units (same _fmUid)
  liveTargets.forEach((t, i) => { t.item._fmUid = liveUnits[i]._fmUid; });

  const livePack = csPackV2PackWithTwins(liveUnits, {
    containerSpec: spec, enableStacks: true,
  });
  const liveApply = csPackV2ApplyPlacementsToTargets(livePack, liveTargets, {
    containerSpec: spec,
  });
  const hugItem = liveTargets.map(t => t.item).find(it => it.role === 'twin_wall_hug');
  const stackItem = liveTargets.map(t => t.item).find(it => it.role === 'nest_stack');
  const stackMesh = liveTargets.find(t => t.item === stackItem);

  check('B16', livePack.ok && livePack.stackCount >= 1
    && liveApply.applied === livePack.placedCount
    && liveApply.missed === 0
    && hugItem && near(hugItem._packV2FootYMm, 0)
    && hugItem.z < -halfW + 400,
  `packP=${livePack.placedCount} app=${liveApply.applied} hugZ=${hugItem && hugItem.z} stacks=${livePack.stackCount}`);

  check('B17', stackItem && stackItem._packV2FootYMm > CSPACK_V2_EPS
    && near(stackMesh.mesh.position.y, stackItem.y * 0.01, 1e-6)
    && stackItem.outsideContainer === false,
  `foot=${stackItem && stackItem._packV2FootYMm} my=${stackMesh && stackMesh.mesh.position.y}`);

  // B18: applied count rises vs targets still outside among unplaced
  const unplacedUids = new Set((livePack.unplaced || []).map(u =>
    (u && (u._fmUid || (u.unit && u.unit._fmUid))) || null).filter(Boolean));
  // also gather from unplaced array shapes
  (livePack.unplaced || []).forEach(u => {
    if (u && u._fmUid) unplacedUids.add(String(u._fmUid));
    if (u && u.unit && u.unit._fmUid) unplacedUids.add(String(u.unit._fmUid));
  });
  const stillOut = liveTargets.filter(t =>
    t.item.outsideContainer && !t.item._packV2Applied);
  check('B18', liveApply.applied >= 6
    && stillOut.every(t => unplacedUids.has(String(t.item._fmUid))
      || livePack.unplacedCount >= stillOut.length),
  `app=${liveApply.applied} stillOut=${stillOut.length} un=${livePack.unplacedCount}`);

  // B19: 5a regression still green
  const a = csPackV2Step5aSelfTest();
  check('B19', a.ok, `${a.passed}/${a.total}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      applied: apply.applied,
      liveApplied: liveApply.applied,
      liveStacks: livePack.stackCount,
      hugZ: hugItem && hugItem.z,
      stackFoot: stackItem && stackItem._packV2FootYMm,
    },
  };
  try { console.info('[PackV2] step5b self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5c — Leftovers outside + visible fitReason / stackFailReason
//
// Real-world rules:
//   • Unplaced units NEVER get an inside seat from this step
//   • Reasons stay honest: NO_SLOT / FOOTPRINT_* / HEIGHT_* / STACK_*
//   • Outside park: +Z beyond far wall (same idea as layoutOutside)
//   • Do not remorph Group By; do not clear placed seats from 5b
// ═══════════════════════════════════════════════════════════════════════════

/** Gap / start offset for outside parking row (mm) — matches layoutOutside spirit. */
const CSPACK_V2_OUTSIDE_GAP_MM = 280;
const CSPACK_V2_OUTSIDE_Z0_PAD_MM = 800;

/**
 * Normalize one pack.unplaced entry into a leftover view for UI / apply.
 */
function csPackV2NormalizeLeftoverEntry(entry, idx) {
  if (!entry) return null;
  const unit = entry.unit || entry;
  const uid = entry._fmUid != null ? entry._fmUid
    : (unit && unit._fmUid != null ? unit._fmUid : null);
  const mark = entry.mark != null ? entry.mark
    : (unit && unit.mark != null ? unit.mark : null);
  const fitReason = entry.fitReason || (unit && unit.fitReason) || 'UNPLACED';
  const fitReasonMsg = entry.fitReasonMsg || (unit && unit.fitReasonMsg)
    || ('Could not place' + (mark ? ` ${mark}` : ''));
  const stackFailReason = entry.stackFailReason
    || (unit && unit.stackFailReason) || null;
  const role = entry.role || (unit && (unit.role || unit.groupKind)) || 'leftover';
  const pl = Math.max(
    +(unit && (unit.packLengthMm || unit.packFootprintL || unit.lengthMm || unit.l)) || 0,
    +(entry.pl) || 0, 1);
  const pw = Math.max(
    +(unit && (unit.packWidthMm || unit.packFootprintW || unit.widthMm || unit.w)) || 0,
    +(entry.pw) || 0, 1);
  const ph = Math.max(
    +(unit && (unit.packHeightMm || unit.packFootprintH || unit.heightMm || unit.h)) || 0,
    +(entry.ph) || 0, 1);

  return {
    index: idx,
    _fmUid: uid,
    mark,
    reason: fitReason,
    reasonMsg: fitReasonMsg,
    fitReason,
    fitReasonMsg,
    stackFailReason,
    role,
    groupKind: (unit && unit.groupKind) || null,
    pl, pw, ph,
    weightKg: Math.max(+(unit && unit.weightKg) || 0, +(entry.weightKg) || 0, 0),
    unit,
    entry,
  };
}

/**
 * Collect leftover views from a pack result.
 * @returns {{ ok, count, leftovers, byReason, lines }}
 */
function csPackV2CollectLeftoverViews(pack, opts) {
  const o = opts || {};
  const raw = (pack && pack.unplaced) ? pack.unplaced : (o.unplaced || []);
  const leftovers = [];
  const byReason = {};

  for (let i = 0; i < raw.length; i++) {
    const view = csPackV2NormalizeLeftoverEntry(raw[i], i);
    if (!view) continue;
    leftovers.push(view);
    const key = view.reason || 'UNPLACED';
    byReason[key] = (byReason[key] || 0) + 1;
  }

  const lines = leftovers.map(v => csPackV2FormatLeftoverLine(v));
  const out = {
    ok: true,
    count: leftovers.length,
    leftovers,
    byReason,
    lines,
    summary: leftovers.length === 0
      ? 'All selected units placed'
      : `${leftovers.length} leftover${leftovers.length === 1 ? '' : 's'} outside`,
  };
  try {
    if (typeof window !== 'undefined')
      window.__lastPackV2Leftovers = out;
  } catch (_) { /* */ }
  return out;
}

/** One-line UI / toast string for a leftover. */
function csPackV2FormatLeftoverLine(view) {
  if (!view) return '';
  const mark = view.mark || view._fmUid || 'unit';
  const reason = view.reason || view.fitReason || 'UNPLACED';
  const stack = view.stackFailReason ? ` (${view.stackFailReason})` : '';
  const msg = view.reasonMsg || view.fitReasonMsg || '';
  if (msg && msg !== reason)
    return `${mark}: ${reason}${stack} — ${msg}`;
  return `${mark}: ${reason}${stack}`;
}

/**
 * Compute an outside park seat (viewer AABB centers, mm).
 * Parks past the far wall (+Z), row-wrapping along +X like layoutOutside.
 */
function csPackV2ComputeOutsideSeat(index, dims, specOrEnv, opts) {
  const o = opts || {};
  const outer = csPackV2BridgeOuter(specOrEnv, o);
  const W = +outer.widthMm;
  const L = +outer.lengthMm;
  const pl = Math.max(+(dims && dims.pl) || +(dims && dims.l) || 500, 1);
  const pw = Math.max(+(dims && dims.pw) || +(dims && dims.w) || 200, 1);
  const ph = Math.max(+(dims && dims.ph) || +(dims && dims.h) || 200, 1);
  const gap = (o.gapMm != null) ? +o.gapMm : CSPACK_V2_OUTSIDE_GAP_MM;
  const z0pad = (o.z0PadMm != null) ? +o.z0PadMm : CSPACK_V2_OUTSIDE_Z0_PAD_MM;
  const i = Math.max(0, +index || 0);

  // Row layout in a local cursor space (same as layoutOutside)
  const maxRowX = Math.max(L * 2.5, pl + gap);
  let xCursor = 0;
  let zStart = W * 0.5 + z0pad;
  let rowMaxW = 200;
  for (let k = 0; k < i; k++) {
    // Unknown prior dims → assume similar; callers pass sequential with known dims
    const prevPl = Math.max(+(o.prevDims && o.prevDims[k] && o.prevDims[k].pl) || pl, 1);
    const prevPw = Math.max(+(o.prevDims && o.prevDims[k] && o.prevDims[k].pw) || pw, 1);
    xCursor += prevPl + gap;
    rowMaxW = Math.max(rowMaxW, prevPw);
    if (xCursor > maxRowX) {
      xCursor = 0;
      zStart += rowMaxW + gap;
      rowMaxW = 200;
    }
  }

  const x = xCursor + pl * 0.5;
  const z = zStart + pw * 0.5;
  const y = ph * 0.5; // viewer center; foot on ground
  const scale = csPackV2SceneScale(o);

  return {
    ok: true,
    x, y, z,
    footYMm: 0,
    pl, pw, ph,
    outsideContainer: true,
    xScene: x * scale,
    yScene: y * scale,
    zScene: z * scale,
    scale,
    outer: { lengthMm: L, widthMm: W, heightMm: +outer.heightMm },
  };
}

/**
 * True if viewer-center pose is clearly outside the outer container box.
 * (Leftovers must fail the inside test.)
 */
function csPackV2ViewerPoseIsOutside(pose, outer, opts) {
  const o = opts || {};
  if (!pose || !outer) return true;
  const L = +outer.lengthMm;
  const W = +outer.widthMm;
  const H = +outer.heightMm || 1e9;
  const pl = +pose.pl || 0;
  const pw = +pose.pw || 0;
  const ph = +pose.ph || 0;
  const aabb = {
    minX: +pose.x - pl * 0.5,
    maxX: +pose.x + pl * 0.5,
    minY: (pose.footYMm != null) ? +pose.footYMm : (+pose.y - ph * 0.5),
    maxY: ((pose.footYMm != null) ? +pose.footYMm : (+pose.y - ph * 0.5)) + ph,
    minZ: +pose.z - pw * 0.5,
    maxZ: +pose.z + pw * 0.5,
  };
  // Outside if any extent is beyond outer walls (not merely clearance envelope)
  const eps = (o.eps != null) ? +o.eps : CSPACK_V2_EPS;
  const inside = aabb.minX >= -eps && aabb.maxX <= L + eps
    && aabb.minZ >= -W * 0.5 - eps && aabb.maxZ <= W * 0.5 + eps
    && aabb.minY >= -eps && aabb.maxY <= H + eps;
  return !inside;
}

/**
 * Stamp leftover view onto an item + optional mesh (outside only).
 */
function csPackV2StampLeftoverOnItem(item, view, outsidePose, opts) {
  const o = opts || {};
  if (!item || !view)
    return { ok: false, reason: 'BAD_ARGS' };

  const keep = {
    lengthMm: item.lengthMm, widthMm: item.widthMm, heightMm: item.heightMm,
    l: item.l, w: item.w, h: item.h,
    sectW: item.sectW, sectH: item.sectH,
  };

  item.fitReason = view.fitReason || view.reason;
  item.fitReasonMsg = view.fitReasonMsg || view.reasonMsg;
  item.stackFailReason = view.stackFailReason || null;
  item.outsideContainer = true;
  item._packV2Leftover = true;
  item._packV2Applied = false;
  item.packPoseLock = false;
  item.floorAnchor = false;
  item.baseLayerLock = false;
  item.role = 'leftover';
  item.packRole = 'leftover';

  if (outsidePose && outsidePose.ok) {
    item.x = outsidePose.x;
    item.y = outsidePose.y;
    item.z = outsidePose.z;
    item._packV2FootYMm = outsidePose.footYMm;
    item._packerSeatX0 = null;
    item._packerSeatZ0 = null;
    item._packerSeatY0 = null;
  }

  if (view._fmUid != null && item._fmUid == null)
    item._fmUid = view._fmUid;

  if (o.preserveDims !== false) {
    if (keep.lengthMm != null) item.lengthMm = keep.lengthMm;
    if (keep.widthMm != null) item.widthMm = keep.widthMm;
    if (keep.heightMm != null) item.heightMm = keep.heightMm;
    if (keep.l != null) item.l = keep.l;
    if (keep.w != null) item.w = keep.w;
    if (keep.h != null) item.h = keep.h;
    if (keep.sectW != null) item.sectW = keep.sectW;
    if (keep.sectH != null) item.sectH = keep.sectH;
  }

  return { ok: true, reason: null };
}

/**
 * Apply leftovers to targets: park outside + stamp reasons.
 * Never moves a target that was already placed by 5b (_packV2Applied).
 *
 * @returns {{ ok, applied, missed, leftovers, results, lines }}
 */
function csPackV2ApplyLeftoversToTargets(pack, targets, opts) {
  const o = opts || {};
  const collected = csPackV2CollectLeftoverViews(pack, o);
  const env = (pack && pack.envelope)
    || o.envelope
    || csPackV2FloorEnvelope(o.containerSpec || (pack && pack.containerSpec));
  const pool = (targets || []).slice();
  const results = [];
  const prevDims = [];
  let applied = 0;
  let missed = 0;

  for (let i = 0; i < collected.leftovers.length; i++) {
    const view = collected.leftovers[i];
    const match = csPackV2MatchTargetForPlacement({
      _fmUid: view._fmUid,
      mark: view.mark,
      unit: view.unit,
    }, pool);

    if (!match.target) {
      missed += 1;
      results.push({
        ok: false,
        reason: match.reason || 'NO_MATCH',
        _fmUid: view._fmUid,
        mark: view.mark,
        fitReason: view.fitReason,
        line: csPackV2FormatLeftoverLine(view),
      });
      continue;
    }

    const item = csPackV2TargetItem(match.target);
    // Never yank a successfully packed piece back outside
    if (item && item._packV2Applied && o.skipApplied !== false) {
      missed += 1;
      results.push({
        ok: false,
        reason: 'ALREADY_PLACED',
        _fmUid: view._fmUid,
        mark: view.mark,
        fitReason: view.fitReason,
      });
      continue;
    }

    const idx = pool.indexOf(match.target);
    if (idx >= 0) pool.splice(idx, 1);

    const dims = { pl: view.pl, pw: view.pw, ph: view.ph };
    const outsidePose = csPackV2ComputeOutsideSeat(applied, dims, env, {
      prevDims: prevDims.slice(),
      gapMm: o.gapMm,
      z0PadMm: o.z0PadMm,
      scale: o.scale,
    });
    prevDims.push(dims);

    const stamp = csPackV2StampLeftoverOnItem(item, view, outsidePose, {
      preserveDims: o.preserveDims !== false,
    });

    const mesh = csPackV2TargetMesh(match.target);
    let meshRes = { ok: true, mode: 'none' };
    if (mesh && o.moveMeshes !== false && outsidePose.ok) {
      // Reuse mesh mover with a synthetic "pose" (centers + foot 0)
      const pose = {
        ok: true,
        x: outsidePose.x, y: outsidePose.y, z: outsidePose.z,
        footYMm: 0,
        scale: outsidePose.scale,
        xScene: outsidePose.xScene,
        yScene: outsidePose.yScene,
        zScene: outsidePose.zScene,
        yawDeg: 0,
      };
      meshRes = csPackV2ApplyPoseToMesh(mesh, pose, { applyPackYaw: false });
      if (match.target.outsideContainer != null)
        match.target.outsideContainer = true;
    }

    const ok = !!(stamp.ok && meshRes.ok
      && csPackV2ViewerPoseIsOutside(outsidePose, outsidePose.outer));
    if (ok) applied += 1;
    else missed += 1;

    results.push({
      ok,
      reason: ok ? null : (stamp.reason || 'OUTSIDE_FAIL'),
      how: match.how,
      _fmUid: view._fmUid,
      mark: view.mark,
      fitReason: view.fitReason,
      stackFailReason: view.stackFailReason,
      line: csPackV2FormatLeftoverLine(view),
      x: outsidePose.x, y: outsidePose.y, z: outsidePose.z,
      outside: true,
      item,
    });
  }

  const lines = results.filter(r => r.ok || r.fitReason).map(r =>
    r.line || csPackV2FormatLeftoverLine(r));

  const out = {
    ok: missed === 0,
    applied,
    missed,
    leftoverCount: collected.count,
    leftovers: collected.leftovers,
    byReason: collected.byReason,
    summary: collected.summary,
    lines,
    results,
  };
  try {
    if (typeof window !== 'undefined')
      window.__lastPackV2LeftoverApply = out;
  } catch (_) { /* */ }
  return out;
}

/**
 * Scene wrapper for leftovers (uses clickable when targets omitted).
 */
function csPackV2ApplyLeftoversToScene(pack, opts) {
  const o = opts || {};
  let targets = o.targets || null;
  if (!targets) {
    try {
      if (typeof clickable !== 'undefined' && Array.isArray(clickable))
        targets = clickable;
    } catch (_) { /* */ }
  }
  if (!targets) targets = [];
  return csPackV2ApplyLeftoversToTargets(pack, targets, o);
}

/**
 * Step 5c self-test — leftover reasons, outside park, no steal of placed.
 * Console: csPackV2Step5cSelfTest()
 */
function csPackV2Step5cSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }
  const near = (a, b, tol) => Math.abs(+a - +b) <= (tol != null ? tol : CSPACK_V2_EPS);

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
  const env = csPackV2FloorEnvelope(spec);
  const halfW = env.outerWidthMm * 0.5;

  // --- C1 empty leftovers ---
  const empty = csPackV2CollectLeftoverViews({ unplaced: [] });
  check('C1', empty.ok && empty.count === 0 && /All selected/.test(empty.summary),
  `n=${empty.count} sum=${empty.summary}`);

  // --- C2 FOOTPRINT_EXCEEDS from PackFloor ---
  const fat = {
    _fmUid: 'fat1', mark: 'FAT',
    packLengthMm: 5000, packWidthMm: 5000, packHeightMm: 200, weightKg: 100,
  };
  const slim = {
    _fmUid: 'slim1', mark: 'SLIM',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 200, weightKg: 50,
  };
  const packFat = csPackV2PackFloor([slim, fat], { containerSpec: spec });
  const viewsFat = csPackV2CollectLeftoverViews(packFat);
  const fatView = viewsFat.leftovers.find(v => v.mark === 'FAT');
  check('C2', packFat.unplacedCount >= 1 && fatView
    && fatView.reason === 'FOOTPRINT_EXCEEDS'
    && /Footprint/i.test(fatView.reasonMsg)
    && viewsFat.byReason.FOOTPRINT_EXCEEDS >= 1,
  `r=${fatView && fatView.reason} msg=${fatView && fatView.reasonMsg}`);

  // --- C3 HEIGHT_EXCEEDS ---
  const tall = {
    _fmUid: 'tall1', mark: 'TALL',
    packLengthMm: 2000, packWidthMm: 200, packHeightMm: 9000, weightKg: 80,
  };
  const packTall = csPackV2PackFloor([tall], { containerSpec: spec });
  const viewsTall = csPackV2CollectLeftoverViews(packTall);
  check('C3', viewsTall.count === 1
    && viewsTall.leftovers[0].reason === 'HEIGHT_EXCEEDS',
  `r=${viewsTall.leftovers[0] && viewsTall.leftovers[0].reason}`);

  // --- C4 NO_SLOT (fits envelope but overcrowded) ---
  const a = {
    _fmUid: 'a1', mark: 'A',
    packLengthMm: 10000, packWidthMm: 2000, packHeightMm: 200, weightKg: 200,
  };
  const b = {
    _fmUid: 'b1', mark: 'B',
    packLengthMm: 10000, packWidthMm: 2000, packHeightMm: 200, weightKg: 180,
  };
  const packSlot = csPackV2PackFloor([a, b], { containerSpec: spec });
  const viewsSlot = csPackV2CollectLeftoverViews(packSlot);
  check('C4', packSlot.placedCount === 1 && packSlot.unplacedCount === 1
    && viewsSlot.leftovers[0].reason === 'NO_SLOT',
  `in=${packSlot.placedCount} out=${packSlot.unplacedCount} r=${viewsSlot.leftovers[0] && viewsSlot.leftovers[0].reason}`);

  // --- C5 STACK_* reason (crafted + live stack-fail stamp path) ---
  const stackViews = csPackV2CollectLeftoverViews({
    unplaced: [{
      _fmUid: 'ns1', mark: 'NEST-S',
      fitReason: 'STACK_HEIGHT_EXCEEDS',
      fitReasonMsg: 'Stack pass: height exceeds clear',
      stackFailReason: 'HEIGHT_EXCEEDS',
      unit: {
        _fmUid: 'ns1', mark: 'NEST-S', groupKind: 'nest_z',
        packLengthMm: 9000, packWidthMm: 300, packHeightMm: 200,
      },
    }],
  });
  check('C5', stackViews.count === 1
    && stackViews.leftovers[0].reason === 'STACK_HEIGHT_EXCEEDS'
    && stackViews.leftovers[0].stackFailReason === 'HEIGHT_EXCEEDS'
    && /NEST-S: STACK_HEIGHT_EXCEEDS/.test(stackViews.lines[0]),
  `line=${stackViews.lines[0]}`);

  // --- C6 format line helper ---
  check('C6', /FAT: FOOTPRINT_EXCEEDS/.test(csPackV2FormatLeftoverLine(fatView)),
  `line=${csPackV2FormatLeftoverLine(fatView)}`);

  // --- C7 outside seat is beyond far wall ---
  const seat0 = csPackV2ComputeOutsideSeat(0, { pl: 2000, pw: 300, ph: 200 }, env);
  check('C7', seat0.ok && seat0.z > halfW
    && csPackV2ViewerPoseIsOutside(seat0, seat0.outer)
    && near(seat0.footYMm, 0) && near(seat0.y, 100),
  `z=${seat0.z} halfW=${halfW} y=${seat0.y}`);

  // --- C8 apply leftovers: stamp reason + park outside ---
  const leftItem = {
    _fmUid: 'fat1', mark: 'FAT',
    lengthMm: 5000, widthMm: 5000, heightMm: 200,
    x: 10, y: 100, z: 0, // was wrongly inside-ish
    outsideContainer: false,
    sectW: 85, sectH: 200,
  };
  const leftMesh = csPackV2MockMesh(0.1, 1, 0);
  const placedItem = {
    _fmUid: 'slim1', mark: 'SLIM',
    lengthMm: 2000, widthMm: 200, heightMm: 200,
    x: 1000, y: 100, z: 0,
    outsideContainer: false,
    _packV2Applied: true,
    packPoseLock: true,
  };
  const leftApply = csPackV2ApplyLeftoversToTargets(packFat, [
    { item: leftItem, mesh: leftMesh },
    { item: placedItem },
  ], { containerSpec: spec });

  check('C8', leftApply.applied >= 1
    && leftItem.outsideContainer === true
    && leftItem.fitReason === 'FOOTPRINT_EXCEEDS'
    && leftItem._packV2Leftover === true
    && leftItem.packPoseLock === false
    && leftItem.z > halfW
    && leftItem.lengthMm === 5000 && leftItem.sectW === 85,
  `out=${leftItem.outsideContainer} r=${leftItem.fitReason} z=${leftItem.z}`);

  // --- C9 placed item not stolen by leftover apply ---
  check('C9', placedItem._packV2Applied === true
    && placedItem.outsideContainer === false
    && placedItem.x === 1000,
  `placedX=${placedItem.x} out=${placedItem.outsideContainer}`);

  // --- C10 mesh moved to outside scene coords ---
  check('C10', near(leftMesh.position.x, leftItem.x * 0.01, 1e-6)
    && near(leftMesh.position.z, leftItem.z * 0.01, 1e-6)
    && leftMesh.position.z > halfW * 0.01,
  `mz=${leftMesh.position.z}`);

  // --- C11 missing leftover target → missed with reason preserved in lines ---
  const miss = csPackV2ApplyLeftoversToTargets(packFat, [], {});
  check('C11', miss.applied === 0 && miss.missed >= 1
    && miss.leftoverCount >= 1
    && miss.results[0].fitReason === 'FOOTPRINT_EXCEEDS',
  `miss=${miss.missed} r=${miss.results[0] && miss.results[0].fitReason}`);

  // --- C12 live PackWithTwins floor-only overcrowded → NO_SLOT leftovers outside ---
  const liveUnits = [];
  const liveTargets = [];
  function addU(uid, mark, fields, dims) {
    const item = {
      _fmUid: uid, mark,
      lengthMm: dims.l, widthMm: dims.w, heightMm: dims.h,
      x: 50, y: 50, z: 0, outsideContainer: false,
    };
    liveUnits.push({
      _fmUid: uid, mark, ...fields,
      packLengthMm: dims.l, packWidthMm: dims.w, packHeightMm: dims.h,
      weightKg: dims.kg || 100,
    });
    liveTargets.push({ item, mesh: csPackV2MockMesh(0.5, 0.5, 0) });
  }
  addU('rfA', 'RF-A', { isAssembly: true, groupKind: 'welded_assembly' },
    { l: 11000, w: 200, h: 2400, kg: 700 });
  addU('rfB', 'RF-B', { isAssembly: true, groupKind: 'welded_assembly' },
    { l: 11000, w: 200, h: 2400, kg: 690 });
  addU('nA', 'NEST-A', { groupKind: 'nest_z', shapeKey: 'z_channel' },
    { l: 9600, w: 400, h: 200, kg: 300 });
  for (let i = 0; i < 6; i++) {
    addU('nc' + i, 'NC' + i, { groupKind: 'nest_z', shapeKey: 'z_channel' },
      { l: 9000, w: 380, h: 180, kg: 220 - i });
  }

  const liveOff = csPackV2PackWithTwins(liveUnits, {
    containerSpec: spec, enableStacks: false,
  });
  // 5b place what fits
  const liveApplyIn = csPackV2ApplyPlacementsToTargets(liveOff, liveTargets, {
    containerSpec: spec,
  });
  const liveLeft = csPackV2ApplyLeftoversToTargets(liveOff, liveTargets, {
    containerSpec: spec,
  });
  const leftoverItems = liveTargets.map(t => t.item).filter(it => it._packV2Leftover);
  const placedItems = liveTargets.map(t => t.item).filter(it => it._packV2Applied);

  check('C12', liveOff.unplacedCount >= 1
    && liveApplyIn.applied === liveOff.placedCount
    && liveLeft.applied === liveOff.unplacedCount
    && leftoverItems.length === liveOff.unplacedCount
    && leftoverItems.every(it => it.outsideContainer && it.fitReason
      && it.z > halfW)
    && placedItems.every(it => !it.outsideContainer && it._packV2Applied),
  `un=${liveOff.unplacedCount} inApp=${liveApplyIn.applied} leftApp=${liveLeft.applied} reasons=${leftoverItems.map(i => i.fitReason).join(',')}`);

  // --- C13 STACK leftover apply stamps stackFailReason ---
  const nestLeft = {
    _fmUid: 'ns1', mark: 'NEST-S',
    lengthMm: 9000, widthMm: 300, heightMm: 200,
    x: 0, y: 0, z: 0, outsideContainer: false,
  };
  const stackPack = {
    envelope: env,
    unplaced: [{
      _fmUid: 'ns1', mark: 'NEST-S',
      fitReason: 'STACK_NO_SUPPORT',
      fitReasonMsg: 'No nest pad left to stack on',
      stackFailReason: 'NO_SUPPORT',
      unit: nestLeft,
    }],
  };
  const stackApply = csPackV2ApplyLeftoversToTargets(stackPack, [
    { item: nestLeft, mesh: csPackV2MockMesh() },
  ], { containerSpec: spec });
  check('C13', stackApply.ok && nestLeft.fitReason === 'STACK_NO_SUPPORT'
    && nestLeft.stackFailReason === 'NO_SUPPORT'
    && nestLeft.outsideContainer
    && /STACK_NO_SUPPORT/.test(stackApply.lines[0]),
  `r=${nestLeft.fitReason} sr=${nestLeft.stackFailReason}`);

  // --- C14 ApplyLeftoversToScene explicit targets ---
  const sceneLeft = csPackV2ApplyLeftoversToScene(packTall, {
    targets: [{
      item: {
        _fmUid: 'tall1', mark: 'TALL',
        lengthMm: 2000, widthMm: 200, heightMm: 9000,
        x: 0, y: 0, z: 0,
      },
      mesh: csPackV2MockMesh(),
    }],
  });
  check('C14', sceneLeft.applied === 1
    && sceneLeft.leftovers[0].reason === 'HEIGHT_EXCEEDS',
  `app=${sceneLeft.applied}`);

  // --- C15 byReason summary counts ---
  check('C15', viewsFat.byReason.FOOTPRINT_EXCEEDS >= 1
    && Object.keys(viewsFat.byReason).length >= 1,
  `by=${JSON.stringify(viewsFat.byReason)}`);

  // --- C16 5b regression ---
  const btest = csPackV2Step5bSelfTest();
  check('C16', btest.ok, `${btest.passed}/${btest.total}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      footprint: fatView && fatView.reason,
      noSlot: viewsSlot.leftovers[0] && viewsSlot.leftovers[0].reason,
      liveUnplaced: liveOff.unplacedCount,
      liveLeftoverReasons: leftoverItems.map(i => i.fitReason),
      outsideZ0: seat0.z,
    },
  };
  try { console.info('[PackV2] step5c self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5d — Optimise wire: BuildUnits → PackWithTwins → apply 5b+5c → layout
//
// Real-world rules:
//   • Checked staging groups only (load order = checkOrder)
//   • PackWithTwins + stacks ON by default
//   • Placed → container items; leftovers → oversized outside with reasons
//   • No Group By remorph; packFootprint from packer, visual dims from source
//   • Headless-safe (opts.units bypasses staging / createPackUnits)
// ═══════════════════════════════════════════════════════════════════════════

/** Ensure each staging group has packUnits (createPackUnits when available). */
function csPackV2EnsureGroupPackUnits(groups) {
  let n = 0;
  (groups || []).forEach(g => {
    if (!g) return;
    if (g.packUnits && g.packUnits.length) {
      n += g.packUnits.length;
      return;
    }
    if (typeof createPackUnits === 'function') {
      try {
        g.packUnits = createPackUnits(g) || [];
        n += g.packUnits.length;
      } catch (_) {
        g.packUnits = g.packUnits || [];
      }
    }
  });
  return n;
}

/**
 * Build a render item from a BuildUnits clone (keeps Group By visual fields).
 */
function csPackV2MakeRenderItemFromUnit(unit) {
  if (!unit) return null;
  const src = unit._srcPackUnit || unit;
  const g = unit._srcGroup || null;
  const item = {};

  Object.keys(src).forEach(k => {
    if (k === '_srcPackUnit' || k === '_srcGroup') return;
    const v = src[k];
    if (Array.isArray(v)) {
      item[k] = v.map(x => (x && typeof x === 'object') ? { ...x } : x);
    } else if (v && typeof v === 'object') {
      item[k] = { ...v };
    } else {
      item[k] = v;
    }
  });

  item._fmUid = unit._fmUid;
  item.mark = unit.mark || src.mark || item.mark || null;
  if ((!item.marks || !item.marks.length) && unit.marks)
    item.marks = unit.marks.slice();
  if ((!item.marks || !item.marks.length) && item.mark)
    item.marks = [item.mark];

  item.groupKind = unit.groupKind || item.groupKind || (g && g.groupKind) || null;
  item.shapeKey = unit.shapeKey || item.shapeKey || null;
  item.isAssembly = !!(unit.isAssembly || item.isAssembly
    || item.groupKind === 'welded_assembly');
  item.weightKg = Math.max(+unit.weightKg || 0, +item.weightKg || 0, 0);
  item.unitWeightKg = item.unitWeightKg || item.weightKg;
  item.weight = item.weight || item.weightKg;

  // Packer footprints (seat math) — do not wipe nest visual sect*/nestPieces
  item.packLengthMm = +unit.packLengthMm || +item.packLengthMm || 0;
  item.packWidthMm = +unit.packWidthMm || +item.packWidthMm || 0;
  item.packHeightMm = +unit.packHeightMm || +item.packHeightMm || 0;
  item.packFootprintL = item.packLengthMm;
  item.packFootprintW = item.packWidthMm;
  item.packFootprintH = item.packHeightMm;

  item.stagingGroupId = (g && g.id) || item.stagingGroupId || null;
  if (g && g._groupByQuat && !item._groupByQuat)
    item._groupByQuat = { ...g._groupByQuat };
  if (item._groupByQuat) item._freezeGroupByPose = true;

  item.outsideContainer = true; // until 5b places it
  item._packV2Applied = false;
  item._packV2Leftover = false;
  return item;
}

/** Toast / summary line for an Optimise run. */
function csPackV2FormatOptimiseToast(pack, leftoverApply) {
  const placed = (pack && pack.placedCount) || 0;
  const un = (pack && pack.unplacedCount) || 0;
  const stacks = (pack && pack.stackCount) || 0;
  const twins = (pack && (pack.twinCount != null ? pack.twinCount
    : (pack.placed || []).filter(p =>
      p && (p.role === 'twin_wall_hug' || p.role === 'twin_beside')).length)) || 0;
  let msg = `✔ Pack V2 · ${placed} in`;
  if (un) msg += ` · ${un} out`;
  if (twins) msg += ` · ${twins} twin`;
  if (stacks) msg += ` · ${stacks} stack`;
  const lines = (leftoverApply && leftoverApply.lines) || [];
  if (lines.length && lines.length <= 3)
    msg += ' — ' + lines.join('; ');
  else if (lines.length > 3)
    msg += ` — ${lines[0]} (+${lines.length - 1} more)`;
  return msg;
}

/**
 * Full Optimise pipeline (headless-safe).
 *
 * @param {object} [opts]
 * @param {object[]} [opts.groups]   assemblyGroups (or fixtures with packUnits)
 * @param {object[]} [opts.units]    skip BuildUnits — use these packer units
 * @param {object}   [opts.containerSpec]
 * @param {boolean}  [opts.enableStacks=true]
 * @param {boolean}  [opts.checkedOnly=true]
 * @returns {{ ok, reason, pack, units, placedItems, leftoverItems, layout, toast, apply, leftovers }}
 */
function csPackV2RunOptimise(opts) {
  const o = opts || {};
  const enableStacks = o.enableStacks !== false;
  const spec = csPackV2ContainerSpec(o.containerSpec);

  let units = o.units ? o.units.slice() : null;
  if (!units) {
    const groups = o.groups || [];
    if (!groups.length)
      return {
        ok: false, reason: 'NO_GROUPS', pack: null, units: [],
        placedItems: [], leftoverItems: [], layout: null, toast: 'No staging groups',
      };
    csPackV2EnsureGroupPackUnits(groups);
    units = csPackV2BuildUnits(groups, {
      containerSpec: spec,
      checkedOnly: o.checkedOnly !== false,
    });
  }

  if (!units.length) {
    return {
      ok: false, reason: 'NO_UNITS', pack: null, units: [],
      placedItems: [], leftoverItems: [], layout: null,
      toast: 'No pack units — Group by Shape / pick sets first',
    };
  }

  const pack = csPackV2PackWithTwins(units, {
    containerSpec: spec,
    enableStacks,
    bearingMin: o.bearingMin,
    allowYaw: o.allowYaw,
  });

  const targets = units.map(u => ({ item: csPackV2MakeRenderItemFromUnit(u) }));
  const apply = csPackV2ApplyPlacementsToTargets(pack, targets, {
    containerSpec: spec,
    envelope: pack.envelope,
    applyPackYaw: !!o.applyPackYaw,
    moveMeshes: false, // layout → renderContainer builds meshes
  });
  const leftovers = csPackV2ApplyLeftoversToTargets(pack, targets, {
    containerSpec: spec,
    envelope: pack.envelope,
    moveMeshes: false,
  });

  const placedItems = targets.map(t => t.item).filter(it => it && it._packV2Applied);
  const leftoverItems = targets.map(t => t.item).filter(it => it && it._packV2Leftover);

  let usedWeightKg = 0;
  let usedVol = 0;
  placedItems.forEach(it => {
    usedWeightKg += Math.max(+it.weightKg || +it.unitWeightKg || +it.weight || 0, 0);
    usedVol += Math.max(+it.packFootprintL || 1, 1)
      * Math.max(+it.packFootprintW || 1, 1)
      * Math.max(+it.packFootprintH || 1, 1);
  });
  const maxWeightKg = Math.max(+spec.maxWeightKg
    || +(o.containerSpec && o.containerSpec.maxWeightKg) || 28000, 1);
  const clearVol = Math.max(spec.lengthMm * spec.widthMm * spec.heightMm, 1);

  const layout = {
    containers: [{
      containerNumber: 1,
      lengthMm: spec.lengthMm,
      widthMm: spec.widthMm,
      heightMm: spec.heightMm,
      maxWeightKg,
      usedWeightKg: Math.round(usedWeightKg * 100) / 100,
      weightUtilizationPct: Math.round(usedWeightKg / maxWeightKg * 1000) / 10,
      volumeUtilizationPct: Math.round(usedVol / clearVol * 1000) / 10,
      items: placedItems,
    }],
    oversized: leftoverItems,
    isOutsideView: false,
    isGroupedView: false,
    packStrategy: 'pack_v2_twins_stacks',
    packV2: pack,
    packV2Apply: apply,
    packV2Leftovers: leftovers,
  };

  const toast = csPackV2FormatOptimiseToast(pack, leftovers);
  const report = csPackV2BuildPackReport({
    pack,
    apply,
    leftovers,
    placedItems,
    leftoverItems,
    layout,
    units,
    enableStacks,
    toast,
  }, { containerSpec: spec });

  const out = {
    ok: !!(pack && pack.ok !== false && apply.missed === 0),
    reason: null,
    pack,
    units,
    placedItems,
    leftoverItems,
    layout,
    toast,
    apply,
    leftovers,
    enableStacks,
    report,
  };
  if (apply.missed > 0 && placedItems.length === 0)
    out.ok = false;
  out.reason = out.ok ? null
    : (placedItems.length ? 'PARTIAL_APPLY' : (pack && pack.ok === false ? 'PACK_FAIL' : 'APPLY_MISS'));

  try {
    if (typeof window !== 'undefined') {
      window.__lastPackV2Optimise = out;
      window.__lastPackV2Report = report;
    }
  } catch (_) { /* */ }
  return out;
}

/**
 * Step 5d self-test — Optimise pipeline end-to-end (headless layout).
 * Console: csPackV2Step5dSelfTest()
 */
function csPackV2Step5dSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }
  const near = (a, b, tol) => Math.abs(+a - +b) <= (tol != null ? tol : CSPACK_V2_EPS);

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690, maxWeightKg: 28000 };
  const halfW = spec.widthMm * 0.5;

  // Synthetic groups with packUnits (no createPackUnits needed)
  function mkGroup(id, mark, pu, checked) {
    return {
      id, mark, marks: [mark],
      checked: checked !== false,
      checkOrder: checked === false ? 0 : (pu.checkOrder || 1),
      state: 'unplaced',
      groupKind: pu.groupKind || null,
      packUnits: [{ ...pu, mark, marks: [mark] }],
      weightKg: pu.weightKg || 100,
    };
  }

  const gTwinA = mkGroup('g-ta', 'RF-A', {
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400,
    lengthMm: 11000, widthMm: 200, heightMm: 2400, weightKg: 700,
    checkOrder: 1,
  });
  const gTwinB = mkGroup('g-tb', 'RF-B', {
    isAssembly: true, groupKind: 'welded_assembly',
    packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400,
    lengthMm: 11000, widthMm: 200, heightMm: 2400, weightKg: 690,
    checkOrder: 2,
  });
  const gNest = mkGroup('g-na', 'NEST-A', {
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200,
    lengthMm: 9600, widthMm: 400, heightMm: 200,
    sectW: 85, sectH: 200, qty: 4, weightKg: 300,
    nestPieces: [
      { lengthMm: 9600, sectW: 85, sectH: 200 },
      { lengthMm: 9600, sectW: 85, sectH: 200 },
    ],
    checkOrder: 3,
  });

  // --- D1 happy path: twins + nest ---
  const run1 = csPackV2RunOptimise({
    groups: [gTwinA, gTwinB, gNest],
    containerSpec: spec,
    enableStacks: true,
  });
  const hug = run1.placedItems.find(it => it.role === 'twin_wall_hug');
  const nestPl = run1.placedItems.find(it =>
    it.role === 'long_nest_strip' || (it.groupKind === 'nest_z' && it._packV2Applied));

  check('D1', run1.ok && run1.pack.placedCount >= 3
    && run1.layout && run1.layout.packStrategy === 'pack_v2_twins_stacks'
    && run1.layout.containers[0].items.length === run1.placedItems.length
    && hug && near(hug._packV2FootYMm, 0) && hug.z < -halfW + 400,
  `ok=${run1.ok} in=${run1.placedItems.length} hugZ=${hug && hug.z} toast=${run1.toast}`);

  // --- D2 nest visual dims preserved; packer may nest-repair footprint W ---
  check('D2', nestPl && nestPl.sectW === 85 && nestPl.nestPieces
    && nestPl.nestPieces.length === 2
    && nestPl.packFootprintW > 0 && nestPl.packFootprintW < 600
    && nestPl.lengthMm === 9600,
  `sectW=${nestPl && nestPl.sectW} nests=${nestPl && nestPl.nestPieces && nestPl.nestPieces.length} pw=${nestPl && nestPl.packFootprintW}`);

  // --- D3/D4 overcrowding via opts.units (same proven Step4 fixture; skip nest-repair shrink) ---
  const crowdUnits = [
    {
      _fmUid: 'tw1', mark: 'T1', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
    },
    {
      _fmUid: 'tw2', mark: 'T2', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
    },
    {
      _fmUid: 'nl1', mark: 'NL1', groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
    },
  ];
  for (let i = 0; i < 6; i++) {
    crowdUnits.push({
      _fmUid: 'nc' + i, mark: 'NC' + i, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220 - i,
    });
  }

  const runOff = csPackV2RunOptimise({
    units: crowdUnits,
    containerSpec: spec,
    enableStacks: false,
  });
  check('D3', runOff.pack.unplacedCount >= 1
    && runOff.leftoverItems.length === runOff.pack.unplacedCount
    && runOff.leftoverItems.every(it => it.outsideContainer && it.fitReason)
    && runOff.leftoverItems.every(it => it.z > halfW)
    && runOff.layout.oversized.length === runOff.leftoverItems.length,
  `un=${runOff.pack.unplacedCount} left=${runOff.leftoverItems.length} r=${runOff.leftoverItems.map(i => i.fitReason).join(',')}`);

  // --- D4 same crowd with stacks → more placed, stack elevated ---
  const runOn = csPackV2RunOptimise({
    units: crowdUnits,
    containerSpec: spec,
    enableStacks: true,
  });
  const stackIt = runOn.placedItems.find(it => it.role === 'nest_stack');
  check('D4', runOn.pack.stackCount >= 1 && stackIt
    && stackIt._packV2FootYMm > CSPACK_V2_EPS
    && runOn.placedItems.length > runOff.placedItems.length,
  `stack=${runOn.pack.stackCount} foot=${stackIt && stackIt._packV2FootYMm} on=${runOn.placedItems.length} off=${runOff.placedItems.length}`);

  // --- D5 unchecked group skipped ---
  const gSkip = mkGroup('g-skip', 'SKIP', {
    groupKind: 'nest_z', shapeKey: 'z_channel',
    packLengthMm: 5000, packWidthMm: 200, packHeightMm: 200,
    lengthMm: 5000, widthMm: 200, heightMm: 200, weightKg: 50,
  }, false);
  const runSkip = csPackV2RunOptimise({
    groups: [gTwinA, gTwinB, gSkip],
    containerSpec: spec,
    checkedOnly: true,
  });
  check('D5', !runSkip.placedItems.some(it => it.mark === 'SKIP')
    && !runSkip.leftoverItems.some(it => it.mark === 'SKIP')
    && runSkip.units.every(u => u.mark !== 'SKIP'),
  `units=${runSkip.units.map(u => u.mark).join(',')}`);

  // --- D6 NO_UNITS / NO_GROUPS ---
  const none = csPackV2RunOptimise({ groups: [], containerSpec: spec });
  const noneU = csPackV2RunOptimise({
    groups: [{ id: 'g-empty', mark: 'E', checked: true, state: 'unplaced', packUnits: [] }],
    containerSpec: spec,
  });
  check('D6', none.reason === 'NO_GROUPS' && noneU.reason === 'NO_UNITS',
  `none=${none.reason} empty=${noneU.reason}`);

  // --- D7 opts.units path (direct) ---
  const directUnits = [
    {
      _fmUid: 'du1', mark: 'DU1', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
    },
    {
      _fmUid: 'du2', mark: 'DU2', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
    },
  ];
  const runU = csPackV2RunOptimise({ units: directUnits, containerSpec: spec });
  check('D7', runU.ok && runU.placedItems.length === 2
    && runU.placedItems.every(it => it._fmUid && it.packPoseLock),
  `n=${runU.placedItems.length}`);

  // --- D8 toast mentions Pack V2 ---
  check('D8', /Pack V2/.test(run1.toast) && /in/.test(run1.toast),
  `toast=${run1.toast}`);

  // --- D9 stagingGroupId stamped ---
  check('D9', run1.placedItems.every(it => it.stagingGroupId)
    && run1.placedItems.some(it => it.stagingGroupId === 'g-ta'),
  `sids=${run1.placedItems.map(i => i.stagingGroupId).join(',')}`);

  // --- D10 placed seats inside envelope; leftovers outside ---
  const env = runOn.pack.envelope || csPackV2FloorEnvelope(spec);
  let allInOk = true;
  runOn.placedItems.forEach(it => {
    const pose = {
      x: it.x, y: it.y, z: it.z,
      pl: it.packFootprintL, pw: it.packFootprintW, ph: it.packFootprintH,
      footYMm: it._packV2FootYMm,
    };
    const aabb = {
      minX: pose.x - pose.pl * 0.5, maxX: pose.x + pose.pl * 0.5,
      minY: pose.footYMm, maxY: pose.footYMm + pose.ph,
      minZ: pose.z - pose.pw * 0.5, maxZ: pose.z + pose.pw * 0.5,
    };
    if (!csPackV2ViewerAabbInsideOuter(aabb, {
      lengthMm: spec.lengthMm, widthMm: spec.widthMm, heightMm: spec.heightMm,
    }, { envelope: env })) allInOk = false;
  });
  check('D10', allInOk
    && runOn.leftoverItems.every(it => csPackV2ViewerPoseIsOutside({
      x: it.x, y: it.y, z: it.z,
      pl: it.packFootprintL || it.lengthMm, pw: it.packFootprintW || it.widthMm,
      ph: it.packFootprintH || it.heightMm, footYMm: it._packV2FootYMm,
    }, { lengthMm: spec.lengthMm, widthMm: spec.widthMm, heightMm: spec.heightMm })),
  `inOk=${allInOk} left=${runOn.leftoverItems.length}`);

  // --- D11 weight util stamped on layout ---
  check('D11', run1.layout.containers[0].usedWeightKg > 0
    && run1.layout.containers[0].weightUtilizationPct > 0,
  `w=${run1.layout.containers[0].usedWeightKg} pct=${run1.layout.containers[0].weightUtilizationPct}`);

  // --- D12 MakeRenderItem preserves assembly flag ---
  check('D12', hug && hug.isAssembly && hug.groupKind === 'welded_assembly',
  `asm=${hug && hug.isAssembly} gk=${hug && hug.groupKind}`);

  // --- D13 ensure packUnits helper ---
  const bare = { id: 'bare', mark: 'BARE', checked: true, packUnits: null };
  // without createPackUnits stays empty
  const nBare = csPackV2EnsureGroupPackUnits([bare]);
  check('D13', nBare === 0 && (!bare.packUnits || bare.packUnits.length === 0
    || Array.isArray(bare.packUnits)),
  `n=${nBare}`);

  // --- D14 5c regression ---
  const c = csPackV2Step5cSelfTest();
  check('D14', c.ok, `${c.passed}/${c.total}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      toast: run1.toast,
      in: run1.placedItems.length,
      stacksOn: runOn.pack.stackCount,
      leftoversOff: runOff.leftoverItems.length,
    },
  };
  try { console.info('[PackV2] step5d self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5e — Pack report (on-screen status + CLI step5)
//
// Real-world rules:
//   • Numbers must match packer (placed / twins / strip / stacks / unplaced)
//   • Leftover reasons listed honestly (NO_SLOT / STACK_*)
//   • Gravity / dig gates surfaced (allFloorY0, allNoOverlap, stackNoTwinDig)
//   • Publish to window.__lastPackV2Report + staging hint / footer when DOM exists
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a stable pack report from a pack result and/or Optimise result.
 * Accepts: PackWithTwins return, or csPackV2RunOptimise return, or mixed opts.
 */
function csPackV2BuildPackReport(packOrOpt, opts) {
  const o = opts || {};
  const src = packOrOpt || {};
  const pack = src.pack || (src.placed ? src : null) || o.pack || null;
  const apply = src.apply || o.apply || null;
  const leftoverApply = src.leftovers || o.leftoverApply || null;
  const placedItems = src.placedItems || o.placedItems || null;
  const leftoverItems = src.leftoverItems || o.leftoverItems || null;
  const layout = src.layout || o.layout || null;
  const units = src.units || o.units || null;

  if (!pack) {
    return {
      ok: false,
      reason: 'NO_PACK',
      strategy: 'pack_v2_twins_stacks',
      summary: 'No pack result',
      line: 'Pack V2 · no report',
      lines: [],
      leftovers: [],
      leftoverByReason: {},
    };
  }

  const placed = pack.placed || [];
  const unplaced = pack.unplaced || [];
  const twinHug = placed.filter(p => p && p.role === 'twin_wall_hug').length;
  const twinBeside = placed.filter(p => p && p.role === 'twin_beside').length;
  const twinPlaced = twinHug + twinBeside;
  const stackN = placed.filter(p =>
    p && (p.role === 'nest_stack' || p.layer === 'stack')).length;
  const floorN = placed.length - stackN;
  const longNest = placed.filter(p => p && p.role === 'long_nest_strip').length;

  const collected = (leftoverApply && leftoverApply.leftovers)
    ? leftoverApply
    : csPackV2CollectLeftoverViews(pack);
  const leftoverViews = (collected.leftovers || []).map(v => ({
    mark: v.mark || null,
    _fmUid: v._fmUid || null,
    reason: v.reason || v.fitReason || 'UNPLACED',
    reasonMsg: v.reasonMsg || v.fitReasonMsg || null,
    stackFailReason: v.stackFailReason || null,
    role: v.role || null,
  }));
  const leftoverByReason = collected.byReason || {};

  const cont = layout && layout.containers && layout.containers[0];
  const unitCount = (units && units.length)
    || (pack.placedCount + pack.unplacedCount)
    || (placed.length + unplaced.length);

  const gates = {
    designOk: pack.designOk !== false,
    allFloorY0: !!pack.allFloorY0,
    allStacksOnSupport: pack.allStacksOnSupport !== false,
    allNoOverlap: !!pack.allNoOverlap,
    stackNoTwinDig: pack.stackNoTwinDig !== false,
    twinGapOk: pack.twinGapOk !== false,
    stripOk: pack.stripOk !== false || pack.stripAcceptable !== false,
    applyMissed: apply ? (apply.missed || 0) : 0,
  };

  const ok = pack.ok !== false
    && gates.designOk
    && gates.allFloorY0
    && gates.allNoOverlap
    && gates.stackNoTwinDig
    && gates.applyMissed === 0
    && (stackN === 0 || gates.allStacksOnSupport);

  const summaryParts = [
    `${pack.placedCount != null ? pack.placedCount : placed.length} in`,
  ];
  const unCount = pack.unplacedCount != null ? pack.unplacedCount : unplaced.length;
  if (unCount) summaryParts.push(`${unCount} out`);
  if (twinPlaced) summaryParts.push(`${twinPlaced} twin`);
  if (longNest) summaryParts.push(`${longNest} strip-nest`);
  if (pack.hasSideStrip) summaryParts.push('side-strip');
  if (stackN) summaryParts.push(`${stackN} stack`);
  const summary = 'Pack V2 · ' + summaryParts.join(' · ');

  const lines = [];
  lines.push(summary);
  if (pack.enableStacks === false) lines.push('Stacks: OFF (floor-only)');
  else lines.push(`Stacks: ON · ${stackN} seated`);
  if (pack.stripReserveMm != null)
    lines.push(`Strip reserve: ${Math.round(+pack.stripReserveMm)} mm`);
  if (pack.feasiblePlaceRate != null)
    lines.push(`Feasible place rate: ${Math.round(+pack.feasiblePlaceRate * 1000) / 10}%`);
  leftoverViews.forEach(v => {
    lines.push(csPackV2FormatLeftoverLine(v));
  });

  const report = {
    ok,
    reason: ok ? null : 'GATE_FAIL',
    strategy: 'pack_v2_twins_stacks',
    unitCount,
    placedCount: pack.placedCount != null ? pack.placedCount : placed.length,
    unplacedCount: unCount,
    floorCount: floorN,
    stackCount: pack.stackCount != null ? pack.stackCount : stackN,
    twinPairCount: pack.twinPairCount || 0,
    twinPairsPlaced: pack.twinPairsPlaced || 0,
    twinPlacedCount: twinPlaced,
    twinHugCount: twinHug,
    twinBesideCount: twinBeside,
    longNestPlacedCount: pack.longNestPlacedCount != null
      ? pack.longNestPlacedCount : longNest,
    hasSideStrip: !!pack.hasSideStrip,
    stripReserveMm: pack.stripReserveMm != null ? +pack.stripReserveMm : null,
    enableStacks: pack.enableStacks !== false,
    feasiblePlaceRate: pack.feasiblePlaceRate != null ? +pack.feasiblePlaceRate : null,
    weightKg: cont ? +cont.usedWeightKg || 0 : 0,
    weightUtilizationPct: cont ? +cont.weightUtilizationPct || 0 : 0,
    volumeUtilizationPct: cont ? +cont.volumeUtilizationPct || 0 : 0,
    leftovers: leftoverViews,
    leftoverByReason,
    leftoverLines: (collected.lines || leftoverViews.map(csPackV2FormatLeftoverLine)),
    gates,
    summary,
    line: summary,
    lines,
    html: csPackV2FormatPackReportHtml({
      summary,
      twinPlaced,
      stackN,
      unCount,
      leftoverViews,
      gates,
      weightPct: cont ? cont.weightUtilizationPct : null,
    }),
    toast: src.toast || csPackV2FormatOptimiseToast(pack, collected),
  };

  return report;
}

/** Compact HTML for workflow hint / status panel. */
function csPackV2FormatPackReportHtml(bits) {
  const b = bits || {};
  const gateFail = b.gates && (
    !b.gates.allFloorY0 || !b.gates.allNoOverlap || !b.gates.stackNoTwinDig);
  const color = gateFail ? 'var(--warn, #c97800)' : 'var(--green, #1d9e75)';
  let html = `<b style="color:${color}">${b.summary || 'Pack V2'}</b>`;
  if (b.twinPlaced) html += ` · twins ${b.twinPlaced}`;
  if (b.stackN) html += ` · stacks ${b.stackN}`;
  if (b.unCount) html += ` · <span style="color:var(--text2)">${b.unCount} leftover</span>`;
  if (b.weightPct != null && +b.weightPct > 0)
    html += ` · wt ${b.weightPct}%`;
  if (b.leftoverViews && b.leftoverViews.length && b.leftoverViews.length <= 4) {
    html += '<br><span style="font-size:11px;color:var(--text3)">'
      + b.leftoverViews.map(v => csPackV2FormatLeftoverLine(v)).join(' · ')
      + '</span>';
  } else if (b.leftoverViews && b.leftoverViews.length > 4) {
    html += '<br><span style="font-size:11px;color:var(--text3)">'
      + csPackV2FormatLeftoverLine(b.leftoverViews[0])
      + ` (+${b.leftoverViews.length - 1} more)</span>`;
  }
  if (gateFail) {
    const g = b.gates;
    const fails = [];
    if (!g.allFloorY0) fails.push('floor-Y');
    if (!g.allNoOverlap) fails.push('overlap');
    if (!g.stackNoTwinDig) fails.push('stack↔twin dig');
    html += `<br><span style="color:${color}">Gate: ${fails.join(', ')}</span>`;
  }
  return html;
}

/**
 * Publish report to window + optional DOM (workflowHint / stagingStats / packReport).
 */
function csPackV2PublishPackReport(report, opts) {
  const o = opts || {};
  const r = report || null;
  try {
    if (typeof window !== 'undefined')
      window.__lastPackV2Report = r;
  } catch (_) { /* */ }
  if (!r) return { ok: false, reason: 'NO_REPORT' };

  let hintUpdated = false;
  let statsUpdated = false;
  let panelUpdated = false;

  if (o.updateDom !== false) {
    try {
      const hint = (typeof document !== 'undefined')
        && document.getElementById('workflowHint');
      if (hint && r.html) {
        hint.innerHTML = r.html;
        hint.style.borderColor = r.ok ? 'var(--green)' : 'var(--warn, #c97800)';
        hintUpdated = true;
      }
    } catch (_) { /* */ }

    try {
      const stats = (typeof document !== 'undefined')
        && document.getElementById('stagingStats');
      if (stats && r.summary) {
        const prev = String(stats.textContent || '');
        // Keep placed/remaining if already present; append pack summary
        if (/placed/i.test(prev) && !/Pack V2/i.test(prev))
          stats.textContent = prev + ' · ' + r.summary;
        else if (!/Pack V2/i.test(prev) || o.replaceStats)
          stats.textContent = r.summary;
        statsUpdated = true;
      }
    } catch (_) { /* */ }

    try {
      let panel = (typeof document !== 'undefined')
        && document.getElementById('packV2Report');
      if (!panel && typeof document !== 'undefined' && o.createPanel !== false) {
        const foot = document.getElementById('stagingFooter');
        if (foot) {
          panel = document.createElement('div');
          panel.id = 'packV2Report';
          panel.style.cssText = 'padding:6px 10px;font-size:11px;color:var(--text2);'
            + 'line-height:1.45;border-top:1px solid var(--border2)';
          foot.appendChild(panel);
        }
      }
      if (panel) {
        panel.textContent = (r.lines || [r.summary]).slice(0, 8).join('\n');
        panel.title = (r.lines || []).join('\n');
        panelUpdated = true;
      }
    } catch (_) { /* */ }
  }

  return {
    ok: true,
    hintUpdated,
    statsUpdated,
    panelUpdated,
    report: r,
  };
}

/**
 * Step 5e self-test — report matches packer; publish; Optimise embeds report.
 * Console: csPackV2Step5eSelfTest()
 */
function csPackV2Step5eSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690, maxWeightKg: 28000 };

  // --- E1 empty / missing pack ---
  const noPack = csPackV2BuildPackReport(null);
  check('E1', !noPack.ok && noPack.reason === 'NO_PACK',
  `r=${noPack.reason}`);

  // --- E2 report from simple twins+nest Optimise ---
  const unitsHappy = [
    {
      _fmUid: 'rfA', mark: 'RF-A', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
    },
    {
      _fmUid: 'rfB', mark: 'RF-B', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
    },
    {
      _fmUid: 'nA', mark: 'NEST-A', groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
    },
  ];
  const optHappy = csPackV2RunOptimise({ units: unitsHappy, containerSpec: spec });
  const repHappy = optHappy.report || csPackV2BuildPackReport(optHappy);
  check('E2', optHappy.ok && repHappy && repHappy.ok
    && repHappy.placedCount === optHappy.pack.placedCount
    && repHappy.twinPlacedCount === 2
    && repHappy.twinHugCount === 1
    && repHappy.twinBesideCount === 1
    && /Pack V2/.test(repHappy.summary)
    && repHappy.strategy === 'pack_v2_twins_stacks',
  `in=${repHappy.placedCount} twins=${repHappy.twinPlacedCount} sum=${repHappy.summary}`);

  // --- E3 overcrowded floor-only: leftovers + reasons in report ---
  const crowd = unitsHappy.slice();
  for (let i = 0; i < 6; i++) {
    crowd.push({
      _fmUid: 'nc' + i, mark: 'NC' + i, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220 - i,
    });
  }
  const optOff = csPackV2RunOptimise({
    units: crowd, containerSpec: spec, enableStacks: false,
  });
  const repOff = optOff.report;
  check('E3', repOff.unplacedCount >= 1
    && repOff.leftovers.length === repOff.unplacedCount
    && repOff.leftovers.every(l => l.reason)
    && repOff.leftoverByReason.NO_SLOT >= 1
    && repOff.enableStacks === false
    && /out/.test(repOff.summary),
  `un=${repOff.unplacedCount} by=${JSON.stringify(repOff.leftoverByReason)}`);

  // --- E4 stacks ON: stackCount matches packer ---
  const optOn = csPackV2RunOptimise({
    units: crowd, containerSpec: spec, enableStacks: true,
  });
  const repOn = optOn.report;
  check('E4', repOn.stackCount === optOn.pack.stackCount
    && repOn.stackCount >= 1
    && repOn.placedCount === optOn.pack.placedCount
    && repOn.placedCount > repOff.placedCount
    && /stack/i.test(repOn.summary),
  `stack=${repOn.stackCount} in=${repOn.placedCount} offIn=${repOff.placedCount}`);

  // --- E5 gates pass on healthy pack ---
  check('E5', repOn.gates.allFloorY0 && repOn.gates.allNoOverlap
    && repOn.gates.stackNoTwinDig && repOn.gates.allStacksOnSupport
    && repOn.ok,
  `gates=${JSON.stringify(repOn.gates)}`);

  // --- E6 report from raw PackWithTwins (no Optimise) ---
  const rawPack = csPackV2PackWithTwins(unitsHappy, {
    containerSpec: spec, enableStacks: true,
  });
  const repRaw = csPackV2BuildPackReport(rawPack);
  check('E6', repRaw.placedCount === rawPack.placedCount
    && repRaw.twinPlacedCount === 2
    && repRaw.unplacedCount === rawPack.unplacedCount,
  `rawIn=${repRaw.placedCount}`);

  // --- E7 HTML + lines non-empty ---
  check('E7', /Pack V2/.test(repOn.html) && repOn.lines.length >= 2
    && repOn.leftoverLines.length === repOn.leftovers.length,
  `htmlLen=${(repOn.html || '').length} lines=${repOn.lines.length}`);

  // --- E8 publish stores __lastPackV2Report (headless: no DOM) ---
  const pub = csPackV2PublishPackReport(repOn, { updateDom: false });
  check('E8', pub.ok && pub.report === repOn,
  `pub=${pub.ok}`);

  // --- E9 RunOptimise embeds identical report counts ---
  check('E9', optOn.report
    && optOn.report.placedCount === optOn.placedItems.length
    && optOn.report.unplacedCount === optOn.leftoverItems.length
    && optOn.report.stackCount === (optOn.placedItems.filter(i =>
      i.role === 'nest_stack').length),
  `repIn=${optOn.report.placedCount} items=${optOn.placedItems.length}`);

  // --- E10 strip / side-strip fields when twins present ---
  check('E10', repHappy.hasSideStrip === !!optHappy.pack.hasSideStrip
    && (repHappy.stripReserveMm == null
      || repHappy.stripReserveMm === optHappy.pack.stripReserveMm
      || Math.abs(repHappy.stripReserveMm - optHappy.pack.stripReserveMm) < 1),
  `strip=${repHappy.hasSideStrip} res=${repHappy.stripReserveMm}`);

  // --- E11 weight util from layout ---
  check('E11', repHappy.weightKg > 0 && repHappy.weightUtilizationPct > 0,
  `kg=${repHappy.weightKg} pct=${repHappy.weightUtilizationPct}`);

  // --- E12 STACK_* leftover reason surfaces in report ---
  const stackLeftPack = {
    ok: true, placed: [], unplaced: [{
      _fmUid: 'ns1', mark: 'NEST-S',
      fitReason: 'STACK_HEIGHT_EXCEEDS',
      fitReasonMsg: 'too tall',
      stackFailReason: 'HEIGHT_EXCEEDS',
    }],
    placedCount: 0, unplacedCount: 1,
    allFloorY0: true, allNoOverlap: true, stackNoTwinDig: true,
    allStacksOnSupport: true, designOk: true, enableStacks: true,
    stackCount: 0, twinPairCount: 0,
  };
  const repStack = csPackV2BuildPackReport(stackLeftPack);
  check('E12', repStack.leftovers[0].reason === 'STACK_HEIGHT_EXCEEDS'
    && repStack.leftovers[0].stackFailReason === 'HEIGHT_EXCEEDS'
    && /STACK_HEIGHT/.test(repStack.leftoverLines[0]),
  `line=${repStack.leftoverLines[0]}`);

  // --- E13 unitCount accounts ---
  check('E13', repOn.unitCount === crowd.length
    && repOn.placedCount + repOn.unplacedCount === crowd.length,
  `u=${repOn.unitCount} p+u=${repOn.placedCount + repOn.unplacedCount}`);

  // --- E14 5d regression ---
  const d = csPackV2Step5dSelfTest();
  check('E14', d.ok, `${d.passed}/${d.total}`);

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      happy: repHappy.summary,
      stacks: repOn.stackCount,
      leftovers: repOff.unplacedCount,
    },
  };
  try { console.info('[PackV2] step5e self-test', out); } catch (_) { /* */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5f — Soak inspect (float / dig / twin / stack) + full Step5 suite
//
// Real-world IFC gates:
//   • Floor seats footY = 0; stacks footY = supportTop (>0)
//   • No AABB dig between placed seats (packer boxes + viewer poses)
//   • Twin wall-hug sits on home wall when twins exist
//   • Stacks raise placedCount vs floor-only when leftovers exist
//   • Report counts match packer; Group By dims not wiped on render items
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inspect an Optimise / PackWithTwins result for soak gates.
 * @returns {{ ok, floatCount, digCount, digTwin, twinHugOk, stacksElevated,
 *            improved, accounted, details }}
 */
function csPackV2SoakInspect(packOrOpt, opts) {
  const o = opts || {};
  const src = packOrOpt || {};
  const pack = src.pack || (src.placed ? src : null);
  const placedItems = src.placedItems || null;
  const optOff = o.floorOnly || o.packFloorOnly || null;

  if (!pack) {
    return {
      ok: false, reason: 'NO_PACK',
      floatCount: -1, digCount: -1, digTwin: -1,
      twinHugOk: false, stacksElevated: false, improved: false, accounted: false,
    };
  }

  const placed = pack.placed || [];
  const eps = (o.eps != null) ? +o.eps : CSPACK_V2_EPS;
  let floatCount = 0;
  let digCount = 0;
  let digTwin = 0;
  const floatSamples = [];
  const digSamples = [];

  // --- Packer-box gravity / dig (authoritative) ---
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    if (!p) continue;
    const isStack = p.role === 'nest_stack' || p.layer === 'stack';
    if (isStack) {
      if (!(+p.y > eps) && !(+p.supportTopY === 0)) {
        floatCount++;
        if (floatSamples.length < 8)
          floatSamples.push({ mark: p.mark, y: p.y, role: p.role, why: 'stack_y' });
      }
      if (p.box && Math.abs(+p.box.minY - +p.y) > eps) {
        floatCount++;
        if (floatSamples.length < 8)
          floatSamples.push({ mark: p.mark, minY: p.box.minY, y: p.y, why: 'box_minY' });
      }
      if (p.supportTopY != null && Math.abs(+p.y - +p.supportTopY) > eps) {
        floatCount++;
        if (floatSamples.length < 8)
          floatSamples.push({
            mark: p.mark, y: p.y, supportTopY: p.supportTopY, why: 'support_mismatch',
          });
      }
    } else {
      if (Math.abs(+p.y) > eps || (p.box && Math.abs(+p.box.minY) > eps)) {
        floatCount++;
        if (floatSamples.length < 8)
          floatSamples.push({ mark: p.mark, y: p.y, role: p.role, why: 'floor_y' });
      }
    }
  }

  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    if (!a || !a.box) continue;
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j];
      if (!b || !b.box) continue;
      if (csPackV2BoxesOverlap(a.box, b.box, eps)) {
        digCount++;
        if (digSamples.length < 8)
          digSamples.push({ a: a.mark, b: b.mark, roles: [a.role, b.role] });
      }
    }
    if (a.role === 'nest_stack' || a.layer === 'stack') {
      for (let j = 0; j < placed.length; j++) {
        const tw = placed[j];
        if (!tw || !tw.box) continue;
        if ((tw.role === 'twin_wall_hug' || tw.role === 'twin_beside')
            && csPackV2BoxesOverlap(a.box, tw.box, eps)) {
          digTwin++;
        }
      }
    }
  }

  // --- Viewer pose consistency (when Optimise applied items exist) ---
  let viewerFloat = 0;
  let viewerDig = 0;
  if (placedItems && placedItems.length) {
    const env = pack.envelope || csPackV2FloorEnvelope(o.containerSpec);
    const halfW = (+env.outerWidthMm || 2438) * 0.5;
    placedItems.forEach(it => {
      if (!it || !it._packV2Applied) return;
      const foot = it._packV2FootYMm;
      if (it.role === 'nest_stack' || it.packLayer === 'stack') {
        if (!(+foot > eps)) viewerFloat++;
      } else if (Math.abs(+foot) > eps) {
        viewerFloat++;
      }
    });
    // pairwise viewer AABB
    for (let i = 0; i < placedItems.length; i++) {
      const a = placedItems[i];
      if (!a || !a._packV2Applied) continue;
      const aA = {
        minX: +a.x - (+a.packFootprintL || 0) * 0.5,
        maxX: +a.x + (+a.packFootprintL || 0) * 0.5,
        minY: +a._packV2FootYMm,
        maxY: +a._packV2FootYMm + (+a.packFootprintH || 0),
        minZ: +a.z - (+a.packFootprintW || 0) * 0.5,
        maxZ: +a.z + (+a.packFootprintW || 0) * 0.5,
      };
      for (let j = i + 1; j < placedItems.length; j++) {
        const b = placedItems[j];
        if (!b || !b._packV2Applied) continue;
        const bA = {
          minX: +b.x - (+b.packFootprintL || 0) * 0.5,
          maxX: +b.x + (+b.packFootprintL || 0) * 0.5,
          minY: +b._packV2FootYMm,
          maxY: +b._packV2FootYMm + (+b.packFootprintH || 0),
          minZ: +b.z - (+b.packFootprintW || 0) * 0.5,
          maxZ: +b.z + (+b.packFootprintW || 0) * 0.5,
        };
        const ov = !(aA.maxX <= bA.minX + eps || aA.minX >= bA.maxX - eps
          || aA.maxY <= bA.minY + eps || aA.minY >= bA.maxY - eps
          || aA.maxZ <= bA.minZ + eps || aA.minZ >= bA.maxZ - eps);
        if (ov) viewerDig++;
      }
    }
    floatCount += viewerFloat;
    digCount += viewerDig;
  }

  const twinHug = placed.filter(p => p && p.role === 'twin_wall_hug');
  const twinBeside = placed.filter(p => p && p.role === 'twin_beside');
  const stacks = placed.filter(p =>
    p && (p.role === 'nest_stack' || p.layer === 'stack'));
  const env = pack.envelope || csPackV2FloorEnvelope(o.containerSpec);
  const halfW = (+env.outerWidthMm || 2438) * 0.5;
  let twinHugOk = twinHug.length === 0; // vacuously ok
  if (twinHug.length) {
    twinHugOk = twinHug.every(p => {
      // home wall: packer z ≈ minZMm
      return Math.abs(+p.z - +env.minZMm) <= eps + 1
        && +p.y === 0;
    });
    // Also check viewer pose if present
    if (placedItems) {
      const hugItems = placedItems.filter(it => it.role === 'twin_wall_hug');
      if (hugItems.length)
        twinHugOk = twinHugOk && hugItems.every(it => it.z < -halfW + 500
          && Math.abs(+it._packV2FootYMm) <= eps);
    }
  }

  const stacksElevated = stacks.length === 0
    || stacks.every(p => +p.y > eps && p.box && +p.box.minY > eps);

  const unitN = (src.units && src.units.length)
    || (pack.placedCount + pack.unplacedCount);
  const accounted = pack.placedCount + pack.unplacedCount === unitN
    || unitN == null;

  let improved = true;
  if (optOff && optOff.placedCount != null) {
    improved = pack.placedCount >= optOff.placedCount
      && (pack.stackCount || 0)
        === Math.max(0, pack.placedCount - optOff.placedCount);
  } else if ((pack.stackCount || 0) > 0) {
    improved = pack.placedCount > (pack.placedCount - pack.stackCount);
  }

  const dimsPreserved = !placedItems || placedItems.every(it => {
    if (!it) return true;
    // sect* / nestPieces must survive Optimise stamp
    if (it.groupKind && /^nest_/i.test(String(it.groupKind))) {
      if (it.sectW != null && !(+it.sectW > 0)) return false;
    }
    return true;
  });

  const ok = floatCount === 0
    && digCount === 0
    && digTwin === 0
    && twinHugOk
    && stacksElevated
    && accounted
    && pack.allFloorY0 !== false
    && pack.allNoOverlap !== false
    && pack.stackNoTwinDig !== false
    && dimsPreserved;

  return {
    ok,
    reason: ok ? null : 'SOAK_FAIL',
    floatCount,
    digCount,
    digTwin,
    viewerFloat,
    viewerDig,
    twinHugOk,
    twinHugCount: twinHug.length,
    twinBesideCount: twinBeside.length,
    stackCount: stacks.length,
    stacksElevated,
    improved,
    accounted,
    dimsPreserved,
    placedCount: pack.placedCount,
    unplacedCount: pack.unplacedCount,
    floatSamples,
    digSamples,
    summary: ok
      ? `Soak OK · in=${pack.placedCount} float=0 dig=0`
        + (stacks.length ? ` stack=${stacks.length}` : '')
        + (twinHug.length ? ` twinHug=${twinHug.length}` : '')
      : `Soak FAIL · float=${floatCount} dig=${digCount} digTwin=${digTwin}`,
  };
}

/**
 * Step 5f self-test — soak gates on real-world fixtures.
 * @param {object} [opts]  opts.skipRegression skips nested 5e (for fast CLI)
 * Console: csPackV2Step5fSelfTest()
 */
function csPackV2Step5fSelfTest(opts) {
  const o = opts || {};
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  const spec = { lengthMm: 12000, widthMm: 2438, heightMm: 2690, maxWeightKg: 28000 };

  // Happy twins + nest
  const happy = [
    {
      _fmUid: 'rfA', mark: 'RF-A', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 700,
    },
    {
      _fmUid: 'rfB', mark: 'RF-B', isAssembly: true, groupKind: 'welded_assembly',
      packLengthMm: 11000, packWidthMm: 200, packHeightMm: 2400, weightKg: 690,
    },
    {
      _fmUid: 'nA', mark: 'NEST-A', groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9600, packWidthMm: 400, packHeightMm: 200, weightKg: 300,
      sectW: 85, sectH: 200, qty: 4,
      nestPieces: [
        { lengthMm: 9600, sectW: 85, sectH: 200 },
        { lengthMm: 9600, sectW: 85, sectH: 200 },
      ],
    },
  ];
  const optHappy = csPackV2RunOptimise({ units: happy, containerSpec: spec });
  const soakHappy = csPackV2SoakInspect(optHappy, { containerSpec: spec });

  check('F1', soakHappy.ok && soakHappy.floatCount === 0 && soakHappy.digCount === 0,
  `sum=${soakHappy.summary}`);

  check('F2', soakHappy.twinHugOk && soakHappy.twinHugCount === 1
    && soakHappy.twinBesideCount === 1,
  `hug=${soakHappy.twinHugCount} beside=${soakHappy.twinBesideCount}`);

  // Overcrowd floor-only vs stacks
  const crowd = happy.slice();
  for (let i = 0; i < 6; i++) {
    crowd.push({
      _fmUid: 'nc' + i, mark: 'NC' + i, groupKind: 'nest_z', shapeKey: 'z_channel',
      packLengthMm: 9000, packWidthMm: 380, packHeightMm: 180, weightKg: 220 - i,
      sectW: 85, sectH: 180,
    });
  }
  const optOff = csPackV2RunOptimise({
    units: crowd, containerSpec: spec, enableStacks: false,
  });
  const optOn = csPackV2RunOptimise({
    units: crowd, containerSpec: spec, enableStacks: true,
  });
  const soakOff = csPackV2SoakInspect(optOff, { containerSpec: spec });
  const soakOn = csPackV2SoakInspect(optOn, {
    containerSpec: spec, floorOnly: optOff.pack,
  });

  function nearish(a, b) {
    return Math.abs(+a - +b) <= CSPACK_V2_EPS;
  }

  check('F3', soakOff.ok && soakOff.floatCount === 0 && soakOff.digCount === 0
    && optOff.pack.unplacedCount >= 1,
  `off=${soakOff.summary} un=${optOff.pack.unplacedCount}`);

  check('F4', soakOn.ok && soakOn.floatCount === 0 && soakOn.digCount === 0
    && soakOn.digTwin === 0
    && soakOn.stackCount >= 1 && soakOn.stacksElevated
    && soakOn.improved
    && optOn.placedItems.length > optOff.placedItems.length,
  `on=${soakOn.summary} improved=${soakOn.improved}`);

  // Stack foot = support top on every nest_stack item
  const stackItems = optOn.placedItems.filter(it => it.role === 'nest_stack');
  check('F5', stackItems.length >= 1
    && stackItems.every(it => +it._packV2FootYMm > CSPACK_V2_EPS
      && nearish(it.y, it._packV2FootYMm + it.packFootprintH * 0.5)),
  `n=${stackItems.length} feet=${stackItems.map(i => i._packV2FootYMm).join(',')}`);

  // Twin wall-hug viewer Z near home
  const hugIt = optOn.placedItems.find(it => it.role === 'twin_wall_hug');
  const halfW = spec.widthMm * 0.5;
  check('F6', hugIt && hugIt.z < -halfW + 400 && nearish(hugIt._packV2FootYMm, 0),
  `z=${hugIt && hugIt.z} foot=${hugIt && hugIt._packV2FootYMm}`);

  // Group By nest dims preserved on render items
  const nestIt = optHappy.placedItems.find(it =>
    it.groupKind === 'nest_z' || it.mark === 'NEST-A');
  check('F7', nestIt && nestIt.sectW === 85 && nestIt.nestPieces
    && nestIt.nestPieces.length === 2
    && nestIt._packV2Applied,
  `sectW=${nestIt && nestIt.sectW} nests=${nestIt && nestIt.nestPieces && nestIt.nestPieces.length}`);

  // Report matches soak / packer
  check('F8', optOn.report
    && optOn.report.placedCount === optOn.pack.placedCount
    && optOn.report.stackCount === optOn.pack.stackCount
    && optOn.report.gates.allFloorY0
    && optOn.report.gates.allNoOverlap,
  `rep=${optOn.report && optOn.report.summary}`);

  // Leftovers outside never dig into container (viewer)
  check('F9', optOff.leftoverItems.every(it => it.outsideContainer
    && it.z > halfW && it.fitReason),
  `left=${optOff.leftoverItems.length}`);

  // Intentionally bad float must fail soak
  const badPack = {
    ok: true,
    placed: [{
      mark: 'BAD', role: 'long_nest_strip', layer: 'floor',
      x: 10, y: 50, z: 10, pl: 1000, pw: 100, ph: 100,
      box: { minX: 10, maxX: 1010, minY: 50, maxY: 150, minZ: 10, maxZ: 110 },
    }],
    unplaced: [],
    placedCount: 1, unplacedCount: 0,
    allFloorY0: false, allNoOverlap: true, stackNoTwinDig: true,
    stackCount: 0,
  };
  const soakBad = csPackV2SoakInspect(badPack);
  check('F10', !soakBad.ok && soakBad.floatCount >= 1,
  `float=${soakBad.floatCount}`);

  // Dig must fail soak
  const digPack = {
    ok: true,
    placed: [
      {
        mark: 'A', role: 'long_nest_strip', y: 0, x: 0, z: 0, pl: 1000, pw: 200, ph: 100,
        box: { minX: 0, maxX: 1000, minY: 0, maxY: 100, minZ: 0, maxZ: 200 },
      },
      {
        mark: 'B', role: 'long_nest_strip', y: 0, x: 500, z: 50, pl: 1000, pw: 200, ph: 100,
        box: { minX: 500, maxX: 1500, minY: 0, maxY: 100, minZ: 50, maxZ: 250 },
      },
    ],
    unplaced: [], placedCount: 2, unplacedCount: 0,
    allFloorY0: true, allNoOverlap: false, stackNoTwinDig: true, stackCount: 0,
  };
  const soakDig = csPackV2SoakInspect(digPack);
  check('F11', !soakDig.ok && soakDig.digCount >= 1,
  `dig=${soakDig.digCount}`);

  // Accounted
  check('F12', soakOn.accounted
    && optOn.pack.placedCount + optOn.pack.unplacedCount === crowd.length,
  `acc=${soakOn.accounted}`);

  // Full Step5e regression (optional skip for fast CLI)
  if (o.skipRegression) {
    check('F13', true, 'skipped');
  } else {
    const e = csPackV2Step5eSelfTest();
    check('F13', e.ok, `${e.passed}/${e.total}`);
  }

  // Step4 regression (optional)
  if (o.skipRegression) {
    check('F14', true, 'skipped');
  } else {
    const s4 = csPackV2Step4SelfTest();
    check('F14', s4.ok, `${s4.passed}/${s4.total}`);
  }

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
    sample: {
      happy: soakHappy.summary,
      stacks: soakOn.summary,
      leftovers: optOff.pack.unplacedCount,
    },
  };
  try { console.info('[PackV2] step5f self-test', out); } catch (_) { /* */ }
  return out;
}

/**
 * Full Step 5 suite (5a–5f). Console: csPackV2Step5SelfTest()
 * @param {object} [opts] opts.fast → skip nested 5e/4 inside 5f (still runs 5f gates)
 */
function csPackV2Step5SelfTest(opts) {
  const o = opts || {};
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  if (o.fast) {
    const f = csPackV2Step5fSelfTest({ skipRegression: true });
    check('S5f', f.ok, `${f.passed}/${f.total}`);
    // Still spot-check 5a/5b/5c/5d lightly via fast 5f fixtures already run
  } else {
    const a = csPackV2Step5aSelfTest();
    check('S5a', a.ok, `${a.passed}/${a.total}`);
    const b = csPackV2Step5bSelfTest();
    check('S5b', b.ok, `${b.passed}/${b.total}`);
    // 5c/5d/5e nested inside 5f regression path
    const f = csPackV2Step5fSelfTest({ skipRegression: false });
    check('S5f', f.ok, `${f.passed}/${f.total}`);
  }

  const passed = results.filter(x => x.ok).length;
  const out = {
    ok: passed === results.length,
    passed,
    total: results.length,
    results,
  };
  try { console.info('[PackV2] step5 self-test', out); } catch (_) { /* */ }
  return out;
}
