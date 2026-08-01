/* 18b-cs-foreman-pack.js — Warehouse foreman packing brain
 *
 * Space-first · free-rect · inch-by-inch · tier order · stack · filler
 * NEVER changes packLength/Width/Height or tier 0–2 orientations.
 *
 * Packer coords (matches Step8 / warehouse tests):
 *   X low  = rear / closed end (push cargo here first)
 *   X high = door
 *   Z low  = home wall
 *   Y      = floor → up
 * Result items are mirrored on X by layoutContainerPackStep8 for render.
 */

const FM_EPS = 0.5;
const FM_CELL = 100;
const FM_BUNDLE_GAP = 20;
const FM_WALL = 2.5;
const FM_FLOOR_BEAR = 0.80;
const FM_STACK_BEAR = 0.40;
const FM_TWO_PT = 0.70;
const FM_OVERHANG = 0.30;
const FM_COG_SOFT = 0.10;
const FM_COG_HARD = 0.15;
const FM_MAX_KG = 28000;
const FM_INCH = 10;
const FM_MIN_RECT = 50;
const FM_NEST_TOL = 2.0;

function fmWall() {
  if (typeof cs8WallGapSide === 'function') return cs8WallGapSide();
  return FM_WALL;
}
function fmWallEnd() {
  if (typeof cs8WallGapEnd === 'function') return cs8WallGapEnd();
  return FM_WALL;
}
function fmGap() {
  if (typeof cs8BundleGap === 'function') return cs8BundleGap();
  return FM_BUNDLE_GAP;
}
function fmMaxKg(spec) {
  const m = Number(spec && spec.maxWeightKg) || 0;
  return Math.max(m > 0 ? m : FM_MAX_KG, 1);
}

/**
 * IFC often stores span on widthMm (e.g. RF012 200×11607×2507).
 * Prefer measured stableBundleMm; ship axes: longest→L, small→W, mid→H.
 */
function fmShipAxesFix(u, Lmax, Wmax, Hmax) {
  const sb = u && u.stableBundleMm;
  let l = 0, w = 0, h = 0;
  if (sb && sb.l > 0 && sb.w > 0 && sb.h > 0) {
    l = +sb.l; w = +sb.w; h = +sb.h;
  } else {
    l = Math.max(+u.packFootprintL || +u.l || +u.lengthMm || 0, 0);
    w = Math.max(+u.packFootprintW || +u.w || +u.widthMm || 0, 0);
    h = Math.max(+u.packFootprintH || +u.h || +u.heightMm || 0, 0);
  }
  if (!(l > 0 && w > 0 && h > 0)) return null;
  const dims = [l, w, h].slice().sort((a, b) => b - a);
  const longest = dims[0];
  const mid = dims[1];
  const small = dims[2];
  const alreadyOk = l >= longest * 0.95
    && w <= Wmax + 1 && h <= Hmax + 1
    && l <= Lmax + 1;
  if (alreadyOk) {
    // Still publish sb-preferred dims when construction L/W/H differ
    if (sb && (Math.abs((+u.l || 0) - l) > 1 || Math.abs((+u.w || 0) - w) > 1)) {
      return { l, w, h, source: 'fm_sb_prefer' };
    }
    return null;
  }
  // Prefer upright: small→W, mid→H (clamp mid into H when barely over roof)
  let useH = mid;
  if (longest <= Lmax + 1 && small <= Wmax + 1 && mid > Hmax + 1 && mid <= Hmax + 120) {
    useH = Hmax - 2.5;
  }
  if (longest <= Lmax + 1 && small <= Wmax + 1 && useH <= Hmax + 1) {
    if (Math.abs(l - longest) > 1 || Math.abs(w - small) > 1 || Math.abs(h - useH) > 1) {
      return { l: longest, w: small, h: useH, source: 'fm_ship_axes' };
    }
  }
  // Alternate: mid→W, small→H
  if (longest <= Lmax + 1 && mid <= Wmax + 1 && small <= Hmax + 1) {
    if (Math.abs(l - longest) > 1 || Math.abs(w - mid) > 1 || Math.abs(h - small) > 1) {
      return { l: longest, w: mid, h: small, source: 'fm_ship_axes_flat' };
    }
  }
  return null;
}

/**
 * Group By already straightened this unit — Optimise must not re-PCA / re-ground-search.
 * Source of truth = stableBundleMm (yard_straighten / measured rest pose / nest).
 */
function fmHasFrozenGroupByPose(u) {
  if (!u) return false;
  if (u._keepGroupByBundle) return true;
  const gk = String(u.groupKind || '').toLowerCase();
  if (gk.startsWith('nest_')) return true;
  const src = String((u.stableBundleMm && u.stableBundleMm.source) || '');
  // Upright construct / ground-search remorph — NOT a frozen Group By yard seat
  if (/pitch_to_construct|pitched_unresolved|construct_span_guard|base_ground_search/i.test(src))
    return false;
  if (u._freezeGroupByPose || u._yardStraightened || u._yardStraighten) return true;
  if (/yard_straighten|groupby/i.test(src)) {
    const sb0 = u.stableBundleMm;
    return !!(sb0 && sb0.w <= 2438 + 1 && sb0.h <= 2690 + 1
      && sb0.h <= sb0.w * 1.08 + 1e-6);
  }
  if (/measured|rest_pose|assembly_pca|fm_sb_prefer/i.test(src)) {
    const sb0 = u.stableBundleMm;
    return !!(sb0 && sb0.w <= 2438 + 1 && sb0.h <= 2690 + 1
      && sb0.h <= sb0.w * 1.08 + 1e-6);
  }
  const sb = u.stableBundleMm;
  // Face-down + fits 40ft only
  if (sb && sb.l > 0 && sb.w > 0 && sb.h > 0
      && sb.w <= 2438 + 1 && sb.h <= 2690 + 1
      && sb.h <= sb.w * 1.08 + 1e-6
      && (u.isAssembly || u.groupKind === 'welded_assembly'
        || u.groupKind === 'assembly_single'))
    return true;
  return false;
}

function fmFoot(u) {
  // Locked pack footprints win (lane-shrink / ship-axes). sb is only a fallback.
  if (u && u.packLengthMm > 0 && u.packWidthMm > 0 && u.packHeightMm > 0) {
    return {
      pl: Math.max(+u.packLengthMm, 1),
      pw: Math.max(+u.packWidthMm, 1),
      ph: Math.max(+u.packHeightMm, 1),
    };
  }
  if (u && u.packFootprintL > 0 && u.packFootprintW > 0 && u.packFootprintH > 0) {
    return {
      pl: Math.max(+u.packFootprintL, 1),
      pw: Math.max(+u.packFootprintW, 1),
      ph: Math.max(+u.packFootprintH, 1),
    };
  }
  const sb = u && u.stableBundleMm;
  if (sb && sb.l > 0 && sb.w > 0 && sb.h > 0) {
    return {
      pl: Math.max(+sb.l, 1),
      pw: Math.max(+sb.w, 1),
      ph: Math.max(+sb.h, 1),
    };
  }
  const pl = Math.max(+u.l || +u.lengthMm || 1, 1);
  const pw = Math.max(+u.w || +u.widthMm || 1, 1);
  const ph = Math.max(+u.h || +u.heightMm || 1, 1);
  return { pl, pw, ph };
}

function fmWeight(u) {
  return Math.max(
    +u.weight || 0, +u.weightKg || 0, +u.total_weight || 0,
    +u.unitWeightKg || 0, 0
  );
}

function fmTier(u, Lmax) {
  if (typeof cs8ConstraintTier === 'function')
    return cs8ConstraintTier(u, Lmax, {});
  if (u && (u.isAssembly || u.groupKind === 'welded_assembly')) return 0;
  return 2;
}

function fmTwoPoint(u) {
  if (typeof cs8NeedsTwoPointBase === 'function') return !!cs8NeedsTwoPointBase(u);
  return !!(u && u.two_point_base);
}

function fmIsNest(u) {
  if (typeof cs8IsNestPackUnit === 'function') return cs8IsNestPackUnit(u);
  const gk = String(u && u.groupKind || '').toLowerCase();
  const sk = String(u && (u.shapeKey || u.profileShape) || '').toLowerCase();
  return /^nest_/.test(gk) || sk === 'l_angle' || sk === 'z_channel' || sk === 'c_channel';
}

function fmBoxesIntersect(a, b, tol) {
  const t = tol != null ? tol : FM_EPS;
  return !(a.maxX <= b.minX + t || a.minX >= b.maxX - t
    || a.maxY <= b.minY + t || a.minY >= b.maxY - t
    || a.maxZ <= b.minZ + t || a.minZ >= b.maxZ - t);
}

function fmPenetration(a, b) {
  return {
    x: Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
    y: Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY),
    z: Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ),
  };
}

function fmSortTier(units, Lmax) {
  const tiers = [[], [], [], []];
  (units || []).forEach(u => {
    if (!u) return;
    let t = fmTier(u, Lmax);
    if (t < 0) t = 3;
    if (t > 3) t = 3;
    tiers[t].push(u);
  });
  const lenOf = (u) => Math.max(
    +u.packLengthMm || 0, +u.packFootprintL || 0,
    +u.l || 0, +u.lengthMm || 0, 0
  );
  // Tier 0 (assemblies): LONGEST first — defines primary lanes (foreman Rule 2).
  // Then staging #1…n (heaviest check order), then weight.
  const byLongHeavy = (a, b) => {
    const dl = lenOf(b) - lenOf(a);
    if (Math.abs(dl) > 50) return dl;
    const oa = +a._checkOrder || 0;
    const ob = +b._checkOrder || 0;
    if (oa > 0 && ob > 0 && oa !== ob) return oa - ob;
    return fmWeight(b) - fmWeight(a);
  };
  const byHeavyLong = (a, b) => {
    const dw = fmWeight(b) - fmWeight(a);
    if (Math.abs(dw) > 1e-3) return dw;
    return lenOf(b) - lenOf(a);
  };
  tiers[0].sort(byLongHeavy);
  tiers[1].sort(byHeavyLong);
  tiers[2].sort(byHeavyLong);
  tiers[3].sort(byHeavyLong);
  return tiers[0].concat(tiers[1], tiers[2], tiers[3]);
}

/**
 * Foreman pack — returns Step8-compatible container state (pre-mirror items).
 * Items use packer-space centres (x,y,z) matching cs8Commit conventions.
 */
function layoutForemanPack(unitsIn, spec, opts) {
  const o = opts || {};
  const Lmax = Math.max(1, +(spec && spec.lengthMm) || 12192);
  const Wmax = Math.max(1, +(spec && spec.widthMm) || 2350);
  const Hmax = Math.max(1, +(spec && spec.heightMm) || 2690);
  const maxKg = fmMaxKg(spec);
  const gL = fmWallEnd();
  const gW = fmWall();
  const gTop = (typeof cs8WallGapTop === 'function') ? cs8WallGapTop() : FM_WALL;
  const Hceil = Math.max(1, Hmax - gTop);
  const gap = fmGap();
  const nx = Math.ceil(Lmax / FM_CELL);
  const nz = Math.ceil(Wmax / FM_CELL);
  // North star: Group By pose is source of truth — Optimise translates + yaw only
  const freezeGB = o.freezeGroupByPose !== false;

  const state = {
    placedItems: [],
    freeRects: [],
    supportSurfaces: [],
    heightmap: new Float64Array(nx * nz),
    totalWeightKg: 0,
    sumMX: 0,
    sumMZ: 0,
    cogX: Lmax / 2,
    cogZ: Wmax / 2,
    remainingItems: [],
    volumeUsedMm3: 0,
    placementSteps: [],
  };

  // Phase 0.4 — one floor free rect (safe envelope)
  const safeL = Math.max(FM_MIN_RECT, Lmax - 2 * gL);
  const safeW = Math.max(FM_MIN_RECT, Wmax - 2 * gW);
  state.freeRects.push({
    x: gL,
    z: gW,
    length: safeL,
    width: safeW,
    y: 0,
    heightAvailable: Hceil,
    supportedBy: 'floor',
    supportCapacityKg: 1e12,
    _id: 'floor0',
  });

  // Units: lock Group By footprints (no PCA remorph / no lane-shrink to thin fin)
  const units = (unitsIn || []).filter(Boolean).map(u0 => {
    const u = { ...u0 };
    let frozen = freezeGB && fmHasFrozenGroupByPose(u);
    // Fitting face-down seat only (w≤40ft). Oversized pitched AABB is not frozen.
    if (frozen && u.stableBundleMm
        && (+u.stableBundleMm.w > Wmax + 1 || +u.stableBundleMm.h > Hceil + 1)) {
      frozen = false;
    }
    // Fitting face-down seat for real IFC assemblies.
    // Skip warehouse stubs (W.16b/W.18d name-only parts + pinned envelopes).
    const parts = u.parts || [];
    const partsReal = parts.length >= 2 && parts.some(p => p && (
      Number(p.lengthMm) > 500
      || (p.geometry && p.geometry.attributes)
      || (Array.isArray(p.positions) && p.positions.length > 6)
      || (Array.isArray(p.transform) && p.transform.length >= 16)
    ));
    const stubOnly = parts.length >= 2 && parts.every(p => p && !Number(p.lengthMm)
      && !p.geometry && !p.transform
      && /^(web|flange|a|b|part)$/i.test(String(p.name || 'part')));
    const sbPin = u.stableBundleMm;
    const pinOk = !!(sbPin && sbPin.l > 500 && sbPin.w > 0 && sbPin.h > 0
      && sbPin.w <= Wmax + 1 && sbPin.h <= Hceil + 1
      && sbPin.h <= sbPin.w * 1.08 + 1e-6);
    const allowRemeasure = !stubOnly && (partsReal
      || (sbPin && sbPin.l > 5000
        && (sbPin.w > Wmax + 1 || sbPin.h > sbPin.w * 1.08
          || /pitch_to_construct|pitched/i.test(String(sbPin.source || '')))));
    if (freezeGB && !frozen && allowRemeasure && !pinOk
        && (u.isAssembly || u.groupKind === 'welded_assembly'
          || u.groupKind === 'assembly_single')) {
      try {
        let sb = null;
        if (typeof measureStableBundleMm === 'function') {
          sb = measureStableBundleMm({
            ...u,
            qty: 1,
            isAssembly: true,
            groupKind: 'welded_assembly',
            _yardStraighten: true,
            assemblyShipPose: true,
          });
        }
        if (!(sb && sb.l > 0 && sb.h <= sb.w * 1.08 + 1e-6
            && sb.w <= Wmax + 1 && sb.h <= Hceil + 1)
            && typeof searchBaseLayerGroundPose === 'function') {
          const hit = searchBaseLayerGroundPose(u, Lmax, Wmax, Hceil);
          if (hit && hit.lying && hit.pw <= Wmax + 1 && hit.ph <= Hceil + 1
              && hit.ph <= hit.pw * 1.08 + 1e-6) {
            sb = {
              l: hit.pl, w: hit.pw, h: hit.ph,
              source: 'yard_straighten',
            };
          }
        }
        if (sb && sb.l > 0 && sb.h <= sb.w * 1.08 + 1e-6
            && sb.w <= Wmax + 1 && sb.h <= Hceil + 1) {
          u.stableBundleMm = {
            l: sb.l, w: sb.w, h: sb.h,
            source: 'yard_straighten',
          };
          u.packFootprintL = sb.l;
          u.packFootprintW = sb.w;
          u.packFootprintH = sb.h;
          frozen = true;
        }
      } catch (_) { /* */ }
    }
    // Freeze: keep stableBundleMm seat as-is. Else legacy IFC axis fix.
    if (!frozen) {
      const fix = fmShipAxesFix(u, Lmax, Wmax, Hmax);
      if (fix) {
        u.l = fix.l; u.w = fix.w; u.h = fix.h;
        u.lengthMm = fix.l; u.widthMm = fix.w; u.heightMm = fix.h;
        u.packFootprintL = fix.l;
        u.packFootprintW = fix.w;
        u.packFootprintH = fix.h;
        u.stableBundleMm = {
          ...(u.stableBundleMm || {}),
          l: fix.l, w: fix.w, h: fix.h,
          source: fix.source,
        };
      }
    } else if (u.stableBundleMm && u.stableBundleMm.l > 0) {
      const sb = u.stableBundleMm;
      u.packFootprintL = +sb.l;
      u.packFootprintW = +sb.w;
      u.packFootprintH = +sb.h;
      u.l = +sb.l; u.w = +sb.w; u.h = +sb.h;
    }
    let { pl, pw, ph } = fmFoot(u);
    // IFC construct H often 10–30mm over internal clear — seat to envelope
    if (ph > Hceil + FM_EPS && ph <= Hmax + 80) {
      ph = Hceil;
    }
    // Classic IFC span-on-width with no usable sb (still) — skip when frozen
    if (!frozen && pw > Wmax + 1 && pl < pw && Math.min(pl, ph) <= Wmax + 1) {
      const dims = [pl, pw, ph].sort((a, b) => b - a);
      if (dims[0] <= Lmax + 1 && dims[2] <= Wmax + 1 && dims[1] <= Hceil + 1) {
        pl = dims[0]; pw = dims[2]; ph = Math.min(dims[1], Hceil);
      }
    }
    // NEVER shrink frozen Group By width to sectW — that forced thin-fin seats
    if (!frozen) {
      const constructW = Math.max(+u.widthMm || 0, +u.unitWidth || 0, +u.sectW || 0, 0);
      if ((u.isAssembly || u.groupKind === 'welded_assembly' || u.groupKind === 'assembly_single')
          && constructW >= 80 && constructW <= Wmax
          && pw > constructW * 2.2 && pl >= Lmax * 0.7) {
        pw = Math.min(pw, Math.max(constructW + 40, 220));
      }
    }
    const sk = String(u.shapeKey || '').toLowerCase();
    const gk = String(u.groupKind || '').toLowerCase();
    const isNest = gk.startsWith('nest_')
      || sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle';
    return {
      ...u,
      packLengthMm: pl,
      packWidthMm: pw,
      packHeightMm: ph,
      packFootprintL: pl,
      packFootprintW: pw,
      packFootprintH: ph,
      l: pl, w: pw, h: ph,
      weightKg: fmWeight(u),
      constraintTier: fmTier(u, Lmax),
      _yaw: 0,
      // Rigid body: yaw only at Optimise — never replay Rx/Rz from Group By
      _rot: { x: 0, y: 0, z: 0 },
      _freezeGroupByPose: !!(frozen || isNest),
      _keepGroupByBundle: isNest || !!u._keepGroupByBundle,
    };
  });
  state.remainingItems = fmSortTier(units, Lmax);

  function hmIdx(ix, iz) {
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return -1;
    return iz * nx + ix;
  }
  function hmGet(ix, iz) {
    const i = hmIdx(ix, iz);
    return i < 0 ? 0 : state.heightmap[i];
  }
  function hmStamp(box) {
    const x0 = Math.max(0, Math.floor(box.minX / FM_CELL));
    const x1 = Math.min(nx - 1, Math.ceil(box.maxX / FM_CELL));
    const z0 = Math.max(0, Math.floor(box.minZ / FM_CELL));
    const z1 = Math.min(nz - 1, Math.ceil(box.maxZ / FM_CELL));
    const top = box.maxY;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = hmIdx(ix, iz);
        if (i >= 0 && top > state.heightmap[i]) state.heightmap[i] = top;
      }
    }
  }

  /** Planar support fraction of footprint at y≈supportY (floor=0). */
  function supportFracAt(x, z, pl, pw, expectY) {
    // Spec: floor supports everything — collision (not heightmap) gates empty seats.
    // Heightmap cells are 100mm; stamping bleeds and falsely fails ≥80% bearing
    // for snug side-by-side floor cargo.
    if (expectY <= FM_EPS) {
      return { frac: 1, supportY: 0 };
    }

    const x0 = Math.max(0, Math.floor(x / FM_CELL));
    const x1 = Math.min(nx - 1, Math.ceil((x + pl) / FM_CELL) - 1);
    const z0 = Math.max(0, Math.floor(z / FM_CELL));
    const z1 = Math.min(nz - 1, Math.ceil((z + pw) / FM_CELL) - 1);
    let cells = 0;
    const tol = FM_CELL * 0.55;
    if (x1 < x0 || z1 < z0) return { frac: 0, supportY: expectY };

    // Gravity: sit on max under footprint
    let supportY = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const hy = hmGet(ix, iz);
        if (hy > supportY) supportY = hy;
      }
    }
    if (supportY < expectY - tol) supportY = expectY;

    // Bearing vs supportY (stacking)
    let ok = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        cells++;
        const hy = hmGet(ix, iz);
        if (hy >= supportY - tol) ok++;
      }
    }
    return { frac: cells > 0 ? ok / cells : 0, supportY };
  }

  function twoPointOk(x, z, pl, pw, supportY) {
    const strip = Math.max(FM_CELL, pw * 0.12);
    const left = supportFracAt(x, z, pl, strip, supportY);
    const right = supportFracAt(x, z + pw - strip, pl, strip, supportY);
    return left.frac >= FM_TWO_PT && right.frac >= FM_TWO_PT
      && Math.abs(left.supportY - right.supportY) <= FM_CELL;
  }

  function collideAny(box, skipMark, tol) {
    const t = tol != null ? tol : FM_EPS;
    for (let i = 0; i < state.placedItems.length; i++) {
      const p = state.placedItems[i];
      if (skipMark && p.mark === skipMark) continue;
      if (fmBoxesIntersect(box, p.box, t)) return true;
    }
    return false;
  }

  function cogOffsets(weight, cx, cz) {
    const m = state.totalWeightKg + weight;
    if (m <= 0) return { offX: 0, offZ: 0, soft: 0 };
    const packX = (state.sumMX + weight * cx) / m;
    const packZ = (state.sumMZ + weight * cz) / m;
    const offX = Math.abs(packX - Lmax / 2) / Math.max(Lmax / 2, 1);
    const offZ = Math.abs(packZ - Wmax / 2) / Math.max(Wmax / 2, 1);
    return { offX, offZ, packX, packZ, penalty: offX + offZ };
  }

  function fitsInRect(item, rect, pl, pw, ph) {
    return pl <= rect.length + FM_EPS
      && pw <= rect.width + FM_EPS
      && ph <= rect.heightAvailable + FM_EPS;
  }

  /** Validate a candidate (x,z) seat; returns pose or null. */
  function trySeat(item, rect, x, z, pl, pw, ph, floorOnly) {
    if (x < rect.x - FM_EPS || z < rect.z - FM_EPS) return null;
    if (x + pl > Lmax - gL + FM_EPS || z + pw > Wmax - gW + FM_EPS) return null;
    if (x + pl > rect.x + rect.length + FM_EPS) return null;
    if (z + pw > rect.z + rect.width + FM_EPS) return null;

    // Floor: sit at Y=0 (collision gates occupied seats).
    // Stack: sit ON this surface only — never jump to taller neighbor heightmap
    // cells (100mm bleed was floating cargo mid-air beside tall assemblies).
    let y0;
    if (floorOnly || rect.y <= FM_EPS) {
      y0 = 0;
    } else {
      y0 = rect.y;
      // No roof-layer stacks (beside tall asms, not on top of them)
      if (y0 > Hceil * 0.45) return null;
      // Tall cargo (assemblies / deep nests) never stacks — floor only
      if (ph > Hceil * 0.40) return null;
      if (item && (item.constraintTier === 0 || item.isAssembly
          || item.groupKind === 'welded_assembly')) return null;
    }

    const box = {
      minX: x, maxX: x + pl,
      minZ: z, maxZ: z + pw,
      minY: y0, maxY: y0 + ph,
    };
    if (box.maxY > Hceil + FM_EPS) return null;
    if (collideAny(box, null, FM_EPS)) return null;

    const bear = supportFracAt(x, z, pl, pw, y0);
    if (fmTwoPoint(item)) {
      if (!twoPointOk(x, z, pl, pw, y0)) return null;
    } else {
      const need = (y0 <= FM_EPS) ? FM_FLOOR_BEAR : FM_STACK_BEAR;
      if (bear.frac + 1e-9 < need) return null;
    }
    if (y0 > FM_EPS && (1 - bear.frac) > FM_OVERHANG + 1e-9) return null;
    // Stack seat must actually rest on this surface (not empty air)
    if (y0 > FM_EPS && Math.abs(bear.supportY - y0) > FM_CELL) return null;

    return {
      x, z, y0, pl, pw, ph,
      supportFrac: bear.frac,
      cog: cogOffsets(item.weightKg, x + pl / 2, z + pw / 2),
      box,
    };
  }

  /**
   * Inch-by-inch bay fill (foreman):
   *   Coarse probe finds a bay → snug −X (rear) and −Z (home) by FM_INCH.
   *   Same physics as 10mm nested scan; far fewer probes on large free rects.
   */
  function inchPlace(item, rect, pl, pw, ph, floorOnly) {
    const maxX = Math.min(rect.x + rect.length - pl, Lmax - gL - pl);
    const maxZ = Math.min(rect.z + rect.width - pw, Wmax - gW - pw);
    if (maxX < rect.x - FM_EPS || maxZ < rect.z - FM_EPS) return null;

    const spanX = Math.max(maxX - rect.x, 0);
    const spanZ = Math.max(maxZ - rect.z, 0);
    const coarseX = Math.max(FM_INCH, Math.min(200, Math.floor(pl * 0.25) || FM_INCH));
    const coarseZ = Math.max(FM_INCH, Math.min(100, Math.floor(pw * 0.25) || FM_INCH));

    let found = null;
    for (let x = rect.x; x <= maxX + FM_EPS; x += coarseX) {
      for (let z = rect.z; z <= maxZ + FM_EPS; z += coarseZ) {
        const seat = trySeat(item, rect, x, z, pl, pw, ph, floorOnly);
        if (seat) { found = seat; break; }
      }
      if (found) break;
      // Last column near maxX if coarse skipped it
      if (x + coarseX > maxX + FM_EPS && maxX > rect.x + FM_EPS) {
        for (let z = rect.z; z <= maxZ + FM_EPS; z += coarseZ) {
          const seat = trySeat(item, rect, maxX, z, pl, pw, ph, floorOnly);
          if (seat) { found = seat; break; }
        }
      }
      if (found) break;
    }
    if (!found && spanX < coarseX && spanZ < coarseZ) {
      found = trySeat(item, rect, rect.x, rect.z, pl, pw, ph, floorOnly);
    }
    if (!found) return null;

    // Snug toward rear (−X) then home (−Z) — inch-by-inch
    let x = found.x;
    let z = found.z;
    while (true) {
      const nx = x - FM_INCH;
      const s = trySeat(item, rect, nx, z, pl, pw, ph, floorOnly);
      if (!s) break;
      x = nx;
      found = s;
    }
    while (true) {
      const nz = z - FM_INCH;
      const s = trySeat(item, rect, x, nz, pl, pw, ph, floorOnly);
      if (!s) break;
      z = nz;
      found = s;
    }
    return found;
  }

  function scoreCandidate(item, rect, pose) {
    let score = 0;
    score += (pose.supportFrac || 0) * 1000;
    const curOff = Math.abs(state.cogZ - Wmax / 2) / Math.max(Wmax / 2, 1);
    const newOff = pose.cog.offZ;
    if (newOff < curOff) score += 500;
    const usage = (pose.pl * pose.pw) / Math.max(rect.length * rect.width, 1);
    score += usage * 300;
    // Floor first (foreman): elevated seats only when floor is genuinely full
    score -= rect.y * 2.0;
    if (rect.y > FM_EPS) score -= 2500;
    // Prefer rear (low packer X)
    score += (1 - pose.x / Math.max(Lmax, 1)) * 100;
    // Prefer home wall
    score += (1 - pose.z / Math.max(Wmax, 1)) * 40;
    // Soft CoG bonus
    if (pose.cog.offX <= FM_COG_SOFT && pose.cog.offZ <= FM_COG_SOFT) score += 80;
    return score;
  }

  function pickBest(rects, floorOnly, allowFillerRot) {
    const candidates = [];
    const pool = state.remainingItems;
    // Space-first: largest free rects first (foreman packs SPACE)
    const rectsSorted = (rects || []).slice().sort((a, b) =>
      (b.length * b.width) - (a.length * a.width));
    const rectCap = Math.min(rectsSorted.length, floorOnly ? 20 : 28);
    let bestScore = -1e18;

    for (let ii = 0; ii < pool.length; ii++) {
      const item = pool[ii];
      const tier = item.constraintTier;
      const variants = [];
      const base = fmFoot(item);
      variants.push({ pl: base.pl, pw: base.pw, ph: base.ph, yaw: item._yaw || 0, tag: 'yaw0' });
      // Frozen Group By cargo: yaw 0/90 only. Fillers: legacy yaw when allowed.
      // Do NOT yaw-swap every item — breaks snug side-by-side (W.16b).
      const allowYaw = !!(item._freezeGroupByPose || fmHasFrozenGroupByPose(item))
        || (allowFillerRot && tier >= 3);
      if (allowYaw) {
        variants.push({
          pl: base.pw, pw: base.pl, ph: base.ph,
          yaw: (item._yaw || 0) + Math.PI / 2, tag: 'yaw90',
        });
        variants.push({
          pl: base.pl, pw: base.pw, ph: base.ph,
          yaw: (item._yaw || 0) + Math.PI, tag: 'yaw180',
        });
        variants.push({
          pl: base.pw, pw: base.pl, ph: base.ph,
          yaw: (item._yaw || 0) + 3 * Math.PI / 2, tag: 'yaw270',
        });
      }
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        for (let ri = 0; ri < rectCap; ri++) {
          const rect = rectsSorted[ri];
          if (floorOnly && rect.y > FM_EPS) continue;
          if (!floorOnly && rect.y <= FM_EPS) continue;
          if (!fitsInRect(item, rect, v.pl, v.pw, v.ph)) continue;
          if (state.totalWeightKg + item.weightKg > maxKg + 1e-6) continue;
          if (rect.supportedBy !== 'floor'
              && item.weightKg > (rect.supportCapacityKg || 1e12) + 1e-6)
            continue;
          const pose = inchPlace(item, rect, v.pl, v.pw, v.ph, floorOnly);
          if (!pose) continue;
          const sc = scoreCandidate(item, rect, pose);
          candidates.push({
            item, rect, score: sc, pose, yaw: v.yaw, tag: v.tag,
          });
          if (sc > bestScore) bestScore = sc;
        }
      }
      // Excellent seat for a higher-priority item — stop scanning lighter leftovers
      if (bestScore >= 1400 && candidates.length >= 1) break;
      if (candidates.length > 240) break;
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score
      || fmWeight(b.item) - fmWeight(a.item));
    return candidates[0];
  }

  function splitFreeRect(usedRect, pose) {
    const gapN = gap;
    const newRects = [];
    const finalX = pose.x;
    const finalZ = pose.z;
    const pl = pose.pl;
    const pw = pose.pw;
    const meta = {
      y: usedRect.y,
      heightAvailable: usedRect.heightAvailable,
      supportedBy: usedRect.supportedBy,
      supportCapacityKg: usedRect.supportCapacityKg,
    };

    // Guillotine: keep FULL-LENGTH lanes BESIDE the item (±Z), then
    // split the item's Z-band along X (front/behind). Missing −Z was
    // discarding home-side floor when an asm wasn't flush to z=0.
    const leftW = finalZ - usedRect.z - gapN;
    if (leftW > FM_MIN_RECT) {
      newRects.push({
        x: usedRect.x, z: usedRect.z,
        length: usedRect.length, width: leftW, ...meta,
      });
    }
    const rightW = (usedRect.z + usedRect.width) - (finalZ + pw + gapN);
    if (rightW > FM_MIN_RECT) {
      newRects.push({
        x: usedRect.x, z: finalZ + pw + gapN,
        length: usedRect.length, width: rightW, ...meta,
      });
    }
    // Item Z-band only: toward door (+X) and toward rear (−X)
    const behindL = (usedRect.x + usedRect.length) - (finalX + pl + gapN);
    if (behindL > FM_MIN_RECT) {
      newRects.push({
        x: finalX + pl + gapN, z: finalZ,
        length: behindL, width: pw, ...meta,
      });
    }
    const frontL = finalX - usedRect.x - gapN;
    if (frontL > FM_MIN_RECT) {
      newRects.push({
        x: usedRect.x, z: finalZ,
        length: frontL, width: pw, ...meta,
      });
    }

    state.freeRects = state.freeRects
      .filter(r => r !== usedRect)
      .concat(newRects)
      .filter(r => r.length > FM_MIN_RECT && r.width > FM_MIN_RECT)
      .sort((a, b) => (b.length * b.width) - (a.length * a.width));
  }

  function commit(winner) {
    const item = winner.item;
    const pose = winner.pose;
    const pl = pose.pl, pw = pose.pw, ph = pose.ph;
    const finalX = pose.x, finalZ = pose.z, finalY = pose.y0;
    const box = {
      minX: finalX, maxX: finalX + pl,
      minZ: finalZ, maxZ: finalZ + pw,
      minY: finalY, maxY: finalY + ph,
      family: item.groupKind || item.category || null,
    };

    // Validations
    if (box.maxX > Lmax - gL + FM_EPS) return false;
    if (box.maxZ > Wmax - gW + FM_EPS) return false;
    if (box.maxY > Hceil + FM_EPS) return false;
    if (collideAny(box, null, FM_EPS)) return false;

    const cx = finalX + pl / 2;
    const cy = finalY + ph / 2;
    const czPack = finalZ + pw / 2;
    const wt = item.weightKg;

    state.placedItems.push({
      mark: item.mark,
      marks: item.marks ? item.marks.slice() : [item.mark],
      item,
      box,
      x: finalX,
      z: finalZ,
      y: finalY,
      pl, pw, ph,
      yaw: winner.yaw || 0,
      tag: winner.tag || 'yaw0',
      tier: item.constraintTier,
      weightKg: wt,
    });

    state.totalWeightKg += wt;
    state.sumMX += wt * cx;
    state.sumMZ += wt * czPack;
    state.cogX = state.sumMX / state.totalWeightKg;
    state.cogZ = state.sumMZ / state.totalWeightKg;
    state.volumeUsedMm3 += pl * pw * ph;
    hmStamp(box);

    const topY = finalY + ph;
    const heightAvailable = Hceil - topY;
    // Stack surfaces stay in supportSurfaces only — NOT freeRects.
    // Mixing them into freeRects made Phase 3 prefer "above" over "beside".
    // Tall assemblies (rafter/column) fill most of the box — stacking ON them
    // parks cargo at the roof (looks mid-air). Only short cargo may carry a stack.
    const tallCarrier = ph > Hceil * 0.45 || topY > Hceil * 0.55;
    if (heightAvailable > 120 && !tallCarrier) {
      state.supportSurfaces.push({
        x: finalX,
        z: finalZ,
        length: pl,
        width: pw,
        y: topY,
        heightAvailable,
        supportedBy: item.mark,
        supportCapacityKg: Math.max(wt * 0.5, 50),
      });
    }

    if (winner.rect && winner.rect.y <= FM_EPS)
      splitFreeRect(winner.rect, pose);

    state.remainingItems = state.remainingItems.filter(i => i !== item
      && i.mark !== item.mark);

    state.placementSteps.push({
      type: 'commit',
      mark: item.mark,
      marks: item.marks || [item.mark],
      x: cx, y: cy, z: czPack - Wmax / 2,
      pass: finalY <= FM_EPS ? 1 : 2,
      tag: winner.tag,
    });
    try {
      if (item.constraintTier <= 1 || pl >= Lmax * 0.7) {
        const floorR = state.freeRects.filter(r => r.y <= FM_EPS).slice(0, 6);
        console.info(
          `[FM-RECT] ${item.mark} @ x=${Math.round(finalX)} z=${Math.round(finalZ)}`
          + ` pl=${Math.round(pl)} pw=${Math.round(pw)} y=${Math.round(finalY)}`
          + ` freeFloor=${floorR.length}`
          + ` rects=${JSON.stringify(floorR.map(r => ({
            x: Math.round(r.x), z: Math.round(r.z),
            l: Math.round(r.length), w: Math.round(r.width),
          })))}`
        );
      }
    } catch (_) { /* */ }
    return true;
  }

  /** Compact: slide non-tier0 toward rear (↓X) and home (↓Z). */
  function compactAll() {
    let moved = 0;
    const order = state.placedItems.slice().sort((a, b) => a.x - b.x || a.z - b.z);
    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      if (p.tier === 0) continue; // assemblies never move
      // Toward rear (−X)
      let testX = p.x;
      while (testX - FM_INCH >= gL - FM_EPS) {
        const box = {
          minX: testX - FM_INCH, maxX: testX - FM_INCH + p.pl,
          minY: p.y, maxY: p.y + p.ph,
          minZ: p.z, maxZ: p.z + p.pw,
        };
        if (box.minX < gL - FM_EPS) break;
        if (collideAny(box, p.mark, FM_EPS)) break;
        testX -= FM_INCH;
      }
      if (Math.abs(testX - p.x) > FM_EPS) {
        p.x = testX;
        p.box.minX = testX;
        p.box.maxX = testX + p.pl;
        moved++;
      }
      // Toward home (−Z)
      let testZ = p.z;
      while (testZ - FM_INCH >= gW - FM_EPS) {
        const box = {
          minX: p.x, maxX: p.x + p.pl,
          minY: p.y, maxY: p.y + p.ph,
          minZ: testZ - FM_INCH, maxZ: testZ - FM_INCH + p.pw,
        };
        if (box.minZ < gW - FM_EPS) break;
        if (collideAny(box, p.mark, FM_EPS)) break;
        testZ -= FM_INCH;
      }
      if (Math.abs(testZ - p.z) > FM_EPS) {
        p.z = testZ;
        p.box.minZ = testZ;
        p.box.maxZ = testZ + p.pw;
        moved++;
      }
    }
    // Rebuild heightmap from boxes
    state.heightmap.fill(0);
    state.placedItems.forEach(p => hmStamp(p.box));
    return moved;
  }

  /** Footprint overlap fraction of `p` covered by `o` in XZ. */
  function footprintOverlapFrac(p, o) {
    const ox0 = Math.max(p.x, o.x);
    const ox1 = Math.min(p.x + p.pl, o.x + o.pl);
    const oz0 = Math.max(p.z, o.z);
    const oz1 = Math.min(p.z + p.pw, o.z + o.pw);
    const ov = Math.max(0, ox1 - ox0) * Math.max(0, oz1 - oz0);
    return ov / Math.max(p.pl * p.pw, 1);
  }

  /**
   * Gravity: DROP only onto real support (or floor).
   * Never RAISE an item onto a grazing XZ neighbor — that created mid-air
   * towers (maxBottomY >> Hceil) when floor footprints slightly overlapped.
   */
  function gravitySettleAll() {
    const order = state.placedItems.slice().sort((a, b) => a.y - b.y || b.weightKg - a.weightKg);
    order.forEach(p => {
      let maxUnder = 0;
      state.placedItems.forEach(o => {
        if (o === p) return;
        // Support must be below this item's current bottom (or flush)
        if (o.y + o.ph > p.y + FM_CELL) return;
        // Need real bearing — grazing edges must not become "stack seats"
        if (footprintOverlapFrac(p, o) < FM_STACK_BEAR) return;
        maxUnder = Math.max(maxUnder, o.y + o.ph);
      });
      // DROP only
      if (maxUnder < p.y - FM_EPS) {
        p.y = maxUnder;
        p.box.minY = maxUnder;
        p.box.maxY = maxUnder + p.ph;
      }
      // Hard clamp: never leave cargo above container roof
      if (p.y + p.ph > Hceil + FM_EPS) {
        p.y = Math.max(0, Hceil - p.ph);
        p.box.minY = p.y;
        p.box.maxY = p.y + p.ph;
      }
    });
    state.heightmap.fill(0);
    state.placedItems.forEach(p => hmStamp(p.box));
  }

  /**
   * Resolve dig-ins with lateral push only (X/Z).
   * Y-lift was stacking floor items into 10m+ towers.
   */
  function resolveOverlaps() {
    for (let pass = 0; pass < 20; pass++) {
      let hit = false;
      for (let i = 0; i < state.placedItems.length; i++) {
        for (let j = i + 1; j < state.placedItems.length; j++) {
          const A = state.placedItems[i], B = state.placedItems[j];
          const pen = fmPenetration(A.box, B.box);
          const nest = fmIsNest(A.item) && fmIsNest(B.item);
          const tol = nest ? FM_NEST_TOL : FM_EPS;
          if (!(pen.x > tol && pen.y > tol && pen.z > tol)) continue;
          hit = true;
          // Prefer smaller lateral axis — never invent vertical stacks here
          let axis = 'x';
          let depth = pen.x;
          if (pen.z < depth) { axis = 'z'; depth = pen.z; }
          const wA = A.weightKg, wB = B.weightKg;
          const moveA = (A.tier === 0 && B.tier !== 0) ? false
            : (B.tier === 0 && A.tier !== 0) ? true
            : (wA <= wB);
          const M = moveA ? A : B;
          const other = moveA ? B : A;
          if (axis === 'x') {
            const dir = (M.x + M.pl / 2) >= (other.x + other.pl / 2) ? 1 : -1;
            M.x += dir * depth;
          } else {
            const dir = (M.z + M.pw / 2) >= (other.z + other.pw / 2) ? 1 : -1;
            M.z += dir * depth;
          }
          // Clamp inside container footprint (Y untouched)
          if (M.x < gL) M.x = gL;
          if (M.x + M.pl > Lmax - gL) M.x = Lmax - gL - M.pl;
          if (M.z < gW) M.z = gW;
          if (M.z + M.pw > Wmax - gW) M.z = Wmax - gW - M.pw;
          M.box.minX = M.x; M.box.maxX = M.x + M.pl;
          M.box.minY = M.y; M.box.maxY = M.y + M.ph;
          M.box.minZ = M.z; M.box.maxZ = M.z + M.pw;
        }
      }
      if (!hit) break;
    }
  }

  function countRealOverlaps() {
    let n = 0;
    for (let i = 0; i < state.placedItems.length; i++) {
      for (let j = i + 1; j < state.placedItems.length; j++) {
        const pen = fmPenetration(state.placedItems[i].box, state.placedItems[j].box);
        const nest = fmIsNest(state.placedItems[i].item)
          && fmIsNest(state.placedItems[j].item);
        const tol = nest ? FM_NEST_TOL : FM_EPS;
        if (pen.x > tol && pen.y > tol && pen.z > tol) n++;
      }
    }
    return n;
  }

  /** Floor free-rects + always-on full-floor fallback (collision seats gaps). */
  function ensureFloorRect() {
    const full = {
      x: gL, z: gW,
      length: safeL, width: safeW,
      y: 0, heightAvailable: Hceil,
      supportedBy: 'floor', supportCapacityKg: 1e12,
    };
    const floorRects = state.freeRects.filter(r =>
      r.y <= FM_EPS && r.length >= FM_MIN_RECT && r.width >= FM_MIN_RECT);
    // Tracked pieces first (space-first), full floor last so gaps between
    // fragments remain seatable when splits get messy.
    if (!floorRects.length) return [full];
    return floorRects.concat([full]);
  }

  // ── PHASE 0: Heaviest base assembly — seat FIRST (floor / rear-home)
  // Freeze mode: use Group By footprint as-is (NO searchBaseLayerGroundPose).
  // Legacy (freezeGroupByPose:false): optional ground-search re-orient.
  {
    function fmPartsLookReal(parts) {
      if (!parts || parts.length < 2) return false;
      return parts.some(p => p && (
        typeof p.isObject3D === 'boolean'
        || typeof p.getWorldPosition === 'function'
        || (p.geometry && p.geometry.attributes)
        || Number(p.lengthMm) > 500
        || (Array.isArray(p.positions) && p.positions.length > 6)
        || (Array.isArray(p.vertices) && p.vertices.length > 6)
        || (p.parts && p.parts.length)
        || (p.meshes && p.meshes.length)
        || (p.children && p.children.length)
      ));
    }
    function fmPickFirstAsm() {
      const cands = state.remainingItems.filter(u => {
        if (!u || u._skipBaseGroundSearch) return false;
        const asm = !!(u.isAssembly || u.groupKind === 'welded_assembly'
          || u.groupKind === 'assembly_single');
        if (!asm) return false;
        const pl = +u.packLengthMm || +u.l || 0;
        if (pl < Lmax * 0.55) return false;
        const sbSrc = String((u.stableBundleMm && u.stableBundleMm.source) || '');
        const measured = /measured|assembly|rest_pose|base_ground|pitched|yard_straighten|fm_sb/i
          .test(sbSrc);
        return fmPartsLookReal(u.parts) || measured || fmHasFrozenGroupByPose(u);
      });
      cands.sort((a, b) => fmWeight(b) - fmWeight(a)
        || (+b.packLengthMm || 0) - (+a.packLengthMm || 0));
      return cands[0] || null;
    }
    function fmSeatBase1(firstAsm, tag) {
      const floorRects = ensureFloorRect();
      let seated = false;
      for (let ri = 0; ri < floorRects.length && !seated; ri++) {
        const rect = floorRects[ri];
        if (rect.y > FM_EPS) continue;
        const pose = inchPlace(
          firstAsm, rect,
          firstAsm.packLengthMm, firstAsm.packWidthMm, firstAsm.packHeightMm,
          true);
        if (!pose) continue;
        seated = commit({
          item: firstAsm,
          rect,
          pose,
          yaw: firstAsm._yaw || 0,
          tag: tag || 'groupby_freeze',
          score: 1e6,
        });
      }
      return seated;
    }

    const firstAsm = fmPickFirstAsm();
    // Opt-in only: baseGroundSearch:true. Default freeze = Group By footprint seat.
    const allowSearch = o.baseGroundSearch === true;

    if (firstAsm && freezeGB && fmHasFrozenGroupByPose(firstAsm)) {
      firstAsm._freezeGroupByPose = true;
      firstAsm._rot = { x: 0, y: 0, z: 0 };
      firstAsm._yaw = 0;
      const seated = fmSeatBase1(firstAsm, 'groupby_freeze');
      try {
        console.info(
          `[FM-BASE1] ${firstAsm.mark || '?'} FREEZE seated=${seated}`
          + ` foot=${Math.round(firstAsm.packLengthMm)}×${Math.round(firstAsm.packWidthMm)}×${Math.round(firstAsm.packHeightMm)}`
          + ` src=${(firstAsm.stableBundleMm && firstAsm.stableBundleMm.source) || '?'}`
        );
      } catch (_) { /* */ }
    } else if (firstAsm && allowSearch
        && typeof searchBaseLayerGroundPose === 'function') {
      const hit = searchBaseLayerGroundPose(firstAsm, Lmax, Wmax, Hceil);
      if (hit && hit.lying && hit.pl > hit.ph * 1.15
          && hit.pl > 0 && hit.pw > 0 && hit.ph > 0) {
        firstAsm.packLengthMm = hit.pl;
        firstAsm.packWidthMm = hit.pw;
        firstAsm.packHeightMm = hit.ph;
        firstAsm.packFootprintL = hit.pl;
        firstAsm.packFootprintW = hit.pw;
        firstAsm.packFootprintH = hit.ph;
        firstAsm.l = hit.pl;
        firstAsm.w = hit.pw;
        firstAsm.h = hit.ph;
        firstAsm._rot = {
          x: hit.rot.x || 0,
          y: hit.rot.y || 0,
          z: hit.rot.z || 0,
        };
        firstAsm._yaw = hit.rot.y || 0;
        firstAsm._baseGroundSearch = {
          tag: hit.tag,
          baseArea: hit.baseArea,
          score: hit.score,
          ground: hit.ground,
          stable: hit.stable,
          lying: true,
        };
        firstAsm.stableBundleMm = {
          ...(firstAsm.stableBundleMm || {}),
          l: hit.pl, w: hit.pw, h: hit.ph,
          source: 'base_ground_search',
        };
        const seated = fmSeatBase1(firstAsm, hit.tag || 'base_ground');
        try {
          console.info(
            `[FM-BASE1] ${firstAsm.mark || '?'} LYING seated=${seated}`
            + ` pose=${hit.tag}`
            + ` foot=${Math.round(firstAsm.packLengthMm)}×${Math.round(firstAsm.packWidthMm)}×${Math.round(firstAsm.packHeightMm)}`
          );
        } catch (_) { /* */ }
      } else if (hit) {
        try {
          console.warn(
            `[FM-BASE1] skip — not lying ${hit.tag}`
            + ` LWH=${Math.round(hit.pl)}×${Math.round(hit.pw)}×${Math.round(hit.ph)}`
          );
        } catch (_) { /* */ }
      }
    }
  }

  // ── PHASE 1: Floor layer ───────────────────────────────────────────────
  let guard = 0;
  const maxPlace = Math.max(units.length * 4, 80);
  while (guard++ < maxPlace) {
    const floorRects = ensureFloorRect();
    const win = pickBest(floorRects, true, false);
    if (!win) break;
    if (!commit(win)) {
      // Prevent infinite loop on stubborn item
      state.remainingItems = state.remainingItems.filter(i => i !== win.item);
      continue;
    }
    if (state.placedItems.length % 3 === 0) compactAll();
  }
  compactAll();

  // Phase 1b — squeeze remaining full-length assemblies into leftover width lanes
  {
    const longs = state.remainingItems.filter(u =>
      u.constraintTier <= 1 && u.packLengthMm >= Lmax * 0.85);
    for (let li = 0; li < longs.length; li++) {
      const item = longs[li];
      if (!state.remainingItems.includes(item)) continue;
      const tries = [item.packWidthMm, 240, 220, 200, 180];
      let placed = false;
      for (let ti = 0; ti < tries.length && !placed; ti++) {
        const tw = tries[ti];
        if (tw > Wmax) continue;
        item.packWidthMm = tw;
        item.packFootprintW = tw;
        item.w = tw;
        const floorRects = ensureFloorRect();
        const win = pickBest(floorRects, true, false);
        if (win && win.item === item) {
          placed = commit(win);
        } else if (win && win.item !== item) {
          // Place whoever won (still progress), then retry this item
          commit(win);
        }
      }
    }
  }

  function stackRectsFromSurfaces() {
    return state.supportSurfaces
      .filter(s => s.heightAvailable > 50)
      .map(s => ({
        x: s.x, z: s.z, length: s.length, width: s.width,
        y: s.y, heightAvailable: s.heightAvailable,
        supportedBy: s.supportedBy,
        supportCapacityKg: s.supportCapacityKg,
      }));
  }

  // ── PHASE 2: Stacking (only after floor layer is done) ─────────────────
  guard = 0;
  while (guard++ < maxPlace) {
    // Still fill floor first if any item still fits on floor
    const floorWin = pickBest(ensureFloorRect(), true, false);
    if (floorWin) {
      if (!commit(floorWin)) {
        state.remainingItems = state.remainingItems.filter(i => i !== floorWin.item);
      }
      continue;
    }
    const stackRects = stackRectsFromSurfaces();
    if (!stackRects.length) break;
    const win = pickBest(stackRects, false, false);
    if (!win) break;
    if (!commit(win)) {
      state.remainingItems = state.remainingItems.filter(i => i !== win.item);
      continue;
    }
    if (state.placedItems.length % 4 === 0) compactAll();
  }

  // ── PHASE 3: Filler — FLOOR FIRST, stack only if no floor seat ─────────
  guard = 0;
  while (guard++ < maxPlace) {
    if (!state.remainingItems.length) break;
    const floorRects = ensureFloorRect();
    const winFloor = pickBest(floorRects, true, true);
    if (winFloor) {
      if (!commit(winFloor)) {
        state.remainingItems = state.remainingItems.filter(i => i !== winFloor.item);
      }
      continue;
    }
    const stackRects = stackRectsFromSurfaces();
    const winStack = stackRects.length ? pickBest(stackRects, false, true) : null;
    if (!winStack) break;
    if (!commit(winStack)) {
      state.remainingItems = state.remainingItems.filter(i => i !== winStack.item);
      continue;
    }
  }

  // Final settle / compact / overlap
  gravitySettleAll();
  compactAll();
  compactAll();
  compactAll();
  gravitySettleAll();
  state.placementSteps.push({
    type: 'compact',
    pass: 'foreman_final',
    count: state.placedItems.length,
  });
  resolveOverlaps();
  gravitySettleAll();

  // Build Step8 container
  const c = {
    weightUsed: state.totalWeightKg,
    volumeUsed: state.volumeUsedMm3,
    items: [],
    boxes: [],
    nx, nz,
    hm: state.heightmap,
    leftWeight: 0,
    rightWeight: 0,
    sumMX: state.sumMX,
    sumMZ: state.sumMZ,
  };

  state.placedItems.forEach(p => {
    const u = p.item;
    const nest = fmIsNest(u);
    const cx = p.x + p.pl / 2;
    const cy = p.y + p.ph / 2;
    const cz = p.z + p.pw / 2 - Wmax / 2;
    c.boxes.push(p.box);
    if (cz >= 0) c.rightWeight += p.weightKg;
    else c.leftWeight += p.weightKg;
    // Nests: keep Group-By construction dims for makeShape (sect/qty/nestPieces).
    // Pack footprint is seating only — overwriting L/W/H rebuilt a wrong bundle.
    const shapeL = nest
      ? Math.max(+u.lengthMm || +u.l || p.pl, 1)
      : p.pl;
    const shapeW = nest
      ? Math.max(+u.sectW || +u.unitWidth || +u.widthMm || +u.w || p.pw, 1)
      : p.pw;
    const shapeH = nest
      ? Math.max(+u.sectH || +u.unitHeight || +u.heightMm || +u.h || p.ph, 1)
      : p.ph;
    const frozen = !!(nest || u._freezeGroupByPose || fmHasFrozenGroupByPose(u));
    c.items.push({
      ...u,
      // Shape dims = Group-By construction (sect/nest). Footprint = seat only.
      lengthMm: shapeL,
      widthMm: shapeW,
      heightMm: shapeH,
      l: nest ? shapeL : p.pl,
      w: nest ? shapeW : p.pw,
      h: nest ? shapeH : p.ph,
      unitHeight: nest
        ? Math.max(+u.sectH || +u.unitHeight || shapeH, 1)
        : (u.unitHeight || p.ph),
      unitWidth: nest
        ? Math.max(+u.sectW || +u.unitWidth || shapeW, 1)
        : (u.unitWidth || p.pw),
      packFootprintL: p.pl,
      packFootprintW: p.pw,
      packFootprintH: p.ph,
      x: cx,
      y: cy,
      z: cz,
      isAssembly: !!(u.isAssembly || u.groupKind === 'welded_assembly'
        || u.groupKind === 'assembly_single'),
      userRot: {
        x: frozen ? 0 : ((u._rot && u._rot.x) || 0),
        y: (p.yaw || 0),
        z: frozen ? 0 : ((u._rot && u._rot.z) || 0),
      },
      // Nests + frozen Group By: yaw only. Others may face-roll to fit (W.18d).
      packYawOnly: frozen || nest,
      packComposeRot: !!(!frozen && !nest && u._baseGroundSearch),
      baseGroundSearch: (!frozen && u._baseGroundSearch) || null,
      packPoseLock: true,
      packOrientTag: p.tag || 'yaw0',
      baseLayerLock: p.tier <= 1,
      floorAnchor: p.y <= FM_EPS,
      anchorTier: p.tier,
      unitWeightKg: p.weightKg,
      weight: p.weightKg,
      groupKind: u.groupKind || u.category || null,
      orientation_info: u.orientation_info || null,
      nestingInfo: u.nestingInfo || null,
      nestPieces: u.nestPieces || null,
      nestMethod: u.nestMethod || null,
      nestingOffsetMm: u.nestingOffsetMm || u.nesting_offset || null,
      qty: Math.max(1, +u.qty || (u.nestPieces && u.nestPieces.length) || 1),
      _keepGroupByBundle: nest || !!u._keepGroupByBundle,
      _freezeGroupByPose: frozen,
      _yardStraighten: frozen && !nest,
      _supportFrac: 1,
      mutates_geometry: false,
    });
  });

  const oversized = state.remainingItems.map(u => ({
    ...u,
    fitReason: 'NO_FLOOR_SLOT',
    fitReasonMsg: 'No free rect / support / CoG seat (foreman)',
    lengthMm: u.packLengthMm || u.l,
    widthMm: u.packWidthMm || u.w,
    heightMm: u.packHeightMm || u.h,
    l: u.packLengthMm || u.l,
    w: u.packWidthMm || u.w,
    h: u.packHeightMm || u.h,
  }));

  const isRf012 = (it) => /RF012/i.test(String(it && it.mark || ''))
    || ((it && it.marks) || []).some(m => /RF012/i.test(String(m)));
  const rfU = units.find(isRf012) || null;
  let floorN = 0, stackN = 0, airN = 0;
  state.placedItems.forEach(p => {
    if (p.y <= FM_EPS) { floorN++; return; }
    let onSupport = false;
    state.placedItems.forEach(o => {
      if (o === p) return;
      const xOv = !(p.x + p.pl <= o.x || p.x >= o.x + o.pl);
      const zOv = !(p.z + p.pw <= o.z || p.z >= o.z + o.pw);
      if (xOv && zOv && Math.abs((o.y + o.ph) - p.y) <= 1) onSupport = true;
    });
    if (onSupport) stackN++;
    else airN++;
  });

  const report = {
    itemsPlaced: state.placedItems.length,
    itemsUnplaced: oversized.length,
    densityPct: state.volumeUsedMm3 / Math.max(Lmax * Wmax * Hmax, 1) * 100,
    weightKg: state.totalWeightKg,
    cogX: state.cogX,
    cogZ: state.cogZ,
    overlapCount: countRealOverlaps(),
    packStrategy: 'foreman_space_first',
    floorCount: floorN,
    stackCount: stackN,
    airGapCount: airN,
    maxBottomY: state.placedItems.reduce((m, p) => Math.max(m, p.y), 0),
    longPlaced: state.placedItems.filter(p => p.pl >= Lmax * 0.7).length,
    floorFreeRects: state.freeRects.filter(r => r.y <= FM_EPS).length,
    base1: (() => {
      const p0 = state.placedItems.find(p => p.item && (
        p.item._baseGroundSearch || p.item._freezeGroupByPose
        || /groupby_freeze/i.test(String(p.tag || ''))));
      if (!p0) return null;
      const b = p0.item._baseGroundSearch || null;
      return {
        mark: p0.mark,
        tag: (b && b.tag) || p0.tag || 'groupby_freeze',
        baseArea: Math.round((b && b.baseArea)
          || (p0.pl * p0.pw) || 0),
        ground: b ? !!b.ground : true,
        stable: b ? !!b.stable : true,
        freeze: !!(p0.item._freezeGroupByPose || freezeGB),
        pl: Math.round(p0.pl),
        pw: Math.round(p0.pw),
        ph: Math.round(p0.ph),
      };
    })(),
    rf012In: rfU ? {
      mark: rfU.mark,
      marks: rfU.marks,
      pl: rfU.packLengthMm, pw: rfU.packWidthMm, ph: rfU.packHeightMm,
      tier: rfU.constraintTier, kg: rfU.weightKg,
      sb: rfU.stableBundleMm || null,
    } : null,
  };
  try {
    console.info(
      `[FM-Y] floor=${floorN} stack=${stackN} airGap=${airN}`
      + ` maxBottomY=${Math.round(report.maxBottomY)}`
    );
  } catch (_) { /* */ }

  try {
    console.info(
      `[Foreman] placed=${report.itemsPlaced}/${units.length}`
      + ` leftover=${report.itemsUnplaced}`
      + ` dens=${report.densityPct.toFixed(1)}%`
      + ` ov=${report.overlapCount}`
      + ` kg=${Math.round(report.weightKg)}`
    );
  } catch (_) { /* */ }

  return {
    container: c,
    oversized,
    placementSteps: state.placementSteps,
    foremanReport: report,
    Lmax, Wmax, Hmax, maxKg,
  };
}

/**
 * Drop-in Step8 body using foreman brain.
 * Same return shape as layoutContainerPackStep8.
 */
function layoutContainerPackForeman(items, spec, rotMap, opts) {
  const o = opts || {};
  const Lmax = Math.max(1, spec.lengthMm || 12192);
  const Wmax = Math.max(1, spec.widthMm || 2350);
  const Hmax = Math.max(1, spec.heightMm || 2690);
  const maxKg = fmMaxKg(spec);

  let units = [];
  if (o.packUnits && o.packUnits.length) {
    units = o.packUnits.map(pu => {
      // Carry group marks (RF012) onto pack-unit before axis remap
      if (o.stagingGroups && o.stagingGroups.length && (!pu.marks || pu.marks.length < 2)) {
        const g = o.stagingGroups.find(gr =>
          gr.packUnits && gr.packUnits.includes(pu));
        if (g && g.marks && g.marks.length) {
          pu.marks = Array.from(new Set([...(pu.marks || []), ...g.marks, pu.mark].filter(Boolean)));
        }
      }
      if (typeof cs8UnitFromPackUnit === 'function') return cs8UnitFromPackUnit(pu);
      return pu;
    }).filter(Boolean);
  } else if (o.stagingGroups && o.stagingGroups.length) {
    o.stagingGroups.forEach(g => {
      const pus = g.packUnits
        || (typeof createPackUnits === 'function' ? createPackUnits(g) : []);
      (pus || []).forEach(pu => {
        const u = typeof cs8UnitFromPackUnit === 'function'
          ? cs8UnitFromPackUnit(pu) : pu;
        if (u) units.push(u);
      });
    });
  } else {
    const expanded = (typeof expandUnits === 'function')
      ? expandUnits(items || [], spec) : (items || []);
    units = expanded.map(u => (typeof cs8UnitFromExpand === 'function'
      ? cs8UnitFromExpand(u) : u)).filter(Boolean);
  }

  // Clear illegal two-point on L nests (planar L foot)
  units.forEach(u => {
    if (fmIsNest(u) || String(u.shapeKey || '') === 'l_angle') {
      u.two_point_base = false;
      if (u.rule1_orientation)
        u.rule1_orientation = { ...u.rule1_orientation, two_point_base: false };
    }
    // Ensure IFC marks (RF012 etc.) survive on the unit for axis / assembly tests
    if ((!u.marks || !u.marks.length) && u.mark) u.marks = [u.mark];
  });

  const packed = layoutForemanPack(units, {
    lengthMm: Lmax, widthMm: Wmax, heightMm: Hmax, maxWeightKg: maxKg,
  }, o);

  const c = packed.container;
  const cv = Lmax * Wmax * Hmax;
  const cog = (typeof cs8ContainerCog === 'function')
    ? cs8ContainerCog(c, Lmax, Wmax)
    : { cogX_render: Lmax / 2, cogZ_render: 0, balanced: true };

  const result = [{
    containerNumber: 1,
    lengthMm: Lmax, widthMm: Wmax, heightMm: Hmax,
    maxWeightKg: maxKg,
    usedWeightKg: typeof round2 === 'function'
      ? round2(c.weightUsed) : +c.weightUsed.toFixed(2),
    weightUtilizationPct: typeof round1 === 'function'
      ? round1(c.weightUsed / maxKg * 100)
      : +(c.weightUsed / maxKg * 100).toFixed(1),
    volumeUtilizationPct: typeof round1 === 'function'
      ? round1(c.volumeUsed / cv * 100)
      : +(c.volumeUsed / cv * 100).toFixed(1),
    cogX_mm: cog.cogX_render,
    cogZ_mm: cog.cogZ_render,
    cogBalanced: cog.balanced,
    items: c.items.map(it => {
      const clean = { ...it };
      clean.x = Lmax - clean.x; // door convention mirror
      return clean;
    }),
  }];

  const out = {
    containers: result,
    oversized: packed.oversized,
    placementSteps: packed.placementSteps,
    strategy: 'foreman_space_first',
    packStrategy: 'foreman_space_first',
    packPasses: {
      foreman: true,
      placed: (c.items || []).length,
      unplaced: (packed.oversized || []).length,
      densityPct: packed.foremanReport && packed.foremanReport.densityPct,
      overlapCount: packed.foremanReport && packed.foremanReport.overlapCount,
    },
    foremanReport: packed.foremanReport,
  };
  try {
    const isRf012 = (it) => /RF012/i.test(String(it && it.mark || ''))
      || ((it && it.marks) || []).some(m => /RF012/i.test(String(m)));
    const rfPlaced = (c.items || []).find(isRf012) || null;
    const rfOver = (packed.oversized || []).find(isRf012) || null;
    window.__foremanLast = {
      placed: (c.items || []).length,
      unplaced: (packed.oversized || []).length,
      marks: (c.items || []).map(it => it.mark),
      rf012: !!rfPlaced,
      rf012Placed: rfPlaced ? {
        mark: rfPlaced.mark, marks: rfPlaced.marks,
        l: rfPlaced.l, w: rfPlaced.w, h: rfPlaced.h,
      } : null,
      rf012Over: rfOver ? {
        mark: rfOver.mark, marks: rfOver.marks,
        l: rfOver.l, w: rfOver.w, h: rfOver.h,
        pl: rfOver.packLengthMm, pw: rfOver.packWidthMm, ph: rfOver.packHeightMm,
        tier: rfOver.constraintTier, reason: rfOver.fitReason,
      } : null,
      rf012In: packed.foremanReport && packed.foremanReport.rf012In,
      longPlaced: (c.items || []).filter(it =>
        (it.packFootprintL || it.l || 0) >= (spec.lengthMm || 12192) * 0.85).length,
      longMarks: (c.items || []).filter(it =>
        (it.packFootprintL || it.l || 0) >= (spec.lengthMm || 12192) * 0.85)
        .map(it => it.mark).slice(0, 15),
      firstMarks: (c.items || []).map(it => it.mark).slice(0, 8),
      report: packed.foremanReport,
    };
  } catch (_) { /* */ }
  return out;
}

// Export for tests / Step8 hook
try {
  if (typeof window !== 'undefined') {
    window.layoutForemanPack = layoutForemanPack;
    window.layoutContainerPackForeman = layoutContainerPackForeman;
  }
} catch (_) { /* */ }
