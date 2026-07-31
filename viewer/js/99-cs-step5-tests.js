/* 99-cs-step5-tests.js — STEP 5 Shape Matching (Grouping) suite (app WebView).
 * Call: runStep5TestSuite()
 *
 * Guide:
 *   same CS signature (±5%) → same shape family
 *   sub-group H/W ±2mm, T ±0.15mm
 *   split surface + destination
 *   welded by assembly mark
 *   merge_key = signature + dimensions + surface + destination
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  function polyZ(H, W, T) {
    return [
      [0, 0], [W, 0], [W, T], [T, T], [T, H - T], [W + T, H - T],
      [W + T, H], [T, H], [T, H - T + T], [0, H - T], [0, 0],
    ];
  }
  function polyC(H, W, T) {
    return [
      [0, 0], [W, 0], [W, T], [T, T], [T, H - T], [W, H - T],
      [W, H], [0, H], [0, 0],
    ];
  }
  function polyI(H, W, Tw, Tf) {
    const x0 = (W - Tw) / 2;
    return [
      [0, 0], [W, 0], [W, Tf], [x0 + Tw, Tf], [x0 + Tw, H - Tf],
      [W, H - Tf], [W, H], [0, H], [0, H - Tf], [x0, H - Tf], [x0, Tf], [0, Tf],
    ];
  }

  function mkItem(o) {
    return Object.assign({
      mark: o.mark || 'X',
      qty: o.qty != null ? o.qty : 1,
      profileDesc: o.profileDesc || '',
      shapeKey: o.shapeKey || null,
      profileShape: o.profileShape || o.shapeKey || null,
      sectH: o.sectH || 0,
      sectW: o.sectW || 0,
      sectT: o.sectT || 0,
      lengthMm: o.lengthMm || 6000,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      unitWeightKg: o.unitWeightKg != null ? o.unitWeightKg : 45,
      surfaceTreatment: o.surfaceTreatment,
      destination: o.destination,
      specialHandling: !!o.specialHandling,
      parts: o.parts || null,
      assemblyName: o.assemblyName || '',
    }, o);
  }

  function zItem(mark, opts) {
    opts = opts || {};
    const H = opts.H != null ? opts.H : 200;
    const W = opts.W != null ? opts.W : 75;
    const T = opts.T != null ? opts.T : 2.5;
    const it = mkItem(Object.assign({
      mark,
      profileDesc: opts.profileDesc || `Z${H}x${W}x${T}`,
      shapeKey: 'z_channel',
      sectH: H, sectW: W, sectT: T,
      surfaceTreatment: opts.surfaceTreatment || 'GALV',
      destination: opts.destination || 'BLDG-A',
      lengthMm: opts.lengthMm || 6000,
    }, opts));
    it.crossSection = {
      outer_points: polyZ(H, W, T),
      vertex_count: polyZ(H, W, T).length,
      cs_height: H, cs_width: W, cs_area: (H * T) + 2 * ((W - T) * T),
    };
    return it;
  }

  function cItem(mark, opts) {
    opts = opts || {};
    const H = opts.H != null ? opts.H : 200;
    const W = opts.W != null ? opts.W : 75;
    const T = opts.T != null ? opts.T : 2.5;
    const it = mkItem(Object.assign({
      mark,
      profileDesc: opts.profileDesc || `C${H}x${W}x${T}`,
      shapeKey: 'c_channel',
      sectH: H, sectW: W, sectT: T,
      surfaceTreatment: opts.surfaceTreatment || 'GALV',
      destination: opts.destination || 'BLDG-A',
      lengthMm: opts.lengthMm || 6000,
    }, opts));
    it.crossSection = {
      outer_points: polyC(H, W, T),
      vertex_count: polyC(H, W, T).length,
      cs_height: H, cs_width: W,
    };
    return it;
  }

  function weldedItem(mark, opts) {
    opts = opts || {};
    const it = mkItem(Object.assign({
      mark,
      profileDesc: 'BUILT-UP',
      assemblyName: 'Rafter',
      parts: [{ id: 1 }, { id: 2 }],
      sectH: 300, sectW: 800, sectT: 12,
      lengthMm: 12000,
      unitWeightKg: 800,
      surfaceTreatment: opts.surfaceTreatment || 'PAINT',
      destination: opts.destination || 'BLDG-A',
    }, opts));
    it.crossSection = {
      outer_points: polyI(300, 800, 12, 20),
      vertex_count: 12,
      cs_height: 300, cs_width: 800,
      welded_like: true,
    };
    return it;
  }

  /** Full Step1→2→5 stamp, then group. */
  function runStep5(items) {
    (items || []).forEach(it => {
      // Keep synthetic CS if present; else extract
      if (!it.crossSection && typeof extractCrossSection === 'function')
        extractCrossSection(it);
      if (typeof analyzeCrossSection === 'function')
        analyzeCrossSection(it);
    });
    if (typeof attachCsSignaturesToItems === 'function')
      attachCsSignaturesToItems(items);
    const groups = (typeof groupItemsByCsSignature === 'function')
      ? groupItemsByCsSignature(items)
      : [];
    return groups;
  }

  function marksOf(g) {
    const m = new Set();
    (g.marks || []).forEach(x => m.add(x));
    (g.memberPieces || []).forEach(p => { if (p.mark) m.add(p.mark); });
    return m;
  }
  function findG(groups, mark) {
    return groups.find(g => marksOf(g).has(mark));
  }
  function sameG(groups, marks) {
    const g0 = findG(groups, marks[0]);
    return !!(g0 && marks.every(m => marksOf(g0).has(m)));
  }
  function diffG(groups, a, b) {
    const ga = findG(groups, a), gb = findG(groups, b);
    return !!(ga && gb && ga !== gb);
  }
  function snapGeom(it) {
    return JSON.stringify({
      sk: it.shapeKey,
      H: it.sectH, W: it.sectW, T: it.sectT,
      L: it.lengthMm,
      pts: it.crossSection && it.crossSection.outer_points
        ? it.crossSection.outer_points.length : 0,
    });
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 5.1 Same signature → same group ───────────────────────────────────────
  t('5.1', 'Same CS signature → one group', () => {
    const items = [zItem('A'), zItem('B'), zItem('C')];
    const before = items.map(snapGeom);
    const groups = runStep5(items);
    assert(groups.length === 1, `groups=${groups.length}`);
    assert(sameG(groups, ['A', 'B', 'C']), 'marks together');
    items.forEach((it, i) => assert(snapGeom(it) === before[i], `geom morph ${it.mark}`));
  });

  // ── 5.2 Signature ±5% still matches ───────────────────────────────────────
  t('5.2', 'Signature values within ±5% still match', () => {
    const a = zItem('A');
    const b = zItem('B');
    runStep5([a]); // analyze a
    // Perturb Step2 signature fields by ~3% (within guide tol)
    const s = a.csAnalysis.signature;
    b.crossSection = JSON.parse(JSON.stringify(a.crossSection));
    b.csAnalysis = JSON.parse(JSON.stringify(a.csAnalysis));
    b.csAnalysis.signature = Object.assign({}, s, {
      area_ratio: s.area_ratio * 1.03,
      perimeter_ratio: s.perimeter_ratio * 0.98,
      concavity_ratio: s.concavity_ratio * 1.02,
    });
    b.csAnalysis.signature_hash = 'force-rehash';
    delete b.csSignature;
    attachCsSignaturesToItems([a, b]);
    assert(csSignaturesMatchForGroup(a.csSignature, b.csSignature), '±5% match');
    assert(a.csSignature.hash === b.csSignature.hash, 'same group hash');
    const groups = groupItemsByCsSignature([a, b]);
    assert(groups.length === 1, `groups=${groups.length}`);
  });

  // ── 5.3 Signature outside ±5% → different ─────────────────────────────────
  t('5.3', 'Signature outside ±5% → different groups', () => {
    const a = zItem('A');
    const b = zItem('B');
    runStep5([a]);
    b.crossSection = JSON.parse(JSON.stringify(a.crossSection));
    b.csAnalysis = JSON.parse(JSON.stringify(a.csAnalysis));
    b.csAnalysis.signature = Object.assign({}, a.csAnalysis.signature, {
      concavity_ratio: (a.csAnalysis.signature.concavity_ratio || 0.3) + 0.12,
      area_ratio: Math.max(0.05, (a.csAnalysis.signature.area_ratio || 0.4) - 0.12),
    });
    delete b.csSignature;
    attachCsSignaturesToItems([a, b]);
    assert(!csSignaturesMatchForGroup(a.csSignature, b.csSignature), 'must not match');
    const groups = groupItemsByCsSignature([a, b]);
    assert(groups.length === 2 && diffG(groups, 'A', 'B'), 'split');
  });

  // ── 5.4 Dim sub-group H/W ±2mm ─────────────────────────────────────────────
  t('5.4', 'H/W within ±2mm → same; beyond → split', () => {
    const ok = runStep5([
      zItem('A', { H: 200.0, W: 75.0, T: 2.5 }),
      zItem('B', { H: 201.5, W: 74.2, T: 2.5 }),
    ]);
    assert(ok.length === 1 && sameG(ok, ['A', 'B']), 'within tol');

    const bad = runStep5([
      zItem('C', { H: 200.0, W: 75.0, T: 2.5 }),
      zItem('D', { H: 205.0, W: 75.0, T: 2.5 }), // +5mm > ±2
    ]);
    assert(bad.length === 2 && diffG(bad, 'C', 'D'), 'H out of tol');
  });

  // ── 5.5 T ±0.15mm ─────────────────────────────────────────────────────────
  t('5.5', 'T within ±0.15mm → same; beyond → split', () => {
    const ok = runStep5([
      zItem('A', { T: 2.50 }),
      zItem('B', { T: 2.60 }),
    ]);
    assert(ok.length === 1, 'T within');

    const bad = runStep5([
      zItem('C', { T: 2.50 }),
      zItem('D', { T: 2.80 }), // +0.30 > ±0.15
    ]);
    assert(bad.length === 2 && diffG(bad, 'C', 'D'), 'T out');
  });

  // ── 5.6 Surface treatment split ───────────────────────────────────────────
  t('5.6', 'GALV ≠ PAINT ≠ BARE', () => {
    const groups = runStep5([
      zItem('G', { surfaceTreatment: 'GALV' }),
      zItem('P', { surfaceTreatment: 'PAINT' }),
      zItem('B', { surfaceTreatment: 'BARE' }),
    ]);
    assert(groups.length === 3, `groups=${groups.length}`);
    assert(diffG(groups, 'G', 'P') && diffG(groups, 'P', 'B') && diffG(groups, 'G', 'B'), 'surf');
  });

  // ── 5.7 Destination split ─────────────────────────────────────────────────
  t('5.7', 'BLDG-A ≠ BLDG-B', () => {
    const groups = runStep5([
      zItem('A', { destination: 'BLDG-A' }),
      zItem('B', { destination: 'BLDG-B' }),
    ]);
    assert(groups.length === 2 && diffG(groups, 'A', 'B'), 'dest');
  });

  // ── 5.8 Welded by mark only ───────────────────────────────────────────────
  t('5.8', 'Welded R-1 ≠ Welded R-2', () => {
    const groups = runStep5([weldedItem('R-1'), weldedItem('R-2')]);
    assert(groups.length === 2 && diffG(groups, 'R-1', 'R-2'), 'marks');
    assert(findG(groups, 'R-1').groupKind === 'welded_assembly', 'kind');
    assert(csgMergeKey(weldedItem('R-1')).startsWith('welded|R-1|'), 'key mark');
  });

  // ── 5.9 Same welded mark groups ───────────────────────────────────────────
  t('5.9', 'Same welded mark → one group', () => {
    const groups = runStep5([
      weldedItem('R-1'), weldedItem('R-1'), weldedItem('R-1'),
    ]);
    assert(groups.length === 1, `g=${groups.length}`);
    assert((groups[0].memberPieces || []).length === 3
      || groups[0].qty === 3, '3 pcs');
  });

  // ── 5.10 merge_key structure ──────────────────────────────────────────────
  t('5.10', 'merge_key = signature|dims|surface|destination…', () => {
    const it = zItem('A', { surfaceTreatment: 'GALV', destination: 'BLDG-A' });
    runStep5([it]);
    const key = csgMergeKey(it);
    assert(it.csSignature && it.csSignature.hash, 'sig hash');
    assert(key.indexOf(it.csSignature.hash) === 0, `sig first: ${key}`);
    assert(/GALV|GALVANIZED/i.test(key), `surf in key: ${key}`);
    assert(/BLDG-A/i.test(key), `dest in key: ${key}`);
    // dims bin present (numbers)
    assert(/\d/.test(key), 'dims digits');
    assert(it.csSignature.source === 'step2', `source=${it.csSignature.source}`);
  });

  // ── 5.11 C ≠ Z even same dims ─────────────────────────────────────────────
  t('5.11', 'C-channel ≠ Z-purlin (same H×W×T)', () => {
    const groups = runStep5([
      zItem('Z1', { H: 200, W: 75, T: 2.5 }),
      cItem('C1', { H: 200, W: 75, T: 2.5 }),
    ]);
    assert(groups.length === 2 && diffG(groups, 'Z1', 'C1'), 'C≠Z');
    assert(!csSignaturesMatchForGroup(
      findG(groups, 'Z1').csSignature || findG(groups, 'Z1').memberPieces[0].csSignature,
      findG(groups, 'C1').csSignature || findG(groups, 'C1').memberPieces[0].csSignature
    ) || findG(groups, 'Z1').mergeKey !== findG(groups, 'C1').mergeKey, 'keys differ');
  });

  // ── 5.12 Prefer Step2 signature ───────────────────────────────────────────
  t('5.12', 'computeCsSignature prefers Step2 signature fields', () => {
    const it = zItem('A');
    analyzeCrossSection(it);
    assert(it.csAnalysis && it.csAnalysis.signature, 'step2 sig');
    const sig = computeCsSignature(it);
    assert(sig.source === 'step2', `source=${sig.source}`);
    assert(sig.step2_hash === it.csAnalysis.signature_hash, 'keeps step2 hash');
    assert(Math.abs(sig.concavity_ratio - it.csAnalysis.signature.concavity_ratio) < 1e-9, 'conc');
    assert(Math.abs(sig.aspect_ratio - it.csAnalysis.signature.aspect_ratio) < 1e-9, 'asp');
  });

  // ── 5.13 Combined guide matrix ────────────────────────────────────────────
  t('5.13', 'Guide matrix: shape×dims×surf×dest', () => {
    const items = [
      zItem('Z-G-A', { surfaceTreatment: 'GALV', destination: 'BLDG-A' }),
      zItem('Z-G-A2', { surfaceTreatment: 'GALV', destination: 'BLDG-A' }),
      zItem('Z-P-A', { surfaceTreatment: 'PAINT', destination: 'BLDG-A' }),
      zItem('Z-G-B', { surfaceTreatment: 'GALV', destination: 'BLDG-B' }),
      zItem('Z-big', { H: 250, W: 75, T: 2.5, surfaceTreatment: 'GALV', destination: 'BLDG-A' }),
      cItem('C-G-A', { surfaceTreatment: 'GALV', destination: 'BLDG-A' }),
      weldedItem('R-1'),
      weldedItem('R-2'),
    ];
    const groups = runStep5(items);
    assert(sameG(groups, ['Z-G-A', 'Z-G-A2']), 'identical Z merge');
    assert(diffG(groups, 'Z-G-A', 'Z-P-A'), 'surf');
    assert(diffG(groups, 'Z-G-A', 'Z-G-B'), 'dest');
    assert(diffG(groups, 'Z-G-A', 'Z-big'), 'dims');
    assert(diffG(groups, 'Z-G-A', 'C-G-A'), 'shape');
    assert(diffG(groups, 'R-1', 'R-2'), 'weld marks');
    assert(groups.length === 7, `expect 7 got ${groups.length}`);
  });

  // ── 5.14 No shape morph ───────────────────────────────────────────────────
  t('5.14', 'Grouping never mutates sect dims / outer_points', () => {
    const it = zItem('A');
    const outer0 = JSON.stringify(it.crossSection.outer_points);
    const H0 = it.sectH, W0 = it.sectW, T0 = it.sectT, L0 = it.lengthMm, sk0 = it.shapeKey;
    runStep5([it, zItem('B')]);
    assert(it.sectH === H0 && it.sectW === W0 && it.sectT === T0, 'sect');
    assert(it.lengthMm === L0 && it.shapeKey === sk0, 'meta');
    assert(JSON.stringify(it.crossSection.outer_points) === outer0, 'poly');
  });

  // ── 5.15 Single-part Z never welded path ──────────────────────────────────
  t('5.15', 'Single-part Z is not welded grouping', () => {
    const a = zItem('P1');
    a.parts = [{ id: 'only' }];
    a.assemblyName = 'Purlin';
    const b = zItem('P2');
    const groups = runStep5([a, b]);
    assert(sameG(groups, ['P1', 'P2']), 'merge with Z');
    assert(!csgIsWeldedOrTapered(a), 'not welded');
    assert(findG(groups, 'P1').groupKind === 'nest_z', `kind=${findG(groups, 'P1').groupKind}`);
  });

  // ── 5.16 Audit coverage ───────────────────────────────────────────────────
  t('5.16', 'All pieces covered by groups (audit)', () => {
    const items = [
      zItem('A'), zItem('B'), cItem('C'),
      weldedItem('R-1'), weldedItem('R-2'),
    ];
    items[0].qty = 3;
    const groups = runStep5(items);
    const audit = auditGroupingCoverage(items, groups);
    assert(audit.ok, `audit ${JSON.stringify(audit)}`);
    assert(audit.inPcs === audit.outPcs, 'pcs');
  });

  function runStep5TestSuite() {
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
      suite: 'step5_shape_matching',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step5Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep5TestSuite = runStep5TestSuite;
  global.__STEP5_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
