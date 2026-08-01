/* 15b-cs-ship-prep.js — Real-world Ship Prep (load-ready pose)
 *
 * Industry pipeline:
 *   IFC as-built → Ship Prep (flat / nest / ground) → Group By view
 *                → Optimise (translate + yaw 0/90 only)
 *
 * Ship Prep owns pose. Optimise must not remorph _shipPrepped units.
 */

/** Classify item for ship rules. */
function csShipPrepClass(it) {
  if (!it) return 'other';
  const sk = String(it.shapeKey || it.profileShape || '').toLowerCase();
  const gk = String(it.groupKind || '').toLowerCase();
  if (gk === 'nest_z' || sk === 'z_channel' || sk === 'z_shape') return 'nest_z';
  if (gk === 'nest_c' || sk === 'c_channel') return 'nest_c';
  if (gk === 'nest_l' || sk === 'l_angle') return 'nest_l';
  if (sk === 'plate' || gk === 'stack_plate' || it.category === 'plate') return 'plate';
  if (sk === 'rod' || sk === 'bent_sag_rod' || it.category === 'rod') return 'rod';
  if (sk === 'i_beam' || sk === 'rhs' || sk === 'chs' || it.category === 'beam')
    return 'beam';
  if (it.isAssembly || gk === 'welded_assembly' || gk === 'assembly_single'
      || (it.parts && it.parts.length >= 2))
    return 'assembly';
  if (typeof csNzIsZShape === 'function' && csNzIsZShape(it)) return 'nest_z';
  return 'other';
}

function csShipPrepIsZ(it) {
  return csShipPrepClass(it) === 'nest_z';
}

/**
 * Bottom tip-gap in mm along the longest horizontal axis.
 * (Yaw 0/90 both valid — never assume world +X is length.)
 */
function csShipPrepTipGapMm(mesh) {
  if (!mesh || typeof THREE === 'undefined') return 1e9;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (!isFinite(box.min.x)) return 1e9;
  const sx = Math.max(box.max.x - box.min.x, 1e-9);
  const sz = Math.max(box.max.z - box.min.z, 1e-9);
  const alongX = sx >= sz;
  const a0 = alongX ? box.min.x : box.min.z;
  const span = alongX ? sx : sz;
  const nBin = 9;
  const bins = new Array(nBin).fill(Infinity);
  const v = new THREE.Vector3();
  let n = 0;
  mesh.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    if (o.isLine || o.isLineSegments) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos || pos.count < 3) return;
    const step = Math.max(1, Math.floor(pos.count / 60));
    for (let i = 0; i < pos.count && n < 1800; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const a = alongX ? v.x : v.z;
      const bi = Math.min(nBin - 1, Math.max(0, Math.floor(((a - a0) / span) * nBin)));
      if (v.y < bins[bi]) bins[bi] = v.y;
      n++;
    }
  });
  const vals = bins.filter(y => isFinite(y));
  if (vals.length < 2) return 0;
  return (Math.max(...vals) - Math.min(...vals)) / sc;
}

/** Nail mesh minY → 0. */
function csShipPrepNailGround(mesh) {
  if (!mesh || typeof THREE === 'undefined') return 0;
  mesh.updateMatrixWorld(true);
  if (typeof csNzSnapObjectToGround === 'function') {
    const s = csNzSnapObjectToGround(mesh);
    return (s && s.moved_y) || 0;
  }
  const box = new THREE.Box3().setFromObject(mesh);
  if (!isFinite(box.min.y)) return 0;
  const dy = -box.min.y;
  if (Math.abs(dy) > 1e-6) mesh.position.y += dy;
  return dy;
}

/**
 * Tip-level for assemblies (Ship Prep only — not Optimise settle).
 * Analytical pitch/roll cancel + discrete refine.
 */
function csShipPrepTipLevel(mesh, keepX, keepZ) {
  if (!mesh || typeof THREE === 'undefined') return { tipGapMm: 1e9 };
  const kx = keepX != null ? keepX : mesh.position.x;
  const kz = keepZ != null ? keepZ : mesh.position.z;
  const maxTipRad = 35 * Math.PI / 180;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
  const tolMm = 8;

  function snapG() {
    mesh.position.x = kx;
    mesh.position.z = kz;
    mesh.position.y = 0;
    mesh.updateMatrixWorld(true);
    csShipPrepNailGround(mesh);
    mesh.position.x = kx;
    mesh.position.z = kz;
    mesh.updateMatrixWorld(true);
  }

  function samplePitchRoll() {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.x)) return { pitch: 0, roll: 0, tipGapMm: 1e9 };
    const x0 = box.min.x, x1 = box.max.x;
    const z0 = box.min.z, z1 = box.max.z;
    const spanX = Math.max(x1 - x0, 1e-9);
    const spanZ = Math.max(z1 - z0, 1e-9);
    const nBin = 9;
    const binsX = new Array(nBin).fill(Infinity);
    const binsZ = new Array(nBin).fill(Infinity);
    const v = new THREE.Vector3();
    let n = 0;
    mesh.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      if (o.isLine || o.isLineSegments) return;
      const pos = o.geometry.attributes && o.geometry.attributes.position;
      if (!pos || pos.count < 3) return;
      const step = Math.max(1, Math.floor(pos.count / 80));
      for (let i = 0; i < pos.count && n < 2400; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const bi = Math.min(nBin - 1, Math.max(0, Math.floor(((v.x - x0) / spanX) * nBin)));
        const bj = Math.min(nBin - 1, Math.max(0, Math.floor(((v.z - z0) / spanZ) * nBin)));
        if (v.y < binsX[bi]) binsX[bi] = v.y;
        if (v.y < binsZ[bj]) binsZ[bj] = v.y;
        n++;
      }
    });
    let iL = -1, iR = -1, jN = -1, jF = -1;
    for (let i = 0; i < nBin; i++) if (isFinite(binsX[i])) { iL = i; break; }
    for (let i = nBin - 1; i >= 0; i--) if (isFinite(binsX[i])) { iR = i; break; }
    for (let j = 0; j < nBin; j++) if (isFinite(binsZ[j])) { jN = j; break; }
    for (let j = nBin - 1; j >= 0; j--) if (isFinite(binsZ[j])) { jF = j; break; }
    let pitch = 0, roll = 0;
    if (iL >= 0 && iR > iL) {
      const xL = x0 + ((iL + 0.5) / nBin) * spanX;
      const xR = x0 + ((iR + 0.5) / nBin) * spanX;
      pitch = Math.atan2(binsX[iR] - binsX[iL], Math.max(xR - xL, 1e-9));
    }
    if (jN >= 0 && jF > jN) {
      const zN = z0 + ((jN + 0.5) / nBin) * spanZ;
      const zF = z0 + ((jF + 0.5) / nBin) * spanZ;
      roll = Math.atan2(binsZ[jF] - binsZ[jN], Math.max(zF - zN, 1e-9));
    }
    return { pitch, roll, tipGapMm: csShipPrepTipGapMm(mesh) };
  }

  function faceDownOk() {
    if (typeof evaluateMeshGroupStability !== 'function') return true;
    const ev = evaluateMeshGroupStability(mesh);
    if (ev.standing_on_end || ev.thin_edge_sit) return false;
    const sy = ev.size?.y || 1;
    const sz = ev.size?.z || 1;
    return sy <= sz * 1.22;
  }

  function applyAxis(axis, ang) {
    if (!(Math.abs(ang) > 1e-7)) return;
    mesh.quaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(axis, ang));
    mesh.rotation.setFromQuaternion(mesh.quaternion);
  }

  snapG();
  for (let iter = 0; iter < 5; iter++) {
    const env = samplePitchRoll();
    let pitch = Math.max(-maxTipRad, Math.min(maxTipRad, env.pitch));
    let roll = Math.max(-maxTipRad, Math.min(maxTipRad, env.roll));
    if (Math.abs(pitch) < 2e-4 && Math.abs(roll) < 2e-4) break;
    const q0 = mesh.quaternion.clone();
    const py0 = mesh.position.y;
    applyAxis(new THREE.Vector3(0, 0, 1), -pitch);
    applyAxis(new THREE.Vector3(1, 0, 0), -roll);
    snapG();
    if (!faceDownOk()) {
      mesh.quaternion.copy(q0);
      mesh.rotation.setFromQuaternion(q0);
      mesh.position.set(kx, py0, kz);
      snapG();
      break;
    }
    if (csShipPrepTipGapMm(mesh) <= tolMm) break;
  }

  let bestTg = csShipPrepTipGapMm(mesh);
  let bestQ = mesh.quaternion.clone();
  let bestPy = mesh.position.y;
  const tipDegs = [0.5, 1, 2, 3, 5, 8, 12, 18, 25];
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const axis of axes) {
      for (const d of tipDegs) {
        for (const sign of [1, -1]) {
          mesh.quaternion.copy(bestQ);
          applyAxis(axis, sign * d * Math.PI / 180);
          snapG();
          if (!faceDownOk()) continue;
          const tg = csShipPrepTipGapMm(mesh);
          if (tg < bestTg - 0.05) {
            bestTg = tg;
            bestQ = mesh.quaternion.clone();
            bestPy = mesh.position.y;
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  mesh.quaternion.copy(bestQ);
  mesh.rotation.setFromQuaternion(bestQ);
  mesh.position.set(kx, bestPy, kz);
  snapG();
  return { tipGapMm: csShipPrepTipGapMm(mesh) };
}

/** Stamp ship-prep fields onto item from live mesh. */
function csShipPrepStamp(it, mesh, cls, tipGapMm) {
  if (!it || !mesh) return;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const q = mesh.quaternion;
  it._groupByQuat = { x: q.x, y: q.y, z: q.z, w: q.w };
  it._freezeGroupByPose = true;
  it._shipPrepped = true;
  it._shipPrepClass = cls || csShipPrepClass(it);
  it.tipGapMm = (typeof tipGapMm === 'number') ? tipGapMm : csShipPrepTipGapMm(mesh);
  it._orientLocked = true;
  try {
    it._lockedQuaternion = mesh.quaternion.clone();
  } catch (_) { /* */ }
  if (isFinite(box.min.x) && sc > 0) {
    let sb = {
      l: Math.max((box.max.x - box.min.x) / sc, 1),
      h: Math.max((box.max.y - box.min.y) / sc, 1),
      w: Math.max((box.max.z - box.min.z) / sc, 1),
      source: 'ship_prep',
      tipGapMm: it.tipGapMm,
    };
    // Mesh max-flat can still exceed 40ft W (pitched plan AABB). Prefer IFC
    // construct axes — same remap as W.12d3/d4 — stamped as ship_prep.
    if ((sb.w > 2438 + 1 || sb.h > 2690 + 1)
        && typeof cs8SanitizePitchedAssemblyEnvelope === 'function') {
      const memberL = Math.max(
        +it.lengthMm || 0, +it.widthMm || 0, +it.heightMm || 0,
        +it.lengthMaxMm || 0, sb.l, 1);
      // IFC axis-swap: span often on widthMm (RF012 200×11607×2507).
      // Prefer rawScene envelope when pack-unit sectH is a Tekla plate stamp.
      let iL = +it.lengthMm || sb.l;
      let iW = +it.widthMm || sb.w;
      let iH = +it.heightMm || sb.h;
      try {
        if (typeof rawScene !== 'undefined' && rawScene && rawScene.items) {
          const marks = new Set(
            [it.mark, ...((it.marks) || [])].filter(Boolean).map(m => String(m)));
          const markRe = Array.from(marks).filter(m => m.length >= 3)
            .map(m => {
              try { return new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
              catch (_) { return null; }
            }).filter(Boolean);
          const hit = rawScene.items.find(r => {
            if (!r) return false;
            const rm = String(r.mark || '');
            if (marks.has(rm)) return true;
            if (((r.marks) || []).some(m => marks.has(String(m)))) return true;
            // RF012 ↔ "604.2A-6 · set 1" share marks[] on pack unit
            return markRe.some(re => re.test(rm)
              || ((r.marks) || []).some(m => re.test(String(m))));
          });
          if (hit && +hit.lengthMm > 0 && +hit.widthMm > 0 && +hit.heightMm > 0) {
            iL = +hit.lengthMm;
            iW = +hit.widthMm;
            iH = +hit.heightMm;
          }
        }
      } catch (_) { /* */ }
      if (typeof cs8NormalizeAssemblyShipAxes === 'function') {
        const ax = cs8NormalizeAssemblyShipAxes(iL, iW, iH, it);
        if (ax) { iL = ax.l; iW = ax.w; iH = ax.h; }
      }
      // Ignore Tekla plate CS stamps (mark "604.2A-6" → sectH=604/sectW=6)
      const sectW = +it.sectW || 0;
      const sectH = +it.sectH || 0;
      const unitW = +it.unitWidth || 0;
      const unitH = +it.unitHeight || 0;
      const cW = (sectW >= 40 && sectW <= 2438 && !(iW >= 80 && sectW < iW * 0.35))
        ? sectW
        : ((unitW >= 40 && unitW <= 2438) ? unitW : iW);
      const cH = (sectH >= 40 && sectH <= 2690 && !(iH >= 80 && Math.abs(sectH - iH) > 200))
        ? sectH
        : ((unitH >= 40 && unitH <= 2690) ? unitH : iH);
      const fixed = cs8SanitizePitchedAssemblyEnvelope(
        sb, it, Math.max(memberL, iL), cW, cH);
      if (fixed && fixed.w <= 2438 + 1 && fixed.h <= 2690 + 1) {
        sb = {
          l: fixed.l, w: fixed.w, h: fixed.h,
          source: 'ship_prep',
          tipGapMm: it.tipGapMm,
          pitchedFrom: fixed.pitchedFrom || { l: sb.l, w: sb.w, h: sb.h },
          constructSeat: true,
        };
        // RF/CL piece marks: always prefer rawScene IFC envelope (not Tekla CS height)
        try {
          const pieceMark = [it.mark, ...((it.marks) || [])]
            .map(m => String(m || ''))
            .find(m => /^(RF|CL)\d+/i.test(m));
          if (pieceMark && typeof rawScene !== 'undefined' && rawScene && rawScene.items
              && typeof cs8NormalizeAssemblyShipAxes === 'function') {
            const hit = rawScene.items.find(r => r && (
              String(r.mark || '') === pieceMark
              || new RegExp(`^${pieceMark}\\b`, 'i').test(String(r.mark || ''))
              || ((r.marks) || []).some(m => String(m) === pieceMark)));
            if (hit) {
              const ax = cs8NormalizeAssemblyShipAxes(
                +hit.lengthMm, +hit.widthMm, +hit.heightMm, it);
              if (ax && ax.w <= 2438 + 1 && ax.h <= 2690 + 1
                  && ax.l > 4000 && ax.h > sb.h + 50) {
                sb.l = ax.l; sb.w = ax.w; sb.h = ax.h;
                sb.fromSceneMark = pieceMark;
              }
            }
          }
        } catch (_) { /* */ }
        // Align live mesh to construct footprint when helper exists
        it.packFootprintL = sb.l;
        it.packFootprintW = sb.w;
        it.packFootprintH = sb.h;
        if (typeof alignMeshToPackFootprint === 'function') {
          try {
            alignMeshToPackFootprint(mesh, it);
            csShipPrepNailGround(mesh);
            const q2 = mesh.quaternion;
            it._groupByQuat = { x: q2.x, y: q2.y, z: q2.z, w: q2.w };
            it.tipGapMm = csShipPrepTipGapMm(mesh);
            sb.tipGapMm = it.tipGapMm;
          } catch (_) { /* */ }
        }
      }
    }
    it.stableBundleMm = sb;
    it.packFootprintL = sb.l;
    it.packFootprintW = sb.w;
    it.packFootprintH = sb.h;
  }
  try {
    if (!mesh.userData) mesh.userData = {};
    mesh.userData._groupByQuat = { ...it._groupByQuat };
    mesh.userData._shipPrepped = true;
  } catch (_) { /* */ }
}

/**
 * Apply Ship Prep to a display mesh (rigid only).
 * @returns {{ ok, class, tipGapMm, method }}
 */
function csShipPrepMesh(mesh, it) {
  if (!mesh || !it || typeof THREE === 'undefined') {
    return { ok: false, reason: 'no_mesh' };
  }
  const cls = csShipPrepClass(it);
  const keepX = mesh.position.x;
  const keepZ = mesh.position.z;
  let method = 'nail';
  let tipGapMm = 0;

  if (cls === 'nest_z') {
    // Legacy Z nest / Rule1 — never PCA flatten
    method = 'nest_z_keep';
    if (typeof ensureStableShape === 'function' && !it._keepGroupByBundle) {
      // makeShape already built nest; just nail
    }
    csShipPrepNailGround(mesh);
    tipGapMm = csShipPrepTipGapMm(mesh);
    csShipPrepStamp(it, mesh, cls, tipGapMm);
    return { ok: true, class: cls, tipGapMm, method };
  }

  if (cls === 'assembly') {
    method = 'assembly_ship_prep';
    it._yardStraighten = true;
    it.assemblyShipPose = true;
    if (typeof straightenYardItemOnGround === 'function') {
      straightenYardItemOnGround(mesh, it);
    }
    const tip = csShipPrepTipLevel(mesh, keepX, keepZ);
    tipGapMm = tip.tipGapMm;
    csShipPrepNailGround(mesh);
    // If max-flat AABB still exceeds 40ft W, try refineAssemblyGroundPose once
    // (may pick construct / mid-height seat that fits without inventing dims).
    {
      const sc0 = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
      mesh.updateMatrixWorld(true);
      const b0 = new THREE.Box3().setFromObject(mesh);
      const w0 = (b0.max.z - b0.min.z) / sc0;
      const h0 = (b0.max.y - b0.min.y) / sc0;
      if ((w0 > 2438 + 1 || h0 > 2690 + 1)
          && typeof refineAssemblyGroundPose === 'function') {
        try {
          refineAssemblyGroundPose(mesh, it, null);
          mesh.position.x = keepX;
          mesh.position.z = keepZ;
          csShipPrepNailGround(mesh);
          const tip2 = csShipPrepTipLevel(mesh, keepX, keepZ);
          tipGapMm = tip2.tipGapMm;
          method = 'assembly_ship_prep_refine';
        } catch (_) { /* */ }
      }
    }
    csShipPrepStamp(it, mesh, cls, tipGapMm);
    return { ok: true, class: cls, tipGapMm, method };
  }

  if (cls === 'nest_c' || cls === 'nest_l') {
    method = 'nest_ground';
    it._keepGroupByBundle = true;
    csShipPrepNailGround(mesh);
    tipGapMm = csShipPrepTipGapMm(mesh);
    csShipPrepStamp(it, mesh, cls, tipGapMm);
    return { ok: true, class: cls, tipGapMm, method };
  }

  // plate / rod / beam / other — yard straighten when available, else nail
  method = 'flat_ground';
  if (typeof straightenYardItemOnGround === 'function' && !csShipPrepIsZ(it)) {
    it._yardStraighten = true;
    straightenYardItemOnGround(mesh, it);
  } else if (typeof groundOrientItem === 'function') {
    groundOrientItem(it, mesh);
  }
  csShipPrepNailGround(mesh);
  tipGapMm = csShipPrepTipGapMm(mesh);
  csShipPrepStamp(it, mesh, cls, tipGapMm);
  return { ok: true, class: cls, tipGapMm, method };
}

/**
 * Measure + Ship Prep a pack unit / item via temp makeShape.
 * Stamps _shipPrepped / quat / stableBundleMm on `it`.
 */
function csShipPrepItem(it) {
  if (!it) return { ok: false, reason: 'no_item' };
  // Re-run when prior stamp still exceeds 40ft or looks like a plate-CS height
  const sb0 = it.stableBundleMm;
  const staleSeat = !!(sb0 && /ship_prep/i.test(String(sb0.source || ''))
    && (+sb0.w > 2438 + 1 || +sb0.h > 2690 + 1
      || (it.sectH > 0 && Math.abs(+sb0.h - +it.sectH) < 1.5 && +sb0.h < 900)));
  if (it._shipPrepped && it._groupByQuat && sb0 && !staleSeat
      && /ship_prep|yard_straighten/i.test(String(sb0.source || ''))) {
    return {
      ok: true, class: it._shipPrepClass || csShipPrepClass(it),
      tipGapMm: it.tipGapMm || 0, method: 'cached',
    };
  }
  if (typeof makeShape !== 'function' || typeof SCALE !== 'number') {
    // Soft stamp so Optimise can still proceed with existing sb
    it._shipPrepped = !!(it._groupByQuat || it.stableBundleMm || it._freezeGroupByPose);
    return { ok: !!it._shipPrepped, method: 'soft_stamp', class: csShipPrepClass(it) };
  }
  let mesh = null;
  try {
    const cls = csShipPrepClass(it);
    mesh = makeShape({
      ...it,
      lengthMm: it.lengthMm || it.l || 500,
      widthMm: it.widthMm || it.w || 200,
      heightMm: it.heightMm || it.h || 200,
      qty: it.qty || 1,
      _yardStraighten: cls !== 'nest_z',
      _keepGroupByBundle: cls === 'nest_z' || cls === 'nest_c' || cls === 'nest_l',
      assemblyShipPose: cls === 'assembly',
      _skipStability: false,
    }, 0xffffff, 1);
    const r = csShipPrepMesh(mesh, it);
    return r;
  } catch (e) {
    try { console.warn('[ship-prep]', it.mark, e); } catch (_) { /* */ }
    return { ok: false, reason: 'exception' };
  } finally {
    if (mesh && typeof disposeTempMesh === 'function') disposeTempMesh(mesh);
    else if (mesh) {
      try {
        mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      } catch (_) { /* */ }
    }
  }
}

/** Ship Prep a pack unit (mutates pu). */
function csShipPrepPackUnit(pu) {
  if (!pu) return { ok: false };
  // Warehouse stubs / name-only parts: soft stamp — do not remesh (keeps W.16b/W.18d)
  const parts = pu.parts || [];
  const stubOnly = parts.length >= 2 && parts.every(p => p && !Number(p.lengthMm)
    && !p.geometry && !p.transform
    && /^(web|flange|a|b|part)$/i.test(String(p.name || 'part')));
  if (stubOnly || pu._skipShipPrepRemesh) {
    pu._shipPrepped = true;
    pu._freezeGroupByPose = true;
    pu.needs_ship_prep = false;
    if (pu.stableBundleMm && !pu.stableBundleMm.source)
      pu.stableBundleMm.source = 'ship_prep';
    return { ok: true, method: 'stub_soft', class: csShipPrepClass(pu) };
  }
  const r = csShipPrepItem(pu);
  if (r && r.ok) {
    pu._shipPrepped = true;
    pu._freezeGroupByPose = true;
    if (pu.stableBundleMm && pu.stableBundleMm.source === 'ship_prep') {
      pu.packFootprintL = pu.stableBundleMm.l;
      pu.packFootprintW = pu.stableBundleMm.w;
      pu.packFootprintH = pu.stableBundleMm.h;
    }
  }
  return r;
}

/** True if unit is ship-ready for Optimise freeze pack. */
function csShipPrepReady(u) {
  if (!u) return false;
  if (u.needs_ship_prep && !u._shipPrepped) return false;
  // Soft stamp / nest stamp / full mesh prep all set _shipPrepped
  if (u._shipPrepped) return true;
  if (u._groupByQuat && u._freezeGroupByPose) return true;
  if (u._keepGroupByBundle && (u.nestPieces || /^nest_/i.test(String(u.groupKind || ''))))
    return true;
  if (u._freezeGroupByPose && u.stableBundleMm
      && /ship_prep|yard_straighten/i.test(String(u.stableBundleMm.source || '')))
    return true;
  return false;
}
