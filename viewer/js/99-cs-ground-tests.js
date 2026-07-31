/* 99-cs-ground-tests.js — Ground-stable rest pose suite (app WebView).
 * Call: runGroundStabilityTestSuite()
 *
 * Asserts every makeShape result:
 *   • sits on Y=0 (floor)
 *   • length horizontal (not standing on end)
 *   • not balanced on a thin edge / corner
 *   • L/Z bundles are Y-stack (no 45° diagonal lean)
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 1e-3);
  }

  function disposeMesh(mesh) {
    if (!mesh) return;
    try {
      if (typeof disposeTempMesh === 'function') { disposeTempMesh(mesh); return; }
      mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
    } catch (_) { /* */ }
  }

  function prep(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    delete it.orientation_info;
    delete it.best_orientation;
    delete it.nestMethod;
    delete it.nestingInfo;
    delete it.stabilityInfo;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    if (typeof findBestOrientation === 'function') findBestOrientation(it);
    if (typeof decideNestMethod === 'function') decideNestMethod(it);
    if (typeof calculateNestingOffset === 'function') calculateNestingOffset(it);
    return it;
  }

  /** Fast path for matrix: skip Step1–4 mesh analysis; stamp nest metadata only. */
  function prepLight(it) {
    delete it.stabilityInfo;
    const sk = it.shapeKey || it.profileShape || '';
    let method = 'PARALLEL_BUNDLE';
    let flip = false;
    if (sk === 'z_channel' || sk === 'c_channel') {
      // Matrix exercises Y-stack path (the diagonal-lean fix). Full INTERLOCK covered in G.4–G.6.
      method = 'STACK_NEST';
      flip = false;
    } else if (sk === 'i_beam') {
      method = 'STACK_NEST';
      flip = false;
    } else if (sk === 'l_angle') {
      method = 'STACK_NEST'; // L: stack face-down (no 180° flip)
    } else if (sk === 'plate') {
      method = 'FLAT_STACK';
    } else if (sk === 'rod') {
      method = 'HEX_BUNDLE';
    } else if (sk === 'rhs' || sk === 'chs') {
      method = 'PARALLEL_BUNDLE';
    }
    const t = Math.max(Number(it.sectT) || 2, 1);
    it.nestMethod = {
      method, alternate_flip: flip, density: 'dense', reason: 'ground_test_light',
    };
    it.nestingInfo = {
      method,
      nesting_offset: t + 3,
      clearance_mm: 3,
      place_mode: method === 'INTERLOCK_NEST' ? 'collision_interlock' : 'stack_up',
      alternate_flip: flip,
    };
    it.nestingOffsetMm = t + 3;
    it.orientation_info = it.orientation_info || { vert_key: sk === 'plate' ? 'T' : 'H' };
    return it;
  }

  function mk(o) {
    return Object.assign({
      mark: o.mark || 'G',
      qty: o.qty != null ? o.qty : 1,
      profileDesc: o.profileDesc || '',
      shapeKey: o.shapeKey || null,
      profileShape: o.profileShape || o.shapeKey || null,
      sectH: o.sectH || 0,
      sectW: o.sectW || 0,
      sectT: o.sectT || 0,
      sectD: o.sectD || 0,
      sectTf: o.sectTf || 0,
      sectTw: o.sectTw || 0,
      lengthMm: o.lengthMm || 6000,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      unitHeight: o.unitHeight || o.sectH || 0,
      unitWidth: o.unitWidth || o.sectW || 0,
      unitWeightKg: o.unitWeightKg || 40,
    }, o);
  }

  function buildAndEval(it, light) {
    if (light) prepLight(it);
    else prep(it);
    const mesh = makeShape(it, 0x8866aa, 1);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const ev = (typeof evaluateMeshGroupStability === 'function')
      ? evaluateMeshGroupStability(mesh)
      : null;
    const info = it.stabilityInfo || null;
    const scale = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
    return {
      mesh, box, size, ev, info, scale,
      minY: box.min.y,
      Lmm: size.x / scale,
      Hmm: size.y / scale,
      Wmm: size.z / scale,
    };
  }

  function assertGroundStable(it, tag, light) {
    const r = buildAndEval(it, !!light);
    try {
      assert(approx(r.minY, 0, 1e-3), `${tag} minY=${r.minY}`);
      assert(r.ev, `${tag} no eval`);
      assert(!r.ev.standing_on_end, `${tag} standing_on_end`);
      assert(!r.ev.thin_edge_sit, `${tag} thin_edge_sit`);
      assert(r.ev.length_horizontal, `${tag} length not horizontal sx=${r.size.x.toFixed(3)} sy=${r.size.y.toFixed(3)} sz=${r.size.z.toFixed(3)}`);
      // Tip must be reasonable (CoG over base)
      assert(r.ev.tip_ratio <= 0.95, `${tag} tip=${r.ev.tip_ratio}`);
      // Ground flag from stabilizer
      if (r.info) {
        assert(r.info.ground_stable || r.info.stable, `${tag} ground_stable=false reason=${r.info.reason}`);
        assert(r.info.length_horizontal, `${tag} info Lhoriz`);
      }
      // Long members: world X ≈ length
      if ((it.lengthMm || 0) >= 2000) {
        assert(r.Lmm >= (it.lengthMm || 0) * 0.85,
          `${tag} Lmm=${r.Lmm.toFixed(0)} want~${it.lengthMm}`);
      }
      // Height must not be near the length (was standing / diagonal tip)
      if ((it.lengthMm || 0) >= 3000) {
        assert(r.Hmm < (it.lengthMm || 0) * 0.55,
          `${tag} height looks like length Hmm=${r.Hmm.toFixed(0)}`);
      }
      return r;
    } finally {
      disposeMesh(r.mesh);
    }
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── Core visual regressions from screenshot ───────────────────────────────
  t('G.1', 'L-angle single sits on horizontal leg', () => {
    const r = assertGroundStable(mk({
      mark: 'L1', shapeKey: 'l_angle',
      sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
    }), 'L1');
    // Section height ≈ H (not length, not √2 diagonal tip)
    assert(r.Hmm < 200, `L height ${r.Hmm}`);
    assert(r.Wmm < 200, `L width ${r.Wmm}`);
  });

  t('G.2', 'L-angle nest qty=3 face-down (no 45° lean)', () => {
    const r = assertGroundStable(mk({
      mark: 'L3', shapeKey: 'l_angle',
      sectH: 100, sectW: 100, sectT: 8, lengthMm: 6000, qty: 3,
    }), 'L3');
    // Face-down Y-stack: width ≈ one piece; height grows with qty
    assert(r.Wmm < 180, `Wmm=${r.Wmm} (diagonal/side-tip would be wider)`);
    assert(r.Hmm >= 100, `Hmm=${r.Hmm}`);
    assert(r.Hmm < 500, `Hmm too tall ${r.Hmm}`);
  });

  t('G.3', 'L-angle nest qty=8 face-down', () => {
    assertGroundStable(mk({
      mark: 'L8', shapeKey: 'l_angle',
      sectH: 75, sectW: 75, sectT: 6, lengthMm: 5000, qty: 8,
    }), 'L8');
  });

  t('G.4', 'Z-purlin single ground stable', () => {
    assertGroundStable(mk({
      mark: 'Z1', shapeKey: 'z_channel',
      sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }), 'Z1');
  });

  t('G.5', 'Z-purlin nest qty=6 ground-stable (no tip/end)', () => {
    const r = assertGroundStable(mk({
      mark: 'Z6', shapeKey: 'z_channel',
      sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 7200, qty: 6,
    }), 'Z6');
    // Length remains the long axis; nest must not stand on end
    assert(r.Lmm > r.Hmm && r.Lmm > r.Wmm * 0.9, `L=${r.Lmm} H=${r.Hmm} W=${r.Wmm}`);
    assert(r.Hmm < r.Lmm * 0.5, `H too large ${r.Hmm}`);
  });

  t('G.6', 'C-channel single opening-up stable', () => {
    assertGroundStable(mk({
      mark: 'C1', shapeKey: 'c_channel',
      sectH: 250, sectW: 100, sectT: 3, lengthMm: 6000,
    }), 'C1');
  });

  t('G.7', 'Plate flat on ground', () => {
    const r = assertGroundStable(mk({
      mark: 'P1', shapeKey: 'plate',
      sectH: 12, sectW: 500, sectT: 12, lengthMm: 2000, widthMm: 500,
    }), 'P1');
    assert(r.ev.up_is_thinnest || r.Hmm < 80, `plate H=${r.Hmm}`);
  });

  t('G.8', 'RHS parallel length horizontal', () => {
    assertGroundStable(mk({
      mark: 'R1', shapeKey: 'rhs',
      sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
    }), 'R1');
  });

  t('G.9', 'Round bar length horizontal', () => {
    assertGroundStable(mk({
      mark: 'O1', shapeKey: 'rod',
      sectH: 16, sectW: 16, sectT: 16, sectD: 16, lengthMm: 6000,
    }), 'O1');
  });

  t('G.10', 'I-beam ground stable', () => {
    assertGroundStable(mk({
      mark: 'I1', shapeKey: 'i_beam',
      sectH: 400, sectW: 200, sectT: 12, sectTw: 12, sectTf: 20, lengthMm: 9000,
    }), 'I1');
  });

  t('G.11', 'chooseStableNestMode never diagonal for L', () => {
    const it = mk({ shapeKey: 'l_angle', sectH: 100, sectW: 100, sectT: 8, qty: 5 });
    prep(it);
    const mode = chooseStableNestMode(it, 5);
    assert(mode !== 'diagonal_same', `mode=${mode}`);
  });

  t('G.12', 'chooseStableNestMode stack_up for STACK_NEST Z', () => {
    const it = mk({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, qty: 4 });
    prep(it);
    it.nestMethod = { method: 'STACK_NEST', alternate_flip: false };
    assert(chooseStableNestMode(it, 4) === 'stack_up', 'stack_up');
  });

  t('G.13', 'Rest pose never mutates sect dims', () => {
    const it = mk({
      shapeKey: 'l_angle', sectH: 120, sectW: 80, sectT: 8, lengthMm: 3500, qty: 4,
    });
    const H0 = it.sectH, W0 = it.sectW, T0 = it.sectT, L0 = it.lengthMm;
    assertGroundStable(it, 'morph');
    assert(it.sectH === H0 && it.sectW === W0 && it.sectT === T0 && it.lengthMm === L0, 'dims');
  });

  // ── Matrix: shapes × lengths × qtys (≥1000 light cases) ───────────────────
  t('G.M', 'Matrix ground-stable (≥1000 cases)', () => {
    const shapes = [
      { shapeKey: 'l_angle', sectH: 75, sectW: 75, sectT: 6 },
      { shapeKey: 'l_angle', sectH: 100, sectW: 100, sectT: 8 },
      { shapeKey: 'l_angle', sectH: 150, sectW: 100, sectT: 10 },
      { shapeKey: 'l_angle', sectH: 200, sectW: 200, sectT: 12 },
      { shapeKey: 'z_channel', sectH: 150, sectW: 60, sectT: 2.0 },
      { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 },
      { shapeKey: 'z_channel', sectH: 250, sectW: 85, sectT: 3.0 },
      { shapeKey: 'z_channel', sectH: 300, sectW: 100, sectT: 3.0 },
      { shapeKey: 'c_channel', sectH: 150, sectW: 65, sectT: 2.5 },
      { shapeKey: 'c_channel', sectH: 200, sectW: 75, sectT: 2.5 },
      { shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3.0 },
      { shapeKey: 'plate', sectH: 6, sectW: 300, sectT: 6, widthMm: 300 },
      { shapeKey: 'plate', sectH: 10, sectW: 500, sectT: 10, widthMm: 500 },
      { shapeKey: 'plate', sectH: 16, sectW: 800, sectT: 16, widthMm: 800 },
      { shapeKey: 'rhs', sectH: 80, sectW: 80, sectT: 4 },
      { shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 },
      { shapeKey: 'rhs', sectH: 200, sectW: 100, sectT: 8 },
      { shapeKey: 'rod', sectH: 12, sectW: 12, sectT: 12, sectD: 12 },
      { shapeKey: 'rod', sectH: 20, sectW: 20, sectT: 20, sectD: 20 },
      { shapeKey: 'rod', sectH: 32, sectW: 32, sectT: 32, sectD: 32 },
      { shapeKey: 'i_beam', sectH: 300, sectW: 150, sectT: 10, sectTw: 8, sectTf: 12 },
      { shapeKey: 'i_beam', sectH: 400, sectW: 200, sectT: 12, sectTw: 12, sectTf: 20 },
      { shapeKey: 'chs', sectH: 114.3, sectW: 114.3, sectT: 5, sectD: 114.3 },
      { shapeKey: 'chs', sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3 },
    ];
    const lengths = [1200, 2000, 3000, 4000, 5000, 6000, 7200, 8500, 10000, 12000];
    const qtys = [1, 2, 3, 4, 5, 6, 8];

    let checked = 0;
    const failures = [];
    for (let si = 0; si < shapes.length; si++) {
      for (let li = 0; li < lengths.length; li++) {
        for (let qi = 0; qi < qtys.length; qi++) {
          const spec = shapes[si];
          const qty = qtys[qi];
          if (qty > 1 && spec.shapeKey === 'chs') continue;
          if (spec.shapeKey === 'plate' && qty > 5) continue;
          if (spec.shapeKey === 'i_beam' && qty > 3) continue;
          if (spec.shapeKey === 'rhs' && qty > 4) continue;
          if (spec.shapeKey === 'rod' && qty > 6) continue;

          const tag = `${spec.shapeKey}_L${lengths[li]}_q${qty}`;
          const it = mk(Object.assign({}, spec, {
            mark: tag,
            lengthMm: lengths[li],
            qty,
            heightMm: spec.sectH,
            widthMm: spec.widthMm || spec.sectW,
          }));
          try {
            assertGroundStable(it, tag, true); // light prep — matrix speed
            checked++;
          } catch (e) {
            failures.push(`${tag}: ${e.message || e}`);
            if (failures.length >= 20) break;
          }
        }
        if (failures.length >= 20) break;
      }
      if (failures.length >= 20) break;
    }
    assert(failures.length === 0,
      `matrix fail ${failures.length}/${checked + failures.length}: ${failures.slice(0, 8).join(' | ')}`);
    assert(checked >= 1000, `expected ≥1000 cases, got ${checked}`);
    global.__GROUND_MATRIX_CHECKED = checked;
  });

  // ── Perturbed initial rotations still settle face-down ────────────────────
  t('G.14', 'Pre-tilted group recovers to ground-stable', () => {
    const it = mk({
      mark: 'TILT', shapeKey: 'l_angle',
      sectH: 120, sectW: 80, sectT: 8, lengthMm: 4000, qty: 1,
    });
    prep(it);
    const mesh = makeShapeRaw(it, 0x8866aa, 1);
    // Corrupt pose like a bad IFC import
    mesh.rotation.set(Math.PI / 4, 0, Math.PI / 5);
    mesh.updateMatrixWorld(true);
    applyStableRestPose(mesh, it.orientation_info, it);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const ev = evaluateMeshGroupStability(mesh);
    try {
      assert(approx(box.min.y, 0, 1e-3), `minY=${box.min.y}`);
      assert(ev.length_horizontal, 'Lhoriz');
      assert(!ev.standing_on_end, 'end');
      assert(!ev.thin_edge_sit, 'edge');
    } finally {
      disposeMesh(mesh);
    }
  });

  t('G.15', 'Compound candidate banned for long L', () => {
    const it = mk({
      mark: 'CMP', shapeKey: 'l_angle',
      sectH: 100, sectW: 100, sectT: 8, lengthMm: 8000,
    });
    const r = assertGroundStable(it, 'CMP');
    const ar = r.info && r.info.applied_rotation;
    if (ar) {
      const compound = Math.abs(ar.x) > 0.2 && Math.abs(ar.z) > 0.2
        && Math.abs(Math.abs(ar.x) - Math.PI) > 0.2
        && Math.abs(Math.abs(ar.z) - Math.PI) > 0.2;
      assert(!compound, `compound rot ${JSON.stringify(ar)}`);
    }
  });

  function runGroundStabilityTestSuite() {
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
      suite: 'ground_stability',
      total: TESTS.length, passed, failed, ok: failed === 0,
      matrix_cases: global.__GROUND_MATRIX_CHECKED || 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(
        `[GroundTests] ${passed}/${TESTS.length} passed, ${failed} failed`
        + ` | matrix=${summary.matrix_cases}`
      );
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runGroundStabilityTestSuite = runGroundStabilityTestSuite;
  global.__GROUND_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
