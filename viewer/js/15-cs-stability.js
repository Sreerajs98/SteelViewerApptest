/* 15-cs-stability.js — Automatic nest / bundle ground stability (rigid only)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / mesh / ExtrudeGeometry / sect dims           ║
 * ║  • ONLY rigid group.rotation + group.position.y (floor sit)          ║
 * ║  • Uses Step3 orientation_info as a HINT, not a geometry rewrite     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Goal: every staging/pack mesh sits face-down on Y=0 (gravity),
 * length horizontal, never balanced on a corner / thin edge.
 *
 * After a nest bundle is built:
 *   1) Evaluate CoG vs base footprint (tip-over risk)
 *   2) Try 90° rest poses; pick most stable (wide base, low CoG, length horiz)
 *   3) Prefer Step3 vert_key + profile face-down priors
 *   4) Nest mode: stack_up / collision_flip — NEVER diagonal for display
 */

const CSTAB_TIP_LIMIT = 0.88;       // |cog offset| / base_half > this → unstable
const CSTAB_MARGIN = 0.08;          // keep CoG inside 92% of base half-extents
const CSTAB_MIN_BASE_MM = 8;

/** Welded / multi-part assembly — base cargo (not nest Z/C). */
function cstabIsWeldedAssembly(it) {
  if (!it) return false;
  if (it._assemblyChild) return false;
  if (it.groupKind === 'welded_assembly') return true;
  if (it.isAssembly && it.parts && it.parts.length >= 2) return true;
  if (it.crossSection?.welded_assembly || it.crossSection?.open_closed === 'welded')
    return true;
  return false;
}

/** Sample world-space mesh vertices (skip edge lines). */
function cstabSampleMeshPoints(group, maxPts) {
  const pts = [];
  if (!group || typeof THREE === 'undefined') return pts;
  group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const budget = Math.max(80, maxPts || 600);
  group.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    if (o.isLine || o.isLineSegments) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos || pos.count < 3) return;
    const step = Math.max(1, Math.floor(pos.count / 48));
    for (let i = 0; i < pos.count && pts.length < budget; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  });
  return pts;
}

/**
 * 3×3 PCA on xyz samples → axes sorted longest→shortest extent.
 * Cancels IFC roof-pitch: longest principal follows the member axis.
 */
function cstabPrincipalAxesFromPoints(xyz) {
  const n = Math.floor((xyz?.length || 0) / 3);
  if (n < 6) return null;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    mx += xyz[i * 3]; my += xyz[i * 3 + 1]; mz += xyz[i * 3 + 2];
  }
  mx /= n; my /= n; mz /= n;

  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (let i = 0; i < n; i++) {
    const dx = xyz[i * 3] - mx;
    const dy = xyz[i * 3 + 1] - my;
    const dz = xyz[i * 3 + 2] - mz;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }
  const inv = 1 / Math.max(n - 1, 1);
  cxx *= inv; cxy *= inv; cxz *= inv; cyy *= inv; cyz *= inv; czz *= inv;

  // Jacobi eigen-decomposition (symmetric 3×3)
  let a = [
    [cxx, cxy, cxz],
    [cxy, cyy, cyz],
    [cxz, cyz, czz],
  ];
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 24; iter++) {
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { max = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > max) { max = Math.abs(a[1][2]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    for (let k = 0; k < 3; k++) {
      const aik = a[p][k], aqk = a[q][k];
      if (k === p || k === q) continue;
      a[p][k] = a[k][p] = c * aik - s * aqk;
      a[q][k] = a[k][q] = s * aik + c * aqk;
    }
    a[p][p] = app - t * apq;
    a[q][q] = aqq + t * apq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vip = v[k][p], viq = v[k][q];
      v[k][p] = c * vip - s * viq;
      v[k][q] = s * vip + c * viq;
    }
  }

  const evals = [a[0][0], a[1][1], a[2][2]];
  const order = [0, 1, 2].sort((i, j) => evals[j] - evals[i]);
  const axes = order.map(i => {
    const ax = new THREE.Vector3(v[0][i], v[1][i], v[2][i]);
    if (ax.lengthSq() < 1e-18) ax.set(1, 0, 0);
    else ax.normalize();
    return ax;
  });
  // Right-handed: axis2 = axis0 × axis1
  const chk = new THREE.Vector3().crossVectors(axes[0], axes[1]);
  if (chk.dot(axes[2]) < 0) axes[2].negate();
  else if (chk.lengthSq() > 1e-12) axes[2].copy(chk.normalize());

  return {
    mean: new THREE.Vector3(mx, my, mz),
    axes, // [longest, mid, shortest]
    eigenvalues: order.map(i => evals[i]),
  };
}

/**
 * Rigid-rotate group so principal longest → world +X (cancels IFC pitch/lean).
 * Roll around X left for face trials.
 */
function cstabAlignLongestToWorldX(group) {
  const xyz = cstabSampleMeshPoints(group, 700);
  const pca = cstabPrincipalAxesFromPoints(xyz);
  if (!pca) return { ok: false };
  const long = pca.axes[0].clone();
  // Prefer +X hemisphere (stable across reloads)
  if (long.x < 0) long.negate();
  if (long.lengthSq() < 1e-12) return { ok: false };
  const target = new THREE.Vector3(1, 0, 0);
  // Already nearly along X — skip tiny jitter
  if (long.dot(target) > 0.9995) return { ok: true, pca, skipped: true };
  const qAlign = new THREE.Quaternion().setFromUnitVectors(long.normalize(), target);
  group.quaternion.premultiply(qAlign);
  group.rotation.setFromQuaternion(group.quaternion);
  group.updateMatrixWorld(true);
  return { ok: true, pca, skipped: false };
}

/**
 * Human-yard rest pose for welded assemblies (rigid only):
 *  1) PCA: cancel IFC roof-pitch / column upright → length along +X
 *  2) Try Rx / Ry / Rz 90° faces (like a yard man rolling the piece)
 *  3) Snap full contact to Y=0; pick widest stable base, not thin-edge tip
 */
function refineAssemblyGroundPose(group, it, orientationInfo) {
  if (!group || typeof THREE === 'undefined') return null;

  const keepX = group.position.x;
  const keepZ = group.position.z;

  // Start from builder pose, then flatten member axis onto world X
  const alignInfo = cstabAlignLongestToWorldX(group);
  const qFlat = group.quaternion.clone();

  // Face rolls a yard man tries after laying length horizontal, plus fine
  // pitch-cancel about Y/Z (IFC roof slope often remains after PCA).
  const trials = [
    { tag: 'flat', qx: 0, qy: 0, qz: 0 },
    { tag: 'Rx90', qx: Math.PI / 2, qy: 0, qz: 0 },
    { tag: 'Rx180', qx: Math.PI, qy: 0, qz: 0 },
    { tag: 'Rx270', qx: -Math.PI / 2, qy: 0, qz: 0 },
    { tag: 'Rz90', qx: 0, qy: 0, qz: Math.PI / 2 },
    { tag: 'Rz270', qx: 0, qy: 0, qz: -Math.PI / 2 },
    { tag: 'Ry180', qx: 0, qy: Math.PI, qz: 0 },
    { tag: 'Rx90_Ry180', qx: Math.PI / 2, qy: Math.PI, qz: 0 },
  ];
  const pitchDeg = [-30, -25, -20, -15, -10, -5, 5, 10, 15, 20, 25, 30];
  pitchDeg.forEach(d => {
    const r = d * Math.PI / 180;
    trials.push({ tag: `Ry${d}`, qx: 0, qy: r, qz: 0 });
    trials.push({ tag: `Rz${d}`, qx: 0, qy: 0, qz: r });
    trials.push({ tag: `Rx90_Ry${d}`, qx: Math.PI / 2, qy: r, qz: 0 });
  });
  let best = null;

  function snapGround() {
    group.position.x = keepX;
    group.position.z = keepZ;
    group.position.y = 0;
    group.updateMatrixWorld(true);
    if (typeof csNzSnapObjectToGround === 'function') {
      csNzSnapObjectToGround(group);
    } else {
      const box = new THREE.Box3().setFromObject(group);
      if (isFinite(box.min.y)) group.position.y -= box.min.y;
    }
    group.position.x = keepX;
    group.position.z = keepZ;
    group.updateMatrixWorld(true);
  }

  // 40ft-ish inner limits in scene units (reject residual roof-pitch footprint)
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  const shipW = 2438 * sc;
  const shipH = 2690 * sc;
  const shipL = 12192 * sc;

  function poseShipsIn40ft(ev) {
    const sx = ev.size?.x || 0;
    const sy = ev.size?.y || 0;
    const sz = ev.size?.z || 0;
    // Rest pose: length on X, lateral Z ≤ W, height Y ≤ H
    return sx <= shipL * 1.02 + 1e-6
      && sz <= shipW * 1.02 + 1e-6
      && sy <= shipH * 1.02 + 1e-6;
  }

  function scorePose(ev) {
    const sx = ev.size?.x || 1;
    const sy = ev.size?.y || 1;
    const sz = ev.size?.z || 1;
    const tipH = sy / Math.max(Math.min(sx, sz), 1e-9);
    const tipLim = (typeof WH_TIP_RATIO_MAX === 'number') ? WH_TIP_RATIO_MAX : 2.0;
    const floorOk = Math.abs(ev.floor_y || 0) < 1e-3;
    const lenHoriz = sx >= sy * 0.9 && sx >= sz * 0.85;
    let score = (ev.base_area || 0);
    if (floorOk) score += 1e7;
    if (ev.stable) score += 5e6;
    if (lenHoriz) score += 5e5;
    if (ev.inside_base) score += 1e5;
    // Hard reject standing / tip / thin-edge for base cargo
    if (ev.standing_on_end) score -= 2e7;
    if (ev.thin_edge_sit) score -= 8e6;
    if (tipH > tipLim) score -= 5e5 * (tipH - tipLim);
    // Prefer flange/web sit: mid height, not needle-thin vertical
    score -= sy * 25;
    score -= (ev.cog_height || 0) * 80;
    score -= (ev.tip_ratio || 0) * 2e4;
    // Reward length on X — NOT a huge Z (that was rewarding roof pitch ~21°)
    score += Math.min(sx, 50000) * 2;
    // Compact lateral (flange/web), not residual roof-pitch span
    if (sz > shipW * 1.02) score -= 8e7;
    else score += (shipW - sz) * 50;
    if (sy > shipH * 1.02) score -= 5e7;
    if (poseShipsIn40ft(ev)) score += 2e7;
    // Prefer lowest CoG + widest base among shippable faces (yard stable)
    score += (ev.base_area || 0) * 0.5;
    return score;
  }

  const candidates = [];
  for (const tr of trials) {
    group.quaternion.copy(qFlat);
    if (tr.qx || tr.qy || tr.qz) {
      const e = new THREE.Euler(tr.qx, tr.qy, tr.qz, 'XYZ');
      const qAdd = new THREE.Quaternion().setFromEuler(e);
      group.quaternion.premultiply(qAdd);
    }
    group.rotation.setFromQuaternion(group.quaternion);
    snapGround();
    const ev = evaluateMeshGroupStability(group);
    const score = scorePose(ev);
    const row = {
      score,
      tag: tr.tag,
      ev,
      q: group.quaternion.clone(),
      py: group.position.y,
      ships: poseShipsIn40ft(ev),
    };
    candidates.push(row);
    if (!best || score > best.score) best = row;
  }
  // Prefer shippable sits; among those, face-down (Y ≤ Z) + lowest height
  const shipOk = candidates.filter(c => c.ships);
  const pool = shipOk.length ? shipOk : candidates;
  if (pool.length) {
    pool.sort((a, b) => {
      const aFace = (a.ev?.size?.y || 0) <= (a.ev?.size?.z || 1) * 1.08 ? 1 : 0;
      const bFace = (b.ev?.size?.y || 0) <= (b.ev?.size?.z || 1) * 1.08 ? 1 : 0;
      if (aFace !== bFace) return bFace - aFace;
      const ay = a.ev?.size?.y || 1e9;
      const by = b.ev?.size?.y || 1e9;
      if (ay < by * 0.92) return -1;
      if (by < ay * 0.92) return 1;
      return b.score - a.score;
    });
    best = pool[0];
  }

  if (!best) return evaluateMeshGroupStability(group);

  group.quaternion.copy(best.q);
  group.rotation.setFromQuaternion(best.q);
  group.position.set(keepX, best.py, keepZ);
  group.updateMatrixWorld(true);
  snapGround();

  // Final re-centre on XZ so staging footprint is predictable
  if (typeof recenterGroupAabb === 'function' && group.children && group.children.length) {
    try {
      // Only shift children in XZ — keep Y ground after
      const box0 = new THREE.Box3().setFromObject(group);
      if (isFinite(box0.min.x)) {
        const cx = (box0.min.x + box0.max.x) * 0.5;
        const cz = (box0.min.z + box0.max.z) * 0.5;
        if (Math.abs(cx) > 1e-6 || Math.abs(cz) > 1e-6) {
          group.children.forEach(ch => {
            if (ch.matrixAutoUpdate === false) {
              ch.matrix.elements[12] -= cx;
              ch.matrix.elements[14] -= cz;
              ch.position.setFromMatrixPosition(ch.matrix);
            } else {
              ch.position.x -= cx;
              ch.position.z -= cz;
            }
          });
          group.updateMatrixWorld(true);
        }
      }
    } catch (_) { /* */ }
  }
  snapGround();

  const finalEv = evaluateMeshGroupStability(group);
  finalEv.applied_rotation = { tag: best.tag };
  finalEv.vert_key_hint = orientationInfo?.vert_key || null;
  finalEv.pose_locked = false;
  finalEv.assembly_base = true;
  finalEv.pca_aligned = !!(alignInfo && alignInfo.ok);
  finalEv.warehouse = {
    ok: true,
    method: 'assembly_pca_ship',
    rot: best.tag,
    tip_ratio: finalEv.tip_ratio,
    ground_stable: Math.abs(finalEv.floor_y || 0) < 1e-3,
    mark: it?.mark || null,
  };
  finalEv.floor_y = new THREE.Box3().setFromObject(group).min.y;
  finalEv.ground_stable = Math.abs(finalEv.floor_y || 0) < 1e-3
    && !finalEv.standing_on_end;
  finalEv.ground_touch = Math.abs(finalEv.floor_y || 0) < 1e-3;
  try {
    console.info(
      `[assembly-ship] ${it?.mark || '?'} pose=${best.tag}`
      + ` ground=${finalEv.ground_touch} pca=${finalEv.pca_aligned}`
      + ` tip=${(finalEv.tip_ratio || 0).toFixed(2)}`
    );
  } catch (_) { /* */ }
  return finalEv;
}

/**
 * Base-layer FIRST (heaviest) item — LYING ONLY (never stand upright).
 * Hard rule: longest AABB axis must be world X (container length).
 * Never accept standing_on_end / length-up poses.
 *
 * Search: X/Y/Z at 0,±1,±5,±15,±45,±90° (+ Rx±90 face rolls) → max ground support.
 *
 * @returns {{ rot:{x,y,z}, tag:string, pl:number, pw:number, ph:number,
 *             score:number, baseArea:number, ground:boolean, lying:boolean }|null}
 */
function searchBaseLayerGroundPose(it, Lmax, Wmax, Hmax) {
  if (!it || typeof THREE === 'undefined' || typeof makeShape !== 'function')
    return null;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
  const Lmm = Math.max(+Lmax || 12192, 1);
  const Wmm = Math.max(+Wmax || 2438, 1);
  const Hmm = Math.max(+Hmax || 2690, 1);
  const anglesDeg = [0, 1, 5, 15, 45, 90, -1, -5, -15, -45, -90];
  // Expected member span — reject poses that stand the piece up
  const spanHint = Math.max(
    +it.lengthMm || 0, +it.l || 0, +it.packLengthMm || 0,
    +it.stableBundleMm?.l || 0, 1);

  let mesh = null;
  try {
    mesh = makeShape({
      ...it,
      qty: 1,
      lengthMm: it.lengthMm || it.l || it.packLengthMm || 1000,
      widthMm: it.widthMm || it.w || it.packWidthMm || 200,
      heightMm: it.heightMm || it.h || it.packHeightMm || 200,
      _keepGroupByBundle: false,
      _skipNestRoll: false,
      packPoseLock: false,
    }, 0xffffff, 1);
  } catch (_) {
    return null;
  }
  if (!mesh) return null;

  const qRest = mesh.quaternion.clone();
  let best = null;
  let bestOrtho = null;
  let bestFits = null; // best among container-fitting lying poses

  function measure() {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.x)) return null;
    if (Math.abs(box.min.y) > 1e-6) {
      mesh.position.y -= box.min.y;
      mesh.updateMatrixWorld(true);
      box.setFromObject(mesh);
    }
    const ev = (typeof evaluateMeshGroupStability === 'function')
      ? evaluateMeshGroupStability(mesh)
      : null;
    if (!ev) return null;
    const pl = Math.max((box.max.x - box.min.x) / sc, 1);
    const ph = Math.max((box.max.y - box.min.y) / sc, 1);
    const pw = Math.max((box.max.z - box.min.z) / sc, 1);
    // LYING: longest on X, never stand on end (container may force non-ideal face)
    const longest = Math.max(pl, pw, ph);
    const faceDown = ph <= pw * 1.08;
    const lying = pl >= longest * 0.92
      && pl >= ph * 1.15
      && !ev.standing_on_end
      && ph <= Hmm * 1.02
      && pl >= Math.min(spanHint, Lmm) * 0.55;
    if (!lying) return null; // hard reject upright / end-stand

    const fits = pl <= Lmm * 1.02 && pw <= Wmm * 1.02 && ph <= Hmm * 1.02;
    const floorOk = Math.abs(ev.floor_y || 0) < 1e-3;
    // Max ground support — prefer face-down when it still fits the box
    let score = (ev.base_area || 0) / (sc * sc) * 20;
    if (floorOk) score += 1e9;
    if (ev.stable) score += 5e8;
    if (ev.length_horizontal) score += 3e8;
    if (fits) score += 1e8;
    else score -= 5e9;
    if (faceDown) score += 6e8;
    else score -= 2e8;
    if (ev.thin_edge_sit) score -= 4e8;
    if (ev.up_is_thinnest) score += 4e8;
    score -= (ev.cog_height || 0) / sc * 100;
    score -= (ev.tip_ratio || 0) * 1e5;
    // Prefer low profile + wide Z contact (flat flange, not fin)
    score -= ph * 400;
    score += pw * 120;
    return {
      score, pl, pw, ph, fits, floorOk, lying: true,
      baseArea: (ev.base_area || 0) / (sc * sc),
      stable: !!ev.stable,
      q: mesh.quaternion.clone(),
    };
  }

  function isOrthoEuler(rx, ry, rz) {
    const tol = 2 * Math.PI / 180;
    const near = (a, b) => Math.abs(a - b) <= tol
      || Math.abs(Math.abs(a - b) - Math.PI) <= tol;
    const ax = [0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI];
    const ok = (v) => ax.some(t => near(v, t));
    return ok(rx) && ok(ry) && ok(rz);
  }

  function tryEuler(rx, ry, rz, tag) {
    mesh.quaternion.copy(qRest);
    if (rx || ry || rz) {
      const qAdd = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rx, ry, rz, 'XYZ'));
      mesh.quaternion.premultiply(qAdd);
    }
    mesh.rotation.setFromQuaternion(mesh.quaternion);
    mesh.position.set(0, 0, 0);
    const row = measure();
    if (!row || !row.lying) return;
    row.tag = tag;
    row.rot = { x: rx, y: ry, z: rz };
    if (!best || row.score > best.score) best = row;
    if (row.fits && (!bestFits || row.score > bestFits.score)) bestFits = row;
    if (isOrthoEuler(rx, ry, rz)) {
      if (!bestOrtho || row.score > bestOrtho.score) bestOrtho = row;
    }
  }

  // Face-roll to lie flat (Rx±90) first — then fine angles for best ground sit
  for (let ai = 0; ai < anglesDeg.length; ai++) {
    const d = anglesDeg[ai];
    const r = d * Math.PI / 180;
    tryEuler(Math.PI / 2, r, 0, `Rx90_Ry${d}`);
    tryEuler(-Math.PI / 2, r, 0, `Rx-90_Ry${d}`);
    tryEuler(Math.PI / 2, 0, r, `Rx90_Rz${d}`);
    tryEuler(-Math.PI / 2, 0, r, `Rx-90_Rz${d}`);
    tryEuler(r, 0, 0, `Rx${d}`);
    tryEuler(0, r, 0, `Ry${d}`);
    tryEuler(0, 0, r, `Rz${d}`);
  }

  try {
    if (mesh && typeof disposeTempMesh === 'function') disposeTempMesh(mesh);
    else if (mesh) {
      mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
  } catch (_) { /* */ }

  // Container must win: never pick a flatter pose that does not fit 40ft
  if (bestFits) best = bestFits;
  if (!best || !best.lying) return null;
  // Prefer flatter ortho ONLY when it still fits
  if (bestOrtho && bestOrtho.lying && bestOrtho.fits
      && bestOrtho.ph < best.ph * 0.85) {
    best = bestOrtho;
  } else if (bestOrtho && bestOrtho.lying && bestOrtho.fits
      && bestOrtho.score >= best.score * 0.92) {
    best = bestOrtho;
  }
  if (!best.fits || !best.lying) return null;

  try {
    console.info(
      `[base-ground] ${it.mark || '?'} LYING → ${best.tag}`
      + ` base=${Math.round(best.baseArea)}mm²`
      + ` LWH=${Math.round(best.pl)}×${Math.round(best.pw)}×${Math.round(best.ph)}`
      + ` stable=${best.stable} ground=${best.floorOk}`
    );
  } catch (_) { /* */ }
  return {
    rot: best.rot,
    tag: best.tag,
    pl: best.pl,
    pw: best.pw,
    ph: best.ph,
    score: best.score,
    baseArea: best.baseArea,
    ground: best.floorOk,
    stable: best.stable,
    lying: true,
  };
}

/**
 * Group-By / yard staging: cancel IFC pitch & diagonal lean.
 * Hard rules — every piece must:
 *   1) Lie flat (longest principal → world +X, never stand on end)
 *   2) Sit axis-aligned (ortho face rolls only — no soft ±pitch)
 *   3) Touch ground (minY → 0) with widest stable base
 * Rigid only — does not mutate BufferGeometry.
 *
 * @returns {object|null} stability eval + warehouse stamp
 */
function straightenYardItemOnGround(mesh, it) {
  if (!mesh || typeof THREE === 'undefined') return null;

  const keepX = mesh.position.x;
  const keepZ = mesh.position.z;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;

  // Allow re-orient even if makeShape already stamped stability
  try {
    if (mesh.userData) mesh.userData._stabilityApplied = false;
  } catch (_) { /* */ }

  // 1) Cancel IFC roof-pitch / upright columns → length along +X
  const alignInfo = (typeof cstabAlignLongestToWorldX === 'function')
    ? cstabAlignLongestToWorldX(mesh)
    : { ok: false };
  const qFlat = mesh.quaternion.clone();

  // 2) Ortho face rolls ONLY — no ±5…30° soft pitch (that left "charinjj" lean)
  const trials = [
    { tag: 'flat', qx: 0, qy: 0, qz: 0 },
    { tag: 'Rx90', qx: Math.PI / 2, qy: 0, qz: 0 },
    { tag: 'Rx180', qx: Math.PI, qy: 0, qz: 0 },
    { tag: 'Rx270', qx: -Math.PI / 2, qy: 0, qz: 0 },
    { tag: 'Rz90', qx: 0, qy: 0, qz: Math.PI / 2 },
    { tag: 'Rz270', qx: 0, qy: 0, qz: -Math.PI / 2 },
    { tag: 'Ry90', qx: 0, qy: Math.PI / 2, qz: 0 },
    { tag: 'Ry270', qx: 0, qy: -Math.PI / 2, qz: 0 },
    { tag: 'Ry180', qx: 0, qy: Math.PI, qz: 0 },
    { tag: 'Rx90_Ry90', qx: Math.PI / 2, qy: Math.PI / 2, qz: 0 },
    { tag: 'Rx90_Ry180', qx: Math.PI / 2, qy: Math.PI, qz: 0 },
    { tag: 'Rx90_Ry270', qx: Math.PI / 2, qy: -Math.PI / 2, qz: 0 },
  ];

  function snapGround() {
    mesh.position.x = keepX;
    mesh.position.z = keepZ;
    mesh.position.y = 0;
    mesh.updateMatrixWorld(true);
    if (typeof csNzSnapObjectToGround === 'function') {
      csNzSnapObjectToGround(mesh);
    } else {
      const box = new THREE.Box3().setFromObject(mesh);
      if (isFinite(box.min.y)) mesh.position.y -= box.min.y;
    }
    mesh.position.x = keepX;
    mesh.position.z = keepZ;
    mesh.updateMatrixWorld(true);
  }

  function scorePose(ev) {
    const sx = ev.size?.x || 1;
    const sy = ev.size?.y || 1;
    const sz = ev.size?.z || 1;
    const longest = Math.max(sx, sy, sz);
    const thinnest = Math.min(sx, sy, sz);
    // Kidathy / max ground support:
    //  • length on X
    //  • cross-section flat: height Y ≤ width Z (not wall-on-edge)
    //  • never stand on end
    const faceDown = sy <= sz * 1.08;
    const lying = sx >= longest * 0.92
      && sx >= sy * 1.12
      && faceDown
      && !ev.standing_on_end
      && !ev.thin_edge_sit;
    const floorOk = Math.abs(ev.floor_y || 0) < 1e-3;
    // Primary: MAX ground footprint (sx×sz) — widest face down
    let score = (ev.base_area || 0) * 25;
    if (!lying) score -= 5e8;
    else score += 2e8;
    if (floorOk) score += 1e8;
    if (ev.stable) score += 5e7;
    if (ev.length_horizontal) score += 2e7;
    if (ev.standing_on_end) score -= 1e9;
    if (ev.thin_edge_sit) score -= 1e9;
    if (!faceDown) score -= 1e9;
    // Flange / plate face down: Y must be the thinnest axis
    if (ev.up_is_thinnest || Math.abs(sy - thinnest) < 1e-6) score += 2e8;
    else if (sy > thinnest * 1.5) score -= 1e8;
    // Strongly prefer low profile (flat) over tall wall
    score -= sy * 2000;
    score += sz * 80;
    score -= (ev.cog_height || 0) * 200;
    score -= (ev.tip_ratio || 0) * 3e4;
    // Height/width aspect — hard punish wall-like sits (even if tabs inflate Z)
    const crossAspect = sy / Math.max(sz, 1e-9);
    if (crossAspect > 1.05) score -= 5e7 * (crossAspect - 1.05);
    return { score, lying, floorOk };
  }

  let best = null;
  for (const tr of trials) {
    mesh.quaternion.copy(qFlat);
    if (tr.qx || tr.qy || tr.qz) {
      const e = new THREE.Euler(tr.qx, tr.qy, tr.qz, 'XYZ');
      mesh.quaternion.premultiply(new THREE.Quaternion().setFromEuler(e));
    }
    mesh.rotation.setFromQuaternion(mesh.quaternion);
    snapGround();
    const ev = evaluateMeshGroupStability(mesh);
    const scv = scorePose(ev);
    const row = {
      score: scv.score,
      lying: scv.lying,
      floorOk: scv.floorOk,
      tag: tr.tag,
      ev,
      q: mesh.quaternion.clone(),
      py: mesh.position.y,
    };
    if (!best || row.score > best.score) best = row;
  }

  // Prefer lying; among lying prefer lowest height (true flat / max support)
  {
    let bestLie = null;
    let bestFlat = null; // up_is_thinnest among lying
    for (const tr of trials) {
      mesh.quaternion.copy(qFlat);
      if (tr.qx || tr.qy || tr.qz) {
        const e = new THREE.Euler(tr.qx, tr.qy, tr.qz, 'XYZ');
        mesh.quaternion.premultiply(new THREE.Quaternion().setFromEuler(e));
      }
      mesh.rotation.setFromQuaternion(mesh.quaternion);
      snapGround();
      const ev = evaluateMeshGroupStability(mesh);
      const scv = scorePose(ev);
      if (!scv.lying) continue;
      const sy = ev.size?.y || 1;
      const row = {
        score: scv.score, lying: true, floorOk: scv.floorOk,
        tag: tr.tag, ev, q: mesh.quaternion.clone(), py: mesh.position.y,
        sy,
      };
      if (!bestLie || row.score > bestLie.score) bestLie = row;
      if (ev.up_is_thinnest) {
        if (!bestFlat || sy < bestFlat.sy - 1e-9
            || (Math.abs(sy - bestFlat.sy) < 1e-6 && row.score > bestFlat.score))
          bestFlat = row;
      }
    }
    if (bestFlat) best = bestFlat;
    else if (bestLie) best = bestLie;
  }

  if (!best) {
    snapGround();
    return evaluateMeshGroupStability(mesh);
  }

  mesh.quaternion.copy(best.q);
  mesh.rotation.setFromQuaternion(best.q);
  mesh.position.set(keepX, best.py, keepZ);
  mesh.updateMatrixWorld(true);
  snapGround();

  // After PCA+ortho, re-align if residual lean left length off X
  if (typeof cstabAlignLongestToWorldX === 'function') {
    const boxA = new THREE.Box3().setFromObject(mesh);
    const sx = (boxA.max.x - boxA.min.x);
    const sy = (boxA.max.y - boxA.min.y);
    const sz = (boxA.max.z - boxA.min.z);
    const longest = Math.max(sx, sy, sz);
    if (sx < longest * 0.9) {
      cstabAlignLongestToWorldX(mesh);
      snapGround();
    }
  }

  // Fin → flat: if still on thin edge (wall sit), roll ±90° about X once
  {
    let evNow = evaluateMeshGroupStability(mesh);
    if (evNow.thin_edge_sit || (!evNow.up_is_thinnest && !evNow.standing_on_end)) {
      const q0 = mesh.quaternion.clone();
      const py0 = mesh.position.y;
      let rescue = null;
      for (const ang of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
        mesh.quaternion.copy(q0);
        mesh.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang));
        mesh.rotation.setFromQuaternion(mesh.quaternion);
        snapGround();
        const evR = evaluateMeshGroupStability(mesh);
        const scR = scorePose(evR);
        if (!scR.lying) continue;
        if (!rescue || scR.score > rescue.score) {
          rescue = {
            score: scR.score, q: mesh.quaternion.clone(), py: mesh.position.y,
            tag: `rescue_Rx${Math.round(ang * 180 / Math.PI)}`,
          };
        }
      }
      if (rescue && rescue.score > (best.score || 0) * 0.5) {
        mesh.quaternion.copy(rescue.q);
        mesh.rotation.setFromQuaternion(rescue.q);
        mesh.position.set(keepX, rescue.py, keepZ);
        snapGround();
        best.tag = `${best.tag}+${rescue.tag}`;
        best.score = rescue.score;
      } else {
        mesh.quaternion.copy(q0);
        mesh.rotation.setFromQuaternion(q0);
        mesh.position.set(keepX, py0, keepZ);
        snapGround();
      }
    }
  }

  const finalEv = evaluateMeshGroupStability(mesh);
  finalEv.applied_rotation = { tag: best.tag };
  finalEv.pca_aligned = !!(alignInfo && alignInfo.ok);
  finalEv.yard_straighten = true;
  finalEv.ground_touch = Math.abs(finalEv.floor_y || 0) < 1e-3;
  finalEv.ground_stable = finalEv.ground_touch && !finalEv.standing_on_end;
  finalEv.warehouse = {
    ok: true,
    method: 'yard_straighten',
    rot: best.tag,
    tip_ratio: finalEv.tip_ratio,
    ground_stable: finalEv.ground_stable,
    mark: it?.mark || null,
  };

  if (it) {
    it.warehouseGround = finalEv.warehouse;
    it._yardStraightened = true;
    if (finalEv.size && sc > 0) {
      it.stableBundleMm = {
        l: finalEv.size.x / sc,
        h: finalEv.size.y / sc,
        w: finalEv.size.z / sc,
        source: 'yard_straighten',
      };
    }
  }
  try {
    if (!mesh.userData) mesh.userData = {};
    mesh.userData._stabilityApplied = true;
    mesh.userData.yardStraighten = finalEv.warehouse;
  } catch (_) { /* */ }

  try {
    console.info(
      `[yard-straight] ${it?.mark || '?'} pose=${best.tag}`
      + ` ground=${finalEv.ground_touch} lying=${!finalEv.standing_on_end}`
      + ` tip=${(finalEv.tip_ratio || 0).toFixed(2)}`
    );
  } catch (_) { /* */ }
  return finalEv;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Evaluate stability of a THREE Group of steel pieces (Y-up, resting on minY).
 * Rigid / AABB / CoG only — no geometry mutation.
 */
function evaluateMeshGroupStability(group) {
  if (!group || typeof THREE === 'undefined') {
    return { stable: true, score: 0, tip_ratio: 0, reason: 'no_group' };
  }
  group.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Equal-mass CoG from mesh world positions (piece roots)
  let n = 0;
  const cog = new THREE.Vector3();
  group.traverse(obj => {
    if (!obj.isMesh || obj.isLine || obj.isLineSegments) return;
    if (obj.parent && obj.parent.isMesh) return;
    const p = new THREE.Vector3();
    obj.getWorldPosition(p);
    cog.add(p);
    n++;
  });
  if (n > 0) cog.multiplyScalar(1 / n);
  else cog.copy(center);

  const sx = Math.max(size.x, 1e-6);
  const sy = Math.max(size.y, 1e-6);
  const sz = Math.max(size.z, 1e-6);

  const halfX = sx * 0.5;
  const halfZ = sz * 0.5;
  const baseHalfMin = Math.min(halfX, halfZ);
  const baseArea = sx * sz;

  const offX = Math.abs(cog.x - center.x);
  const offZ = Math.abs(cog.z - center.z);
  const tipX = offX / Math.max(halfX, 1e-6);
  const tipZ = offZ / Math.max(halfZ, 1e-6);
  const tip_ratio = Math.max(tipX, tipZ);

  const cogHeight = Math.max(cog.y - box.min.y, 1e-6);
  const scale = (typeof SCALE !== 'undefined' && SCALE > 0) ? SCALE : 0.01;
  const stability_score = (baseArea * Math.max(baseHalfMin, CSTAB_MIN_BASE_MM * scale))
    / (cogHeight * cogHeight);

  const inside = tipX <= (1 - CSTAB_MARGIN) && tipZ <= (1 - CSTAB_MARGIN);
  const stable = inside && tip_ratio <= CSTAB_TIP_LIMIT;

  const dims = [sx, sy, sz];
  const thinnest = Math.min(sx, sy, sz);
  const tallest = Math.max(sx, sy, sz);
  const up_is_thinnest = Math.abs(sy - thinnest) < 1e-6;
  const up_is_tallest = Math.abs(sy - tallest) < 1e-6;
  // Length should be the long horizontal axis (X preferred)
  const length_horizontal = sx + 1e-6 >= sy && sx + 1e-6 >= sz * 0.85;
  const standing_on_end = sy + 1e-6 >= sx * 0.95 && sy + 1e-6 >= sz * 0.95;
  // Thin-edge tower: height taller than plan span
  const thin_edge_tower = (sy > Math.max(sx, sz) * 1.15)
    && (Math.min(sx, sz) < Math.max(sx, sz) * 0.35);
  // Long fin / blade: length on X but standing on narrow Z (wall-on-edge).
  // Classic tower test misses this — sy << sx so old rule never fired.
  const thin_edge_fin = length_horizontal
    && (sy > sz * 1.25)
    && (sz < sx * 0.15)
    && (sy > thinnest * 1.4);
  const thin_edge_sit = thin_edge_tower || thin_edge_fin;

  return {
    stable,
    score: stability_score,
    tip_ratio,
    tip_x: tipX,
    tip_z: tipZ,
    cog_height: cogHeight,
    base_area: baseArea,
    base_half_min: baseHalfMin,
    size: { x: sx, y: sy, z: sz },
    up_is_thinnest,
    up_is_tallest,
    length_horizontal,
    standing_on_end,
    thin_edge_sit,
    floor_y: box.min.y,
    inside_base: inside,
    reason: stable
      ? (standing_on_end ? 'standing_on_end' : (thin_edge_sit ? 'thin_edge' : 'ok'))
      : (inside ? 'high_tip_ratio' : 'cog_outside_base'),
  };
}

/**
 * FIRST PRIORITY: warehouse AABB widest-face ground sit (rigid only).
 * Falls back to legacy CoG search only if warehouse helper missing.
 */
function applyStableRestPose(group, orientationInfo, itemOrOpts) {
  if (!group) return null;

  const it = itemOrOpts || null;
  const sk = (it && (it.shapeKey || it.profileShape)) || '';
  const qty = Math.max(1, Number(it?.qty) || 1);
  const nestKids = cstabCountPieceMeshes(group);

  // Multi-piece nest stacks: do NOT tip the whole nest onto its side —
  // EXCEPT Group-By yard straighten (must lie horizontal / no diagonal lean).
  if (qty > 1 && nestKids > 1 && !(it && it._yardStraighten)) {
    const locked = cstabLockedRestPose(sk, it, nestKids, qty);
    if (locked) {
      group.rotation.set(locked.x, locked.y, locked.z);
      group.updateMatrixWorld(true);
      if (typeof recenterGroupAabb === 'function') recenterGroupAabb(group);
      group.updateMatrixWorld(true);
      const boxL = new THREE.Box3().setFromObject(group);
      if (isFinite(boxL.min.y)) group.position.y -= boxL.min.y;
      group.updateMatrixWorld(true);
      const finalLocked = evaluateMeshGroupStability(group);
      finalLocked.applied_rotation = locked;
      finalLocked.pose_locked = true;
      finalLocked.nest_upright = true;
      finalLocked.ground_stable = !!(
        finalLocked.stable
        && !finalLocked.standing_on_end
        && Math.abs(finalLocked.floor_y || 0) < 1e-3
      );
      return finalLocked;
    }
  }

  // ── RULE 1 single pipeline (assembly / live-rotate / warehouse) ─────────
  // groundOrientItem is the ONLY display-mesh ground path (no parallel systems).
  if (typeof groundOrientItem === 'function' && !(qty > 1 && nestKids > 1)) {
    const r1 = groundOrientItem(it, group);
    group.updateMatrixWorld(true);
    const finalEv = (typeof evaluateMeshGroupStability === 'function')
      ? evaluateMeshGroupStability(group)
      : {
        stable: !!(r1 && r1.ground_stable),
        floor_y: r1 && r1.floor_y,
        tip_ratio: 0,
        score: 0,
      };
    const live = r1 && r1.live;
    const wh = r1 && r1.warehouse;
    finalEv.applied_rotation = live
      ? { x: Number(live.applied_rad) || 0, y: 0, z: 0 }
      : (wh && wh.rot === 'Rx'
        ? { x: Math.PI / 2, y: 0, z: 0 }
        : (wh && wh.rot === 'Rz'
          ? { x: 0, y: 0, z: Math.PI / 2 }
          : { x: 0, y: 0, z: 0 }));
    finalEv.vert_key_hint = orientationInfo?.vert_key || null;
    finalEv.pose_locked = false;
    finalEv.warehouse = wh || null;
    finalEv.z_nesting = live || null;
    finalEv.nesting_angle_rad = live?.applied_rad
      || it?.orientation_info?.nesting_angle_rad || 0;
    finalEv.rule1 = r1;
    finalEv.floor_y = (r1 && r1.floor_y != null) ? r1.floor_y : finalEv.floor_y;
    finalEv.ground_stable = !!(r1 && r1.ground_stable)
      || Math.abs(finalEv.floor_y || 0) < 1e-3;
    finalEv.ground_touch = finalEv.ground_stable;
    finalEv.thin_edge_sit = false;
    finalEv.chosen_score = (wh && wh.face_area) || finalEv.score || 0;
    return finalEv;
  }

  // ── Legacy fallback (should rarely run) ─────────────────────────────────
  const locked = cstabLockedRestPose(sk, it, nestKids, qty);
  if (locked) {
    group.rotation.set(locked.x, locked.y, locked.z);
    group.updateMatrixWorld(true);
    if (typeof recenterGroupAabb === 'function') recenterGroupAabb(group);
    group.updateMatrixWorld(true);
    const boxL = new THREE.Box3().setFromObject(group);
    if (isFinite(boxL.min.y)) group.position.y -= boxL.min.y;
    group.updateMatrixWorld(true);
    const finalLocked = evaluateMeshGroupStability(group);
    finalLocked.applied_rotation = locked;
    finalLocked.pose_locked = true;
    finalLocked.ground_stable = !!(
      finalLocked.stable
      && !finalLocked.standing_on_end
      && Math.abs(finalLocked.floor_y || 0) < 1e-3
    );
    return finalLocked;
  }

  const singleAxis = [
    { x: 0, y: 0, z: 0 },
    { x: Math.PI / 2, y: 0, z: 0 },
    { x: -Math.PI / 2, y: 0, z: 0 },
    { x: 0, y: 0, z: Math.PI / 2 },
    { x: 0, y: 0, z: -Math.PI / 2 },
  ];
  let best = null;
  const savedPos = { x: group.position.x, y: group.position.y, z: group.position.z };
  for (const r of singleAxis) {
    group.rotation.set(r.x, r.y, r.z);
    group.position.set(savedPos.x, savedPos.y, savedPos.z);
    group.updateMatrixWorld(true);
    const box0 = new THREE.Box3().setFromObject(group);
    if (isFinite(box0.min.y)) group.position.y -= box0.min.y;
    group.updateMatrixWorld(true);
    const ev = evaluateMeshGroupStability(group);
    const score = (ev.base_area || 1) / Math.max(ev.cog_height || 1, 1e-6)
      * (ev.stable ? 1.4 : 0.4);
    if (!best || score > best.score) best = { r: { ...r }, score, ev };
  }
  if (!best) return evaluateMeshGroupStability(group);
  group.rotation.set(best.r.x, best.r.y, best.r.z);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (isFinite(box.min.y)) group.position.y -= box.min.y;
  group.updateMatrixWorld(true);
  const finalEv = evaluateMeshGroupStability(group);
  finalEv.applied_rotation = best.r;
  finalEv.ground_stable = !!(finalEv.stable && Math.abs(finalEv.floor_y || 0) < 1e-3);
  return finalEv;
}

/** Count top-level piece meshes in a nest group. */
function cstabCountPieceMeshes(group) {
  if (!group || !group.children) return 0;
  let n = 0;
  group.children.forEach(ch => {
    if (ch.isMesh || (ch.isGroup && ch.children && ch.children.length)) n++;
  });
  return n;
}

/**
 * Known analytic shapes: return locked euler (radians) or null to search.
 * IMPORTANT: some builders leave orientation on mesh.rotation (rod z=π/2,
 * C single x=π/2). Extruded profiles bake length into geometry (euler 0).
 * Locking to 0 must NOT wipe those mesh.rotation builders.
 */
function cstabLockedRestPose(sk, it, nestKids, qty) {
  // CylinderGeometry is Y-up; makeRod sets child/mesh z=π/2 → length on X.
  // Bundle: children already rotated — group lock must stay identity.
  if (sk === 'rod' || sk === 'bent_sag_rod') {
    if (qty > 1 || nestKids > 1) return { x: 0, y: 0, z: 0 };
    return { x: 0, y: 0, z: Math.PI / 2 };
  }
  // Single C: opening UP via mesh.rotation.x = π/2 (do not wipe to 0)
  if (sk === 'c_channel' && qty <= 1 && nestKids <= 1) {
    return { x: Math.PI / 2, y: 0, z: 0 };
  }
  // Extruded analytic profiles (geometry already face-down, euler 0)
  if (sk === 'l_angle' || sk === 'z_channel' || sk === 'c_channel'
      || sk === 'i_beam' || sk === 'rhs' || sk === 'chs'
      || sk === 'plate') {
    return { x: 0, y: 0, z: 0 };
  }
  return null;
}

/** Pose score — maximize face-down stability for yard packing. */
function cstabScorePose(ev, ctx) {
  const { vert, sk, longMember, r, openLong } = ctx;
  let score = ev.score;

  if (ev.stable) score *= 1.40;
  else score *= 0.35;

  // Hard preferences
  if (ev.length_horizontal) score *= 1.55;
  else score *= 0.25;

  if (ev.standing_on_end) score *= 0.05;
  if (ev.thin_edge_sit) score *= 0.12;

  // Low tip + low CoG
  score *= (1.20 - 0.55 * Math.min(ev.tip_ratio, 1));
  const aspectUp = ev.size.y / Math.max(Math.sqrt(ev.base_area), 1e-6);
  score *= 1 / (1 + aspectUp); // prefer squat

  // Step3 hint
  if (vert === 'T' && ev.up_is_thinnest) score *= 1.45;
  if (vert === 'H' && ev.up_is_tallest) score *= 1.15;
  if (vert === 'W' && !ev.up_is_thinnest && !ev.up_is_tallest) score *= 1.10;

  // Profile face-down priors (analytic shapes start in known poses)
  const rx = Math.abs(r.x), rz = Math.abs(r.z);
  const near0 = (a) => a < 1e-6 || Math.abs(a - Math.PI) < 1e-6;
  const isIdentity = near0(rx) && near0(rz);
  const isPitch90 = Math.abs(rx - Math.PI / 2) < 1e-6 && near0(rz);

  if (sk === 'l_angle') {
    // makeLAngle already has horizontal leg DOWN — prefer identity
    if (isIdentity) score *= 2.40;
    else if (isPitch90) score *= 0.55; // tips onto vertical leg edge
  } else if (sk === 'z_channel' || sk === 'c_channel') {
    // Prefer web/flange stack with length horiz; C single uses +90°X (opening up)
    if (sk === 'c_channel' && isPitch90) score *= 1.80;
    if (sk === 'z_channel' && (isIdentity || isPitch90)) score *= 1.55;
  } else if (sk === 'plate') {
    if (ev.up_is_thinnest) score *= 2.20;
  } else if (sk === 'rhs' || sk === 'chs' || sk === 'rod') {
    if (ev.length_horizontal) score *= 1.35;
  } else if (sk === 'i_beam') {
    if (isIdentity || (near0(rx) && Math.abs(rz - Math.PI / 2) < 1e-6)) score *= 1.40;
  }

  // Compound rotations on long members are almost always corner-tilt
  const compound = !near0(rx) && !near0(rz)
    && Math.abs(rx - Math.PI) > 1e-6 && Math.abs(rz - Math.PI) > 1e-6;
  if (compound) score *= (longMember || openLong) ? 0.08 : 0.45;

  return score;
}

/**
 * Nest build mode for open profiles.
 * @returns {'collision_flip'|'stack_up'|'diagonal_same'}
 */
function chooseStableNestMode(it, count) {
  const n = Math.max(1, count | 0);
  const method = it?.nestMethod?.method
    || it?.nestingInfo?.method
    || '';
  const sk = it?.shapeKey || it?.profileShape || '';

  // L-angles: NEVER diagonal / NEVER flip-interlock slide.
  // L has no reliable 180° nest — always stack on the horizontal leg (Y-up).
  if (sk === 'l_angle') return 'stack_up';

  // Non-interlock methods: vertical / designed axis stack only
  if (method === 'STACK_NEST' || method === 'FLAT_STACK'
      || method === 'PARALLEL_BUNDLE' || method === 'HEX_BUNDLE'
      || method === 'PER_MARK_STACK')
    return 'stack_up';

  if (method !== 'INTERLOCK_NEST') return 'stack_up';

  // INTERLOCK: prefer collision+flip; diagonal ONLY if offset is degenerate
  const off = Number(it?.nestingInfo?.nesting_offset) || Number(it?.sectT) || 2;
  const H = Number(it?.sectH || it?.nestingInfo?.dims_used?.h) || 100;
  const nestOff = Number(it?.nestingInfo?.nesting_offset) || 0;
  if (nestOff > H * 0.85) return 'stack_up'; // was diagonal — still avoid lean
  // Rare: if flip unavailable and n large, still stack_up (safer than 45° stair)
  if (!it?.nestMethod?.alternate_flip && n >= 8) return 'stack_up';
  return 'collision_flip';
}

/**
 * Measure world AABB (mm) after makeShape + rest-pose — READ ONLY, no morph.
 * @returns {{l,w,h}|null}
 */
function measureStableBundleMm(it) {
  if (!it || typeof makeShape !== 'function') return null;
  if (typeof SCALE !== 'number' || !(SCALE > 0)) return null;
  let mesh = null;
  try {
    mesh = makeShape({
      ...it,
      lengthMm: it.lengthMm || it.l || 500,
      widthMm: it.widthMm || it.w || 200,
      heightMm: it.heightMm || it.h || 200,
      qty: it.qty || 1,
      // Match Group-By yard pose so spacing uses flat AABB (not IFC pitch)
      _yardStraighten: true,
      assemblyShipPose: !!(it.isAssembly || it.assemblyShipPose
        || it.groupKind === 'welded_assembly'),
    }, 0xffffff, 1);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) return null;
    const dims = {
      l: Math.max((box.max.x - box.min.x) / SCALE, 1),
      h: Math.max((box.max.y - box.min.y) / SCALE, 1),
      w: Math.max((box.max.z - box.min.z) / SCALE, 1),
      source: 'measured_rest_pose',
    };
    it.stableBundleMm = dims;
    return dims;
  } catch (_) {
    return null;
  } finally {
    if (mesh && typeof disposeTempMesh === 'function') disposeTempMesh(mesh);
    else if (mesh) {
      try {
        mesh.traverse(o => {
          if (o.geometry) o.geometry.dispose();
        });
      } catch (_) { /* */ }
    }
  }
}

/**
 * Apply rest-pose stability to ANY makeShape result (bundle or single piece).
 */
function ensureStableShape(obj, it) {
  if (!obj || !it) return obj;
  if (it._assemblyChild || it._skipStability) return obj;
  try {
    if (obj.userData && obj.userData._stabilityApplied) return obj;
  } catch (_) { /* */ }
  stabilizeNestBundle(obj, it);
  try {
    if (!obj.userData) obj.userData = {};
    obj.userData._stabilityApplied = true;
  } catch (_) { /* */ }
  return obj;
}

/**
 * Run after nest group built: stabilize rest pose + stamp metadata on `it`.
 */
function stabilizeNestBundle(group, it) {
  if (!group) return null;
  const oi = it?.orientation_info || null;
  const ev = applyStableRestPose(group, oi, it) || evaluateMeshGroupStability(group);

  const ground_stable = !!(
    ev.ground_stable
    || (ev.stable && !ev.standing_on_end && !ev.thin_edge_sit
      && Math.abs(ev.floor_y || 0) < 1e-3)
  );

  const live = ev.z_nesting || ev.rule1?.live || null;
  const twoPt = (typeof needsZStyleGroundFix === 'function')
    ? !!needsZStyleGroundFix(it)
    : false;
  const applied = ev.applied_rotation || { x: 0, y: 0, z: 0 };
  /** Packer-facing Rule1 payload — Stage A/B → Stage C (18-cs-container-pack). */
  const rule1_orientation = {
    ground_stable,
    method: (ev.rule1 && ev.rule1.method) || (live ? 'live_rotate' : 'warehouse'),
    rot: {
      x: Number(applied.x) || Number(live?.applied_rad) || 0,
      y: Number(applied.y) || 0,
      z: Number(applied.z) || 0,
    },
    // Rest-pose already baked in makeShape; packer adds Y-yaw only
    packYawOnly: true,
    packComposeRot: false,
    nesting_angle_rad: Number(ev.nesting_angle_rad) || Number(live?.applied_rad) || 0,
    contact_a: live?.contact_a || null,
    contact_b: live?.contact_b || null,
    two_point_base: twoPt,
    tip_ratio: ev.tip_ratio,
  };

  const info = {
    stable: !!ev.stable,
    ground_stable,
    tip_ratio: ev.tip_ratio,
    score: ev.score,
    reason: ev.reason,
    applied_rotation: ev.applied_rotation || null,
    warehouse: ev.warehouse || null,
    vert_key_hint: oi?.vert_key || null,
    up_is_thinnest: !!ev.up_is_thinnest,
    length_horizontal: !!ev.length_horizontal,
    standing_on_end: !!ev.standing_on_end,
    thin_edge_sit: !!ev.thin_edge_sit,
    size: ev.size || null,
    rule1: ev.rule1 || null,
    rule1_orientation,
    nesting_angle_rad: rule1_orientation.nesting_angle_rad,
    z_nesting: live,
    two_point_base: twoPt,
    auto: true,
    mutates_geometry: false,
  };
  if (it) {
    it.stabilityInfo = info;
    it.rule1_orientation = rule1_orientation;
    it._rule1GroundResult = ev.rule1 || it._rule1GroundResult || null;
    it.warehouseGround = ev.warehouse || null;
    if (ev.size && typeof SCALE === 'number' && SCALE > 0) {
      it.stableBundleMm = {
        l: ev.size.x / SCALE,
        h: ev.size.y / SCALE,
        w: ev.size.z / SCALE,
      };
    } else if (ev.warehouse?.extents_after && typeof SCALE === 'number' && SCALE > 0) {
      const e = ev.warehouse.extents_after;
      it.stableBundleMm = {
        l: e.x / SCALE, h: e.y / SCALE, w: e.z / SCALE,
      };
    }
    try {
      if (it.stagingGroupId && typeof assemblyGroups !== 'undefined' && assemblyGroups) {
        const g = assemblyGroups.find(x => x.id === it.stagingGroupId);
        if (g) {
          g.stabilityInfo = info;
          g.rule1_orientation = rule1_orientation;
          if (ev.rule1) g._rule1GroundResult = ev.rule1;
        }
        if (!window._stabStagingDirty) {
          window._stabStagingDirty = true;
          requestAnimationFrame(() => {
            window._stabStagingDirty = false;
            if (typeof renderStagingList === 'function') renderStagingList();
          });
        }
      }
    } catch (_) { /* */ }
  }
  try {
    console.info(
      `[warehouse] ${it?.mark || '?'} ground=${info.ground_stable}`
      + ` tip=${(info.tip_ratio || 0).toFixed(2)}`
      + ` rot=${info.warehouse?.rot || info.applied_rotation && 'legacy' || '-'}`
      + ` (rigid — shapes unchanged)`
    );
  } catch (_) { /* */ }
  return info;
}

/** Label for staging pills */
function stabilityLabel(info) {
  if (!info) return '';
  if (info.ground_stable || info.stable) return 'Stable';
  return 'Unstable';
}
