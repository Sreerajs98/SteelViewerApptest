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

  // Face rolls a human would try on the yard after laying length horizontal
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
    // Reward low vertical / long footprint (shippable)
    score += Math.min(sx, 50000) * 2;
    score += Math.min(sz, 20000);
    return score;
  }

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
    if (!best || score > best.score) {
      best = {
        score,
        tag: tr.tag,
        ev,
        q: group.quaternion.clone(),
        py: group.position.y,
      };
    }
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
  // Thin-edge sit: tall AND tiny base in one axis
  const thin_edge_sit = (sy > Math.max(sx, sz) * 1.15)
    && (Math.min(sx, sz) < Math.max(sx, sz) * 0.35);

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

  // Multi-piece nest stacks: do NOT tip the whole nest onto its side.
  // Warehouse AABB on a tall nest prefers laying it flat — wrong for yard nest display.
  if (qty > 1 && nestKids > 1) {
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
    auto: true,
    mutates_geometry: false,
  };
  if (it) {
    it.stabilityInfo = info;
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
        if (g) g.stabilityInfo = info;
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
