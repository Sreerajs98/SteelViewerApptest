/* 99-cs-step2-tests.js — STEP 2 Cross-Section Analysis suite (app WebView).
 * Call: runStep2TestSuite()
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

  function analyze(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    return analyzeCrossSection(it);
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 2.1 Z-Purlin ──────────────────────────────────────────────────────────
  t('2.1', 'Z-Purlin analysis', () => {
    const a = analyze(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    assert(a.profile_type === 'OPEN' && a.open_closed === 'open', `type=${a.profile_type}`);
    assert(a.concavity_ratio > 0.8, `conc=${a.concavity_ratio}`);
    assert(a.has_180_symmetry && a.can_flip, `sym=${a.symmetry_score}`);
    assert(a.can_nest && a.nest_type === 'INTERLOCK', `nest=${a.nest_type}`);
    assert(a.signature.vertex_count === 8, 'verts');
    assert(a.signature.area_ratio < 0.15, `ar=${a.signature.area_ratio}`);
    assert(a.signature.aspect_ratio > 1.2, `asp=${a.signature.aspect_ratio}`);
    assert(a.signature_hash, 'hash');
  });

  // ── 2.2 C-Channel ─────────────────────────────────────────────────────────
  t('2.2', 'C-Channel analysis', () => {
    const a = analyze(mkItem({
      shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3, lengthMm: 7200,
    }));
    assert(a.profile_type === 'OPEN', 'OPEN');
    assert(a.concavity_ratio > 0.7, `conc=${a.concavity_ratio}`);
    assert(a.nest_type === 'INTERLOCK', `nest=${a.nest_type}`);
    assert(a.signature.vertex_count === 8, '8 verts');
    const z = analyze(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5,
    }));
    assert(a.signature_hash !== z.signature_hash, 'C hash ≠ Z hash');
  });

  // ── 2.3 L-Angle ───────────────────────────────────────────────────────────
  t('2.3', 'L-Angle — no 180° flip', () => {
    const a = analyze(mkItem({
      shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
    }));
    assert(a.profile_type === 'OPEN', 'OPEN');
    assert(a.signature.vertex_count === 6, `v=${a.signature.vertex_count}`);
    assert(!a.has_180_symmetry, `sym=${a.symmetry_score} must be low`);
    assert(a.can_flip === false, 'can_flip false');
    assert(a.nest_type === 'INTERLOCK' || a.nest_type === 'STACK', `nest=${a.nest_type}`);
    assert(a.symmetry_score < 0.85, `score=${a.symmetry_score}`);
  });

  // ── 2.4 I-Beam ────────────────────────────────────────────────────────────
  t('2.4', 'I-Beam analysis', () => {
    const a = analyze(mkItem({
      shapeKey: 'i_beam', sectH: 400, sectW: 200, sectT: 12, sectTw: 12, sectTf: 20,
    }));
    assert(a.profile_type === 'OPEN', 'OPEN');
    assert(a.signature.vertex_count === 12, `v=${a.signature.vertex_count}`);
    assert(a.has_180_symmetry, `sym=${a.symmetry_score}`);
    assert(a.nest_type === 'INTERLOCK', `nest=${a.nest_type}`);
  });

  // ── 2.5 Flat Plate ────────────────────────────────────────────────────────
  t('2.5', 'Flat plate → SOLID FLAT_STACK', () => {
    const a = analyze(mkItem({
      shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500,
    }));
    assert(a.profile_type === 'SOLID', `type=${a.profile_type}`);
    assert(a.concavity_ratio < 0.05, `conc=${a.concavity_ratio}`);
    assert(a.nest_type === 'FLAT_STACK', `nest=${a.nest_type}`);
    assert(a.signature.vertex_count === 4, '4');
    assert(a.signature.area_ratio > 0.9, `ar=${a.signature.area_ratio}`);
  });

  // ── 2.6 RHS ───────────────────────────────────────────────────────────────
  t('2.6', 'RHS → CLOSED PARALLEL', () => {
    const a = analyze(mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6,
    }));
    assert(a.profile_type === 'CLOSED', `type=${a.profile_type}`);
    assert(a.has_inner_void, 'inner');
    assert(a.nest_type === 'PARALLEL' && !a.can_nest, `nest=${a.nest_type}`);
  });

  // ── 2.7 CHS ───────────────────────────────────────────────────────────────
  t('2.7', 'CHS pipe → CLOSED', () => {
    const a = analyze(mkItem({
      shapeKey: 'chs', sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3,
    }));
    assert(a.profile_type === 'CLOSED', `type=${a.profile_type}`);
    assert(a.nest_type === 'PARALLEL', 'PARALLEL');
    assert(approx(a.signature.aspect_ratio, 1, 0.15), `asp=${a.signature.aspect_ratio}`);
    // Thin-wall CHS: steel/bbox ≈ π/4×(1−(ri/ro)²) ≈ 0.10 for t=6 on Ø168
    assert(a.signature.area_ratio > 0.05 && a.signature.area_ratio < 0.5, `ar=${a.area_ratio}`);
    assert(a.has_inner_void, 'hole');
  });

  // ── 2.8 Round bar SOLID BUNDLE ────────────────────────────────────────────
  t('2.8', 'Round bar → SOLID BUNDLE', () => {
    const a = analyze(mkItem({
      shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16,
    }));
    assert(a.profile_type === 'SOLID', `type=${a.profile_type}`);
    assert(!a.has_inner_void, 'no hole');
    assert(a.nest_type === 'BUNDLE', `nest=${a.nest_type}`);
    assert(approx(a.signature.area_ratio, Math.PI / 4, 0.08), `ar=${a.area_ratio}`);
  });

  // ── 2.9 Same Z match ──────────────────────────────────────────────────────
  t('2.9', 'Same Z signatures match', () => {
    const a = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000 }));
    const b = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 7200 }));
    assert(signaturesMatch(a.signature, b.signature), 'match');
    assert(a.signature_hash === b.signature_hash, 'hash');
  });

  // ── 2.10 Z vs C different ─────────────────────────────────────────────────
  t('2.10', 'Z vs C same dims → signatures differ', () => {
    const z = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }));
    const c = analyze(mkItem({ shapeKey: 'c_channel', sectH: 200, sectW: 75, sectT: 2.5 }));
    assert(!signaturesMatch(z.signature, c.signature)
      || z.signature_hash !== c.signature_hash, 'must differ');
    // Stronger: hashes must differ (overall width/perimeter differ)
    assert(z.signature_hash !== c.signature_hash, `${z.signature_hash} vs ${c.signature_hash}`);
  });

  // ── 2.11 Z200 vs Z250 both OPEN INTERLOCK ─────────────────────────────────
  t('2.11', 'Z200 vs Z250 both OPEN INTERLOCK', () => {
    const a = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }));
    const b = analyze(mkItem({ shapeKey: 'z_channel', sectH: 250, sectW: 100, sectT: 3 }));
    assert(a.profile_type === 'OPEN' && b.profile_type === 'OPEN', 'OPEN');
    assert(a.nest_type === 'INTERLOCK' && b.nest_type === 'INTERLOCK', 'INTERLOCK');
  });

  // ── 2.12 Plates same type ─────────────────────────────────────────────────
  t('2.12', 'Plates SOLID FLAT_STACK', () => {
    const a = analyze(mkItem({ shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, widthMm: 500 }));
    const b = analyze(mkItem({ shapeKey: 'plate', sectH: 16, sectW: 500, sectT: 16, widthMm: 500 }));
    assert(a.profile_type === 'SOLID' && b.profile_type === 'SOLID', 'SOLID');
    assert(a.nest_type === 'FLAT_STACK' && b.nest_type === 'FLAT_STACK', 'STACK');
    assert(signaturesMatch(a.signature, b.signature)
      || (a.signature.vertex_count === 4 && b.signature.vertex_count === 4), 'rect-like');
  });

  // ── 2.13 Convex hull ──────────────────────────────────────────────────────
  t('2.13', 'Z convex hull + high concavity', () => {
    const it = mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 });
    extractCrossSection(it);
    const a = analyzeCrossSection(it);
    // Hull of Z verts is not full AABB (empty corner cut) — still >> steel area
    assert(a.hull_area > a.net_area * 5, `hull=${a.hull_area} steel=${a.net_area}`);
    assert(a.concavity_ratio > 0.8, `conc=${a.concavity_ratio}`);
    assert(a.concavity_area > 0, 'concavity area');
  });

  // ── 2.14 Symmetry Z yes L no ──────────────────────────────────────────────
  t('2.14', 'Symmetry Z yes / L no', () => {
    const z = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }));
    const l = analyze(mkItem({ shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10 }));
    assert(z.symmetry_score > 0.85, `Z=${z.symmetry_score}`);
    assert(l.symmetry_score < 0.85, `L=${l.symmetry_score}`);
    assert(z.symmetry_score - l.symmetry_score > 0.2, 'gap');
  });

  // ── 2.15 Welded skip ──────────────────────────────────────────────────────
  t('2.15', 'Welded → PER_MARK', () => {
    const a = analyze(mkItem({
      mark: 'R-1', profileDesc: 'BUILT-UP',
      lengthMm: 12000, widthMm: 300, heightMm: 800,
      parts: [{}, {}],
    }));
    assert(a.profile_type === 'WELDED', `type=${a.profile_type}`);
    assert(a.nest_type === 'PER_MARK', `nest=${a.nest_type}`);
    assert(!a.can_nest, 'no nest');
  });

  // ── 2.16 All hashes unique ────────────────────────────────────────────────
  t('2.16', 'Signature hashes unique across standards', () => {
    const specs = [
      { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 },
      { shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3 },
      { shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10 },
      { shapeKey: 'i_beam', sectH: 400, sectW: 200, sectTw: 12, sectTf: 20, sectT: 12 },
      { shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, widthMm: 500 },
      { shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 },
      { shapeKey: 'chs', sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3 },
      { shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16 },
    ];
    const hashes = specs.map(s => analyze(mkItem(s)).signature_hash);
    const uniq = new Set(hashes);
    assert(uniq.size === hashes.length, `dupes: ${hashes.join(' ; ')}`);
  });

  // ── 2.17 Thin plate override ──────────────────────────────────────────────
  t('2.17', 'Thin plate override → SOLID', () => {
    const a = analyze(mkItem({
      shapeKey: 'plate', sectH: 2, sectW: 300, sectT: 2, widthMm: 300, heightMm: 2,
    }));
    assert(a.profile_type === 'SOLID', `type=${a.profile_type}`);
    assert(a.nest_type === 'FLAT_STACK', `nest=${a.nest_type}`);
  });

  // ── 2.18 Step1→Step2 pipeline ─────────────────────────────────────────────
  t('2.18', 'Step1+Step2 pipeline complete fields', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const cs = extractCrossSection(it);
    const a = analyzeCrossSection(it);
    assert(cs && cs.verified, 'step1');
    assert(a && a.profile_type && a.nest_type && a.signature && a.signature_hash, 'step2');
    assert(a.cs_width > 0 && a.cs_height > 0, 'dims');
    assert(a.can_flip === true, 'flip');
    assert(a.concavity_ratio > 0.8, 'conc');
  });

  // Extra stress
  t('2.19', 'Batch 100 mixed profiles all analyze', () => {
    const kinds = [
      () => ({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }),
      () => ({ shapeKey: 'c_channel', sectH: 200, sectW: 80, sectT: 2.5 }),
      () => ({ shapeKey: 'plate', sectH: 10, sectW: 400, sectT: 10, widthMm: 400 }),
      () => ({ shapeKey: 'rod', sectH: 12, sectW: 12, sectT: 12 }),
      () => ({ shapeKey: 'rhs', sectH: 80, sectW: 80, sectT: 5 }),
    ];
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const a = analyze(mkItem(Object.assign({ mark: 'M' + i, lengthMm: 3000 + i }, kinds[i % kinds.length]())));
      if (a && a.profile_type && a.nest_type && a.signature_hash) ok++;
    }
    assert(ok === 100, `ok=${ok}`);
  });

  t('2.20', 'max_concavity_depth meaningful for Z', () => {
    const a = analyze(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 }));
    // Slide-in depth ≈ flange width scale (guide ~72mm for Z200×75)
    assert(a.max_concavity_depth > 35, `depth=${a.max_concavity_depth}`);
    assert(a.concavity_ratio > 0.8, 'deep concavity');
  });

  function runStep2TestSuite() {
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
      suite: 'step2_cs_analysis',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step2Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep2TestSuite = runStep2TestSuite;
  global.__STEP2_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
