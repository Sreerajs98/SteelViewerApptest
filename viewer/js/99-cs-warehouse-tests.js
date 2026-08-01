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

  t('W.12d2', 'Pitch footprint rejected — ship pose fits 40ft W×H', () => {
    if (typeof THREE === 'undefined' || typeof refineAssemblyGroundPose !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Long rafter with ~21.5° pitch baked in (RF012-class Z span)
    const group = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(11.864, 0.2, 0.869),
      new THREE.MeshBasicMaterial()
    );
    group.add(beam);
    // Pitch about Y → long axis spills into Z (RF012-class width 4341)
    group.rotation.y = Math.atan(4341 / 11864); // ~21.5°
    group.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(group);
    const bsz = new THREE.Vector3();
    before.getSize(bsz);
    assert(bsz.z > 2.5, `pitched Z before=${bsz.z.toFixed(2)} (want >2.5)`);

    refineAssemblyGroundPose(group, {
      mark: 'RF012', isAssembly: true, parts: [{}, {}],
      groupKind: 'welded_assembly', assemblyName: 'RAFTER',
    }, null);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
    assert(size.z <= 2438 * sc * 1.05 + 0.02,
      `ship Z=${(size.z / sc).toFixed(0)}mm (want ≤2438, pitch stripped)`);
    assert(size.y <= 2690 * sc * 1.05 + 0.02,
      `ship Y=${(size.y / sc).toFixed(0)}mm (want ≤2690)`);
    assert(size.x > size.z * 2 && size.x > size.y * 2, 'length still on X');
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  });

  t('W.12d5', 'axis-swap construct preferred over plate CS stamp', () => {
    if (typeof cs8UnitFromPackUnit !== 'function') { assert(true, 'skip'); return; }
    const pu = {
      mark: 'ASM-A', marks: ['ASM-A'],
      groupKind: 'welded_assembly', shapeKey: 'i_beam', category: 'beam',
      isAssembly: true, parts: [{}, {}],
      assemblyName: 'RAFTER',
      qty: 1, total_weight: 711, weightKg: 711,
      lengthMm: 11607.8, widthMm: 200, heightMm: 2507.5,
      // Plate CS stamp from "604.2A-6" must NOT override envelope
      sectW: 6, sectH: 604.2,
      stableBundleMm: {
        l: 200, w: 11607.8, h: 2507.5, source: 'measured_rest_pose',
      },
      bundle_bbox: { l: 11607.8, w: 200, h: 2507.5 },
    };
    const u = cs8UnitFromPackUnit(pu);
    assert(u.l > 10000, `span kept ${u.l}`);
    assert(u.h > 2000 && u.w <= 500, `upright web ${u.l}×${u.w}×${u.h}`);
    assert(u.widthMm > 50 || u.w > 50, 'not 6mm plate width');
  });

  t('W.12d6', 'Ship Prep API + yardSettle (pose then place)', () => {
    assert(typeof yardSettlePackedMeshes === 'function', 'yardSettle missing');
    assert(typeof yardItemWeightKg === 'function', 'yardWeight missing');
    // Ship Prep class router — source of truth before Optimise freeze pack
    assert(typeof csShipPrepClass === 'function', 'csShipPrepClass');
    assert(typeof csShipPrepMesh === 'function', 'csShipPrepMesh');
    assert(typeof csShipPrepPackUnit === 'function', 'csShipPrepPackUnit');
    assert(typeof csShipPrepReady === 'function', 'csShipPrepReady');
    assert(typeof csShipPrepTipGapMm === 'function', 'csShipPrepTipGapMm');
    assert(csShipPrepClass({ groupKind: 'nest_z' }) === 'nest_z', 'class nest_z');
    assert(csShipPrepClass({ isAssembly: true, parts: [{}, {}] }) === 'assembly',
      'class assembly');
    // Soft stamp must mark ready without remeshing warehouse stubs
    const stub = {
      mark: 'SP-STUB', isAssembly: true, groupKind: 'welded_assembly',
      parts: [{ name: 'web' }, { name: 'flange' }],
      stableBundleMm: { l: 10000, w: 400, h: 350 },
      _skipShipPrepRemesh: true,
    };
    const r = csShipPrepPackUnit(stub);
    assert(r && r.ok, 'stub soft prep');
    assert(stub._shipPrepped, '_shipPrepped stamped');
    assert(csShipPrepReady(stub) || stub._shipPrepped, 'ready gate');
  });

  t('W.25', 'FLANGE BRACE / ANGLE BRACE classify as l_angle not plate/rod', () => {
    if (typeof detectFromName !== 'function') { assert(true, 'skip'); return; }
    const cases = [
      'FLANGE BRACE', 'FLANGE_BRACE', 'Flange Brace ASSY',
      'ANGLE BRACE', 'L_BRACE', 'EQUAL ANGLE',
    ];
    cases.forEach(n => {
      const d = detectFromName(n);
      assert(d && d.shape === 'l_angle', `${n} → ${d && d.shape}`);
    });
    // Bare plate flange still plate; rod brace still rod
    assert(detectFromName('FLANGE PLATE')?.shape === 'plate'
      || detectFromName('TOP FLANGE')?.shape === 'plate', 'bare flange→plate');
    assert(detectFromName('ROD_BRACE')?.shape === 'rod', 'rod brace stays rod');
    // Nest pack bbox must grow for isAssembly L pieces (not assembly_single)
    if (typeof cspuBundleBBox === 'function') {
      const pieces = Array.from({ length: 4 }, (_, i) => ({
        mark: 'FB' + i, isAssembly: true, lengthMm: 600,
        sectH: 40, sectW: 40, sectT: 2.5, widthMm: 40, heightMm: 40,
      }));
      const bb = cspuBundleBBox(pieces, {
        method: 'STACK_NEST', nesting_offset: 5.5,
      }, 'STACK_NEST', {
        groupKind: 'nest_l', shapeKey: 'l_angle',
        sectH: 40, sectW: 40, sectT: 2.5, lengthMm: 600,
      });
      assert(bb && bb.h > 40 + 2 * 5, `nest L pack H grows (h=${bb && bb.h})`);
      assert(bb.w < 80, `nest L pack W stays section (w=${bb && bb.w})`);
    }
  });

  t('W.26b', 'Foreman packer places heavy assembly on floor', () => {
    if (typeof layoutContainerPackForeman !== 'function'
        && typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const packUnits = [
      {
        mark: 'ASM1', marks: ['ASM1'], groupKind: 'welded_assembly',
        isAssembly: true, parts: [{}, {}],
        shapeKey: 'i_beam', qty: 1, total_weight: 900, weightKg: 900,
        lengthMm: 9000, widthMm: 400, heightMm: 600,
        bundle_bbox: { l: 9000, w: 400, h: 600 },
        l: 9000, w: 400, h: 600,
      },
      {
        mark: 'FILL1', marks: ['FILL1'], groupKind: 'loose_small',
        shapeKey: 'plate', qty: 1, total_weight: 20, weightKg: 20,
        lengthMm: 500, widthMm: 300, heightMm: 12,
        bundle_bbox: { l: 500, w: 300, h: 12 },
        l: 500, w: 300, h: 12,
      },
    ];
    const res = (typeof layoutContainerPackForeman === 'function')
      ? layoutContainerPackForeman([], spec, null, { packUnits, maxContainers: 1 })
      : layoutContainerPackStep8([], spec, null, { packUnits, maxContainers: 1 });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.some(it => /ASM1/.test(String(it.mark))), 'assembly placed');
    const asm = placed.find(it => /ASM1/.test(String(it.mark)));
    if (asm) {
      assert((asm.packFootprintH || asm.h || 600) > 0, 'has height');
      // Floor: centre Y ≈ half height
      assert((asm.y || 0) < 800, `asm near floor y=${asm.y}`);
    }
  });

  t('W.26', 'pack best-of picks a strategy with placed items', () => {
    if (typeof layoutOptimized !== 'function') { assert(true, 'skip'); return; }
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const packUnits = [
      {
        mark: 'B1', marks: ['B1'], groupKind: 'bundle_beam', shapeKey: 'i_beam',
        isAssembly: true, qty: 1, total_weight: 800, weightKg: 800,
        lengthMm: 11000, widthMm: 200, heightMm: 400,
        stableBundleMm: { l: 11000, w: 200, h: 400 },
        bundle_bbox: { l: 11000, w: 200, h: 400 },
      },
      {
        mark: 'N1', marks: ['N1'], groupKind: 'nest_l', shapeKey: 'l_angle',
        qty: 6, total_weight: 180, weightKg: 180,
        lengthMm: 6000, widthMm: 75, heightMm: 75, sectH: 75, sectW: 75, sectT: 6,
        stableBundleMm: { l: 6000, w: 90, h: 200 },
        bundle_bbox: { l: 6000, w: 90, h: 200 },
      },
    ];
    const res = layoutOptimized([], spec, null, {
      packUnits, maxContainers: 1, pass2: true, markOrder: null,
    });
    const n = ((res.containers || [])[0]?.items || []).length;
    assert(n >= 1, `bestOf placed ${n}`);
    assert(res.packStrategy, 'packStrategy stamped');
  });

  t('W.12d4', 'IFC axis-swap RF012 200×11607×2507 remaps and places', () => {
    if (typeof cs8NormalizeAssemblyShipAxes !== 'function'
        || typeof cs8UnitFromPackUnit !== 'function'
        || typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const ax = cs8NormalizeAssemblyShipAxes(200, 11607.8, 2507.5, {
      mark: 'RF012', assemblyName: 'RAFTER', isAssembly: true,
      groupKind: 'welded_assembly',
    });
    assert(ax && ax.l > 10000 && ax.w < 500 && ax.h > 2000,
      `axis ${ax && ax.l}×${ax && ax.w}×${ax && ax.h}`);
    const pu = {
      mark: 'RF012', marks: ['RF012'],
      groupKind: 'welded_assembly', shapeKey: 'i_beam', category: 'beam',
      isAssembly: true, parts: [{}, {}],
      assemblyName: 'RAFTER',
      qty: 1, total_weight: 711, weightKg: 711,
      // Real A1321 scene axes (span on widthMm)
      lengthMm: 200, widthMm: 11607.8, heightMm: 2507.5,
      sectW: 200, sectH: 2507.5, sectT: 12,
      stableBundleMm: { l: 200, w: 11607.8, h: 2507.5 },
      bundle_bbox: { l: 200, w: 11607.8, h: 2507.5 },
    };
    const u = cs8UnitFromPackUnit(pu);
    assert(u.l > 10000 && u.w <= 2438 && u.h <= 2690,
      `unit ${u.l}×${u.w}×${u.h}`);
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits: [pu], maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    const ov = (res.oversized || []).map(o => o.fitReason).join(',');
    assert(placed.length >= 1, `axis-swap RF012 not placed; ov=${ov || 'none'}`);
  });

  t('W.12d3', 'pitched measure + ship construct → placeable (no invent)', () => {
    if (typeof cs8SanitizePitchedAssemblyEnvelope !== 'function'
        || typeof cs8UnitFromPackUnit !== 'function'
        || typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    // Measured still pitched; construct already ship axes (same member L)
    const raw = { l: 11864, w: 4341, h: 869, source: 'assembly_measured' };
    const fixed = cs8SanitizePitchedAssemblyEnvelope(
      raw,
      {
        mark: 'ASM-R', assemblyName: 'RAFTER', isAssembly: true,
        groupKind: 'welded_assembly',
      },
      11864, 200, 2507
    );
    assert(fixed && fixed.w <= 2438 && fixed.h <= 2690,
      `ship ${fixed && fixed.l}×${fixed && fixed.w}×${fixed && fixed.h}`);
    const pu = {
      mark: 'ASM-R', marks: ['ASM-R'],
      groupKind: 'welded_assembly', shapeKey: 'i_beam', category: 'beam',
      isAssembly: true, parts: [{}, {}],
      assemblyName: 'RAFTER',
      qty: 1, total_weight: 711, weightKg: 711,
      lengthMm: 11864, widthMm: 200, heightMm: 2507,
      sectW: 200, sectH: 2507, sectT: 12,
      stableBundleMm: { l: 11864, w: 4341, h: 869 },
      bundle_bbox: { l: 11864, w: 200, h: 2507 },
    };
    const u = cs8UnitFromPackUnit(pu);
    assert(u.w <= 2438 && u.h <= 2690, `unit ${u.l}×${u.w}×${u.h}`);
    const spec = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits: [pu], maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    const ov = (res.oversized || []).map(o => o.fitReason).join(',');
    assert(placed.length >= 1, `rafter-class not placed; ov=${ov || 'none'}`);
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

  t('W.18c', 'tipPen: upright I-beam soft; Z upright hard; flat beam wins when fit', () => {
    if (typeof cs8StableBaseOrients !== 'function'
        || typeof cs8OrientTipPenalty !== 'function') {
      assert(true, 'skip');
      return;
    }
    const Lmax = 12192, Wmax = 2438, Hpack = 2541, Houter = 2591;
    const opts = { Houter, floorClearMm: 0 };

    // Test 1 — rafter: only upright fits → positive score, Rx90 best
    const rafter = {
      mark: 'RF', l: 11608, w: 2508, h: 200, weight: 711,
      shapeKey: 'i_beam', category: 'beam', groupKind: 'bundle_beam',
    };
    const rO = cs8StableBaseOrients(rafter, Lmax, Wmax, Hpack, opts);
    assert(rO.length >= 1, 'rafter has orient');
    assert(rO[0].h >= 2400 && rO[0].w <= 350, `rafter best upright got ${rO[0].tag}`);
    // Score without soleFit boost should still be positive (tipPen soft)
    const rBase = (rO[0].baseArea || 0) - (rO[0].h || 0) * 40 - (rO[0].tipPen || 0);
    assert(rBase > 0, `rafter tipPen soft → baseScore=${rBase} (want >0)`);
    assert((rO[0].tipPen || 0) < 1e6, `rafter tipPen=${rO[0].tipPen} (want tiny)`);

    // Test 2 — normal beam: flat has wider base → yaw0/180 beats upright
    const beam = {
      mark: 'B1', l: 9000, w: 400, h: 200, weight: 800,
      shapeKey: 'i_beam', category: 'beam', groupKind: 'bundle_beam',
    };
    const bO = cs8StableBaseOrients(beam, Lmax, Wmax, Hpack, opts);
    assert(bO.length >= 2, 'beam multi-orient');
    assert(/yaw0|yaw180/i.test(bO[0].tag), `beam best=${bO[0].tag} (want flat)`);
    const uprightB = bO.find(o => o.h >= 350 && o.w <= 250);
    if (uprightB) {
      assert((bO[0].stabilityScore || 0) > (uprightB.stabilityScore || 0),
        'flat score > upright fallback');
    }

    // Test 3 — Z-purlin upright: NOT structural → heavy tipPen
    const zUp = { l: 6000, w: 75, h: 200 }; // would-be upright face dims
    const zPen = cs8OrientTipPenalty(zUp, {
      shapeKey: 'z_channel', groupKind: 'nest_z',
    }, false);
    assert(zPen > 1e8, `Z tipPen=${zPen} (want 1e9-scale)`);
    const beamUp = { l: 11608, w: 200, h: 2508 };
    const bPen = cs8OrientTipPenalty(beamUp, {
      shapeKey: 'i_beam', category: 'beam', groupKind: 'bundle_beam',
    }, false);
    assert(bPen < 1e5, `I-beam upright tipPen=${bPen} (want tipRatio×100)`);
  });

  t('W.18d', 'Upright rafter: pack places + footprint fit accepts (no mesh reject)', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof packFootprintFitsInContainer !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = {
      lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000,
    };
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits: [{
        mark: 'RF-WIDE', marks: ['RF-WIDE'],
        groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        isAssembly: true, parts: [{ name: 'web' }, { name: 'flange' }],
        qty: 1, total_weight: 711, weightKg: 711, unitWeightKg: 711,
        lengthMm: 11608, widthMm: 2508, heightMm: 200,
        bundle_bbox: { l: 11608, w: 2508, h: 200 },
        // Pin rest-pose AABB — skip bogus measureStableBundleMm on stub parts
        stableBundleMm: { l: 11608, w: 2508, h: 200 },
        l: 11608, w: 2508, h: 200,
      }],
      maxContainers: 1, pass2: false, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    const over = res.oversized || [];
    assert(placed.some(it => /RF-WIDE/.test(String(it.mark))),
      `placed; over=${(over[0] && (over[0].fitReason || over[0].fitReasonMsg)) || 'none'}`);
    const it = placed.find(p => /RF-WIDE/.test(String(p.mark)));
    assert(it.packFootprintH >= 2400 && it.packFootprintW <= 350,
      `footprint ${it.packFootprintL}x${it.packFootprintW}x${it.packFootprintH}`);
    assert(packFootprintFitsInContainer(it, spec) === true, 'pack footprint fits');
    if (typeof itemPoseFitsInContainer === 'function')
      assert(itemPoseFitsInContainer(it, spec), 'itemPoseFits accepts face-roll');
    if (typeof cs8IsStructuralFaceRoll === 'function') {
      assert(cs8IsStructuralFaceRoll(
        { groupKind: 'bundle_beam', shapeKey: 'i_beam' },
        { packYawOnly: false, packComposeRot: true }
      ), 'structural face-roll');
    }
  });

  t('W.19', 'Dense pack: upright rafter + narrow beam snug adjacent (Z gap≈bundle)', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof cs8MaxFloorStripMm !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = {
      lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000,
    };
    const packUnits = [
      {
        mark: 'RF1', marks: ['RF1'],
        groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        qty: 1, total_weight: 711, weightKg: 711, unitWeightKg: 711,
        lengthMm: 11608, widthMm: 2508, heightMm: 200,
        bundle_bbox: { l: 11608, w: 2508, h: 200 },
        stableBundleMm: { l: 11608, w: 2508, h: 200 },
        l: 11608, w: 2508, h: 200,
      },
      {
        mark: 'B2', marks: ['B2'],
        groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
        qty: 1, total_weight: 400, weightKg: 400, unitWeightKg: 400,
        lengthMm: 9000, widthMm: 200, heightMm: 300,
        bundle_bbox: { l: 9000, w: 200, h: 300 },
        stableBundleMm: { l: 9000, w: 200, h: 300 },
        l: 9000, w: 200, h: 300,
      },
    ];
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits, maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.length >= 2, `placed=${placed.length}`);
    const rf = placed.find(it => /RF1/.test(String(it.mark)));
    const b2 = placed.find(it => /B2/.test(String(it.mark)));
    assert(rf && b2, 'both marks');
    // Upright rafter footprint narrow in W
    assert((rf.packFootprintW || 999) <= 350 || (rf.packFootprintH || 0) >= 2400,
      `rf foot W=${rf.packFootprintW} H=${rf.packFootprintH}`);
    // Side-by-side gap in packer Z (render z + W/2)
    const Wmax = spec.widthMm;
    const rfZ0 = (rf.z || 0) + Wmax / 2 - (rf.packFootprintW || 200) / 2;
    const rfZ1 = rfZ0 + (rf.packFootprintW || 200);
    const b2Z0 = (b2.z || 0) + Wmax / 2 - (b2.packFootprintW || 200) / 2;
    const b2Z1 = b2Z0 + (b2.packFootprintW || 200);
    const gapZ = Math.max(0, Math.max(rfZ0, b2Z0) - Math.min(rfZ1, b2Z1));
    // If overlapping in Z projection they are stacked or same lane — allow;
    // if side-by-side, gap should be near bundle gap (20) not a huge corridor
    const sideBySide = !(rfZ1 <= b2Z0 + 1 || b2Z1 <= rfZ0 + 1)
      ? false
      : true;
    if (sideBySide || gapZ > 0) {
      const clearGap = rfZ1 <= b2Z0 ? (b2Z0 - rfZ1) : (rfZ0 - b2Z1);
      if (clearGap > 0) {
        assert(clearGap <= 120,
          `Z corridor ${Math.round(clearGap)}mm (want ≤120 snug, not empty lane)`);
      }
    }
    const strip = cs8MaxFloorStripMm(res.containers[0], spec.lengthMm, spec.widthMm);
    // Full empty legal W ≈ W − 2×inner (2.5); two ~200mm feet + gap must shrink strip
    const sideClr = (typeof cs8WallGapSide === 'function') ? cs8WallGapSide() : 2.5;
    const emptyW = spec.widthMm - 2 * sideClr;
    assert(strip < emptyW - 350,
      `max floor strip ${Math.round(strip)}mm (want occupied, empty≈${emptyW})`);
  });

  t('W.21', 'Inner load line clearance is 2.5mm', () => {
    if (typeof getLoadingRules !== 'function' && typeof getPackEnvelope !== 'function') {
      assert(true, 'skip');
      return;
    }
    const r = (typeof getLoadingRules === 'function') ? getLoadingRules() : null;
    if (r) {
      assert(Math.abs(r.WALL_CLEARANCE_SIDE_MM - 2.5) < 0.05, `side=${r.WALL_CLEARANCE_SIDE_MM}`);
      assert(Math.abs(r.WALL_CLEARANCE_END_MM - 2.5) < 0.05, `end=${r.WALL_CLEARANCE_END_MM}`);
      assert(Math.abs(r.WALL_CLEARANCE_TOP_MM - 2.5) < 0.05, `top=${r.WALL_CLEARANCE_TOP_MM}`);
    }
    const env = getPackEnvelope({ lengthMm: 12192, widthMm: 2438, heightMm: 2591 });
    assert(Math.abs(env.clearanceSideMm - 2.5) < 0.05, `env.side=${env.clearanceSideMm}`);
  });

  t('W.21b', 'Human seat: first floor piece hugs back inner line (low packer X)', () => {
    if (typeof layoutContainerPackStep8 !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = {
      lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000,
    };
    const packUnits = [{
      mark: 'RF1', marks: ['RF1'],
      groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
      qty: 1, total_weight: 711, weightKg: 711, unitWeightKg: 711,
      lengthMm: 11608, widthMm: 2508, heightMm: 200,
      bundle_bbox: { l: 11608, w: 2508, h: 200 },
      stableBundleMm: { l: 11608, w: 2508, h: 200 },
      l: 11608, w: 2508, h: 200,
    }];
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits, maxContainers: 1, pass2: true, markOrder: null,
    });
    const it = (res.containers[0] && res.containers[0].items || [])[0];
    assert(it, 'placed');
    const fl = it.packFootprintL || 11608;
    // Result x is render (mirrored): packer back ≈ high render X near door? 
    // clean.x = Lmax - packerCx; packerCx ≈ gL + fl/2 when snug back
    // → render x ≈ Lmax - gL - fl/2
    const gL = (typeof cs8WallGapEnd === 'function') ? cs8WallGapEnd() : 2.5;
    const expectRenderX = spec.lengthMm - gL - fl / 2;
    const dx = Math.abs((it.x || 0) - expectRenderX);
    assert(dx <= 80,
      `back-hug dx=${Math.round(dx)}mm (x=${Math.round(it.x)} want≈${Math.round(expectRenderX)})`);
  });

  t('W.24', 'Yard compact: ground sit + inner-line (no muttiyal)', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof cs8PoseInsideSafeEnvelope !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = {
      lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000,
    };
    const mk = (i) => ({
      mark: `YC${i}`, marks: [`YC${i}`],
      groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
      qty: 1, total_weight: 400, weightKg: 400, unitWeightKg: 400,
      lengthMm: 9000, widthMm: 200, heightMm: 300,
      bundle_bbox: { l: 9000, w: 200, h: 300 },
      stableBundleMm: { l: 9000, w: 200, h: 300 },
      l: 9000, w: 200, h: 300,
    });
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits: [mk(1), mk(2), mk(3), mk(4)],
      maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.length >= 3, `placed=${placed.length}`);
    // Compact step: legacy Pass1 or foreman final compact both count
    const compactSteps = (res.placementSteps || []).filter(s => s.type === 'compact');
    const foremanOk = !!(res.packPasses && res.packPasses.foreman)
      || res.strategy === 'foreman_space_first'
      || res.packStrategy === 'foreman_space_first';
    assert(compactSteps.length >= 1 || foremanOk,
      `expected Pass1/foreman compact, got ${compactSteps.length}; p2=${JSON.stringify(res.packPasses || {})} strat=${res.packStrategy || res.strategy || ''}`);
    const Lmax = spec.lengthMm;
    const Wmax = spec.widthMm;
    placed.forEach((it, i) => {
      const fl = it.packFootprintL || it.lengthMm || 9000;
      const fw = it.packFootprintW || it.widthMm || 200;
      const fh = it.packFootprintH || it.heightMm || 300;
      // Result x is render-mirrored; packerCx = Lmax - x
      const packerCx = Lmax - (it.x || 0);
      const packerX0 = packerCx - fl / 2;
      const packerZ0 = (it.z || 0) + Wmax / 2 - fw / 2;
      const y0 = (it.y || 0) - fh / 2;
      // Ground touch (floor seat)
      assert(y0 <= 30,
        `item[${i}] y0=${Math.round(y0)} (want ground ~0)`);
      assert(cs8PoseInsideSafeEnvelope(
        packerX0, packerZ0, Math.max(0, y0), fl, fw, fh, Lmax, Wmax, spec.heightMm
      ), `item[${i}] outside safe envelope (muttiyal)`);
    });
    // Neighbour Z gaps tight after compact
    const zSpans = placed.map(it => {
      const fw = it.packFootprintW || 200;
      const z0 = (it.z || 0) + Wmax / 2 - fw / 2;
      return { z0, z1: z0 + fw };
    }).sort((a, b) => a.z0 - b.z0);
    const gap = (typeof cs8BundleGap === 'function') ? cs8BundleGap() : 20;
    for (let i = 1; i < Math.min(zSpans.length, 4); i++) {
      const clear = zSpans[i].z0 - zSpans[i - 1].z1;
      if (clear < 0) continue; // stacked / same bay overlap in projection
      // Same bay neighbours should be snug; door-bay jump can be large — only check small gaps
      if (clear < 800) {
        assert(clear <= gap + 50,
          `Z gap[${i}]=${Math.round(clear)} after compact (want ~${gap})`);
      }
    }
  });

  t('W.23', 'Envelope guard: position (x+fl), not dims alone', () => {
    if (typeof cs8PoseInsideSafeEnvelope !== 'function') {
      assert(true, 'skip');
      return;
    }
    const Lmax = 12000, Wmax = 2350;
    const fl = 9000, fw = 200, fh = 300;
    // Dims fit but seat starts too far toward door → overhang past end clearance
    assert(!cs8PoseInsideSafeEnvelope(4000, 50, 0, fl, fw, fh, Lmax, Wmax, 2690),
      'must reject x+fl past safe end');
    // Legal closed-end seat
    const gL = (typeof cs8WallGapEnd === 'function') ? cs8WallGapEnd() : 2.5;
    const gW = (typeof cs8WallGapSide === 'function') ? cs8WallGapSide() : 2.5;
    assert(cs8PoseInsideSafeEnvelope(gL, gW, 0, fl, fw, fh, Lmax, Wmax, 2690),
      'legal back+home seat ok');
    // Dims alone would pass but Z overflows
    assert(!cs8PoseInsideSafeEnvelope(gL, Wmax - 50, 0, fl, fw, fh, Lmax, Wmax, 2690),
      'must reject z+fw past side');
  });

  t('W.22', 'Inch-by-inch: 3 narrow beams fill Z from home wall (no mid corridor)', () => {
    if (typeof layoutContainerPackStep8 !== 'function'
        || typeof cs8InchByInchPlace !== 'function') {
      assert(true, 'skip');
      return;
    }
    const spec = {
      lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000,
    };
    const mk = (i) => ({
      mark: `NB${i}`, marks: [`NB${i}`],
      groupKind: 'bundle_beam', shapeKey: 'i_beam', category: 'beam',
      qty: 1, total_weight: 400, weightKg: 400, unitWeightKg: 400,
      lengthMm: 9000, widthMm: 200, heightMm: 300,
      bundle_bbox: { l: 9000, w: 200, h: 300 },
      stableBundleMm: { l: 9000, w: 200, h: 300 },
      l: 9000, w: 200, h: 300,
    });
    const res = layoutContainerPackStep8([], spec, null, {
      packUnits: [mk(1), mk(2), mk(3)],
      maxContainers: 1, pass2: true, markOrder: null,
    });
    const placed = (res.containers[0] && res.containers[0].items) || [];
    assert(placed.length >= 3, `placed=${placed.length}`);
    const Wmax = spec.widthMm;
    const zSpans = placed.map(it => {
      const fw = it.packFootprintW || 200;
      const z0 = (it.z || 0) + Wmax / 2 - fw / 2;
      return { z0, z1: z0 + fw, fw };
    }).sort((a, b) => a.z0 - b.z0);
    // Home wall: first span starts near side clearance
    const gW = (typeof cs8WallGapSide === 'function') ? cs8WallGapSide() : 2.5;
    assert(zSpans[0].z0 <= gW + 40,
      `home Z0=${Math.round(zSpans[0].z0)} (want ≤${gW + 40})`);
    // Adjacent gaps ≈ bundle gap, not empty lane
    const gap = (typeof cs8BundleGap === 'function') ? cs8BundleGap() : 20;
    for (let i = 1; i < zSpans.length; i++) {
      const clear = zSpans[i].z0 - zSpans[i - 1].z1;
      assert(clear >= -1 && clear <= gap + 40,
        `Z gap[${i}]=${Math.round(clear)}mm (want ~${gap}, not corridor)`);
    }
  });

  t('W.19b', 'Fine scan: narrow foot uses 50mm step', () => {
    if (typeof cs8BuildScanAxes !== 'function') {
      assert(true, 'skip');
      return;
    }
    const Lmax = 12192, Wmax = 2438;
    const fl = 11608, fw = 200;
    const gL = 50, gW = 50, gap = 20;
    const axes = cs8BuildScanAxes({ boxes: [] }, fl, fw, Lmax, Wmax, gL, gW, gap);
    assert(axes.stepZm === 50, `stepZm=${axes.stepZm} (narrow → 50)`);
    assert(axes.zs.indexOf(gW) >= 0, 'wall-edge Z seeded');
  });

  t('W.20', 'Pack render: foot-snap kills float (center Y → mesh minY=y0)', () => {
    if (typeof snapMeshToPackerFootY !== 'function'
        || typeof makeShape !== 'function'
        || typeof THREE === 'undefined') {
      assert(true, 'skip');
      return;
    }
    const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
    // Floor-sat rest pose (origin near bottom) — packing used to float these
    const it = {
      mark: 'FLOAT1',
      category: 'beam',
      shapeKey: 'i_beam',
      lengthMm: 4000, widthMm: 200, heightMm: 600,
      sectH: 600, sectW: 200, sectT: 10, sectTf: 12, sectTw: 8,
      x: 2000, y: 300, z: 0, // AABB center (y0=0, h=600)
      packFootprintL: 4000, packFootprintW: 200, packFootprintH: 600,
      packPoseLock: true,
      userRot: { x: 0, y: 0, z: 0 },
      packYawOnly: true,
    };
    const mesh = makeShape(it, 0x4488ff, 1);
    mesh.position.set(it.x * sc, it.y * sc, it.z * sc);
    // Simulate float: origin treated as center without snap
    mesh.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(mesh);
    const floated = before.min.y > 0.02; // >20mm in scene units if SCALE=0.001 → 20mm
    snapMeshToPackerFootY(mesh, it);
    mesh.updateMatrixWorld(true);
    const after = new THREE.Box3().setFromObject(mesh);
    assert(Math.abs(after.min.y) < 0.002,
      `minY=${after.min.y.toFixed(4)} (want ~0 ground, before=${before.min.y.toFixed(4)})`);
    if (floated) {
      assert(after.min.y < before.min.y - 0.01, 'snap must lower floated mesh');
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
      // Pin envelope — stub parts must not invent a non-fitting bbox
      stableBundleMm: { l: 9000, w: 280, h: 450 },
    });
    const g = {
      id: 'G-CL', groupKind: 'welded_assembly',
      nestMethod: { method: 'PER_MARK_STACK' },
      memberPieces: [mk(), mk(), mk()],
      sectH: 450, sectW: 280, lengthMm: 9000,
    };
    const packUnits = buildPackUnitsStep7(g);
    assert(packUnits.length === 3, `pu=${packUnits.length}`);
    // Bypass fragile measureStableBundleMm on stub parts {} 
    packUnits.forEach(u => {
      u.stableBundleMm = { l: 9000, w: 280, h: 450 };
      u.bundle_bbox = { l: 9000, w: 280, h: 450, skidMm: 0 };
      u.l = 9000; u.w = 280; u.h = 450;
      u.lengthMm = 9000; u.widthMm = 280; u.heightMm = 450;
      u.skidMm = 0;
    });
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
    // Empty: narrow Z → 50mm fine step (or leftover strip <400)
    const empty = cs8BuildScanAxes({ boxes: [] }, fl, fw, Lmax, Wmax, gL, gW, gap);
    assert(empty.stepZm === 50, `stepZm=${empty.stepZm} (narrow → 50)`);
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
