/* 99-cs-warehouse-tests.js — FIRST PRIORITY warehouse ground-sit suite.
 * Call: runWarehouseGroundTestSuite()
 * Covers guide Tests 1–10 (AABB widest face + tip-check + minY=0).
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 1e-3);
  }

  /** Build axis-aligned box vertices (8 corners × xyz). */
  function boxVerts(minX, minY, minZ, maxX, maxY, maxZ) {
    const c = [
      [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
      [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ];
    const out = [];
    c.forEach(p => out.push(p[0], p[1], p[2]));
    return out;
  }

  function bboxOf(pos) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      extX: maxX - minX, extY: maxY - minY, extZ: maxZ - minZ,
    };
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── Test 1: Tapered column standing → lie flat ────────────────────────────
  t('W.1', 'Tapered column standing → lies flat height=300', () => {
    // X=300, Y=8000, Z=500 standing
    const v = boxVerts(0, 0, 0, 300, 8000, 500);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), `minY=${bb.minY}`);
    assert(approx(bb.extY, 300, 1), `height=${bb.extY} want 300`);
    assert(bb.extX > 4000 || bb.extZ > 4000, 'length horizontal');
    assert(r.rot === 'Rz', `rot=${r.rot}`);
    assert(r.tip_ratio <= 2.01, `tip=${r.tip_ratio}`);
  });

  // ── Test 2: Beam already horizontal — stays lying, minY=0 ─────────────────
  t('W.2', 'Beam horizontal — stays flat on ground (minY=0)', () => {
    // X=10000, Y=400, Z=200 — face_XY (10k×400) > face_XZ (10k×200),
    // so widest-face rule may Rx → height 200 (even flatter). Still not standing.
    const v = boxVerts(0, 50, 0, 10000, 450, 200);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), `minY=${bb.minY}`);
    assert(bb.extY <= 401, `H=${bb.extY} must stay flat`);
    assert(bb.extX > 5000, 'length horiz');
    assert(r.rot === 'none' || r.rot === 'Rx', `rot=${r.rot}`);
    assert(r.tip_ratio <= 2.01, `tip=${r.tip_ratio}`);
  });

  // ── Test 3: Floating → drop ───────────────────────────────────────────────
  t('W.3', 'Floating item dropped to minY=0', () => {
    const v = boxVerts(0, 500, 0, 1000, 700, 200);
    orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), `minY=${bb.minY}`);
    assert(approx(bb.extY, 200, 1), `H=${bb.extY}`);
  });

  // ── Test 4: Below ground → lift ───────────────────────────────────────────
  t('W.4', 'Underground item lifted to minY=0', () => {
    const v = boxVerts(0, -200, 0, 1000, 0, 200);
    orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), `minY=${bb.minY}`);
    assert(bb.maxY > 0, 'above');
  });

  // ── Test 5: Plate on edge → flat ──────────────────────────────────────────
  t('W.5', 'Plate standing on edge → flat 12mm tall', () => {
    // X=500, Y=1000, Z=12
    const v = boxVerts(0, 0, 0, 500, 1000, 12);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), 'minY');
    assert(approx(bb.extY, 12, 1), `H=${bb.extY}`);
    assert(r.rot === 'Rx', `rot=${r.rot}`);
  });

  // ── Test 6: Assembly combined AABB (simulate multi-part as one cloud) ─────
  t('W.6', 'Assembly combined bbox — one transform, lies flat', () => {
    // Combined X=12000, Y=800, Z=300 upright-ish (Y=800 tall relative)
    // Actually Y=800 with X=12000: face_XY largest → Rx → height=300
    const v = boxVerts(0, 0, 0, 12000, 800, 300);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), 'minY');
    assert(approx(bb.extY, 300, 1), `H=${bb.extY}`);
    assert(r.rot === 'Rx', `rot=${r.rot}`);
  });

  // ── Test 7: Round bar standing → horizontal ───────────────────────────────
  t('W.7', 'Round bar standing → horizontal', () => {
    const v = boxVerts(0, 0, 0, 16, 3000, 16);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), 'minY');
    assert(bb.extY < 50, `H=${bb.extY}`);
    assert(bb.extX > 2000 || bb.extZ > 2000, 'length horiz');
    assert(r.rot !== 'none', `rot=${r.rot}`);
  });

  // ── Test 8: Z-purlin — flat with 75mm height ──────────────────────────────
  t('W.8', 'Z-purlin X=6000 Y=200 Z=75 → height 75', () => {
    const v = boxVerts(0, 0, 0, 6000, 200, 75);
    // tip: Y vert tip_ratio=200/75>2 → prefer Z vertical (Rx)
    const choice = chooseWarehouseBaseFace(6000, 200, 75);
    assert(choice.rot === 'Rx', `choice=${choice.rot} tipY would tip`);
    const r = orientVerticesToWarehouseGround(v);
    const bb = bboxOf(v);
    assert(approx(bb.minY, 0, 1e-6), 'minY');
    assert(approx(bb.extY, 75, 1), `H=${bb.extY}`);
    assert(approx(bb.extZ, 200, 1) || approx(bb.extX, 200, 1), '200 on base');
  });

  // ── Test 9: Batch — all minY=0 ─────────────────────────────────────────────
  t('W.9', 'Batch 300 synthetic items all minY=0', () => {
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      const L = 1000 + (i % 50) * 100;
      const H = 50 + (i % 20) * 10;
      const W = 20 + (i % 15) * 5;
      // Mix orientations
      let v;
      if (i % 3 === 0) v = boxVerts(0, 100, 0, W, 100 + L, H); // standing on Y
      else if (i % 3 === 1) v = boxVerts(0, -50, 0, L, -50 + H, W); // underground
      else v = boxVerts(0, 200, 0, L, 200 + H, W); // floating flat
      orientVerticesToWarehouseGround(v);
      const bb = bboxOf(v);
      assert(approx(bb.minY, 0, 1e-4), `item ${i} minY=${bb.minY}`);
      assert(bb.extY <= Math.max(bb.extX, bb.extZ) + 1e-3
        || bb.extY / Math.min(bb.extX, bb.extZ) <= 2.05,
        `item ${i} unstable H=${bb.extY}`);
    }
    const ms = performance.now() - t0;
    assert(ms < 5000, `batch ms=${ms}`);
  });

  // ── Test 10: THREE Object3D path (if available) ───────────────────────────
  t('W.10', 'THREE Object3D warehouse orient + ground', () => {
    if (typeof THREE === 'undefined' || typeof orientObjectToWarehouseGround !== 'function') {
      assert(true, 'skip no THREE');
      return;
    }
    const geo = new THREE.BoxGeometry(0.3, 8, 0.5); // world units ~ standing
    // Simulate mm via SCALE if present
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    const info = orientObjectToWarehouseGround(group, { mark: 'COL1' });
    assert(info && info.ok, 'ok');
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    assert(approx(box.min.y, 0, 1e-3), `minY=${box.min.y}`);
    const size = new THREE.Vector3();
    box.getSize(size);
    assert(size.y + 1e-6 <= Math.max(size.x, size.z) * 1.05
      || size.y / Math.min(size.x, size.z) <= 2.05, `tip size=${size.x},${size.y},${size.z}`);
    // dispose
    geo.dispose();
  });

  // ── Tip-over prefers second face ──────────────────────────────────────────
  t('W.11', 'Tip-over: reject largest face if vertical > 2×base_min', () => {
    // Standing thin: X=100, Y=5000, Z=100 — face_XY=face_YZ=500k, face_XZ=10k
    // Both XY and YZ tip? vert for Z-up: vert=100, baseMin=100, tip=1 OK
    // Actually Y-up tips. Z-up: height 100, base 100×5000 OK.
    const c = chooseWarehouseBaseFace(100, 5000, 100);
    assert(c.rot !== 'none', 'must rotate off Y-up');
    assert(c.tip_ratio <= 2.01, `tip=${c.tip_ratio}`);
  });

  // ── Assembly base: multi-part trial faces → ground touch ──────────────────
  t('W.12a', 'refineAssemblyGroundPose — multi-part group touches Y=0', () => {
    if (typeof THREE === 'undefined' || typeof refineAssemblyGroundPose !== 'function') {
      assert(true, 'skip');
      return;
    }
    const group = new THREE.Group();
    // Two "flange" boxes forming a tall-ish assembly (Y up)
    const mk = (sx, sy, sz, y) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshBasicMaterial()
      );
      m.position.y = y;
      group.add(m);
      return m;
    };
    mk(8, 0.2, 0.8, 0.5);   // web-ish
    mk(8, 0.05, 0.4, 0.1);  // bottom flange
    mk(8, 0.05, 0.4, 0.9);  // top flange
    const it = {
      mark: 'R-1', isAssembly: true, groupKind: 'welded_assembly',
      parts: [{}, {}], assemblyName: 'Rafter',
    };
    const ev = refineAssemblyGroundPose(group, it, null);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    assert(approx(box.min.y, 0, 2e-3), `minY=${box.min.y}`);
    assert(ev && ev.ground_touch !== false, 'ground_touch');
    assert(ev.assembly_base === true, 'assembly_base flag');
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  });

  t('W.12d', 'PCA cancels IFC roof-pitch — length ends along +X, ground', () => {
    if (typeof THREE === 'undefined' || typeof refineAssemblyGroundPose !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Simulate pitched rafter: long box rotated ~30° about Z (roof pitch)
    const group = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(10, 0.4, 0.25),
      new THREE.MeshBasicMaterial()
    );
    group.add(beam);
    group.rotation.z = Math.PI / 6; // 30° pitch — the X-cross bug
    group.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(group);
    const beforeSize = new THREE.Vector3();
    before.getSize(beforeSize);
    assert(beforeSize.y > 2.0, `pitched height before=${beforeSize.y}`);

    const ev = refineAssemblyGroundPose(group, {
      mark: 'R-PITCH', isAssembly: true, parts: [{}, {}],
      groupKind: 'welded_assembly', assemblyName: 'Rafter',
    }, null);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    assert(approx(box.min.y, 0, 3e-3), `minY=${box.min.y}`);
    assert(size.x > size.y * 3 && size.x > size.z * 3, `len along X sx=${size.x} sy=${size.y} sz=${size.z}`);
    assert(size.y < 1.2, `flat-ish height sy=${size.y}`); // pitch cancelled
    assert(ev && ev.pca_aligned !== false, 'pca');
    assert(ev.ground_touch, 'ground');
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  });

  t('W.12e', 'Standing column assembly lays down (not tip on end)', () => {
    if (typeof THREE === 'undefined' || typeof refineAssemblyGroundPose !== 'function') {
      assert(true, 'skip');
      return;
    }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 8, 0.35),
      new THREE.MeshBasicMaterial()
    ));
    const ev = refineAssemblyGroundPose(group, {
      mark: 'C-1', isAssembly: true, parts: [{}, {}],
      groupKind: 'welded_assembly', assemblyName: 'Column',
    }, null);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    assert(approx(box.min.y, 0, 3e-3), `minY=${box.min.y}`);
    assert(size.y < size.x * 0.5, `laid down sy=${size.y} sx=${size.x}`);
    assert(!ev.standing_on_end, 'not on end');
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  });

  t('W.12g', 'Rule#1 sort: heaviest assemblies first, then long beam before nest', () => {
    if (typeof cs8SortHeavyAnchor !== 'function') {
      assert(true, 'skip');
      return;
    }
    const u = [
      { mark: 'nest-heavy', weight: 400, l: 400, shapeKey: 'z_channel' },
      { mark: 'nest-long-heavy', weight: 400, l: 8000, shapeKey: 'z_channel' },
      { mark: 'beam-light', weight: 66, l: 8400, shapeKey: 'i_beam' },
      { mark: 'asm-light', weight: 200, l: 9000, isAssembly: true, parts: [{}, {}] },
      { mark: 'asm-heavy', weight: 900, l: 10000, isAssembly: true, parts: [{}, {}] },
    ];
    cs8SortHeavyAnchor(u, 12000);
    assert(u[0].mark === 'asm-heavy', `heaviest asm first=${u[0].mark}`);
    assert(u[1].mark === 'asm-light', `2nd asm=${u[1].mark}`);
    // tier1: longer lane first (8400 before 8000) even if lighter
    assert(u[2].mark === 'beam-light', `beam lane=${u[2].mark}`);
    assert(u[3].mark === 'nest-long-heavy', `long nest=${u[3].mark}`);
    assert(u[4].mark === 'nest-heavy', `short nest last=${u[4].mark}`);
  });

  t('W.12n', 'Weight unit: grams→kg via normalizeMassToKg', () => {
    if (typeof normalizeMassToKg !== 'function') {
      assert(true, 'skip');
      return;
    }
    // ROD20-like: IFC 47356 (g), bbox est ~40 kg → 47.356 kg
    const rod = normalizeMassToKg(47356, 40);
    assert(rod > 40 && rod < 60, `rod=${rod} (want ~47 kg from grams)`);
    // PANEL: section-like light est (~20) → grams; fat AABB est capped in function
    const panel = normalizeMassToKg(16866, 20);
    assert(panel > 10 && panel < 30, `panel=${panel} (want ~17 kg)`);
    // Fat AABB alone must not keep 16866 as kg when light est also passed via item normalize
    const panelFat = normalizeMassToKg(16866, 50); // capped path still light
    assert(panelFat > 10 && panelFat < 30, `panelFat=${panelFat}`);
    // Screenshot: hex 27900 > container → 27.9 kg
    const hex = normalizeMassToKg(27900, 8000);
    assert(hex > 20 && hex < 40, `hex=${hex} (want ~27.9)`);
    // Real heavy beam already in kg — keep
    const beam = normalizeMassToKg(8000, 7500);
    assert(Math.abs(beam - 8000) < 1, `beam=${beam} (keep kg)`);
  });

  t('W.12k', 'Staging: load order floor→filler; show N pcs + kg/pc + total', () => {
    if (typeof sortStagingGroupsByWeight !== 'function'
        || typeof attachGroupWeightFields !== 'function'
        || typeof groupLoadAnchorTier !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Display fields: unit + total
    const flat = {
      mark: 'ANGLE', groupKind: 'stack_plate', weightKg: 28.4, qty: 4,
      memberPieces: Array.from({ length: 4 }, () => ({
        unitWeightKg: 7.1, qty: 1, lengthMm: 2500, widthMm: 50, heightMm: 1.5,
        shapeKey: 'plate', profileDesc: 'FLAT PL1.5',
      })),
    };
    attachGroupWeightFields(flat);
    assert(Math.abs(flat.unitWeightKg - 7.1) < 0.2, `unit=${flat.unitWeightKg}`);
    assert(Math.abs(flat.totalWeightKg - 28.4) < 1, `total=${flat.totalWeightKg}`);
    assert(groupLoadAnchorTier(flat) === 1, `plate tier=${flat.loadTier} (floor)`);

    // Load order: assemblies (kg/pc) → light beam floor → Z secondary → rod filler
    // Even though Z pack total is heavy, beam (floor) beats Z (secondary)
    const g2 = [
      {
        mark: 'R1', groupKind: 'welded_assembly', weightKg: 10000, qty: 5,
        isAssembly: true, parts: [{}, {}], lengthMaxMm: 11000,
        memberPieces: Array.from({ length: 5 }, () => ({
          unitWeightKg: 2000, qty: 1, lengthMm: 11000,
        })),
      },
      {
        mark: 'C1', groupKind: 'welded_assembly', weightKg: 9000, qty: 3,
        isAssembly: true, parts: [{}, {}], lengthMaxMm: 9000,
        memberPieces: Array.from({ length: 3 }, () => ({
          unitWeightKg: 3000, qty: 1, lengthMm: 9000,
        })),
      },
      {
        mark: 'B50', groupKind: 'bundle_beam', weightKg: 50, qty: 1,
        shapeKey: 'i_beam', category: 'beam', lengthMaxMm: 8400,
        memberPieces: [{ unitWeightKg: 50, qty: 1, lengthMm: 8400 }],
      },
      {
        mark: 'Z50', groupKind: 'nest_z', weightKg: 2250, qty: 50,
        shapeKey: 'z_channel',
        packUnits: [{ total_weight: 540, weightKg: 540, qty: 12 }],
        memberPieces: Array.from({ length: 50 }, () => ({
          unitWeightKg: 45, qty: 1, lengthMm: 6000,
        })),
      },
      {
        mark: 'ROD', groupKind: 'bundle_rod', weightKg: 112, qty: 16,
        shapeKey: 'rod',
        memberPieces: Array.from({ length: 16 }, () => ({
          unitWeightKg: 7, qty: 1, lengthMm: 6000,
        })),
      },
    ];
    sortStagingGroupsByWeight(g2);
    assert(g2.map(x => x.mark).join(',') === 'C1,R1,B50,Z50,ROD',
      `order=${g2.map(x => x.mark).join(',')} (want C1,R1,B50,Z50,ROD)`);
    assert(g2[0].loadTierLabel === 'Floor', 'C1 Floor');
    assert(g2[2].loadTier === 1, `B50 tier=${g2[2].loadTier}`);
    assert(g2[3].loadTier === 2, `Z50 tier=${g2[3].loadTier}`);
    assert(g2[4].loadTier === 3, `ROD tier=${g2[4].loadTier}`);
    assert(Math.abs(g2[0].totalWeightKg - 9000) < 1, 'C1 total');
    assert(Math.abs(g2[0].unitWeightKg - 3000) < 1, 'C1 kg/pc');
  });

  t('W.12i', 'Pack smoke: long beam seats on empty floor before nest fills', () => {
    if (typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const packUnits = [
      {
        mark: 'NEST1', marks: ['NEST1'], groupKind: 'nest_z',
        shapeKey: 'z_channel', profileShape: 'z_channel',
        qty: 12, total_weight: 480, weightKg: 480,
        lengthMm: 400, widthMm: 200, heightMm: 200,
        bundle_bbox: { l: 400, w: 200, h: 200 },
        l: 400, w: 200, h: 200,
      },
      {
        mark: 'BEAM84', marks: ['BEAM84'], groupKind: 'bundle_beam',
        shapeKey: 'i_beam', profileShape: 'i_beam', category: 'beam',
        qty: 1, total_weight: 66, weightKg: 66,
        lengthMm: 8400, widthMm: 200, heightMm: 300,
        bundle_bbox: { l: 8400, w: 200, h: 300 },
        l: 8400, w: 200, h: 300,
      },
    ];
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits, maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    const marks = placed.map(it => it.mark);
    assert(marks.some(m => /BEAM84/.test(String(m))), `beam placed marks=${marks.join(',')}`);
    const beam = placed.find(it => /BEAM84/.test(String(it.mark)));
    const nest = placed.find(it => /NEST1/.test(String(it.mark)));
    if (beam && nest) {
      // Beam must be on floor (y centre ≈ h/2)
      assert((beam.y || 0) < (nest.y || 0) + 50 || (beam.packFootprintH || 300) >= (beam.y || 0),
        'beam on/near floor');
    }
    const over = res.oversized || [];
    assert(!over.some(u => /BEAM84/.test(String(u.mark))),
      `beam not rejected: ${(over[0] && over[0].fitReason) || ''}`);
  });

  t('W.12j', 'yaw180 is NOT yaw90 for station axis', () => {
    if (typeof cs8OrientIsYaw90 !== 'function') {
      assert(true, 'skip');
      return;
    }
    assert(!cs8OrientIsYaw90({ tag: 'yaw180', rot: { y: Math.PI } }), '180');
    assert(!cs8OrientIsYaw90({ tag: 'yaw0', rot: { y: 0 } }), '0');
    assert(cs8OrientIsYaw90({ tag: 'yaw90', rot: { y: Math.PI / 2 } }), '90');
  });

  t('W.12h', 'Diagnose unfit — length / width reason codes', () => {
    if (typeof cs8DiagnoseUnfit !== 'function') {
      assert(true, 'skip');
      return;
    }
    const long = cs8DiagnoseUnfit(
      { mark: 'B1', l: 13000, w: 300, h: 400, weight: 800 },
      12000, 2350, 2690, [{ weightUsed: 0 }], 26000
    );
    assert(long.code === 'LENGTH_EXCEEDS_CONTAINER', `code=${long.code}`);
    const wide = cs8DiagnoseUnfit(
      { mark: 'B2', l: 10000, w: 3000, h: 400, weight: 800 },
      12000, 2350, 2690, [{ weightUsed: 0 }], 26000
    );
    assert(wide.code === 'WIDTH_EXCEEDS_ENVELOPE', `code=${wide.code}`);
  });

  t('W.12f', 'Rule#1 Constraint-First tiers + legacy yaw 0/180', () => {
    if (typeof cs8ConstraintTier !== 'function' && typeof cs8AnchorTier !== 'function') {
      assert(true, 'skip');
      return;
    }
    const tier = typeof cs8ConstraintTier === 'function' ? cs8ConstraintTier : cs8AnchorTier;
    assert(tier({ isAssembly: true, parts: [{}, {}], weight: 100 }) === 0, 'asm tier0');
    assert(tier({ shapeKey: 'i_beam', category: 'beam', weight: 500 }) === 1, 'beam tier1');
    assert(tier({ groupKind: 'stack_plate', shapeKey: 'plate' }) === 1, 'plate floor');
    assert(tier({ shapeKey: 'z_channel', weight: 50, l: 400, w: 200, h: 200 }) === 2, 'nest secondary');
    assert(tier({ groupKind: 'bundle_rod', shapeKey: 'rod', l: 3000, unitWeightKg: 7 }) === 3, 'rod filler');
    assert(tier({ assemblyName: 'Portal Frame', weight: 900 }) === 0, 'portal');
    // Length-ratio floor (≥70%) even if light
    assert(tier({ l: 11608, w: 200, h: 300, unitWeightKg: 66, mark: 'LONG' }, 12192) === 1,
      'long lane → floor');
    if (typeof cs8YawOrientsFloorAnchor !== 'function') return;
    const orients = cs8YawOrientsFloorAnchor(
      { l: 10000, w: 400, h: 600 }, 12000, 2350, 2690);
    assert(orients.length === 2, `n=${orients.length}`);
    assert(orients.every(o => o.tag === 'yaw0' || o.tag === 'yaw180'), 'legacy longitudinal only');
    assert(!orients.some(o => o.tag === 'yaw90'), 'no 90 in legacy');
    if (typeof cs8FloorAnchorSupportMin === 'function')
      assert(cs8FloorAnchorSupportMin() >= 0.79, '≥80%');
    if (typeof cs8IsFloorOrSkidY === 'function') {
      assert(cs8IsFloorOrSkidY(0), 'floor');
      assert(cs8IsFloorOrSkidY(100), 'skid');
      assert(!cs8IsFloorOrSkidY(800), 'not stacked');
    }
  });

  t('W.12m', 'Stable-base orients: all directions, widest base first', () => {
    if (typeof cs8StableBaseOrients !== 'function') {
      assert(true, 'skip');
      return;
    }
    const o = cs8StableBaseOrients(
      { l: 5000, w: 1800, h: 600, weight: 800 },
      12000, 2350, 2690
    );
    assert(o.length >= 2, `orients=${o.length}`);
    assert(o.some(x => x.tag === 'yaw0' || x.tag === 'yaw180'), 'has longitudinal');
    assert(o.some(x => /Rx|Rz|yaw90|yaw270/i.test(x.tag)), 'has roll or cross-yaw');
    assert((o[0].stabilityScore || 0) + 1e-6 >= (o[1].stabilityScore || 0), 'stable first');
  });

  t('W.18', 'Constraint Rule1: wide-flat rafter finds upright orient + packs', () => {
    if (typeof cs8StableBaseOrients !== 'function'
        || typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Flat AABB: length × oversize width × thin height (won't fit without roll)
    const u = {
      mark: 'RF-WIDE', l: 11608, w: 2508, h: 200,
      weight: 711, weightKg: 711, unitWeightKg: 711, qty: 1,
      shapeKey: 'i_beam', profileShape: 'i_beam', category: 'beam',
      groupKind: 'bundle_beam',
    };
    const Lmax = 12192, Wmax = 2438, Houter = 2591;
    const Hpack = Houter - 50; // preferred top clearance
    const orients = cs8StableBaseOrients(u, Lmax, Wmax, Hpack, {
      Houter, floorClearMm: 0,
    });
    assert(orients.length >= 1, `orients=${orients.length}`);
    // Flat yaw0 (w=2508) must NOT appear — only upright-class fits
    assert(!orients.some(o => o.w > Wmax + 1),
      `over-width orient leaked: ${orients.map(o => o.w).join(',')}`);
    const upright = orients.find(o =>
      o.l <= Lmax + 1 && o.w <= Wmax + 1 && o.h <= Houter + 1
      && o.h >= 2400 && o.w <= 350 && o.l >= 11000);
    assert(!!upright, `no upright among ${orients.map(o => `${o.tag}:${Math.round(o.l)}x${Math.round(o.w)}x${Math.round(o.h)}`).join('|')}`);
    // tipPen must NOT bury sole/upright fit — first orient is upright-class
    assert(orients[0].h >= 2400 && orients[0].w <= 350,
      `first=${orients[0].tag} ${Math.round(orients[0].l)}x${Math.round(orients[0].w)}x${Math.round(orients[0].h)} (want upright first)`);
    if (orients.length === 1) assert(orients[0].soleFit, 'soleFit flag');

    const nOri = typeof cs8ValidOrientCount === 'function'
      ? cs8ValidOrientCount(u, Lmax, Wmax, Hpack, { Houter, floorClearMm: 0 })
      : orients.length;
    assert(nOri >= 1 && nOri <= 4, `validOrients=${nOri} (highly constrained)`);

    const res = layoutContainerPackStep8([], {
      lengthMm: Lmax, widthMm: Wmax, heightMm: Houter, maxWeightKg: 26000,
    }, null, {
      packUnits: [{
        mark: 'RF-WIDE', marks: ['RF-WIDE'],
        groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        qty: 1, total_weight: 711, weightKg: 711, unitWeightKg: 711,
        lengthMm: 11608, widthMm: 2508, heightMm: 200,
        bundle_bbox: { l: 11608, w: 2508, h: 200 },
        l: 11608, w: 2508, h: 200,
      }],
      maxContainers: 1, pass2: false, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    const over = res.oversized || [];
    assert(placed.some(it => /RF-WIDE/.test(String(it.mark))),
      `rafter placed; over=${(over[0] && over[0].fitReason) || 'none'} marks=${placed.map(p => p.mark).join(',')}`);
    const it = placed.find(p => /RF-WIDE/.test(String(p.mark)));
    if (it) {
      const fh = it.packFootprintH || it.heightMm || 0;
      const fw = it.packFootprintW || it.widthMm || 0;
      assert(fh >= 2000 || fw <= 400, `upright-ish fh=${fh} fw=${fw}`);
    }
  });

  t('W.18b', 'Constraint sort: long light beam before heavy short nest', () => {
    if (typeof cs8SortHeavyAnchor !== 'function'
        || typeof cs8ConstraintTier !== 'function') {
      assert(true, 'skip');
      return;
    }
    const Lmax = 12192, Wmax = 2438, Hpack = 2541;
    const eo = { Wmax, Hmax: Hpack, Houter: 2591, floorClearMm: 0 };
    const units = [
      {
        mark: 'NEST', groupKind: 'nest_z', shapeKey: 'z_channel',
        l: 400, w: 200, h: 200, weight: 2250, weightKg: 2250,
        unitWeightKg: 45, qty: 50,
      },
      {
        mark: 'BEAM', groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        l: 8400, w: 200, h: 300, weight: 66, weightKg: 66, unitWeightKg: 66, qty: 1,
      },
      {
        mark: 'ROD', groupKind: 'bundle_rod', shapeKey: 'rod',
        l: 3000, w: 20, h: 20, weight: 112, weightKg: 112, unitWeightKg: 7, qty: 16,
      },
    ];
    assert(cs8ConstraintTier(units[1], Lmax, eo) === 1, 'beam floor');
    assert(cs8ConstraintTier(units[0], Lmax, eo) === 2, 'nest secondary');
    assert(cs8ConstraintTier(units[2], Lmax, eo) === 3, 'rod filler');
    cs8SortHeavyAnchor(units, Lmax, eo);
    assert(units.map(u => u.mark).join(',') === 'BEAM,NEST,ROD',
      `order=${units.map(u => u.mark).join(',')} (want BEAM,NEST,ROD)`);
  });

  t('W.13a', 'Rule1 gate: Z-geometry (opposite flange) — not mark/name', () => {
    const gate = (typeof needsZStyleGroundFix === 'function')
      ? needsZStyleGroundFix
      : requiresLiveRotateSearch;
    if (typeof gate !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Unknown mark + Z polygon (left high / right low) → TRUE
    const zPoly = [
      [-40, 30], [-5, 30], [-5, 5], [5, -5], [40, -5], [40, -30],
      [5, -30], [5, -10], [-5, 10], [-40, 10],
    ];
    const purlinA = {
      mark: 'PURLIN-A',
      profileDesc: 'UNKNOWN',
      shapeKey: 'other',
      crossSection: { outer_points: zPoly },
      csAnalysis: {
        open_closed: 'open', profile_type: 'OPEN',
        concavity_ratio: 0.72, has_180_symmetry: true, symmetry_180: 0.92,
      },
    };
    assert(gate(purlinA) === true, 'PURLIN-A Z geometry');

    // C-like: web on left, BOTH flanges extend to +U (same side) — not Z
    const cPoly = [
      [-30, 40], [35, 40], [35, 32], [-20, 32], [-20, -32], [35, -32], [35, -40], [-30, -40],
    ];
    const cItem = {
      mark: 'C250',
      shapeKey: 'c_channel',
      crossSection: { outer_points: cPoly },
      csAnalysis: {
        open_closed: 'open', profile_type: 'OPEN',
        concavity_ratio: 0.70, has_180_symmetry: false, symmetry_180: 0.2,
      },
    };
    assert(gate(cItem) === false, 'C not Z-style');

    // Name says Z but CLOSED / no poly asymmetry → FALSE (no name trust)
    assert(gate({
      mark: '200Z2',
      profileDesc: '200Z2',
      shapeKey: 'z_channel',
      crossSection: { outer_points: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      csAnalysis: {
        open_closed: 'closed', profile_type: 'CLOSED',
        concavity_ratio: 0.01, has_180_symmetry: false,
      },
    }) === false, 'name alone not enough');

    assert(gate({
      mark: 'PL1',
      csAnalysis: { open_closed: 'solid', profile_type: 'SOLID', concavity_ratio: 0 },
      crossSection: { outer_points: [[0, 0], [10, 0], [10, 1], [0, 1]] },
    }) === false, 'solid no');
  });

  t('W.13b', 'Direct tip+joint atan2 levels contacts (physics, no deg bias)', () => {
    if (typeof csNzDirectTipJointAngle !== 'function'
        || typeof csNzMakeZChannelPolyMm !== 'function') {
      assert(true, 'skip');
      return;
    }
    const pts = csNzMakeZChannelPolyMm({
      sectH: 200, sectW: 70, sectT: 2.0, sectD: 18,
    });
    const hit = csNzDirectTipJointAngle(pts);
    assert(!!hit, 'hit');
    // Direct atan2 levels the tip–joint line; gap should be near 0
    assert(hit.gap < 2.0, `gap=${hit.gap}`);
    if (typeof csNzLiveRotateFindGroundAngle === 'function') {
      const live = csNzLiveRotateFindGroundAngle(pts);
      assert(!!live && live.gap < 2.0, `live gap=${live && live.gap}`);
    }
    // Physics-only score: no +deg cosmetic term
    if (typeof csNzContactScore === 'function') {
      assert(csNzContactScore(0, 0) > csNzContactScore(1, 0), 'gap hurts');
      assert(csNzContactScore(0, 0) > csNzContactScore(0, 1), 'float hurts');
    }
  });

  t('W.13c', 'groundOrientItem exists and stamps rule1 result', () => {
    if (typeof groundOrientItem !== 'function' || typeof THREE === 'undefined') {
      assert(true, 'skip');
      return;
    }
    const geo = new THREE.BoxGeometry(2, 0.2, 0.4);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    mesh.position.set(1, 5, 0);
    const it = {
      mark: 'BOX1',
      csAnalysis: { open_closed: 'solid', profile_type: 'SOLID', concavity_ratio: 0 },
    };
    const r = groundOrientItem(it, mesh);
    assert(!!r && r.ok, 'ok');
    assert(Math.abs(r.floor_y) < 1e-2, `floor_y=${r.floor_y}`);
    assert(r.stages && r.stages.length, 'stages');
    geo.dispose();
  });

  t('W.14a', 'Rule1 primary orients beat face-roll when ground_stable', () => {
    if (typeof cs8Rule1PrimaryOrients !== 'function'
        || typeof cs8ResolveTryOrients !== 'function') {
      assert(true, 'skip');
      return;
    }
    const u = {
      l: 8000, w: 200, h: 75, weight: 40,
      rule1_orientation: {
        ground_stable: true,
        packYawOnly: true,
        two_point_base: true,
        rot: { x: 0.4, y: 0, z: 0 },
      },
      two_point_base: true,
    };
    const prim = cs8Rule1PrimaryOrients(u, 12000, 2350, 2690);
    assert(prim.length === 2, `n=${prim.length}`);
    assert(prim.every(o => o.rule1Primary && o.packYawOnly), 'yaw-only primary');
    assert(!prim.some(o => /Rx|Rz/i.test(o.tag)), 'no face-roll in primary');
    const res = cs8ResolveTryOrients(u, 12000, 2350, 2690, true, true);
    assert(res.primary.length === 2, 'resolve primary');
    assert(res.fallback.length > 0, 'fallback available');
  });

  t('W.14b', 'Two-point support gate for OPEN bases', () => {
    if (typeof cs8NeedsTwoPointBase !== 'function'
        || typeof cs8SupportAccepted !== 'function') {
      assert(true, 'skip');
      return;
    }
    const u = { two_point_base: true, rule1_orientation: { two_point_base: true } };
    assert(cs8NeedsTwoPointBase(u), 'needs two-pt');
    const ok = {
      supportFrac: 0.1, twoPointOk: true, edgeSupportMin: 0.8, hangFrac: 0.1,
    };
    const bad = {
      supportFrac: 0.9, twoPointOk: false, edgeSupportMin: 0.2, hangFrac: 0.1,
    };
    assert(cs8SupportAccepted(ok, u, { two_point_base: true }, 0.8, true), 'two-pt ok');
    assert(!cs8SupportAccepted(bad, u, { two_point_base: true }, 0.8, true), 'two-pt reject');
    // Planar beam: uses 80% even if twoPointOk false
    const beam = { two_point_base: false };
    assert(cs8SupportAccepted(
      { supportFrac: 0.85, twoPointOk: false }, beam, {}, 0.8, true), 'planar ok');
  });

  t('W.15', 'Welded assemblies → 1 pack unit each (not pre-stacked tall)', () => {
    if (typeof createPackUnits !== 'function' && typeof buildPackUnitsStep7 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const mk = () => ({
      mark: 'RF001',
      qty: 1,
      unitWeightKg: 2800,
      lengthMm: 11000,
      widthMm: 350,
      heightMm: 800,
      isAssembly: true,
      parts: [{ name: 'web' }, { name: 'flange' }],
      sectH: 800, sectW: 350, sectT: 12,
    });
    const fn = typeof buildPackUnitsStep7 === 'function' ? buildPackUnitsStep7 : createPackUnits;
    const g5 = {
      id: 'G-RF',
      groupKind: 'welded_assembly',
      mark: 'RF001',
      nestMethod: { method: 'PER_MARK_STACK' },
      memberPieces: [mk(), mk(), mk(), mk(), mk()],
      sectH: 800, sectW: 350, sectT: 12,
      lengthMm: 11000,
    };
    const units = fn(g5);
    assert(units.length === 5, `units=${units.length} (want 5, one per rafter)`);
    units.forEach((pu, i) => {
      assert((pu.qty || 1) === 1, `unit[${i}].qty=${pu.qty}`);
      const h = (pu.bundle_bbox && pu.bundle_bbox.h) || pu.heightMm || 0;
      // Single rafter + skid — must fit typical 40ft H (~2690), not 5× stack
      assert(h < 2000, `unit[${i}] h=${h} (must not be 5-high stack)`);
    });
    // qty=5 on one row must also expand to 5 units
    const gQty = {
      id: 'G-RF-Q',
      groupKind: 'welded_assembly',
      nestMethod: { method: 'PER_MARK_STACK' },
      memberPieces: [{ ...mk(), qty: 5 }],
      sectH: 800, sectW: 350, lengthMm: 11000,
    };
    assert(fn(gQty).length === 5, `qty-expand units=${fn(gQty).length}`);
  });

  t('W.15b', 'Pack smoke: 3 identical assemblies → place more than one', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof buildPackUnitsStep7 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const mk = () => ({
      mark: 'CL1', qty: 1, unitWeightKg: 900,
      lengthMm: 9000, widthMm: 280, heightMm: 450,
      isAssembly: true, parts: [{}, {}],
      sectH: 450, sectW: 280, sectT: 10,
      groupKind: 'welded_assembly',
    });
    const g = {
      id: 'G-CL', groupKind: 'welded_assembly',
      nestMethod: { method: 'PER_MARK_STACK' },
      memberPieces: [mk(), mk(), mk()],
      sectH: 450, sectW: 280, lengthMm: 9000,
    };
    const packUnits = buildPackUnitsStep7(g);
    assert(packUnits.length === 3, `pu=${packUnits.length}`);
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits, maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.length >= 2, `placed=${placed.length} (want ≥2 of 3)`);
  });

  t('W.17', 'Pack numbers: #1 = load order (assy → beam floor → loose filler)', () => {
    if (typeof renumberCheckOrderByWeight !== 'function'
        || typeof compareStagingLoadOrder !== 'function') {
      assert(true, 'skip');
      return;
    }
    const fake = [
      {
        id: 'A', checked: true, checkOrder: 1, weightKg: 100, qty: 1,
        groupKind: 'loose_small',
        memberPieces: [{ unitWeightKg: 100, qty: 1 }],
      },
      {
        id: 'B', checked: true, checkOrder: 2, weightKg: 10000, qty: 5,
        groupKind: 'welded_assembly', isAssembly: true, parts: [{}, {}],
        memberPieces: Array.from({ length: 5 }, () => ({ unitWeightKg: 2000, qty: 1 })),
      },
      {
        id: 'C', checked: true, checkOrder: 3, weightKg: 800, qty: 1,
        groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        lengthMaxMm: 9000,
        memberPieces: [{ unitWeightKg: 800, qty: 1, lengthMm: 9000 }],
      },
      {
        id: 'D', checked: false, checkOrder: 99, weightKg: 9000, qty: 3,
        groupKind: 'welded_assembly', isAssembly: true, parts: [{}, {}],
      },
    ];
    renumberCheckOrderByWeight(fake);
    // B assembly → #1; C floor beam → #2; A loose filler → #3
    assert(fake.find(x => x.id === 'B').checkOrder === 1, 'B assy → #1');
    assert(fake.find(x => x.id === 'C').checkOrder === 2, 'C beam floor → #2');
    assert(fake.find(x => x.id === 'A').checkOrder === 3, 'A loose filler → #3');
    assert(fake.find(x => x.id === 'D').checkOrder === 0, 'unchecked → 0');
  });

  t('W.16', 'Scan axes: fine step + adjacent seeds beside placed box', () => {
    if (typeof cs8BuildScanAxes !== 'function') {
      assert(true, 'skip');
      return;
    }
    const Lmax = 12192, Wmax = 2438;
    const fl = 12000, fw = 300;
    const gL = 50, gW = 50;
    const gap = 50;
    // Empty: narrow Z → 100mm step (not 200)
    const empty = cs8BuildScanAxes({ boxes: [] }, fl, fw, Lmax, Wmax, gL, gW, gap);
    assert(empty.stepZm === 100, `stepZm=${empty.stepZm} (narrow → 100)`);
    // One rafter at Z=50 → next seed exactly at maxZ+gap
    const placed = {
      boxes: [{
        minX: 100, maxX: 100 + fl,
        minY: 0, maxY: 800,
        minZ: 50, maxZ: 50 + fw,
      }],
    };
    const next = cs8BuildScanAxes(placed, fl, fw, Lmax, Wmax, gL, gW, gap);
    const zAdj = 50 + fw + gap; // 400
    assert(next.zs.indexOf(Math.round(zAdj)) >= 0,
      `zs missing adjacent ${zAdj}; have ${next.zs.slice(0, 8).join(',')}`);
  });

  t('W.16b', 'Pack: 3 narrow assemblies snug side-by-side (adjacent Z)', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof buildPackUnitsStep7 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const mk = () => ({
      mark: 'RF-S', qty: 1, unitWeightKg: 800,
      lengthMm: 11000, widthMm: 300, heightMm: 700,
      isAssembly: true, parts: [{ name: 'a' }, { name: 'b' }],
      sectH: 700, sectW: 300, sectT: 12,
      groupKind: 'welded_assembly',
      // Pin pack envelope — skip bogus measureStableBundleMm on stub parts
      stableBundleMm: { l: 11000, w: 300, h: 700 },
    });
    const g = {
      id: 'G-RF-S', groupKind: 'welded_assembly',
      nestMethod: { method: 'PER_MARK_STACK' },
      memberPieces: [mk(), mk(), mk()],
      sectH: 700, sectW: 300, lengthMm: 11000,
    };
    const packUnits = buildPackUnitsStep7(g);
    assert(packUnits.length === 3, `pu=${packUnits.length}`);
    packUnits.forEach(pu => {
      pu.stableBundleMm = { l: 11000, w: 300, h: 700 };
      pu.bundle_bbox = {
        l: 11000, w: 300, h: 800, hSteel: 700, skidMm: 100, source: 'test',
      };
      pu.widthMm = 300;
      pu.heightMm = 800;
    });
    const spec = { lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000 };
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits, maxContainers: 1, pass2: false, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.length === 3, `placed=${placed.length} (want all 3 side-by-side)`);
    placed.forEach((it, i) => {
      assert(cs8IsFloorOrSkidY(Number(it.y) - Number(it.packFootprintH || it.h || 0) / 2)
        || (Number(it.y) || 0) < 500,
        `item[${i}] not floor-ish y=${it.y}`);
    });
    // Packer Z from footprint centres (render z is container-centred)
    const zC = placed.map(it => Number(it.z) || 0).sort((a, b) => a - b);
    const minGap = 200; // ~300mm wide + bundle gap → centres ≥ ~320 apart
    assert(zC[1] - zC[0] >= minGap,
      `Z12 gap=${(zC[1] - zC[0]).toFixed(0)} z=${zC.map(v => v.toFixed(0)).join(',')}`);
    assert(zC[2] - zC[1] >= minGap,
      `Z23 gap=${(zC[2] - zC[1]).toFixed(0)} z=${zC.map(v => v.toFixed(0)).join(',')}`);
  });

  t('W.12b', 'cstabIsWeldedAssembly detects multi-part', () => {
    if (typeof cstabIsWeldedAssembly !== 'function') {
      assert(true, 'skip');
      return;
    }
    assert(cstabIsWeldedAssembly({ isAssembly: true, parts: [{}, {}] }), 'parts');
    assert(cstabIsWeldedAssembly({ groupKind: 'welded_assembly' }), 'kind');
    assert(!cstabIsWeldedAssembly({ shapeKey: 'z_channel', qty: 1 }), 'not Z');
    assert(!cstabIsWeldedAssembly({ _assemblyChild: true, isAssembly: true, parts: [{}, {}] }), 'child skip');
  });

  t('W.12c', 'stagingFootprintMm prefers packEnvelope for assembly', () => {
    if (typeof stagingFootprintMm !== 'function') {
      assert(true, 'skip');
      return;
    }
    const fp = stagingFootprintMm({
      isAssembly: true,
      l: 100, w: 50, h: 40,
      packEnvelopeMm: { l: 9000, w: 600, h: 350 },
    });
    assert(fp.footX >= 9000, `footX=${fp.footX}`);
    assert(fp.footZ >= 600 * 1.1, `footZ=${fp.footZ}`); // pad ≥1.12
  });

  // ── makeShape integration smoke ───────────────────────────────────────────
  t('W.12', 'makeShape IFC-like standing box ends ground-stable', () => {
    if (typeof makeShape !== 'function' || typeof THREE === 'undefined') {
      assert(true, 'skip');
      return;
    }
    // Analytic plate standing-ish via height/width — plate builder is flat;
    // use rhs tall as proxy for warehouse via makeShape
    const it = {
      mark: 'WH1', shapeKey: 'rhs',
      sectH: 300, sectW: 100, sectT: 6, lengthMm: 8000,
      qty: 1, heightMm: 300, widthMm: 100,
    };
    const mesh = makeShape(it, 0x888888, 1);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    assert(approx(box.min.y, 0, 1e-2), `minY=${box.min.y}`);
    assert(it.stabilityInfo && it.stabilityInfo.ground_stable !== false, 'stable info');
    try {
      mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    } catch (_) { /* */ }
  });

  function runWarehouseGroundTestSuite() {
    const results = [];
    let passed = 0, failed = 0;
    for (let i = 0; i < TESTS.length; i++) {
      const tc = TESTS[i];
      const row = { id: tc.id, name: tc.name, ok: false, error: null };
      try { tc.fn(); row.ok = true; passed++; }
      catch (e) { row.ok = false; row.error = String(e && e.message ? e.message : e); failed++; }
      results.push(row);
    }
    const summary = {
      suite: 'warehouse_ground',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[WarehouseTests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runWarehouseGroundTestSuite = runWarehouseGroundTestSuite;
  global.__WAREHOUSE_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
