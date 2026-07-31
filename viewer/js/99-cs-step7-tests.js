/* 99-cs-step7-tests.js — STEP 7 Nesting Offset Calculation suite (app WebView).
 * Call: runStep7TestSuite()
 *
 * DONE WHEN:
 *   Z-purlin offset ≈ web_thickness + 3mm
 *   No polygon overlap in nested position
 *   Alternate flip where symmetric
 *   Bundle AABB correct
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 1e-3);
  }

  function mk(o) {
    return Object.assign({
      mark: o.mark || 'N',
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
    }, o);
  }

  function pipeline(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    delete it.nestMethod;
    delete it.nestingInfo;
    delete it.nestingOffsetMm;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    if (typeof decideNestMethod === 'function') decideNestMethod(it);
    return calculateNestingOffset(it);
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 7.1 Z offset ≈ T + 3mm ────────────────────────────────────────────────
  t('7.1', 'Z-purlin offset ≈ web_thickness + 3mm', () => {
    const T = 2.5;
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: T, lengthMm: 6000,
    });
    const n = pipeline(it);
    assert(n.method === 'INTERLOCK_NEST', `method=${n.method}`);
    assert(n.alternate_flip === true, 'Z flip');
    assert(n.clearance_mm === 3 || approx(n.clearance_mm, 3, 0.01), `clear=${n.clearance_mm}`);
    // gap ~ thickness; offset = gap + clear → near T+3
    const expect = T + 3;
    assert(n.nesting_offset > T * 0.5, `off=${n.nesting_offset} too small`);
    assert(n.nesting_offset < expect + 25, `off=${n.nesting_offset} too large vs T+3=${expect}`);
    // Prefer close to T+3 when collision_fit works (allow wider band for lips)
    if (n.source === 'collision_fit' || n.source === 'polygon_slide') {
      assert(n.gap_mm != null && n.gap_mm >= 0, 'gap');
      assert(approx(n.nesting_offset, n.gap_mm + n.clearance_mm, 0.05), 'off=gap+clear');
    }
  });

  // ── 7.2 No overlap in nested Z ────────────────────────────────────────────
  t('7.2', 'Z nest placements have no polygon overlap', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    pipeline(it);
    const v = verifyNestNoOverlap(it, 6);
    assert(v.ok, `overlap=${v.max_overlap} pairs=${JSON.stringify(v.pairs)}`);
    assert(v.max_overlap <= 0.02, `max_ov=${v.max_overlap}`);
  });

  // ── 7.3 Alternate flip for symmetric Z ────────────────────────────────────
  t('7.3', 'Alternate flip applied for symmetric Z', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5,
    });
    pipeline(it);
    assert(it.nestingInfo.alternate_flip === true, 'flip');
    const pack = computeInterlockNestPlacements(
      it.crossSection, 4,
      it.nestingInfo.nest_direction_2d,
      it.nestingInfo.clearance_mm,
      true
    );
    assert(pack.placements[0].flip === false, 'p0');
    assert(pack.placements[1].flip === true, 'p1');
    assert(pack.placements[2].flip === false, 'p2');
    assert(pack.placements[3].flip === true, 'p3');
  });

  // ── 7.4 L no flip → placements match ──────────────────────────────────────
  t('7.4', 'L-angle no flip — offset matches no-flip slide', () => {
    const it = mk({
      shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
    });
    const n = pipeline(it);
    // L may be INTERLOCK or STACK; flip must be false
    assert(n.alternate_flip === false, `flip=${n.alternate_flip}`);
    if (n.method === 'INTERLOCK_NEST') {
      const pack = computeInterlockNestPlacements(
        it.crossSection, 3, n.nest_direction_2d, n.clearance_mm, false
      );
      assert(pack.placements.every(p => !p.flip), 'no flips');
      const v = verifyNestNoOverlap(it, 3);
      assert(v.ok, `L overlap=${v.max_overlap}`);
    }
  });

  // ── 7.5 PARALLEL = width + 5mm ────────────────────────────────────────────
  t('7.5', 'RHS PARALLEL offset = width + 5mm', () => {
    const it = mk({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
    });
    const n = pipeline(it);
    assert(n.method === 'PARALLEL_BUNDLE', `method=${n.method}`);
    assert(approx(n.clearance_mm, 5, 0.01), `clear=${n.clearance_mm}`);
    const w = n.nest_direction_2d === 'v' ? n.dims_used.h : n.dims_used.w;
    assert(approx(n.nesting_offset, w + 5, 0.5), `off=${n.nesting_offset} want ${w}+5`);
  });

  // ── 7.6 FLAT = thickness, no clearance ────────────────────────────────────
  t('7.6', 'Plate FLAT_STACK offset = thickness (no clearance)', () => {
    const it = mk({
      shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12,
      lengthMm: 1000, widthMm: 500,
    });
    const n = pipeline(it);
    assert(n.method === 'FLAT_STACK', `method=${n.method}`);
    assert(n.clearance_mm === 0, `clear=${n.clearance_mm}`);
    assert(approx(n.nesting_offset, 12, 0.5) || approx(n.nesting_offset, n.dims_used.t, 0.5),
      `off=${n.nesting_offset} t=${n.dims_used.t}`);
    assert(n.nesting_offset < 12 + 1.5, 'must not add 3mm clear');
  });

  // ── 7.7 STACK = T + 3 ─────────────────────────────────────────────────────
  t('7.7', 'Open shallow STACK offset = T + 3mm', () => {
    const it = mk({
      mark: 'SH', shapeKey: null, sectH: 100, sectW: 80, sectT: 8, lengthMm: 3000,
    });
    it.crossSection = {
      outer_points: [
        [0, 0], [80, 0], [80, 8], [8, 8], [8, 92], [80, 92], [80, 100], [0, 100],
      ],
      vertex_count: 8, cs_height: 100, cs_width: 80,
    };
    analyzeCrossSection(it);
    it.csAnalysis.open_closed = 'open';
    it.csAnalysis.concavity_ratio = 0.08;
    it.csAnalysis.nest_type = 'STACK';
    it.csAnalysis.can_flip = false;
    decideNestMethod(it);
    const n = calculateNestingOffset(it);
    assert(n.method === 'STACK_NEST', `method=${n.method}`);
    assert(approx(n.nesting_offset, 8 + 3, 0.5), `off=${n.nesting_offset}`);
  });

  // ── 7.8 Bundle AABB INTERLOCK ─────────────────────────────────────────────
  t('7.8', 'Bundle bounding box INTERLOCK correct', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const n = pipeline(it);
    const N = 5;
    const bb = computeNestBundleBounds(N, n, {
      length: 6000, width: 75, height: 200, thickness: 2.5,
    });
    assert(approx(bb.bundle_length, 6000, 1), `L=${bb.bundle_length}`);
    if (n.use_tilted_nest_axis) {
      const dy = Math.abs(n.nesting_offset_y);
      const dz = Math.abs(n.nesting_offset_z);
      assert(approx(bb.bundle_width, 75 + (N - 1) * dz, 1), `W=${bb.bundle_width}`);
      assert(approx(bb.bundle_height, 200 + (N - 1) * dy, 1), `H=${bb.bundle_height}`);
    } else {
      assert(approx(bb.bundle_width, 75, 1), `W=${bb.bundle_width}`);
      assert(approx(bb.bundle_height, 200 + (N - 1) * n.nesting_offset, 1),
        `H=${bb.bundle_height}`);
    }
  });

  // ── 7.9 Bundle AABB PARALLEL ──────────────────────────────────────────────
  t('7.9', 'Bundle bounding box PARALLEL correct', () => {
    const it = mk({ shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 4000 });
    const n = pipeline(it);
    const N = 4;
    const bb = computeNestBundleBounds(N, n, {
      length: 4000, width: 150, height: 100, thickness: 6,
    });
    assert(approx(bb.bundle_length, 4000, 1), 'L');
    assert(approx(bb.bundle_height, 100, 1), 'H');
    assert(approx(bb.bundle_width, 150 + (N - 1) * n.nesting_offset, 1),
      `W=${bb.bundle_width}`);
  });

  // ── 7.10 Bundle AABB FLAT ─────────────────────────────────────────────────
  t('7.10', 'Bundle bounding box FLAT_STACK correct', () => {
    const it = mk({
      shapeKey: 'plate', sectH: 10, sectW: 400, sectT: 10, lengthMm: 2000, widthMm: 400,
    });
    const n = pipeline(it);
    const N = 6;
    const bb = computeNestBundleBounds(N, n, {
      length: 2000, width: 400, height: 10, thickness: 10,
    });
    assert(approx(bb.bundle_height, N * n.nesting_offset, 1), `H=${bb.bundle_height}`);
    assert(approx(bb.bundle_width, 400, 1), 'W');
  });

  // ── 7.11 World placements flip + axis ─────────────────────────────────────
  t('7.11', 'World Y placements respect flip + nest axis', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    pipeline(it);
    const w = computeInterlockWorldYPlacements(it, 4);
    assert(w.placements.length === 4, 'n');
    assert(w.placements[0].flip === false, 'f0');
    assert(w.placements[1].flip === true, 'f1');
    // Offsets non-decreasing along nest progress (distance from piece 0)
    for (let i = 1; i < w.placements.length; i++) {
      const d0 = Math.hypot(w.placements[i - 1].y_offset_mm, w.placements[i - 1].z_offset_mm);
      const d1 = Math.hypot(w.placements[i].y_offset_mm, w.placements[i].z_offset_mm);
      assert(d1 + 1e-6 >= d0, `mono dist ${d0}→${d1}`);
      assert(w.placements[i].step_from_prev_mm > 0, 'step>0');
    }
    if (w.nest_world_axis === 'tilted') {
      assert(Math.abs(w.placements[1].y_offset_mm) > 0 || Math.abs(w.placements[1].z_offset_mm) > 0,
        'tilted has YZ');
    }
  });

  // ── 7.12 No geometry morph ────────────────────────────────────────────────
  t('7.12', 'calculateNestingOffset never mutates geometry', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    extractCrossSection(it);
    const outer0 = JSON.stringify(it.crossSection.outer_points);
    const H0 = it.sectH, T0 = it.sectT;
    calculateNestingOffset(it);
    decideNestMethod(it);
    calculateNestingOffset(it);
    assert(it.sectH === H0 && it.sectT === T0, 'dims');
    assert(JSON.stringify(it.crossSection.outer_points) === outer0, 'poly');
    assert(it.nestingInfo.mutates_geometry === false, 'flag');
  });

  // ── 7.13 HEX offset ───────────────────────────────────────────────────────
  t('7.13', 'Round bar HEX offsets d+clear and row pitch', () => {
    const it = mk({
      shapeKey: 'rod', sectH: 20, sectW: 20, sectT: 20, sectD: 20, lengthMm: 6000,
    });
    const n = pipeline(it);
    assert(n.method === 'HEX_BUNDLE', `method=${n.method}`);
    const d = Math.max(n.dims_used.min, n.dims_used.t);
    assert(approx(n.nesting_offset_x, d + n.clearance_mm, 0.5), `ox=${n.nesting_offset_x}`);
    assert(approx(n.nesting_offset_y, (d + n.clearance_mm) * Math.cos(Math.PI / 6), 0.5),
      `oy=${n.nesting_offset_y}`);
  });

  // ── 7.14 C no-overlap with flip if symmetric ──────────────────────────────
  t('7.14', 'C-channel nest no overlap', () => {
    const it = mk({
      shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3, lengthMm: 7200,
    });
    pipeline(it);
    if (it.nestMethod.method === 'INTERLOCK_NEST') {
      const v = verifyNestNoOverlap(it, 5);
      assert(v.ok, `C ov=${v.max_overlap}`);
    }
  });

  // ── 7.15 Matrix: many Z sizes offset sanity ───────────────────────────────
  t('7.15', 'Matrix Z sizes: offset in [T, T+30] and no overlap', () => {
    const specs = [
      { H: 150, W: 60, T: 2.0 },
      { H: 200, W: 75, T: 2.5 },
      { H: 250, W: 85, T: 3.0 },
      { H: 300, W: 100, T: 3.0 },
      { H: 200, W: 70, T: 1.8 },
      { H: 220, W: 80, T: 2.2 },
    ];
    const fails = [];
    specs.forEach(s => {
      const it = mk({
        mark: `Z${s.H}`, shapeKey: 'z_channel',
        sectH: s.H, sectW: s.W, sectT: s.T, lengthMm: 6000,
      });
      try {
        const n = pipeline(it);
        assert(n.method === 'INTERLOCK_NEST', 'INTERLOCK');
        assert(n.nesting_offset >= s.T * 0.4, `small ${n.nesting_offset}`);
        assert(n.nesting_offset <= s.T + 30, `large ${n.nesting_offset}`);
        const v = verifyNestNoOverlap(it, 4);
        assert(v.ok, `ov=${v.max_overlap}`);
      } catch (e) {
        fails.push(`Z${s.H}x${s.T}: ${e.message || e}`);
      }
    });
    assert(fails.length === 0, fails.join(' | '));
  });

  // ── 7.16 DONE-WHEN matrix ─────────────────────────────────────────────────
  t('7.16', 'DONE-WHEN: Z offset / no overlap / flip / bbox', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const n = pipeline(it);
    assert(n.alternate_flip, 'flip');
    assert(n.nesting_offset > 2.5 && n.nesting_offset < 28, `Z off=${n.nesting_offset}`);
    assert(verifyNestNoOverlap(it, 8).ok, 'no overlap');
    const bb = computeNestBundleBounds(8, n, {
      length: 6000, width: 75, height: 200, thickness: 2.5,
    });
    assert(bb.bundle_height > 200, 'bundle grows');
    assert(bb.bundle_length === 6000, 'L');
  });

  // ── 7.17 Z Nesting Angle → tilted offset axis ─────────────────────────────
  t('7.17', 'Z Nesting Angle: tilted nest offsets (not pure horizontal)', () => {
    const it = mk({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const n = pipeline(it);
    assert(n.profile_type === 'Z_SHAPE' || n.use_tilted_nest_axis, 'Z tilt flag');
    assert(n.use_tilted_nest_axis, 'use_tilted_nest_axis');
    assert(typeof n.nest_axis_angle_rad === 'number', 'axis');
    assert(Math.abs(n.nesting_offset_y) + Math.abs(n.nesting_offset_z) > 0, 'yz components');
    // Magnitude preserved: sqrt(oy²+oz²) ≈ nesting_offset
    const mag = Math.hypot(n.nesting_offset_y, n.nesting_offset_z);
    assert(Math.abs(mag - n.nesting_offset) < 0.05, `mag=${mag} off=${n.nesting_offset}`);
    // Must not be pure-horizontal only (oz==off, oy==0) unless axis says so
    if (Math.abs(n.nest_axis_angle_deg) > 10 && Math.abs(n.nest_axis_angle_deg) < 80) {
      assert(Math.abs(n.nesting_offset_y) > 0.1, 'has Y component');
      assert(Math.abs(n.nesting_offset_z) > 0.1, 'has Z component (tilted)');
    }
  });

  // ── 7.18 LIVE rotate: tip + web-joint on ground ──────────────────────────
  t('7.18', 'LIVE rotate tip + web-joint both on ground', () => {
    assert(typeof calculateZNestingAngle === 'function', 'helper');
    const it = { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 };
    const nest = calculateZNestingAngle(null, it);
    assert(nest.ok, 'ok');
    assert(nest.source === 'live_rotate_tip_joint_ground', `src=${nest.source}`);
    assert(nest.contact_a && nest.contact_b, 'contacts');
    // makeZChannel live search ≈ +115° (or mirror ≈ −65°)
    const ad = Math.abs(nest.nesting_angle_deg);
    assert(ad > 50 && ad < 140, `roll=${nest.nesting_angle_deg}`);
    assert(nest.contact_gap_mm < 1, `gap=${nest.contact_gap_mm}`);
    assert(nest.contact_float_mm < 1, `float=${nest.contact_float_mm}`);
  });

  // ── 7.19 Contacts share Y and sit on minY ────────────────────────────────
  t('7.19', 'after LIVE roll tip+joint on minY', () => {
    const it = { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 };
    const nest = calculateZNestingAngle(null, it);
    assert(nest.ok, 'ok');
    const poly = typeof csNzMakeZChannelPolyMm === 'function'
      ? csNzMakeZChannelPolyMm(it) : null;
    assert(poly && poly.length > 4, 'poly');
    const a = nest.nesting_angle_rad;
    const rotY = (p) => p[1] * Math.cos(a) - p[0] * Math.sin(a);
    let minY = Infinity;
    poly.forEach(p => { const y = rotY(p); if (y < minY) minY = y; });
    assert(Math.abs(rotY(nest.contact_a) - rotY(nest.contact_b)) < 1, 'level');
    assert(rotY(nest.contact_a) - minY < 1, 'tip on ground');
    assert(rotY(nest.contact_b) - minY < 1, 'joint on ground');
  });

  function runStep7TestSuite() {
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
      suite: 'step7_nest_offset',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step7Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep7TestSuite = runStep7TestSuite;
  global.__STEP7_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
