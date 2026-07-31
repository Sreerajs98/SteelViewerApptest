/* 99-cs-step4-tests.js — STEP 4 Apply Orientation suite (app WebView).
 * Call: runStep4TestSuite()
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 1.0);
  }

  function mkItem(o) {
    return Object.assign({
      mark: o.mark || 'X', qty: 1,
      profileDesc: o.profileDesc || '',
      shapeKey: o.shapeKey || null,
      sectH: o.sectH || 0, sectW: o.sectW || 0, sectT: o.sectT || 0,
      sectTf: o.sectTf || 0, sectTw: o.sectTw || 0, sectD: o.sectD || 0,
      lengthMm: o.lengthMm || 6000,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      parts: o.parts || null,
      meshPositionsMm: o.meshPositionsMm || null,
      meshIndices: o.meshIndices || null,
    }, o);
  }

  function boxFlat(L, H, W, ox, oy, oz) {
    ox = ox || 0; oy = oy || 0; oz = oz || 0;
    const c = [
      [0, 0, 0], [L, 0, 0], [L, H, 0], [0, H, 0],
      [0, 0, W], [L, 0, W], [L, H, W], [0, H, W],
    ];
    const flat = [];
    c.forEach(([x, y, z]) => { flat.push(x + ox, y + oy, z + oz); });
    return flat;
  }

  function pipeline(it) {
    delete it.crossSection;
    delete it.csAnalysis;
    delete it.orientation_info;
    delete it.best_orientation;
    delete it.orientedItem;
    if (typeof extractCrossSection === 'function') extractCrossSection(it);
    if (typeof analyzeCrossSection === 'function') analyzeCrossSection(it);
    if (typeof findBestOrientation === 'function') findBestOrientation(it);
    return applyOrientation(it);
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 4.1 No rotation ───────────────────────────────────────────────────────
  t('4.1', 'No rotation when already correct', () => {
    // Force A winner: RHS taller on W so H vertical wins — or plate
    const it = mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
      meshPositionsMm: boxFlat(6000, 100, 150),
    });
    const o = pipeline(it);
    assert(o, 'oriented');
    assert(it.orientation_info.orientation_id === 'A', 'A wins');
    assert(o.transformation.rotation_angle === 0, `angle=${o.transformation.rotation_angle}`);
    assert(approx(o.oriented_height, 100, 1), `h=${o.oriented_height}`);
    assert(approx(o.oriented_length, 6000, 1), `L=${o.oriented_length}`);
    assert(approx(o.oriented_bbox.minY, 0, 1e-6), 'minY0');
    assert(approx(o.oriented_bbox.minX, 0, 1e-6) && approx(o.oriented_bbox.minZ, 0, 1e-6), 'origin');
  });

  // ── 4.2 90° around X ──────────────────────────────────────────────────────
  t('4.2', '90° rotate Z-purlin → height 75', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      meshPositionsMm: boxFlat(6000, 200, 75), // Y=200 standing
    });
    const o = pipeline(it);
    assert(it.orientation_info.orientation_id === 'B', 'B');
    assert(Math.abs(o.transformation.rotation_angle) === 90, `ang=${o.transformation.rotation_angle}`);
    assert(approx(o.oriented_height, 75, 1), `h=${o.oriented_height} want 75`);
    assert(approx(o.oriented_width, 200, 1), `w=${o.oriented_width}`);
    assert(approx(o.oriented_length, 6000, 1), `L=${o.oriented_length}`);
    assert(approx(o.oriented_bbox.minY, 0, 1e-6), 'ground');
    assert(approx(o.oriented_bbox.minX, 0, 1e-6) && approx(o.oriented_bbox.minZ, 0, 1e-6), 'origin');
    assert(o.height_matches_target, 'height matches Step3');
  });

  // ── 4.3 Ground align ──────────────────────────────────────────────────────
  t('4.3', 'Ground alignment minY=0', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      meshPositionsMm: boxFlat(6000, 200, 75, 0, -50, 0), // floating
    });
    const o = pipeline(it);
    assert(approx(o.oriented_bbox.minY, 0, 1e-6), `minY=${o.oriented_bbox.minY}`);
    assert(approx(o.oriented_bbox.maxY, o.oriented_height, 1e-3), 'maxY=height');
  });

  // ── 4.4 Origin align ──────────────────────────────────────────────────────
  t('4.4', 'Origin alignment minX=minZ=0', () => {
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      meshPositionsMm: boxFlat(6000, 200, 75, -3000, 0, -100),
    });
    const o = pipeline(it);
    assert(approx(o.oriented_bbox.minX, 0, 1e-6), `minX=${o.oriented_bbox.minX}`);
    assert(approx(o.oriented_bbox.minZ, 0, 1e-6), `minZ=${o.oriented_bbox.minZ}`);
    assert(approx(o.oriented_bbox.maxX, o.oriented_length, 1), 'maxX');
    assert(approx(o.oriented_bbox.maxZ, o.oriented_width, 1), 'maxZ');
  });

  // ── 4.5 Length > width enforce ────────────────────────────────────────────
  t('4.5', 'Length along X enforced', () => {
    // Length on Z, short on X — after orient must swap
    const it = mkItem({
      shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
      meshPositionsMm: boxFlat(200, 100, 6000), // X=200, Z=6000 wrongly
    });
    // Override dims so Step3 still uses nominal L=6000
    it.lengthMm = 6000;
    const o = pipeline(it);
    // If mesh extents dominate collection, length enforce swaps X/Z
    assert(o.oriented_length + 1 >= o.oriented_width, `L=${o.oriented_length} W=${o.oriented_width}`);
    assert(approx(o.oriented_bbox.minX, 0, 1e-6), 'minX0');
  });

  // ── 4.6 Plate flat ────────────────────────────────────────────────────────
  t('4.6', 'Plate flat on ground', () => {
    const it = mkItem({
      shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12,
      lengthMm: 1000, widthMm: 500, heightMm: 12,
      meshPositionsMm: boxFlat(1000, 12, 500),
    });
    const o = pipeline(it);
    assert(approx(o.oriented_height, 12, 1), `h=${o.oriented_height}`);
    assert(o.oriented_length >= o.oriented_width - 1, 'L≥W');
    assert(approx(o.oriented_bbox.minY, 0, 1e-6), 'ground');
  });

  // ── 4.7 Welded bbox only ──────────────────────────────────────────────────
  t('4.7', 'Welded rafter bbox-only', () => {
    const it = mkItem({
      mark: 'RAF', sectH: 800, sectW: 300, sectT: 16, lengthMm: 12000,
      heightMm: 800, widthMm: 300,
    });
    it.crossSection = {
      outer_points: [[0, 0], [300, 0], [300, 800], [0, 800]],
      inner_points: [], cs_width: 300, cs_height: 800, cs_area: 240000,
      member_length: 12000, vertex_count: 4, welded_like: true, source: 'bbox',
      length_axis: 'X',
    };
    analyzeCrossSection(it);
    findBestOrientation(it);
    const o = applyOrientation(it);
    assert(o.source === 'bbox', `src=${o.source}`);
    assert(approx(o.oriented_height, 300, 1), `h=${o.oriented_height}`);
    assert(approx(o.oriented_width, 800, 1), `w=${o.oriented_width}`);
    assert(approx(o.oriented_length, 12000, 1), `L=${o.oriented_length}`);
  });

  // ── 4.8 Round bar ─────────────────────────────────────────────────────────
  t('4.8', 'Round bar symmetric', () => {
    const it = mkItem({
      shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16, lengthMm: 3000,
      meshPositionsMm: boxFlat(3000, 16, 16),
    });
    const o = pipeline(it);
    assert(approx(o.oriented_length, 3000, 1), 'L');
    assert(approx(o.oriented_height, 16, 1), 'H');
    assert(approx(o.oriented_width, 16, 1), 'W');
  });

  // ── 4.9 Transformation reverse ────────────────────────────────────────────
  t('4.9', 'Transformation reverse ≈ original', () => {
    const flat = boxFlat(6000, 200, 75, 10, 20, 30);
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      meshPositionsMm: flat.slice(),
    });
    const o = pipeline(it);
    assert(Math.abs(o.transformation.rotation_angle) === 90, 'rotated');
    const back = reverseOrientationVertices(
      o.oriented_vertices, o.transformation, o.original_bbox
    );
    assert(back && back.length === o.original_vertices.length, 'count');
    let maxD = 0;
    for (let i = 0; i < back.length; i++) {
      const d = Math.hypot(
        back[i][0] - o.original_vertices[i][0],
        back[i][1] - o.original_vertices[i][1],
        back[i][2] - o.original_vertices[i][2]
      );
      if (d > maxD) maxD = d;
    }
    assert(maxD < 2.0, `roundtrip maxD=${maxD}`);
  });

  // ── 4.10 Original preserved ───────────────────────────────────────────────
  t('4.10', 'Original mesh deep-copied', () => {
    const flat = boxFlat(1000, 200, 75);
    const snap = flat.slice();
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 1000,
      meshPositionsMm: flat,
    });
    const o = pipeline(it);
    // Source flat untouched
    for (let i = 0; i < snap.length; i++)
      assert(flat[i] === snap[i], 'source mesh mutated');
    // Oriented ≠ original (rotated)
    let diff = false;
    for (let i = 0; i < o.oriented_vertices.length; i++) {
      if (o.oriented_vertices[i][1] !== o.original_vertices[i][1]
          || o.oriented_vertices[i][2] !== o.original_vertices[i][2]) {
        diff = true; break;
      }
    }
    assert(diff, 'oriented should differ');
    // Mutate oriented — original copy unchanged
    const y0 = o.original_vertices[0][1];
    o.oriented_vertices[0][1] = 99999;
    assert(o.original_vertices[0][1] === y0, 'deep copy');
  });

  // ── 4.11 Multi sub-parts ──────────────────────────────────────────────────
  t('4.11', 'Assembly parts share transform', () => {
    const it = mkItem({
      mark: 'ASM', sectH: 400, sectW: 200, sectT: 12, lengthMm: 8000,
      isAssembly: true,
      parts: [
        { name: 'web', meshPositionsMm: boxFlat(8000, 400, 12, 0, 0, 94) },
        { name: 'top', meshPositionsMm: boxFlat(8000, 20, 200, 0, 380, 0) },
        { name: 'bot', meshPositionsMm: boxFlat(8000, 20, 200, 0, 0, 0) },
        { name: 's1', meshPositionsMm: boxFlat(12, 360, 180, 1000, 20, 10) },
        { name: 's2', meshPositionsMm: boxFlat(12, 360, 180, 5000, 20, 10) },
      ],
    });
    // Use i_beam path for Step3
    it.shapeKey = 'i_beam';
    it.sectTf = 20; it.sectTw = 12;
    extractCrossSection(it);
    analyzeCrossSection(it);
    findBestOrientation(it);
    const o = applyOrientation(it);
    assert(o.oriented_parts && o.oriented_parts.length === 5, `parts=${o.oriented_parts && o.oriented_parts.length}`);
    // Relative: all parts same rotation angle
    assert(o.transformation, 'xform');
    // Combined bbox on ground
    assert(approx(o.oriented_bbox.minY, 0, 1e-6), 'ground');
    // Parts didn't explode — extents finite and reasonable
    assert(o.oriented_length > 1000 && o.oriented_height > 0, 'dims');
  });

  // ── 4.12 Large mesh performance ───────────────────────────────────────────
  t('4.12', '50k verts < 100ms', () => {
    const n = 50000;
    const flat = new Array(n * 3);
    for (let i = 0; i < n; i++) {
      flat[i * 3] = (i % 1000) * 6;
      flat[i * 3 + 1] = (i % 200);
      flat[i * 3 + 2] = (i % 75);
    }
    const it = mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
      meshPositionsMm: flat,
    });
    extractCrossSection(it);
    analyzeCrossSection(it);
    findBestOrientation(it);
    const t0 = performance.now();
    const o = applyOrientation(it);
    const ms = performance.now() - t0;
    assert(o && o.oriented_vertices.length === n, 'count');
    assert(ms < 100, `ms=${ms.toFixed(1)}`);
  });

  // ── 4.13 Batch 500 ────────────────────────────────────────────────────────
  t('4.13', 'Batch 500 items', () => {
    const kinds = [
      () => ({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000 }),
      () => ({ shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3, lengthMm: 7200 }),
      () => ({ shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500 }),
      () => ({ shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000 }),
      () => ({ shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, sectD: 16, lengthMm: 3000 }),
    ];
    const items = [];
    for (let i = 0; i < 500; i++) {
      const k = kinds[i % kinds.length]();
      const it = mkItem(Object.assign({ mark: 'M' + i }, k));
      it.meshPositionsMm = boxFlat(k.lengthMm, k.sectH, k.sectW);
      items.push(it);
    }
    const t0 = performance.now();
    items.forEach(it => {
      extractCrossSection(it);
      analyzeCrossSection(it);
      findBestOrientation(it);
    });
    const stats = attachAppliedOrientationsToItems(items);
    const ms = performance.now() - t0;
    assert(stats.ok === 500, `ok=${stats.ok}`);
    items.forEach((it, i) => {
      const o = it.orientedItem;
      assert(o && approx(o.oriented_bbox.minY, 0, 1e-3), `minY ${i}`);
      assert(o.oriented_length + 1e-6 >= o.oriented_width, `L≥W ${i}`);
      assert(o.oriented_height >= 0, `h ${i}`);
    });
    assert(ms < 5000, `batch ms=${ms.toFixed(0)}`);
  });

  // ── 4.14 Axis convention ──────────────────────────────────────────────────
  t('4.14', 'X=L Y=H Z=W convention', () => {
    const cases = [
      { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000 },
      { shapeKey: 'i_beam', sectH: 400, sectW: 200, sectT: 12, sectTf: 20, sectTw: 12, lengthMm: 10000 },
      { shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500 },
      { shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000 },
      { shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000 },
    ];
    cases.forEach(c => {
      const it = mkItem(c);
      it.meshPositionsMm = boxFlat(c.lengthMm, c.sectH, c.sectW);
      const o = pipeline(it);
      assert(o.transformation.length_along === 'X', 'X');
      assert(o.transformation.height_along === 'Y', 'Y');
      assert(o.transformation.width_along === 'Z', 'Z');
      assert(o.oriented_length + 1 >= o.oriented_width, `${c.shapeKey} L≥W`);
      assert(approx(o.oriented_height, it.best_orientation.vertical_dim, 1.5),
        `${c.shapeKey} h=${o.oriented_height} vs ${it.best_orientation.vertical_dim}`);
    });
  });

  function runStep4TestSuite() {
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
      suite: 'step4_apply_orientation',
      total: TESTS.length, passed, failed, ok: failed === 0,
      results, ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step4Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r => console.warn(`  FAIL ${r.id}: ${r.error}`));
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep4TestSuite = runStep4TestSuite;
  global.__STEP4_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
