/* 15a-warehouse-ground.js — FIRST PRIORITY: Warehouse ground sit on IFC load
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  GOAL (shipping / yard — before nest / pack)                         ║
 * ║  • Widest stable face on ground                                      ║
 * ║  • Touching Y=0 (not floating / underground)                         ║
 * ║  • Tip-over check: vertical ≤ 2 × base_min                           ║
 * ║  • Assemblies: ONE rotation for all sub-meshes (combined AABB)       ║
 * ║                                                                      ║
 * ║  RIGID ONLY — group.rotation + group.position.y                      ║
 * ║  Never rewrite ExtrudeGeometry / sect dims / meshPositionsMm         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Algorithm (guide):
 *   A) AABB extents
 *   B) Largest base face + tip-over fallback
 *   C) Rigid 90° about X or Z (or none)
 *   D) Drop minY → 0
 *   E) Keep XZ (layout spreads items)
 */

const WH_TIP_RATIO_MAX = 2.0; // vertical > 2×base_min → tip risk

/**
 * Pure math: choose which axis should be vertical (warehouse base).
 * @returns {{ vertical:'X'|'Y'|'Z', area, tip_ratio, tips:boolean, rot:'none'|'Rx'|'Rz' }}
 */
function chooseWarehouseBaseFace(extX, extY, extZ) {
  const ex = Math.max(+extX || 0, 1e-9);
  const ey = Math.max(+extY || 0, 1e-9);
  const ez = Math.max(+extZ || 0, 1e-9);

  const opts = [
    {
      vertical: 'Y',
      area: ex * ez,
      vert: ey,
      baseMin: Math.min(ex, ez),
      baseA: ex,
      baseB: ez,
      rot: 'none',
    },
    {
      vertical: 'Z',
      area: ex * ey,
      vert: ez,
      baseMin: Math.min(ex, ey),
      baseA: ex,
      baseB: ey,
      rot: 'Rx', // swap Y↔Z
    },
    {
      vertical: 'X',
      area: ey * ez,
      vert: ex,
      baseMin: Math.min(ey, ez),
      baseA: ey,
      baseB: ez,
      rot: 'Rz', // swap X↔Y
    },
  ];

  opts.forEach(o => {
    o.tip_ratio = o.vert / Math.max(o.baseMin, 1e-9);
    o.tips = o.tip_ratio > WH_TIP_RATIO_MAX;
  });

  // Largest face first
  opts.sort((a, b) => b.area - a.area || a.tip_ratio - b.tip_ratio);

  const stable = opts.filter(o => !o.tips);
  let pick = stable.length
    ? stable[0]
    : opts.slice().sort((a, b) => a.tip_ratio - b.tip_ratio || b.area - a.area)[0];

  // Prefer current Y-up when already stable and within 2% of best face area
  // (avoids needless Rx/Rz that fights builder euler e.g. rod z=π/2)
  const yup = opts.find(o => o.rot === 'none');
  if (yup && !yup.tips && pick.rot !== 'none') {
    if (pick.area <= yup.area * 1.02) pick = yup;
    else if (yup.tip_ratio <= 1.05 && pick.area <= yup.area * 1.15) pick = yup;
  }

  return {
    vertical: pick.vertical,
    area: pick.area,
    tip_ratio: pick.tip_ratio,
    tips: pick.tips,
    rot: pick.rot,
    vert_extent: pick.vert,
    base_min: pick.baseMin,
    base_a: pick.baseA,
    base_b: pick.baseB,
    candidates: opts,
  };
}

/**
 * Orient a flat xyz vertex array (mm) in-place — guide Steps A–D.
 * Used for tests / optional meshPositionsMm warehouse copy.
 * @param {number[]|Float32Array} positions length = 3N
 * @returns {{ rot, tip_ratio, minY0:true, extents_after }}
 */
function orientVerticesToWarehouseGround(positions) {
  if (!positions || positions.length < 9) return null;
  const n = Math.floor(positions.length / 3);

  function bbox() {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      extX: maxX - minX, extY: maxY - minY, extZ: maxZ - minZ,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
    };
  }

  let bb = bbox();
  const choice = chooseWarehouseBaseFace(bb.extX, bb.extY, bb.extZ);
  const cx = bb.cx, cy = bb.cy, cz = bb.cz;

  if (choice.rot === 'Rx') {
    // Swap Y and Z: y' = -z_rel+cy, z' = y_rel+cz
    for (let i = 0; i < n; i++) {
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const yRel = y - cy;
      const zRel = z - cz;
      positions[i * 3 + 1] = -zRel + cy;
      positions[i * 3 + 2] = yRel + cz;
    }
  } else if (choice.rot === 'Rz') {
    // Swap X and Y: x' = -y_rel+cx, y' = x_rel+cy
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const xRel = x - cx;
      const yRel = y - cy;
      positions[i * 3] = -yRel + cx;
      positions[i * 3 + 1] = xRel + cy;
    }
  }

  bb = bbox();
  const drop = bb.minY;
  for (let i = 0; i < n; i++) positions[i * 3 + 1] -= drop;

  bb = bbox();
  return {
    rot: choice.rot,
    tip_ratio: choice.tip_ratio,
    vertical: choice.vertical,
    minY0: Math.abs(bb.minY) < 1e-6,
    extents_after: { x: bb.extX, y: bb.extY, z: bb.extZ },
    choice,
  };
}

/**
 * Orient a THREE Object3D (single mesh OR assembly group) to warehouse ground.
 * Combined AABB for all children → ONE rigid group rotation → minY=0.
 * Does NOT mutate BufferGeometry / ExtrudeGeometry / sect dims.
 *
 * @returns {object} warehouseInfo
 */
function orientObjectToWarehouseGround(obj, it) {
  if (!obj || typeof THREE === 'undefined') return null;

  // Do NOT wipe obj.rotation — analytic builders (rod z=π/2, C x=π/2)
  // already encode face-down / length-horizontal. Measure CURRENT pose.
  const keepX = obj.position.x;
  const keepZ = obj.position.z;
  obj.position.y = 0;
  obj.updateMatrixWorld(true);

  const box0 = new THREE.Box3().setFromObject(obj);
  if (!isFinite(box0.min.x)) {
    return { ok: false, reason: 'empty_bbox' };
  }
  const size0 = new THREE.Vector3();
  box0.getSize(size0);
  const extX = size0.x;
  const extY = size0.y;
  const extZ = size0.z;

  const choice = chooseWarehouseBaseFace(extX, extY, extZ);

  // Compose additional 90° in WORLD space (premultiply) so existing local
  // euler (rod z=π/2, C x=π/2) is not destroyed by Euler rotateX/Z.
  if (choice.rot === 'Rx' || choice.rot === 'Rz') {
    const axis = choice.rot === 'Rx'
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);
    const qAdd = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2);
    obj.quaternion.premultiply(qAdd);
    obj.rotation.setFromQuaternion(obj.quaternion);
  }

  obj.updateMatrixWorld(true);
  if (typeof recenterGroupAabb === 'function' && obj.children && obj.children.length > 1) {
    try { recenterGroupAabb(obj); } catch (_) { /* */ }
  }
  obj.updateMatrixWorld(true);

  const box1 = new THREE.Box3().setFromObject(obj);
  if (isFinite(box1.min.y)) obj.position.y -= box1.min.y;
  obj.position.x = keepX;
  obj.position.z = keepZ;
  obj.updateMatrixWorld(true);

  const boxF = new THREE.Box3().setFromObject(obj);
  const sizeF = new THREE.Vector3();
  boxF.getSize(sizeF);
  const tip = sizeF.y / Math.max(Math.min(sizeF.x, sizeF.z), 1e-9);

  const info = {
    ok: true,
    method: 'warehouse_aabb',
    rot: choice.rot,
    vertical_was: choice.vertical,
    tip_ratio: tip,
    tips: tip > WH_TIP_RATIO_MAX,
    face_area: choice.area,
    extents_before: { x: extX, y: extY, z: extZ },
    extents_after: { x: sizeF.x, y: sizeF.y, z: sizeF.z },
    floor_y: boxF.min.y,
    ground_stable: Math.abs(boxF.min.y) < 1e-3 && tip <= WH_TIP_RATIO_MAX,
    mutates_geometry: false,
    mark: it?.mark || null,
  };

  try {
    if (obj.userData) obj.userData.warehouseGround = info;
  } catch (_) { /* */ }

  return info;
}

/**
 * Apply warehouse ground to all raw IFC items' display meshes (batch helper).
 * Call after makeShape paths — prefer ensureStableShape which already hooks this.
 */
function attachWarehouseGroundToItems(items) {
  // Metadata stamp only — actual orient runs in ensureStableShape/makeShape
  let n = 0;
  (items || []).forEach(it => {
    if (!it) return;
    it._warehouseGroundPreferred = true;
    n++;
  });
  try {
    console.info(`[warehouse-ground] preferred for ${n} items (applied on makeShape)`);
  } catch (_) { /* */ }
  return { total: n };
}
