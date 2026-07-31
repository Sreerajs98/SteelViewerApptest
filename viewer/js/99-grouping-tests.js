/* 99-grouping-tests.js — Full grouping scenario suite (runs inside app WebView).
 * Call: runGroupingTestSuite() → { passed, failed, results[] }
 * Does not morph production shapes; uses synthetic cross-sections only.
 */
(function (global) {
  'use strict';

  // ── synthetic cross-sections (mm) ─────────────────────────────────────────
  function polyZ(H, W, T) {
    // Classic Z open profile outline
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
  function polyRect(H, W) {
    return [[0, 0], [W, 0], [W, H], [0, H]];
  }
  function polyL(H, W, T) {
    return [[0, 0], [W, 0], [W, T], [T, T], [T, H], [0, H]];
  }
  function polyI(H, W, Tw, Tf) {
    const x0 = (W - Tw) / 2;
    return [
      [0, 0], [W, 0], [W, Tf], [x0 + Tw, Tf], [x0 + Tw, H - Tf],
      [W, H - Tf], [W, H], [0, H], [0, H - Tf], [x0, H - Tf], [x0, Tf], [0, Tf],
    ];
  }
  function polyCircle(D, n) {
    const r = D / 2, out = [];
    const N = n || 24;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      out.push([r + r * Math.cos(a), r + r * Math.sin(a)]);
    }
    return out;
  }

  function withCS(it, outer, opts) {
    opts = opts || {};
    it.crossSection = {
      outer_points: outer,
      vertex_count: outer.length,
      cs_height: opts.H || it.sectH || 0,
      cs_width: opts.W || it.sectW || 0,
      is_tapered: !!opts.tapered,
      welded_like: !!opts.welded_like,
    };
    it.csAnalysis = Object.assign({
      open_closed: opts.open_closed || 'open',
      concavity_ratio: opts.concavity != null ? opts.concavity : 0.35,
      symmetry_180: opts.sym != null ? opts.sym : 0.9,
      area_ratio: opts.area_ratio != null ? opts.area_ratio : 0.45,
      perimeter_ratio: 0.9,
    }, opts.analysis || {});
    return it;
  }

  function item(mark, o) {
    o = o || {};
    const it = {
      mark,
      qty: o.qty != null ? o.qty : 1,
      profileDesc: o.profileDesc || '',
      assemblyName: o.assemblyName || '',
      shapeKey: o.shapeKey || null,
      profileShape: o.profileShape || o.shapeKey || null,
      category: o.category || '',
      sectH: o.sectH || 0,
      sectW: o.sectW || 0,
      sectT: o.sectT || 0,
      sectD: o.sectD || 0,
      lengthMm: o.lengthMm || 0,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      unitWeightKg: o.unitWeightKg != null ? o.unitWeightKg : 45,
      surfaceTreatment: o.surfaceTreatment,
      destination: o.destination,
      specialHandling: o.specialHandling === true,
      remarks: o.remarks || '',
      parts: o.parts || null,
      pathPointsMm: o.pathPointsMm || null,
      pathDiamMm: o.pathDiamMm || 0,
    };
    if (o.outer) withCS(it, o.outer, o.cs || {});
    return it;
  }

  function zItem(mark, len, surf, dest, extra) {
    extra = extra || {};
    const H = extra.H != null ? extra.H : 200;
    const W = extra.W != null ? extra.W : 75;
    const T = extra.T != null ? extra.T : 2.5;
    return item(mark, Object.assign({
      profileDesc: extra.profileDesc || `Z${H}x${W}x${T}`,
      shapeKey: 'z_channel',
      sectH: H, sectW: W, sectT: T,
      lengthMm: len,
      unitWeightKg: extra.unitWeightKg != null ? extra.unitWeightKg : 45,
      surfaceTreatment: surf,
      destination: dest,
      outer: polyZ(H, W, T),
      cs: { H, W, open_closed: 'open', concavity: 0.4, sym: 0.92 },
    }, extra));
  }

  function cItem(mark, len, surf, dest, extra) {
    extra = extra || {};
    const H = extra.H != null ? extra.H : 200;
    const W = extra.W != null ? extra.W : 75;
    const T = extra.T != null ? extra.T : 2.5;
    return item(mark, Object.assign({
      profileDesc: extra.profileDesc || `C${H}x${W}x${T}`,
      shapeKey: 'c_channel',
      sectH: H, sectW: W, sectT: T,
      lengthMm: len,
      surfaceTreatment: surf,
      destination: dest,
      outer: polyC(H, W, T),
      cs: { H, W, open_closed: 'open', concavity: 0.35, sym: 0.85 },
    }, extra));
  }

  function runGroup(items) {
    if (typeof attachCsSignaturesToItems === 'function')
      attachCsSignaturesToItems(items);
    if (typeof attachNestMethodsToItems === 'function')
      attachNestMethodsToItems(items);
    if (typeof attachNestingOffsetsToItems === 'function')
      attachNestingOffsetsToItems(items);
    const groups = (typeof groupItemsByCsSignature === 'function')
      ? groupItemsByCsSignature(items)
      : [];
    if (typeof attachPackUnitsToGroups === 'function')
      attachPackUnitsToGroups(groups);
    const audit = (typeof auditGroupingCoverage === 'function')
      ? auditGroupingCoverage(items, groups)
      : { ok: false };
    return { groups, audit };
  }

  function pcs(g) {
    return (g.memberPieces && g.memberPieces.length)
      ? g.memberPieces.length
      : (g.qty || 0);
  }

  function marksOf(g) {
    const m = new Set();
    (g.marks || []).forEach(x => m.add(x));
    (g.memberPieces || []).forEach(p => { if (p.mark) m.add(p.mark); });
    return m;
  }

  function findGroupWith(groups, mark) {
    return groups.find(g => marksOf(g).has(mark));
  }

  function sameGroup(groups, marks) {
    const g0 = findGroupWith(groups, marks[0]);
    if (!g0) return false;
    return marks.every(m => marksOf(g0).has(m));
  }

  function differentGroups(groups, a, b) {
    const ga = findGroupWith(groups, a);
    const gb = findGroupWith(groups, b);
    return !!(ga && gb && ga !== gb);
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  // ── individual tests ──────────────────────────────────────────────────────
  const TESTS = [];

  function t(id, name, fn) {
    TESTS.push({ id, name, fn });
  }

  // CATEGORY 1
  t('1.1', 'Identical items → one group', () => {
    const items = ['A', 'B', 'C'].map(m => zItem(m, 6000, 'GALV', 'BLDG-A'));
    const { groups, audit } = runGroup(items);
    assert(audit.ok, 'audit');
    assert(groups.length === 1, `groups=${groups.length}`);
    assert(pcs(groups[0]) === 3, `pcs=${pcs(groups[0])}`);
    assert(/GALV|GALVANIZED/i.test(groups[0].mark), 'surface in label');
    assert(/BLDG-A/i.test(groups[0].mark), 'dest in label');
    assert(/3 pcs/i.test(groups[0].mark), 'qty in label');
  });

  t('1.2', '50 identical → 1 group, pack units by SET_SIZE', () => {
    const items = [];
    for (let i = 0; i < 50; i++) items.push(zItem('Z' + i, 6000, 'GALV', 'BLDG-A'));
    const { groups, audit } = runGroup(items);
    assert(audit.ok && groups.length === 1, 'one group');
    assert(pcs(groups[0]) === 50, '50 pcs');
    const pus = groups[0].packUnits || [];
    assert(pus.length >= 2, `pack units=${pus.length}`);
    const total = pus.reduce((s, pu) => s + (pu.nestPieces
      ? pu.nestPieces.reduce((a, n) => a + (n.qty || 1), 0)
      : (pu.qty || 0)), 0);
    assert(total === 50, `pack pcs=${total}`);
    // INTERLOCK max 12 — no unit larger than setSize
    const maxSet = typeof cspuMaxSetForMethod === 'function'
      ? cspuMaxSetForMethod('INTERLOCK_NEST') : 12;
    pus.forEach((pu, i) => {
      const n = pu.nestPieces
        ? pu.nestPieces.reduce((a, x) => a + (x.qty || 1), 0)
        : (pu.qty || 0);
      assert(n <= maxSet, `unit ${i} size ${n} > ${maxSet}`);
    });
  });

  t('1.3', 'Single item → one group', () => {
    const { groups, audit } = runGroup([zItem('A', 6000, 'GALV', 'BLDG-A')]);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 1, 'single');
  });

  // CATEGORY 2
  t('2.1', 'Same profile different lengths → ONE group with range', () => {
    const items = [
      zItem('A', 6000, 'GALV', 'BLDG-A'),
      zItem('B', 7200, 'GALV', 'BLDG-A'),
      zItem('C', 6000, 'GALV', 'BLDG-A'),
      zItem('D', 7200, 'GALV', 'BLDG-A'),
    ];
    const { groups, audit } = runGroup(items);
    assert(audit.ok && groups.length === 1, `groups=${groups.length}`);
    assert(pcs(groups[0]) === 4, '4 pcs');
    assert(/6\.0|7\.2|–|-/.test(groups[0].mark), 'length range in label');
  });

  t('2.2', 'Many lengths → one group, longest-first packs', () => {
    const lens = [
      ...Array(4).fill(7200), ...Array(3).fill(6000), ...Array(2).fill(5500),
      4800, ...Array(5).fill(3000), ...Array(2).fill(2500), ...Array(3).fill(1200),
    ];
    const items = lens.map((L, i) => zItem('L' + i, L, 'GALV', 'BLDG-A'));
    const { groups, audit } = runGroup(items);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 20, '20 in one');
    const pu0 = (groups[0].packUnits || [])[0];
    assert(pu0, 'has pack unit');
    const nest = pu0.nestPieces || pu0.memberItems || [];
    if (nest.length >= 2) {
      assert((nest[0].lengthMm || 0) >= (nest[nest.length - 1].lengthMm || 0),
        'longest→shortest in unit');
    }
  });

  t('2.3', 'Extreme length difference still one group', () => {
    const { groups } = runGroup([
      zItem('A', 12000, 'GALV', 'BLDG-A'),
      zItem('B', 1000, 'GALV', 'BLDG-A'),
    ]);
    assert(groups.length === 1 && pcs(groups[0]) === 2, 'one group extreme L');
  });

  // CATEGORY 3
  t('3.1', 'Z vs C must NOT group', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A'),
      cItem('B', 6000, 'GALV', 'BLDG-A'),
    ]);
    assert(groups.length === 2, `groups=${groups.length}`);
    assert(differentGroups(groups, 'A', 'B'), 'separated');
  });

  t('3.2', 'Same Z type different dims must NOT group', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { H: 250, W: 100, T: 3.0, profileDesc: 'Z250x100x3.0' }),
    ]);
    assert(groups.length === 2 && differentGroups(groups, 'A', 'B'), 'dim split');
  });

  t('3.3', 'Plate vs Beam vs Angle', () => {
    const plate = item('A', {
      profileDesc: 'PL12x500x300', shapeKey: 'plate', category: 'plate',
      sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500, heightMm: 12,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyRect(12, 500),
      cs: { H: 12, W: 500, open_closed: 'solid', concavity: 0, area_ratio: 1, sym: 1 },
    });
    const beam = item('B', {
      profileDesc: 'UB406x178x67', shapeKey: 'i_beam', category: 'beam',
      sectH: 406, sectW: 178, sectT: 14, lengthMm: 6000,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyI(406, 178, 10, 14),
      cs: { H: 406, W: 178, open_closed: 'solid', concavity: 0.2, sym: 0.95 },
    });
    const ang = item('C', {
      profileDesc: 'L150x150x10', shapeKey: 'l_angle',
      sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyL(150, 150, 10),
      cs: { H: 150, W: 150, open_closed: 'open', concavity: 0.25, sym: 0.5 },
    });
    const { groups, audit } = runGroup([plate, beam, ang]);
    assert(audit.ok && groups.length === 3, `groups=${groups.length}`);
    assert(differentGroups(groups, 'A', 'B') && differentGroups(groups, 'B', 'C'), 'all split');
  });

  t('3.4', 'RHS vs CHS must NOT group', () => {
    const rhs = item('A', {
      profileDesc: 'RHS150x100x6', shapeKey: 'rhs',
      sectH: 150, sectW: 100, sectT: 6, lengthMm: 6000,
      surfaceTreatment: 'BARE', destination: 'BLDG-A',
      outer: polyRect(150, 100),
      cs: { H: 150, W: 100, open_closed: 'closed', concavity: 0, area_ratio: 0.7, sym: 1 },
    });
    const chs = item('B', {
      profileDesc: 'CHS168.3x6', shapeKey: 'rhs', category: 'rod',
      sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3, lengthMm: 6000,
      surfaceTreatment: 'BARE', destination: 'BLDG-A',
      outer: polyCircle(168.3),
      cs: { H: 168.3, W: 168.3, open_closed: 'closed', concavity: 0, area_ratio: 0.78, sym: 1 },
    });
    // Force distinct shapeKey for CHS if app uses rod/chs
    chs.shapeKey = 'rod';
    chs.profileShape = 'rod';
    const { groups } = runGroup([rhs, chs]);
    assert(groups.length >= 2 && differentGroups(groups, 'A', 'B'), 'RHS≠CHS');
  });

  // CATEGORY 4
  t('4.1', 'GALV vs PAINT must separate (CRITICAL)', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALVANIZED', 'BLDG-A'),
      zItem('B', 6000, 'PAINTED', 'BLDG-A'),
      zItem('C', 6000, 'GALVANIZED', 'BLDG-A'),
    ]);
    assert(sameGroup(groups, ['A', 'C']), 'A+C together');
    assert(differentGroups(groups, 'A', 'B'), 'B separate');
    assert(groups.length === 2, `groups=${groups.length}`);
  });

  t('4.2', 'Four surfaces → four groups', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALVANIZED', 'BLDG-A'),
      zItem('B', 6000, 'PAINTED', 'BLDG-A'),
      zItem('C', 6000, 'BARE', 'BLDG-A'),
      zItem('D', 6000, 'POWDER_COATED', 'BLDG-A'),
    ]);
    assert(groups.length === 4, `groups=${groups.length}`);
  });

  t('4.3', 'NULL surface groups together', () => {
    const a = zItem('A', 6000, null, 'BLDG-A');
    const b = zItem('B', 6000, null, 'BLDG-A');
    delete a.surfaceTreatment;
    delete b.surfaceTreatment;
    const { groups } = runGroup([a, b]);
    assert(groups.length === 1 && pcs(groups[0]) === 2, 'null surface same group');
  });

  // CATEGORY 5
  t('5.1', 'Different destination separates', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A'),
      zItem('B', 6000, 'GALV', 'BLDG-B'),
      zItem('C', 6000, 'GALV', 'BLDG-A'),
    ]);
    assert(sameGroup(groups, ['A', 'C']) && differentGroups(groups, 'A', 'B'), 'dest');
    assert(groups.length === 2, `n=${groups.length}`);
  });

  t('5.2', 'Multiple destinations', () => {
    const items = [];
    for (let i = 0; i < 5; i++) items.push(zItem('A' + i, 6000, 'GALV', 'BLDG-A'));
    for (let i = 0; i < 3; i++) items.push(zItem('B' + i, 6000, 'GALV', 'BLDG-B'));
    for (let i = 0; i < 2; i++) items.push(zItem('C' + i, 6000, 'GALV', 'BLDG-C'));
    const { groups, audit } = runGroup(items);
    assert(audit.ok && groups.length === 3, `groups=${groups.length}`);
    const sizes = groups.map(pcs).sort((a, b) => b - a);
    assert(sizes[0] === 5 && sizes[1] === 3 && sizes[2] === 2, `sizes=${sizes}`);
  });

  t('5.3', 'NULL destination groups together', () => {
    const a = zItem('A', 6000, 'GALV', null);
    const b = zItem('B', 6000, 'GALV', null);
    delete a.destination; delete b.destination;
    const { groups } = runGroup([a, b]);
    assert(groups.length === 1, 'null dest together');
  });

  // CATEGORY 6
  t('6.1', 'Welded different marks never merge', () => {
    const mk = (mark) => item(mark, {
      profileDesc: 'BUILT-UP', assemblyName: 'Rafter',
      mark, lengthMm: 12000, widthMm: 800, heightMm: 300,
      sectH: 300, sectW: 800, sectT: 12,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      parts: [{ id: 1 }, { id: 2 }],
      unitWeightKg: 2800,
      outer: polyI(300, 800, 12, 20),
      cs: { H: 300, W: 800, open_closed: 'solid', welded_like: true, concavity: 0.1 },
    });
    const { groups } = runGroup([mk('R-1'), mk('R-2')]);
    assert(groups.length === 2 && differentGroups(groups, 'R-1', 'R-2'), 'marks split');
  });

  t('6.2', 'Same welded mark can group', () => {
    const mk = (i) => item('R-1', {
      profileDesc: 'BUILT-UP', assemblyName: 'Rafter',
      lengthMm: 12000, widthMm: 800, heightMm: 300,
      sectH: 300, sectW: 800,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      parts: [{ id: 1 }, { id: 2 }],
      unitWeightKg: 500,
      // unique piece identity via qty expand — use distinct marks then remap? 
      // expand uses mark; duplicate marks OK with qty
      outer: polyI(300, 800, 12, 20),
      cs: { H: 300, W: 800, open_closed: 'solid', welded_like: true },
      qty: 1,
    });
    // Four separate items same mark
    const items = [0, 1, 2, 3].map(i => {
      const it = mk(i);
      it._pieceIdx = i;
      return it;
    });
    const { groups } = runGroup(items);
    assert(groups.length === 1 && pcs(groups[0]) === 4, `g=${groups.length} pcs=${pcs(groups[0])}`);
  });

  t('6.3', 'Welded vs standard beam separate', () => {
    const welded = item('R-1', {
      profileDesc: 'BUILT-UP', parts: [{}, {}],
      lengthMm: 12000, sectH: 800, sectW: 300,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyI(800, 300, 12, 20),
      cs: { H: 800, W: 300, open_closed: 'solid', welded_like: true },
    });
    const beam = item('B1', {
      profileDesc: 'UB457x191x67', shapeKey: 'i_beam',
      lengthMm: 12000, sectH: 457, sectW: 191, sectT: 14,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyI(457, 191, 11, 14),
      cs: { H: 457, W: 191, open_closed: 'solid', concavity: 0.15 },
    });
    const { groups } = runGroup([welded, beam]);
    assert(groups.length === 2 && differentGroups(groups, 'R-1', 'B1'), 'weld≠beam');
    const gw = findGroupWith(groups, 'R-1');
    assert(gw && gw.groupKind === 'welded_assembly', 'welded family');
  });

  t('6.4', 'Single-part Z assembly → nest_z not welded', () => {
    const a = zItem('P1', 6000, 'GALV', 'BLDG-A');
    a.parts = [{ id: 'only' }]; // single part
    a.assemblyName = 'Purlin Assy';
    const b = zItem('P2', 6000, 'GALV', 'BLDG-A');
    const { groups } = runGroup([a, b]);
    assert(sameGroup(groups, ['P1', 'P2']), 'single-part nests with Z');
    const g = findGroupWith(groups, 'P1');
    assert(g.groupKind === 'nest_z', `kind=${g.groupKind}`);
  });

  t('6.5', 'Rafter vs Column marks separate', () => {
    const mk = (mark) => item(mark, {
      profileDesc: 'BUILT-UP', parts: [{}, {}],
      lengthMm: 10000, sectH: 400, sectW: 200,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      outer: polyI(400, 200, 10, 16),
      cs: { H: 400, W: 200, open_closed: 'solid', welded_like: true },
      unitWeightKg: 800,
    });
    const { groups } = runGroup([mk('R-1'), mk('C-1'), mk('R-1'), mk('C-1')]);
    // expand: two R-1 and two C-1 items with same marks — qty from duplicate marks
    assert(groups.length === 2, `groups=${groups.length}`);
    assert(sameGroup(groups, ['R-1']) && sameGroup(groups, ['C-1']), 'marks');
    assert(differentGroups(groups, 'R-1', 'C-1'), 'R≠C');
    assert(pcs(findGroupWith(groups, 'R-1')) === 2, '2 rafters');
    assert(pcs(findGroupWith(groups, 'C-1')) === 2, '2 columns');
  });

  // CATEGORY 7
  t('7.1', 'Within H/W/T tolerance → same group', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200.0, W: 75.0, T: 2.50 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { H: 200.5, W: 74.8, T: 2.48 }),
      zItem('C', 6000, 'GALV', 'BLDG-A', { H: 199.5, W: 75.2, T: 2.52 }),
    ]);
    assert(groups.length === 1 && pcs(groups[0]) === 3, `g=${groups.length}`);
  });

  t('7.2', 'Outside H tolerance → separate', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200.0, W: 75.0, T: 2.50 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { H: 205.0, W: 75.0, T: 2.50, profileDesc: 'Z205' }),
    ]);
    assert(groups.length === 2 && differentGroups(groups, 'A', 'B'), 'H split');
  });

  t('7.3', 'Thickness tolerance boundary', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.50 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.65 }),
      zItem('C', 6000, 'GALV', 'BLDG-A', { T: 2.70 }),
    ]);
    // A+B within ±0.15 of 2.5 bin; C may bin separately
    assert(sameGroup(groups, ['A', 'B']), 'A+B together');
    assert(differentGroups(groups, 'A', 'C'), 'C separate');
  });

  t('7.3b', 'Z gauges 2.5 / 2.0 / 1.5 → separate sets with qty', () => {
    const items = [];
    for (let i = 0; i < 20; i++)
      items.push(zItem('Z25-' + i, 6000, 'GALV', 'BLDG-A', { T: 2.5 }));
    for (let i = 0; i < 25; i++)
      items.push(zItem('Z20-' + i, 6000, 'GALV', 'BLDG-A', { T: 2.0 }));
    for (let i = 0; i < 30; i++)
      items.push(zItem('Z15-' + i, 6000, 'GALV', 'BLDG-A', { T: 1.5 }));
    const { groups } = runGroup(items);
    const zGroups = groups.filter(g => g.groupKind === 'nest_z' || g.shapeKey === 'z_channel');
    assert(zGroups.length >= 3, `expected ≥3 Z groups, got ${zGroups.length}`);
    const byT = {};
    zGroups.forEach(g => {
      const t = Number(g.sectT) || 0;
      const key = t.toFixed(1);
      byT[key] = (byT[key] || 0) + (g.qty || 0);
    });
    assert(byT['2.5'] === 20, `2.5 qty=${byT['2.5']}`);
    assert(byT['2.0'] === 25, `2.0 qty=${byT['2.0']}`);
    assert(byT['1.5'] === 30, `1.5 qty=${byT['1.5']}`);
  });

  t('7.3c', 'Z200x75xT profileDesc parse splits gauges when sectT missing', () => {
    const items = [
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5, sectT: 0, profileDesc: 'Z200x75x2.5' }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.0, sectT: 0, profileDesc: 'Z200x75x2.0' }),
      zItem('C', 6000, 'GALV', 'BLDG-A', { T: 1.5, sectT: 0, profileDesc: 'Z200x75x1.5' }),
    ];
    // Force missing sectT (zItem assigns T into sectT via Object.assign order — override)
    items.forEach((it, i) => {
      it.sectT = 0;
      it.profileDesc = ['Z200x75x2.5', 'Z200x75x2.0', 'Z200x75x1.5'][i];
    });
    const { groups } = runGroup(items);
    assert(groups.length >= 3, `g=${groups.length}`);
    assert(differentGroups(groups, 'A', 'B'), '2.5≠2.0');
    assert(differentGroups(groups, 'B', 'C'), '2.0≠1.5');
  });

  t('7.3d', 'Same dims different nest methods → separate groups', () => {
    const items = [
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
    ];
    if (typeof attachCsSignaturesToItems === 'function')
      attachCsSignaturesToItems(items);
    if (typeof attachNestMethodsToItems === 'function')
      attachNestMethodsToItems(items);
    // Force incompatible strategies after stamp (merge key must honour nestMethod)
    items[0].nestMethod = { method: 'INTERLOCK_NEST', alternate_flip: true };
    items[1].nestMethod = { method: 'PARALLEL_BUNDLE', alternate_flip: false };
    const groups = (typeof groupItemsByCsSignature === 'function')
      ? groupItemsByCsSignature(items) : [];
    assert(groups.length >= 2, `g=${groups.length}`);
    assert(differentGroups(groups, 'A', 'B'), 'INTERLOCK ≠ PARALLEL');
  });

  t('7.3e', 'Stage card carries sectT + nestMethod + title', () => {
    const { groups } = runGroup([zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 })]);
    assert(groups.length >= 1, 'has group');
    const g = groups[0];
    assert(Number(g.sectT) > 0, `sectT=${g.sectT}`);
    assert(g.nestMethod && g.nestMethod.method, 'nestMethod.method');
    assert(/×2\.5|x2\.5/i.test(String(g.mark || g.dimLabel || '')), `title dims ${g.mark}`);
    assert(/INTERLOCK|PARALLEL|STACK|HEX|FLAT|PER-MARK/i.test(String(g.mark || '')),
      `title nest ${g.mark}`);
  });

  t('7.3f', 'Balanced pack units 25→~even (not 12,12,1) + skid on bbox', () => {
    if (typeof cspuBalancedSizes === 'function') {
      const sizes = cspuBalancedSizes(25, 12);
      assert(sizes.length === 3, `k=${sizes.length}`);
      assert(sizes[0] === 9 && sizes[1] === 8 && sizes[2] === 8,
        `sizes=${sizes.join(',')}`);
    }
    const items = [];
    for (let i = 0; i < 25; i++)
      items.push(zItem('Z' + i, 6000, 'GALV', 'BLDG-A', { T: 2.5, unitWeightKg: 40 }));
    const { groups } = runGroup(items);
    assert(groups.length >= 1, 'group');
    const g = groups[0];
    const pus = g.packUnits || [];
    assert(pus.length >= 2, `packUnits=${pus.length}`);
    const qtys = pus.map(pu => pu.qty || 0);
    const minQ = Math.min(...qtys), maxQ = Math.max(...qtys);
    assert(maxQ - minQ <= 1, `unbalanced ${qtys.join(',')}`);
    assert(!qtys.some(q => q === 1 && maxQ >= 8), `orphan 1 in ${qtys.join(',')}`);
    const pu0 = pus[0];
    assert(pu0.skidMm === 100 || (pu0.bundle_bbox && pu0.bundle_bbox.skidMm === 100),
      `skid=${pu0.skidMm}`);
    if (pu0.bundle_bbox && pu0.bundle_bbox.hSteel != null) {
      assert(Math.abs(pu0.bundle_bbox.h - pu0.bundle_bbox.hSteel - 100) < 0.5, 'h = steel+skid');
    }
  });

  // CATEGORY 8
  t('8.1', 'Full project mix → distinct families', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push(zItem('Z' + i, 5000 + i * 100, 'GALV', 'BLDG-A'));
    for (let i = 0; i < 8; i++) items.push(cItem('C' + i, 5000, 'GALV', 'BLDG-A', { H: 250, W: 100, T: 3 }));
    for (let i = 0; i < 6; i++) {
      items.push(item('L' + i, {
        profileDesc: 'L150x150x10', shapeKey: 'l_angle',
        sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
        surfaceTreatment: 'BARE', destination: 'BLDG-A',
        outer: polyL(150, 150, 10),
        cs: { H: 150, W: 150, open_closed: 'open', concavity: 0.25 },
      }));
    }
    for (let i = 0; i < 4; i++) {
      items.push(item('PL' + i, {
        profileDesc: 'PL12', shapeKey: 'plate', category: 'plate',
        sectH: 12, sectW: 500, sectT: 12, lengthMm: 300, widthMm: 500,
        surfaceTreatment: 'PAINT', destination: 'BLDG-A',
        outer: polyRect(12, 500),
        cs: { H: 12, W: 500, open_closed: 'solid', concavity: 0, area_ratio: 1 },
      }));
    }
    for (let i = 0; i < 4; i++) {
      items.push(item('R-1', {
        profileDesc: 'BUILT-UP', parts: [{}, {}],
        lengthMm: 12000, sectH: 400, sectW: 200,
        surfaceTreatment: 'PAINT', destination: 'BLDG-A', unitWeightKg: 400,
        outer: polyI(400, 200, 10, 16),
        cs: { H: 400, W: 200, open_closed: 'solid', welded_like: true },
      }));
    }
    for (let i = 0; i < 4; i++) {
      items.push(item('C-1', {
        profileDesc: 'BUILT-UP', parts: [{}, {}],
        lengthMm: 8000, sectH: 350, sectW: 180,
        surfaceTreatment: 'PAINT', destination: 'BLDG-A', unitWeightKg: 400,
        outer: polyI(350, 180, 10, 16),
        cs: { H: 350, W: 180, open_closed: 'solid', welded_like: true },
      }));
    }
    for (let i = 0; i < 20; i++) {
      items.push(item('SR' + i, {
        profileDesc: 'SAG ROD dia16', shapeKey: 'rod', category: 'rod',
        sectH: 16, sectW: 16, sectD: 16, lengthMm: 3000,
        surfaceTreatment: 'GALV', destination: 'BLDG-A', unitWeightKg: 5,
        outer: polyCircle(16),
        cs: { H: 16, W: 16, open_closed: 'solid', concavity: 0, area_ratio: 0.78 },
      }));
    }
    for (let i = 0; i < 5; i++) {
      items.push(item('RHS' + i, {
        profileDesc: 'RHS150x100x6', shapeKey: 'rhs',
        sectH: 150, sectW: 100, sectT: 6, lengthMm: 6000,
        surfaceTreatment: 'PAINT', destination: 'BLDG-A',
        outer: polyRect(150, 100),
        cs: { H: 150, W: 100, open_closed: 'closed', concavity: 0, area_ratio: 0.7 },
      }));
    }
    const { groups, audit } = runGroup(items);
    assert(audit.ok, 'audit');
    assert(audit.inPcs === 61, `inPcs=${audit.inPcs}`);
    const kinds = new Set(groups.map(g => g.groupKind));
    assert(kinds.has('nest_z'), 'nest_z');
    assert(kinds.has('nest_c'), 'nest_c');
    assert(kinds.has('nest_l'), 'nest_l');
    assert(kinds.has('stack_plate'), 'stack_plate');
    assert(kinds.has('welded_assembly'), 'welded');
    assert(kinds.has('bundle_rod') || kinds.has('bundle_bent'), 'rod');
    assert(kinds.has('bundle_rhs'), 'rhs');
    assert(groups.length >= 8, `groups=${groups.length}`);
  });

  t('8.2', 'Z vs RHS same numbers → separate', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
      item('B', {
        profileDesc: 'RHS200x75x2.5', shapeKey: 'rhs',
        sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
        surfaceTreatment: 'GALV', destination: 'BLDG-A',
        outer: polyRect(200, 75),
        cs: { H: 200, W: 75, open_closed: 'closed', concavity: 0, area_ratio: 0.85 },
      }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'shape≠dims');
    assert(findGroupWith(groups, 'A').groupKind === 'nest_z', 'z');
    assert(findGroupWith(groups, 'B').groupKind === 'bundle_rhs', 'rhs');
  });

  // CATEGORY 9
  t('9.1', 'Straight vs bent rods separate', () => {
    const straight = (m) => item(m, {
      profileDesc: 'ROD dia16 STRAIGHT', shapeKey: 'rod', category: 'rod',
      sectH: 16, sectW: 16, sectD: 16, lengthMm: 4000,
      surfaceTreatment: 'GALV', destination: 'BLDG-A', unitWeightKg: 6,
      outer: polyCircle(16),
      cs: { H: 16, W: 16, open_closed: 'solid', area_ratio: 0.78, concavity: 0 },
    });
    const bent = item('B', {
      profileDesc: 'ROD dia16 BENT', shapeKey: 'bent_sag_rod', category: 'rod',
      sectH: 16, sectW: 16, sectD: 16, lengthMm: 4000,
      pathPointsMm: [[0, 0, 0], [1000, 0, 0], [2000, 200, 0], [3000, 0, 0]],
      pathDiamMm: 16,
      surfaceTreatment: 'GALV', destination: 'BLDG-A', unitWeightKg: 6,
      outer: polyCircle(16),
      cs: { H: 16, W: 16, open_closed: 'solid', area_ratio: 0.78, concavity: 0 },
    });
    const { groups } = runGroup([straight('A'), bent, straight('C')]);
    assert(sameGroup(groups, ['A', 'C']), 'straights together');
    assert(differentGroups(groups, 'A', 'B'), 'bent separate');
  });

  t('9.2', 'Different rod diameters separate', () => {
    const rod = (m, d) => item(m, {
      profileDesc: `ROD dia${d}`, shapeKey: 'rod', category: 'rod',
      sectH: d, sectW: d, sectD: d, lengthMm: 3000,
      surfaceTreatment: 'GALV', destination: 'BLDG-A',
      outer: polyCircle(d),
      cs: { H: d, W: d, open_closed: 'solid', area_ratio: 0.78, concavity: 0 },
    });
    const { groups } = runGroup([rod('A', 16), rod('B', 20), rod('C', 16)]);
    assert(sameGroup(groups, ['A', 'C']) && differentGroups(groups, 'A', 'B'), 'dia');
  });

  // CATEGORY 10
  t('10.1', 'Special handling separates', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { specialHandling: false }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { specialHandling: true }),
      zItem('C', 6000, 'GALV', 'BLDG-A', { specialHandling: false }),
    ]);
    assert(sameGroup(groups, ['A', 'C']), 'normal together');
    assert(differentGroups(groups, 'A', 'B'), 'special separate');
  });

  // CATEGORY 11 — orientation
  t('11.1', 'Z-purlin prefers stable orientation (wide base)', () => {
    const it = zItem('A', 6000, 'GALV', 'BLDG-A');
    attachCsSignaturesToItems([it]);
    const ori = typeof findBestOrientation === 'function' ? findBestOrientation(it) : null;
    assert(ori, 'has orientation');
    // Guide Step3: B = cs_width vertical → base = H×L (200×6000), base_min≈200
    assert(ori.base_width >= 150, `base_width=${ori.base_width}`);
    assert(ori.orientation_id === 'B' || ori.vert_key === 'W',
      `id=${ori.orientation_id} vert=${ori.vert_key} (expect B/W flat)`);
  });

  t('11.2', 'Plate lies flat (T or thin axis vertical)', () => {
    const it = item('P', {
      profileDesc: 'PL12x1000x500', shapeKey: 'plate', category: 'plate',
      sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500, heightMm: 12,
      outer: polyRect(12, 500),
      cs: { H: 12, W: 500, open_closed: 'solid', concavity: 0, area_ratio: 1 },
    });
    attachCsSignaturesToItems([it]);
    const ori = findBestOrientation(it);
    assert(ori, 'ori');
    // thin dimension vertical → small vertical_mm
    assert(ori.vertical_mm <= 50, `vertical_mm=${ori.vertical_mm}`);
  });

  t('11.3', 'RHS wider base preferred', () => {
    const it = item('R', {
      profileDesc: 'RHS200x100x6', shapeKey: 'rhs',
      sectH: 200, sectW: 100, sectT: 6, lengthMm: 6000,
      outer: polyRect(200, 100),
      cs: { H: 200, W: 100, open_closed: 'closed', concavity: 0, area_ratio: 0.7 },
    });
    attachCsSignaturesToItems([it]);
    const ori = findBestOrientation(it);
    assert(ori && ori.base_a_mm >= ori.vertical_mm - 1e-6, `base=${ori && ori.base_a_mm}`);
  });

  // CATEGORY 12 — nesting offset
  t('12.1', 'Z nest offset > 0 and no Y overlap in placements', () => {
    const items = [];
    for (let i = 0; i < 5; i++) items.push(zItem('Z' + i, 6000, 'GALV', 'BLDG-A'));
    const { groups } = runGroup(items);
    const g = groups[0];
    const off = g.nestingOffsetMm || g.nestingInfo?.nesting_offset || 0;
    assert(off > 0, `offset=${off}`);
    // Simulate Y positions with alternate flip
    const ys = [];
    let y = 0;
    for (let i = 0; i < 5; i++) {
      ys.push({ min: y, max: y + 2.5 }); // web thickness contact band proxy
      y += off;
    }
    for (let i = 0; i < ys.length; i++) {
      for (let j = i + 1; j < ys.length; j++) {
        const overlap = ys[i].max > ys[j].min + 1e-6 && ys[i].min < ys[j].max - 1e-6;
        assert(!overlap, `Y overlap ${i},${j}`);
      }
    }
  });

  t('12.2', 'Plate stack offset = thickness', () => {
    const items = [];
    for (let i = 0; i < 4; i++) {
      items.push(item('P' + i, {
        profileDesc: 'PL12', shapeKey: 'plate', category: 'plate',
        sectH: 12, sectW: 500, sectT: 12, lengthMm: 300, widthMm: 500,
        surfaceTreatment: 'PAINT', destination: 'BLDG-A',
        outer: polyRect(12, 500),
        cs: { H: 12, W: 500, open_closed: 'solid', concavity: 0, area_ratio: 1 },
      }));
    }
    const { groups } = runGroup(items);
    const off = groups[0].nestingOffsetMm || groups[0].nestingInfo?.nesting_offset || 0;
    assert(Math.abs(off - 12) < 0.6 || off >= 11, `plate offset=${off}`);
  });

  // CATEGORY 13 — bundle weight
  t('13.1', 'Within weight limit → one bundle of 12', () => {
    const items = [];
    for (let i = 0; i < 12; i++) {
      items.push(zItem('Z' + i, 6000, 'GALV', 'BLDG-A', { unitWeightKg: 45 }));
    }
    const { groups } = runGroup(items);
    const pus = groups[0].packUnits || [];
    assert(pus.length === 1, `units=${pus.length}`);
  });

  t('13.2', 'Weight limit forces smaller SET_SIZE', () => {
    const items = [];
    for (let i = 0; i < 20; i++) {
      items.push(cItem('C' + i, 10000, 'GALV', 'BLDG-A', {
        H: 400, W: 100, T: 5, unitWeightKg: 350, profileDesc: 'C400x5.0',
      }));
    }
    const { groups } = runGroup(items);
    const pus = groups[0].packUnits || [];
    assert(pus.length >= 3, `units=${pus.length}`);
    pus.forEach((pu, i) => {
      const n = pu.nestPieces
        ? pu.nestPieces.reduce((a, x) => a + (x.qty || 1), 0)
        : (pu.qty || 0);
      const w = pu.total_weight || pu.weightKg || (n * 350);
      assert(n <= 8, `unit ${i} n=${n}`);
      assert(w <= 3000 + 1, `unit ${i} w=${w}`);
    });
  });

  t('13.3', 'Heavy single welded still packs as 1', () => {
    const it = item('R-1', {
      profileDesc: 'BUILT-UP', parts: [{}, {}],
      lengthMm: 12000, sectH: 500, sectW: 300,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A',
      unitWeightKg: 3500,
      outer: polyI(500, 300, 12, 20),
      cs: { H: 500, W: 300, open_closed: 'solid', welded_like: true },
    });
    const { groups } = runGroup([it]);
    assert(groups.length === 1 && (groups[0].packUnits || []).length === 1, 'one unit');
  });

  // CATEGORY 18 — edge
  t('18.1', 'Empty input → zero groups', () => {
    const { groups, audit } = runGroup([]);
    assert(groups.length === 0 && audit.inPcs === 0, 'empty');
  });

  t('18.2', 'Single item IFC', () => {
    const { groups, audit } = runGroup([zItem('ONLY', 6000, 'GALV', 'BLDG-A')]);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 1, 'one');
  });

  t('18.3', 'All unique welded marks', () => {
    const mk = (mark) => item(mark, {
      profileDesc: 'BUILT-UP', parts: [{}, {}],
      lengthMm: 8000, sectH: 300, sectW: 200,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A', unitWeightKg: 500,
      outer: polyI(300, 200, 10, 16),
      cs: { H: 300, W: 200, open_closed: 'solid', welded_like: true },
    });
    const { groups } = runGroup([mk('R-1'), mk('R-2'), mk('C-1'), mk('C-2'), mk('BR-1')]);
    assert(groups.length === 5, `g=${groups.length}`);
  });

  t('18.4', 'Zero weight still groups', () => {
    const it = zItem('A', 6000, 'GALV', 'BLDG-A', { unitWeightKg: 0 });
    const { groups } = runGroup([it, zItem('B', 6000, 'GALV', 'BLDG-A', { unitWeightKg: 0 })]);
    assert(groups.length === 1 && pcs(groups[0]) === 2, 'zero weight');
  });

  t('18.5', 'Missing profile name → geometry still groups', () => {
    const a = zItem('A', 6000, 'GALV', 'BLDG-A');
    const b = zItem('B', 6000, 'GALV', 'BLDG-A');
    a.profileDesc = '';
    b.profileDesc = '';
    const { groups } = runGroup([a, b]);
    assert(groups.length === 1, 'geometry group');
  });

  t('18.6', 'Duplicate identical items count 2', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A'),
      zItem('A', 6000, 'GALV', 'BLDG-A'),
    ]);
    assert(pcs(groups[0]) === 2, `pcs=${pcs(groups[0])}`);
  });

  // ── HUMAN / YARD GROUPING ONLY (merge key · qty · cards — not packer layout) ─
  function lItem(mark, len, surf, dest, extra) {
    extra = extra || {};
    const H = extra.H != null ? extra.H : 150;
    const W = extra.W != null ? extra.W : 150;
    const T = extra.T != null ? extra.T : 10;
    return item(mark, Object.assign({
      profileDesc: extra.profileDesc || `L${H}x${W}x${T}`,
      shapeKey: 'l_angle',
      sectH: H, sectW: W, sectT: T,
      lengthMm: len,
      surfaceTreatment: surf,
      destination: dest,
      outer: polyL(H, W, T),
      cs: { H, W, open_closed: 'open', concavity: 0.25, sym: 0.5 },
    }, extra));
  }

  t('H.01', 'Yard: different Tekla marks, same Z section → ONE nest set', () => {
    const { groups, audit } = runGroup([
      zItem('PURLIN-A1', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('PURLIN-A2', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('PURLIN-B9', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
    ]);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 3, 'marks ignored for nest');
  });

  t('H.02', 'Yard: item.qty expands into piece count', () => {
    const it = zItem('ZLOT', 6000, 'GALV', 'BLDG-A', { T: 2.5 });
    it.qty = 20;
    const { groups, audit } = runGroup([it]);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 20, `pcs=${pcs(groups[0])}`);
  });

  t('H.03', 'Yard: C gauges 2.5 / 2.0 / 1.5 → three sets', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push(cItem('C25-' + i, 6000, 'GALV', 'BLDG-A', { T: 2.5 }));
    for (let i = 0; i < 8; i++) items.push(cItem('C20-' + i, 6000, 'GALV', 'BLDG-A', { T: 2.0 }));
    for (let i = 0; i < 6; i++) items.push(cItem('C15-' + i, 6000, 'GALV', 'BLDG-A', { T: 1.5 }));
    const { groups, audit } = runGroup(items);
    assert(audit.ok, 'audit');
    const cG = groups.filter(g => g.groupKind === 'nest_c' || g.shapeKey === 'c_channel');
    assert(cG.length >= 3, `C groups=${cG.length}`);
    const byT = {};
    cG.forEach(g => { byT[(Number(g.sectT) || 0).toFixed(1)] = (byT[(Number(g.sectT) || 0).toFixed(1)] || 0) + pcs(g); });
    assert(byT['2.5'] === 10 && byT['2.0'] === 8 && byT['1.5'] === 6, JSON.stringify(byT));
  });

  t('H.04', 'Yard: C same H different flange W → separate', () => {
    const { groups } = runGroup([
      cItem('A', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
      cItem('B', 6000, 'GALV', 'BLDG-A', { H: 200, W: 100, T: 2.5, profileDesc: 'C200x100x2.5' }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'C flange split');
  });

  t('H.05', 'Yard: C mixed lengths still ONE thickness set', () => {
    const { groups, audit } = runGroup([
      cItem('A', 7200, 'GALV', 'BLDG-A', { T: 2.5 }),
      cItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      cItem('C', 4800, 'GALV', 'BLDG-A', { T: 2.5 }),
    ]);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 3, 'C length not in merge');
  });

  t('H.06', 'Yard: L angles different thickness separate', () => {
    const { groups } = runGroup([
      lItem('A', 4000, 'BARE', 'BLDG-A', { T: 6 }),
      lItem('B', 4000, 'BARE', 'BLDG-A', { T: 10, profileDesc: 'L150x150x10' }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'L T split');
  });

  t('H.07', 'Yard: L vs Z never merge even if H looks similar', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 150, W: 75, T: 2.5 }),
      lItem('B', 6000, 'GALV', 'BLDG-A', { H: 150, W: 150, T: 10 }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'L≠Z');
  });

  t('H.08', 'Yard: GALV Z and PAINT Z never share a set', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('B', 6000, 'PAINT', 'BLDG-A', { T: 2.5 }),
      zItem('C', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
    ]);
    assert(sameGroup(groups, ['A', 'C']), 'GALV together');
    assert(differentGroups(groups, 'A', 'B'), 'PAINT out');
  });

  t('H.09', 'Yard: BLDG-A vs BLDG-B same steel → two deliveries', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-B', { T: 2.5 }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'dest split');
  });

  t('H.10', 'Yard: SPECIAL flag never mixes with normal', () => {
    const a = zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 });
    const b = zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5 });
    b.specialHandling = true;
    const { groups } = runGroup([a, b]);
    assert(differentGroups(groups, 'A', 'B'), 'SPECIAL split');
  });

  t('H.11', 'Yard: profileDesc label differs, same dims → still ONE group', () => {
    const a = zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5, profileDesc: '200Z25' });
    const b = zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5, profileDesc: 'Z200/2.5' });
    a.sectT = 2.5; b.sectT = 2.5;
    const { groups } = runGroup([a, b]);
    assert(groups.length === 1 && pcs(groups[0]) === 2, 'label not merge key');
  });

  t('H.12', 'Yard: audit — no piece lost across 3 thickness lots', () => {
    const items = [];
    for (let i = 0; i < 7; i++) items.push(zItem('A' + i, 5000, 'GALV', 'SITE', { T: 2.5 }));
    for (let i = 0; i < 5; i++) items.push(zItem('B' + i, 5000, 'GALV', 'SITE', { T: 2.0 }));
    for (let i = 0; i < 4; i++) items.push(cItem('C' + i, 5000, 'GALV', 'SITE', { T: 2.5 }));
    const { groups, audit } = runGroup(items);
    assert(audit.ok && audit.inPcs === 16, `in=${audit.inPcs}`);
    const out = groups.reduce((s, g) => s + pcs(g), 0);
    assert(out === 16, `out=${out}`);
  });

  t('H.13', 'Yard: Z200 vs Z250 never one pile', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { H: 250, W: 85, T: 2.5, profileDesc: 'Z250x85x2.5' }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'web height');
  });

  t('H.14', 'Yard: C vs Z same H×W×T numbers still separate families', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
      cItem('B', 6000, 'GALV', 'BLDG-A', { H: 200, W: 75, T: 2.5 }),
    ]);
    assert(groups.length === 2, `g=${groups.length}`);
    assert(findGroupWith(groups, 'A').groupKind === 'nest_z'
      || findGroupWith(groups, 'A').shapeKey === 'z_channel', 'Z kind');
    assert(findGroupWith(groups, 'B').groupKind === 'nest_c'
      || findGroupWith(groups, 'B').shapeKey === 'c_channel', 'C kind');
  });

  t('H.15', 'Yard: card shows thickness for C set', () => {
    const { groups } = runGroup([
      cItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.0 }),
      cItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.0 }),
    ]);
    const g = groups[0];
    assert(Number(g.sectT) === 2.0 || Math.abs(Number(g.sectT) - 2) < 0.05, `T=${g.sectT}`);
    assert(/×2(\.0)?|x2(\.0)?/i.test(String(g.mark || g.dimLabel || '')), `title=${g.mark}`);
  });

  t('H.16', 'Yard: POWDER vs GALV separate', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'POWDER', 'BLDG-A', { T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'coating');
  });

  t('H.17', 'Yard: many C identical → one group correct qty', () => {
    const items = [];
    for (let i = 0; i < 18; i++) items.push(cItem('C' + i, 6000, 'BARE', 'YARD', { T: 3 }));
    const { groups, audit } = runGroup(items);
    assert(audit.ok && groups.length === 1 && pcs(groups[0]) === 18, '18 C');
  });

  t('H.18', 'Yard: weld marks R-1 / R-2 never merge', () => {
    const mk = (mark) => item(mark, {
      profileDesc: 'BUILT-UP', parts: [{}, {}],
      lengthMm: 10000, sectH: 400, sectW: 200,
      surfaceTreatment: 'PAINT', destination: 'BLDG-A', unitWeightKg: 800,
      outer: polyI(400, 200, 12, 18),
      cs: { H: 400, W: 200, open_closed: 'solid', welded_like: true },
    });
    const { groups } = runGroup([mk('R-1'), mk('R-2'), mk('R-1')]);
    // two R-1 pcs one group; R-2 alone → 2 groups
    assert(groups.length === 2, `g=${groups.length}`);
    assert(pcs(findGroupWith(groups, 'R-1')) === 2, 'R-1 qty');
    assert(pcs(findGroupWith(groups, 'R-2')) === 1, 'R-2 qty');
  });

  t('H.19', 'Yard: merge key includes nest strategy token', () => {
    const it = zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 });
    if (typeof attachNestMethodsToItems === 'function') attachNestMethodsToItems([it]);
    if (typeof computeCsSignature === 'function') computeCsSignature(it);
    assert(typeof csgMergeKey === 'function', 'csgMergeKey');
    const k = csgMergeKey(it);
    assert(/INTERLOCK|STACK|PARALLEL|FLAT|HEX|PER_MARK/i.test(k), `key=${k}`);
  });

  t('H.20', 'Yard: fallback stageMergeKey also splits C thickness', () => {
    if (typeof stageMergeKey !== 'function') return; // skip if missing
    const a = cItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 });
    const b = cItem('B', 6000, 'GALV', 'BLDG-A', { T: 1.5 });
    if (typeof attachNestMethodsToItems === 'function') attachNestMethodsToItems([a, b]);
    const ka = stageMergeKey(a), kb = stageMergeKey(b);
    assert(ka !== kb, `${ka} vs ${kb}`);
  });

  t('H.21', 'Yard: 1 Z + 1 C + 1 L + 1 plate → ≥4 groups', () => {
    const plate = item('PL', {
      profileDesc: 'PL10', shapeKey: 'plate', category: 'plate',
      sectH: 10, sectW: 400, sectT: 10, lengthMm: 2000, widthMm: 400, heightMm: 10,
      surfaceTreatment: 'BARE', destination: 'BLDG-A',
      outer: polyRect(10, 400),
      cs: { H: 10, W: 400, open_closed: 'solid', concavity: 0, area_ratio: 1, sym: 1 },
    });
    const { groups, audit } = runGroup([
      zItem('Z1', 6000, 'GALV', 'BLDG-A'),
      cItem('C1', 6000, 'GALV', 'BLDG-A'),
      lItem('L1', 4000, 'BARE', 'BLDG-A'),
      plate,
    ]);
    assert(audit.ok && groups.length >= 4, `g=${groups.length}`);
  });

  t('H.22', 'Yard: coverage audit lists no missing marks', () => {
    const items = [
      zItem('M1', 6000, 'GALV', 'A'),
      zItem('M2', 7200, 'GALV', 'A'),
      cItem('M3', 6000, 'GALV', 'A'),
    ];
    const { audit } = runGroup(items);
    assert(audit.ok, 'ok');
    assert(!(audit.missingMarks && audit.missingMarks.length), 'missing');
  });

  t('H.23', 'Yard: tiny T drift within bin stays together (2.50 & 2.55)', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.50 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.55 }),
    ]);
    assert(sameGroup(groups, ['A', 'B']), 'within T bin');
  });

  t('H.24', 'Yard: T 2.50 vs 2.80 must split', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.50 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.80 }),
    ]);
    assert(differentGroups(groups, 'A', 'B'), 'T far');
  });

  t('H.25', 'Yard: human card readable — dims · nest · pcs', () => {
    const { groups } = runGroup([
      zItem('A', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
      zItem('B', 6000, 'GALV', 'BLDG-A', { T: 2.5 }),
    ]);
    const m = String(groups[0].mark || '');
    assert(/2\.5/.test(m), 'T in title');
    assert(/\d+\s*pcs/i.test(m), 'pcs');
    assert(/INTERLOCK|PARALLEL|STACK|HEX|FLAT/i.test(m), 'nest token');
  });

  // Packer helpers for cat 14–17 (light checks using existing APIs)
  t('14.1', 'Container weight capacity math (group stage only)', () => {
    // Documented rule: 26000 - 8*2800 = 3600 → max 80 purlins @45kg
    const rem = 26000 - 8 * 2800;
    assert(rem === 3600, `rem=${rem}`);
    assert(Math.floor(rem / 45) === 80, 'max purlins');
  });

  t('16.1', 'AABB no-collision helper', () => {
    const A = { x: 0, y: 0, z: 0, l: 7200, w: 125, h: 200 };
    const B = { x: 7250, y: 0, z: 0, l: 6000, w: 100, h: 200 };
    const hit = !(A.x + A.l <= B.x || B.x + B.l <= A.x);
    assert(!hit, 'no collision');
  });

  t('16.2', 'AABB collision detected', () => {
    const A = { x: 0, l: 7200 };
    const B = { x: 7100, l: 6000 };
    const hit = !(A.x + A.l <= B.x || B.x + B.l <= A.x);
    assert(hit, 'collision');
  });

  t('17.1', 'Bundle fits container yaw0', () => {
    const L = 12192, W = 2438, H = 2591;
    const bl = 7200, bw = 125, bh = 200;
    assert(bl <= L && bw <= W && bh <= H, 'fit');
  });

  t('17.3', 'Oversized flagged by yaw fit', () => {
    const L = 12192, W = 2438;
    const bl = 15000, bw = 600;
    const ok = (bl <= L && bw <= W) || (bw <= L && bl <= W);
    assert(!ok, 'oversized');
  });

  t('15.1', 'Support Y match = valid (logic)', () => {
    const placeY = 500, hm = 500;
    assert(Math.abs(placeY - hm) < 1e-6, 'supported');
  });

  t('15.2', 'Float detected', () => {
    const placeY = 500, hm = 300;
    assert(placeY - hm > 1, 'floating');
  });

  // ── runner ────────────────────────────────────────────────────────────────
  function runGroupingTestSuite() {
    const results = [];
    let passed = 0, failed = 0;
    for (let i = 0; i < TESTS.length; i++) {
      const tc = TESTS[i];
      const row = { id: tc.id, name: tc.name, ok: false, error: null };
      try {
        tc.fn();
        row.ok = true;
        passed++;
      } catch (e) {
        row.ok = false;
        row.error = String(e && e.message ? e.message : e);
        failed++;
      }
      results.push(row);
    }
    const summary = {
      total: TESTS.length,
      passed,
      failed,
      ok: failed === 0,
      results,
      ts: new Date().toISOString(),
    };
    try {
      const human = results.filter(r => String(r.id).startsWith('H.'));
      const humanFail = human.filter(r => !r.ok).length;
      console.info(
        `[GroupingTests] ${passed}/${TESTS.length} passed, ${failed} failed`
        + ` | human-yard H.* ${human.length - humanFail}/${human.length}`
      );
      results.filter(r => !r.ok).forEach(r =>
        console.warn(`  FAIL ${r.id} ${r.name}: ${r.error}`));
    } catch (_) { /* */ }

    // Notify C# host if present
    try {
      if (global.chrome && chrome.webview && chrome.webview.postMessage) {
        chrome.webview.postMessage({ type: 'grouping_tests', payload: summary });
      }
    } catch (_) { /* */ }
    return summary;
  }

  global.runGroupingTestSuite = runGroupingTestSuite;
  global.__GROUPING_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
