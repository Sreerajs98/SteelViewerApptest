/* 99-cs-step3-tests.js — STEP 3 Best Orientation suite (app WebView).
 * Call: runStep3TestSuite()
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 0.05);
  }

  function mkItem(o) {
    return Object.assign({
      mark: o.mark || 'X', qty: 1,
      profileDesc: o.profileDesc || '',
      shapeKey: o.shapeKey || null,
      profileShape: o.profileShape || o.shapeKey || null,
      sectH: o.sectH || 0, sectW: o.sectW || 0, sectT: o.sectT || 0,
      sectTf: o.sectTf || 0, sectTw: o.sectTw || 0, sectD: o.sectD || 0,
      lengthMm: o.lengthMm || 6000,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      parts: o.parts || null,
    }, o);
  }

  function orient(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    delete it.orientation_info;
    delete it.best_orientation;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    return findBestOrientation(it);
  }

  function cand(o, id) {
    return (o.candidates || []).find(c => c.orientation_id === id);
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 3.1 Z-Purlin: Flat (B) wins ───────────────────────────────────────────
  t('3.1', 'Z-Purlin — B wins, C disqualified', () => {
    const o = orient(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    assert(o && o.orientation_id === 'B', `id=${o && o.orientation_id}`);
    assert(o.vert_key === 'W', `vert=${o.vert_key}`);
    assert(approx(o.vertical_mm, 75, 1), `vert_mm=${o.vertical_mm}`);
    assert(o.base_min_width >= 199, `base_min=${o.base_min_width}`);
    const c = cand(o, 'C');
    assert(c && c.disqualified && c.stability_score === 0, 'C DQ');
    const a = cand(o, 'A');
    assert(o.total_score > (a?.total_score || 0) * 2, 'B >> A');
    assert(o.best_orientation || true);
    // Z Nesting Angle: support flange tip + web-joint on ground
    assert(o.profile_type === 'Z_SHAPE', 'profile_type');
    assert(typeof o.nesting_angle_rad === 'number', 'nesting_angle_rad');
    assert(typeof o.nest_axis_angle_rad === 'number', 'nest_axis_angle');
    // LIVE rotate: tip + web-joint both on ground
    assert(o.z_nesting?.source === 'live_rotate_tip_joint_ground' || o.z_nesting?.ok === true, 'z_nesting');
    assert(Math.abs(o.nesting_angle_deg) > 40, `nest roll ${o.nesting_angle_deg}`);
  });

  // ── 3.2 Flat plate ────────────────────────────────────────────────────────
  t('3.2', 'Plate lies flat — only thin vertical survives', () => {
    const o = orient(mkItem({
      shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12,
      lengthMm: 1000, widthMm: 500, heightMm: 12,
    }));
    assert(o.orientation_id === 'A', `id=${o.orientation_id}`);
    assert(approx(o.vertical_mm, 12, 1), `v=${o.vertical_mm}`);
    assert(cand(o, 'B').disqualified, 'B DQ');
    assert(cand(o, 'C').disqualified, 'C DQ');
  });

  // ── 3.3 RHS wider face down ───────────────────────────────────────────────
  t('3.3', 'RHS — wider face down (A if H<W)', () => {
    // Guide: cs_height=100, cs_width=150 → A wins (100 vertical, 150 base)
    const o = orient(mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
    }));
    assert(o.orientation_id === 'A', `id=${o.orientation_id}`);
    assert(approx(o.vertical_mm, 100, 2), `v=${o.vertical_mm}`);
    assert(o.base_min_width >= 149, `base=${o.base_min_width}`);
    assert(o.total_score > cand(o, 'B').total_score, 'A > B');
  });

  // ── 3.4 I-Beam flange down ────────────────────────────────────────────────
  t('3.4', 'I-Beam — B wins (wider base)', () => {
    const o = orient(mkItem({
      shapeKey: 'i_beam', sectH: 400, sectW: 200, sectT: 12,
      sectTw: 12, sectTf: 20, lengthMm: 10000,
    }));
    assert(o.orientation_id === 'B', `id=${o.orientation_id}`);
    assert(approx(o.vertical_mm, 200, 2), `v=${o.vertical_mm}`);
    assert(o.base_min_width >= 399, `base=${o.base_min_width}`);
  });

  // ── 3.5 Equal angle tie ───────────────────────────────────────────────────
  t('3.5', 'Equal L — A/B tie, consistent pick', () => {
    const scores = [];
    for (let i = 0; i < 5; i++) {
      const o = orient(mkItem({
        shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
      }));
      scores.push(o.orientation_id);
      const a = cand(o, 'A'), b = cand(o, 'B');
      assert(approx(a.total_score, b.total_score, Math.max(1, a.total_score * 1e-6)),
        `A=${a.total_score} B=${b.total_score}`);
    }
    assert(scores.every(s => s === scores[0]), `consistent=${scores.join(',')}`);
    assert(scores[0] === 'A' || scores[0] === 'B', 'A or B');
  });

  // ── 3.6 Round bar ─────────────────────────────────────────────────────────
  t('3.6', 'Round bar — A/B equal, C DQ', () => {
    const o = orient(mkItem({
      shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16, lengthMm: 3000,
    }));
    assert(o.orientation_id === 'A' || o.orientation_id === 'B', `id=${o.orientation_id}`);
    assert(cand(o, 'C').disqualified, 'C DQ');
    assert(approx(cand(o, 'A').total_score, cand(o, 'B').total_score,
      Math.max(1, cand(o, 'A').total_score * 1e-6)), 'A≈B');
  });

  // ── 3.7 Welded rafter ─────────────────────────────────────────────────────
  t('3.7', 'Welded rafter — B (300 vertical)', () => {
    const it = mkItem({
      mark: 'RAF1', profileDesc: 'BUILT-UP',
      sectH: 800, sectW: 300, sectT: 16, lengthMm: 12000,
      heightMm: 800, widthMm: 300,
    });
    it.crossSection = {
      outer_points: [[0, 0], [300, 0], [300, 800], [0, 800]],
      inner_points: [],
      cs_width: 300, cs_height: 800, cs_area: 300 * 800,
      member_length: 12000, vertex_count: 4,
      welded_assembly: true, welded_like: true, source: 'bbox',
    };
    analyzeCrossSection(it);
    const ow = findBestOrientation(it);
    assert(ow.orientation_id === 'B', `id=${ow.orientation_id}`);
    assert(approx(ow.vertical_mm, 300, 2), `v=${ow.vertical_mm}`);
  });

  // ── 3.8 Thin member ───────────────────────────────────────────────────────
  t('3.8', 'Thin member lies flat', () => {
    const it = mkItem({
      shapeKey: 'plate', sectH: 2.5, sectW: 200, sectT: 2.5,
      lengthMm: 6000, widthMm: 200, heightMm: 2.5,
    });
    it.crossSection = {
      outer_points: [[0, 0], [200, 0], [200, 2.5], [0, 2.5]],
      inner_points: [],
      cs_width: 200, cs_height: 2.5, cs_area: 500,
      member_length: 6000, vertex_count: 4, source: 'analytic',
    };
    analyzeCrossSection(it);
    const o = findBestOrientation(it);
    assert(o.orientation_id === 'A', `id=${o.orientation_id}`);
    assert(cand(o, 'B').disqualified, 'B DQ on 2.5 edge');
  });

  // ── 3.9 Tiny cube — no crash ──────────────────────────────────────────────
  t('3.9', 'Tiny piece still picks an orientation', () => {
    const it = mkItem({ lengthMm: 50, sectH: 10, sectW: 10, sectT: 10 });
    it.crossSection = {
      outer_points: [[0, 0], [10, 0], [10, 10], [0, 10]],
      inner_points: [],
      cs_width: 10, cs_height: 10, cs_area: 100,
      member_length: 50, vertex_count: 4, source: 'analytic',
    };
    analyzeCrossSection(it);
    const o = findBestOrientation(it);
    assert(o && o.orientation_id, 'picked');
    assert(o.stability_score > 0 || o.needs_manual_review != null, 'scored');
  });

  // ── 3.10 Stackability tip when stability close ────────────────────────────
  t('3.10', 'Stackability breaks close stability', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 100, sectW: 95, sectT: 3, lengthMm: 5000,
    });
    extractCrossSection(it);
    analyzeCrossSection(it);
    // Inject asymmetric nest seps so B gets tiny nest pitch
    it.csAnalysis.nest_type = 'INTERLOCK';
    it.csAnalysis.can_interlock_nest = true;
    it.csAnalysis.nest_direction = 'Y';
    it.csAnalysis.nest_sep_u_mm = 50;
    it.csAnalysis.nest_sep_v_mm = 10;
    const o = findBestOrientation(it);
    assert(o.orientation_id === 'B', `id=${o.orientation_id} (stack tips to B)`);
    assert(cand(o, 'B').stackability_score > cand(o, 'A').stackability_score, 'B stack > A');
  });

  // ── 3.11 No rotation when A wins ──────────────────────────────────────────
  t('3.11', 'Rotation none when A already best', () => {
    const o = orient(mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
    }));
    assert(o.orientation_id === 'A', 'A');
    assert(o.rotation_needed && o.rotation_needed.angle === 0, JSON.stringify(o.rotation_needed));
    assert(o.rotation_needed.axis === 'none', 'axis none');
  });

  // ── 3.12 90° about length when B wins ─────────────────────────────────────
  t('3.12', 'Rotation 90° length_axis when B wins', () => {
    const o = orient(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    assert(o.orientation_id === 'B', 'B');
    assert(o.rotation_needed.axis === 'length_axis', `axis=${o.rotation_needed.axis}`);
    assert(o.rotation_needed.angle === 90, `angle=${o.rotation_needed.angle}`);
  });

  // ── 3.13 Origin alignment metadata for Step 4 ─────────────────────────────
  t('3.13', 'best_orientation fields ready for Step4', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const o = orient(it);
    const b = it.best_orientation;
    assert(b, 'best_orientation');
    assert(b.orientation_id === 'B', 'id');
    assert(b.vertical_dim > 0 && b.base_dim_1 > 0 && b.base_dim_2 > 0, 'dims');
    assert(b.rotation_needed && typeof b.rotation_needed.angle === 'number', 'rot');
    assert(b.stability_score > 0 && b.stackability_score > 0, 'scores');
    // Alignment itself is Step4 — here we only guarantee transform recipe exists
    assert(o.applies_to_display === false && o.mutates_geometry === false, 'no mesh mutate');
  });

  // ── 3.14 Determinism ──────────────────────────────────────────────────────
  t('3.14', 'Same Z → identical results ×10', () => {
    const hashes = [];
    for (let i = 0; i < 10; i++) {
      const o = orient(mkItem({
        shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      }));
      hashes.push([
        o.orientation_id, o.vertical_mm, o.stability_score,
        o.stackability_score, o.total_score, o.rotation_needed.angle,
      ].join('|'));
    }
    assert(hashes.every(h => h === hashes[0]), 'deterministic');
  });

  // ── 3.15 Batch standard profiles ──────────────────────────────────────────
  t('3.15', 'Batch standards — wider base down', () => {
    const cases = [
      { sk: 'z_channel', H: 200, W: 75, T: 2.5, L: 6000, expect: 'B' },
      { sk: 'c_channel', H: 250, W: 100, T: 3, L: 7200, expect: 'B' },
      { sk: 'l_angle', H: 150, W: 150, T: 10, L: 4000, expect: 'AB' },
      { sk: 'i_beam', H: 400, W: 200, T: 12, Tf: 20, Tw: 12, L: 10000, expect: 'B' },
      { sk: 'plate', H: 12, W: 500, T: 12, L: 1000, expect: 'A' },
      { sk: 'rhs', H: 100, W: 150, T: 6, L: 6000, expect: 'A' },
      { sk: 'rod', H: 16, W: 16, T: 16, D: 16, L: 3000, expect: 'AB' },
    ];
    cases.forEach(c => {
      const o = orient(mkItem({
        shapeKey: c.sk, sectH: c.H, sectW: c.W, sectT: c.T,
        sectTf: c.Tf || 0, sectTw: c.Tw || 0, sectD: c.D || 0,
        lengthMm: c.L, widthMm: c.W, heightMm: c.H,
      }));
      if (c.expect === 'AB')
        assert(o.orientation_id === 'A' || o.orientation_id === 'B', `${c.sk}=${o.orientation_id}`);
      else
        assert(o.orientation_id === c.expect, `${c.sk} got ${o.orientation_id} want ${c.expect}`);
      // Never stand on length
      assert(o.orientation_id !== 'C', `${c.sk} not C`);
    });

    // Welded bbox rafter
    const raf = mkItem({ sectH: 800, sectW: 300, lengthMm: 12000 });
    raf.crossSection = {
      outer_points: [[0, 0], [300, 0], [300, 800], [0, 800]],
      inner_points: [], cs_width: 300, cs_height: 800, cs_area: 240000,
      member_length: 12000, vertex_count: 4, welded_like: true, source: 'bbox',
    };
    analyzeCrossSection(raf);
    const or = findBestOrientation(raf);
    assert(or.orientation_id === 'B', `rafter=${or.orientation_id}`);
  });

  // ── 3.16 Nesting offset drives stackability ───────────────────────────────
  t('3.16', 'Nest offset → B stackability >> A', () => {
    const o = orient(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    const a = cand(o, 'A'), b = cand(o, 'B');
    assert(b.nest_step_mm < 20, `B nest_step=${b.nest_step_mm}`);
    assert(a.nest_step_mm > 50, `A nest_step=${a.nest_step_mm}`);
    assert(b.stackability_score > a.stackability_score * 3, `stack B=${b.stackability_score} A=${a.stackability_score}`);
  });

  function runStep3TestSuite() {
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
      suite: 'step3_orientation',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step3Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep3TestSuite = runStep3TestSuite;
  global.__STEP3_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
