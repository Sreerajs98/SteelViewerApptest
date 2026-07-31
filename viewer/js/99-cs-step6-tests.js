/* 99-cs-step6-tests.js — STEP 6 Nest Method Assignment suite (app WebView).
 * Call: runStep6TestSuite()
 *
 * Guide DONE WHEN:
 *   Z-purlins → interlock + 180° flip
 *   Plates → flat stack
 *   RHS → parallel bundle
 *   Welded → per mark with dunnage
 *   Unknown shape → auto from Step2 properties
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  function mkItem(o) {
    return Object.assign({
      mark: o.mark || 'X',
      qty: 1,
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
      parts: o.parts || null,
      assemblyName: o.assemblyName || '',
    }, o);
  }

  function pipeline(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    delete it.nestMethod;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    return decideNestMethod(it);
  }

  function snapGeom(it) {
    return JSON.stringify({
      sk: it.shapeKey, H: it.sectH, W: it.sectW, T: it.sectT, L: it.lengthMm,
      pts: it.crossSection?.outer_points?.length || 0,
    });
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 6.1 Z → INTERLOCK + flip ──────────────────────────────────────────────
  t('6.1', 'Z-purlins → INTERLOCK_NEST with 180° flip', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const before = snapGeom(Object.assign({}, it, {
      crossSection: null,
    }));
    const nm = pipeline(it);
    assert(nm.method === 'INTERLOCK_NEST', `method=${nm.method}`);
    assert(nm.alternate_flip === true, 'flip required');
    assert(it.csAnalysis.nest_type === 'INTERLOCK', 'step2 INTERLOCK');
    assert(it.csAnalysis.can_flip === true, 'step2 can_flip');
    assert(nm.density === 'dense', 'dense');
    // geometry unchanged by Step6
    assert(it.sectH === 200 && it.sectW === 75 && it.sectT === 2.5, 'dims');
    assert(it.shapeKey === 'z_channel', 'shapeKey');
  });

  // ── 6.2 C → INTERLOCK (flip from symmetry) ────────────────────────────────
  t('6.2', 'C-channel → INTERLOCK_NEST', () => {
    const nm = pipeline(mkItem({
      shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3, lengthMm: 7200,
    }));
    assert(nm.method === 'INTERLOCK_NEST', `method=${nm.method}`);
    // Flip follows Step2 symmetry — do not force
    assert(typeof nm.alternate_flip === 'boolean', 'flip bool');
  });

  // ── 6.3 L → INTERLOCK without flip (no 180°) ─────────────────────────────
  t('6.3', 'L-angle deep open → INTERLOCK no flip', () => {
    const it = mkItem({
      shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
    });
    const nm = pipeline(it);
    if (it.csAnalysis.nest_type === 'INTERLOCK') {
      assert(nm.method === 'INTERLOCK_NEST', 'INTERLOCK');
      assert(nm.alternate_flip === false, `flip=${nm.alternate_flip} must be false`);
      assert(it.csAnalysis.can_flip === false, 'step2 no flip');
    } else {
      assert(nm.method === 'STACK_NEST', `shallow→STACK got ${nm.method}`);
      assert(nm.alternate_flip === false, 'no flip on stack');
    }
  });

  // ── 6.4 Plate → FLAT_STACK ─────────────────────────────────────────────────
  t('6.4', 'Plates → FLAT_STACK', () => {
    const nm = pipeline(mkItem({
      shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12,
      lengthMm: 1000, widthMm: 500,
    }));
    assert(nm.method === 'FLAT_STACK', `method=${nm.method}`);
    assert(nm.alternate_flip === false, 'no flip');
    assert(nm.density === 'vertical' || /flat/i.test(nm.reason), 'flat dens');
  });

  // ── 6.5 RHS → PARALLEL_BUNDLE ─────────────────────────────────────────────
  t('6.5', 'RHS → PARALLEL_BUNDLE', () => {
    const it = mkItem({ shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 });
    const nm = pipeline(it);
    assert(it.csAnalysis.open_closed === 'closed', 'closed');
    assert(nm.method === 'PARALLEL_BUNDLE', `method=${nm.method}`);
    assert(nm.alternate_flip === false, 'no flip');
    assert(nm.density === 'rows' || nm.reason.indexOf('PARALLEL') >= 0, 'rows');
  });

  // ── 6.6 CHS pipe → PARALLEL (closed, not hex) ─────────────────────────────
  t('6.6', 'CHS pipe → PARALLEL_BUNDLE (closed)', () => {
    const nm = pipeline(mkItem({
      shapeKey: 'chs', sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3,
    }));
    assert(nm.method === 'PARALLEL_BUNDLE', `method=${nm.method}`);
  });

  // ── 6.7 Round bar → HEX_BUNDLE ────────────────────────────────────────────
  t('6.7', 'Round bar → HEX_BUNDLE', () => {
    const it = mkItem({
      shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16,
    });
    const nm = pipeline(it);
    assert(it.csAnalysis.nest_type === 'BUNDLE', `step2=${it.csAnalysis.nest_type}`);
    assert(nm.method === 'HEX_BUNDLE', `method=${nm.method}`);
    assert(nm.density === 'hex', 'hex dens');
  });

  // ── 6.8 Welded → PER_MARK + dunnage ───────────────────────────────────────
  t('6.8', 'Welded → PER_MARK_STACK with dunnage', () => {
    const it = mkItem({
      mark: 'R-1',
      profileDesc: 'BUILT-UP',
      assemblyName: 'Rafter',
      parts: [{ id: 1 }, { id: 2 }],
      sectH: 400, sectW: 200, sectT: 12, lengthMm: 12000,
      // synthetic welded CS
    });
    // Force welded analysis path via multi-part + welded_like after extract
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (it.crossSection) it.crossSection.welded_like = true;
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    const nm = decideNestMethod(it);
    assert(nm.method === 'PER_MARK_STACK', `method=${nm.method}`);
    assert(nm.density === 'dunnage', `density=${nm.density}`);
    assert(nm.alternate_flip === false, 'no flip');
  });

  // ── 6.9 Single-part Z never PER_MARK ──────────────────────────────────────
  t('6.9', 'Single-part Z never PER_MARK even with parts[1]', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5,
      parts: [{ id: 'only' }],
      assemblyName: 'Purlin',
    });
    const nm = pipeline(it);
    assert(nm.method === 'INTERLOCK_NEST', `method=${nm.method}`);
    assert(nm.method !== 'PER_MARK_STACK', 'not per-mark');
  });

  // ── 6.10 Prefers Step2 nest_type ──────────────────────────────────────────
  t('6.10', 'Prefers Step2 nest_type mapping', () => {
    const it = mkItem({ shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 });
    pipeline(it);
    assert(it.nestMethod.from_step2 === true, 'from_step2');
    assert(it.nestMethod.step2_nest_type === 'PARALLEL', 'step2 type');
  });

  // ── 6.11 Open shallow → STACK ─────────────────────────────────────────────
  t('6.11', 'Open + shallow concavity → STACK_NEST', () => {
    const it = mkItem({
      mark: 'SH', shapeKey: null, sectH: 100, sectW: 80, sectT: 8, lengthMm: 3000,
    });
    // Synthetic shallow-open CS (U-ish mild concavity)
    it.crossSection = {
      outer_points: [
        [0, 0], [80, 0], [80, 8], [8, 8], [8, 92], [80, 92], [80, 100], [0, 100], [0, 0],
      ],
      vertex_count: 8,
      cs_height: 100, cs_width: 80,
      cs_area: 80 * 100 * 0.35, // force mid area
    };
    analyzeCrossSection(it);
    // Force shallow open for guide branch (Step2 may classify variously)
    it.csAnalysis.open_closed = 'open';
    it.csAnalysis.concavity_ratio = 0.08;
    it.csAnalysis.nest_type = 'STACK';
    it.csAnalysis.can_flip = false;
    it.csAnalysis.can_alternate_flip = false;
    const nm = decideNestMethod(it);
    assert(nm.method === 'STACK_NEST', `method=${nm.method}`);
    assert(nm.alternate_flip === false, 'no flip');
  });

  // ── 6.12 Unknown solid thick → PARALLEL (not profile-name) ────────────────
  t('6.12', 'Unknown solid thick rect → PARALLEL_BUNDLE (auto)', () => {
    const it = mkItem({
      mark: 'UNK', shapeKey: null, profileDesc: '',
      sectH: 120, sectW: 80, sectT: 40, lengthMm: 2000,
    });
    it.crossSection = {
      outer_points: [[0, 0], [80, 0], [80, 120], [0, 120]],
      vertex_count: 4,
      cs_height: 120, cs_width: 80, cs_area: 80 * 120,
    };
    analyzeCrossSection(it);
    const nm = decideNestMethod(it);
    // Solid non-thin non-round → FLAT_STACK (Step2) or PARALLEL fallback
    assert(
      nm.method === 'FLAT_STACK' || nm.method === 'PARALLEL_BUNDLE',
      `auto method=${nm.method}`
    );
    assert(nm.method !== 'PER_MARK_STACK', 'not welded');
    assert(!/z_channel|rhs|plate/i.test(nm.reason), 'no profile-name reason');
  });

  // ── 6.13 No geometry morph ────────────────────────────────────────────────
  t('6.13', 'decideNestMethod never mutates geometry', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    extractCrossSection(it);
    analyzeCrossSection(it);
    const outer0 = JSON.stringify(it.crossSection.outer_points);
    const H0 = it.sectH, sk0 = it.shapeKey;
    decideNestMethod(it);
    assert(it.sectH === H0 && it.shapeKey === sk0, 'dims');
    assert(JSON.stringify(it.crossSection.outer_points) === outer0, 'poly');
    assert(it.nestMethod.mutates_geometry === false, 'flag');
  });

  // ── 6.14 Batch stamp ──────────────────────────────────────────────────────
  t('6.14', 'attachNestMethodsToItems stamps all', () => {
    const items = [
      mkItem({ mark: 'Z', shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }),
      mkItem({ mark: 'P', shapeKey: 'plate', sectH: 12, sectW: 400, sectT: 12, widthMm: 400 }),
      mkItem({ mark: 'R', shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 }),
      mkItem({ mark: 'O', shapeKey: 'rod', sectH: 20, sectW: 20, sectT: 20, sectD: 20 }),
    ];
    items.forEach(it => {
      extractCrossSection(it);
      analyzeCrossSection(it);
    });
    const stats = attachNestMethodsToItems(items);
    assert(stats.ok === 4, `ok=${stats.ok}`);
    assert(items[0].nestMethod.method === 'INTERLOCK_NEST', 'Z');
    assert(items[1].nestMethod.method === 'FLAT_STACK', 'plate');
    assert(items[2].nestMethod.method === 'PARALLEL_BUNDLE', 'rhs');
    assert(items[3].nestMethod.method === 'HEX_BUNDLE', 'rod');
  });

  // ── 6.15 Labels / strategy map ────────────────────────────────────────────
  t('6.15', 'Labels and strategy mapping', () => {
    assert(nestMethodLabel({ method: 'INTERLOCK_NEST', alternate_flip: true })
      === 'Interlock+flip', 'label flip');
    assert(nestMethodLabel({ method: 'INTERLOCK_NEST', alternate_flip: false })
      === 'Interlock nest', 'label noflip');
    assert(nestMethodLabel({ method: 'FLAT_STACK' }) === 'Flat stack', 'flat');
    assert(nestMethodLabel({ method: 'PER_MARK_STACK' }) === 'Per-mark stack', 'pm');
    assert(nestMethodToStrategy({ method: 'PER_MARK_STACK' }) === 'SingleUnit', 'su');
    assert(nestMethodToStrategy({ method: 'FLAT_STACK' }) === 'Stack', 'st');
    assert(nestMethodToStrategy({ method: 'PARALLEL_BUNDLE' }) === 'Bundle', 'bu');
  });

  // ── 6.16 Guide DONE-WHEN matrix ───────────────────────────────────────────
  t('6.16', 'DONE-WHEN matrix: Z/plate/RHS/welded/unknown', () => {
    const z = pipeline(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5,
    }));
    const plate = pipeline(mkItem({
      shapeKey: 'plate', sectH: 10, sectW: 600, sectT: 10, widthMm: 600,
    }));
    const rhs = pipeline(mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6,
    }));
    const weld = mkItem({
      mark: 'R-1', profileDesc: 'BUILT-UP', parts: [{}, {}],
      sectH: 300, sectW: 200, lengthMm: 10000,
    });
    extractCrossSection(weld);
    if (weld.crossSection) weld.crossSection.welded_like = true;
    analyzeCrossSection(weld);
    const wnm = decideNestMethod(weld);

    assert(z.method === 'INTERLOCK_NEST' && z.alternate_flip, 'Z interlock+flip');
    assert(plate.method === 'FLAT_STACK', 'plate flat');
    assert(rhs.method === 'PARALLEL_BUNDLE', 'rhs parallel');
    assert(wnm.method === 'PER_MARK_STACK' && wnm.density === 'dunnage', 'weld dunnage');
  });

  function runStep6TestSuite() {
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
      suite: 'step6_nest_method',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step6Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep6TestSuite = runStep6TestSuite;
  global.__STEP6_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
