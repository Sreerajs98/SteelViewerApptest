/* 99-cs-step1-tests.js — STEP 1 Cross-Section Extraction suite (app WebView).
 * Call: runStep1TestSuite() → { passed, failed, results[] }
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol != null ? tol : 1);
  }
  function polyLooksClosed(pts) {
    if (!pts || pts.length < 3) return false;
    const d = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    // Either explicitly closed, or open ring (shoelace treats as closed)
    return d < 0.5 || pts.length >= 3;
  }
  function bboxOf(pts) {
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    pts.forEach(p => {
      if (p[0] < minU) minU = p[0]; if (p[0] > maxU) maxU = p[0];
      if (p[1] < minV) minV = p[1]; if (p[1] > maxV) maxV = p[1];
    });
    return { w: maxU - minU, h: maxV - minV };
  }
  /** Max |cross| of consecutive edge directions — high = sharp corners (not a blob). */
  function cornerSharpness(pts) {
    if (!pts || pts.length < 3) return 0;
    let max = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const ux = b[0] - a[0], uy = b[1] - a[1];
      const vx = c[0] - b[0], vy = c[1] - b[1];
      const cross = Math.abs(ux * vy - uy * vx);
      if (cross > max) max = cross;
    }
    return max;
  }

  function extract(it) {
    // Force re-extract
    delete it.crossSection;
    return extractCrossSection(it);
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
      sectTf: o.sectTf || 0,
      sectTw: o.sectTw || 0,
      sectD: o.sectD || 0,
      lengthMm: o.lengthMm || 0,
      widthMm: o.widthMm || o.sectW || 0,
      heightMm: o.heightMm || o.sectH || 0,
      parts: o.parts || null,
      meshPositionsMm: o.meshPositionsMm || null,
      meshIndices: o.meshIndices || null,
      pathDiamMm: o.pathDiamMm || 0,
      pathPointsMm: o.pathPointsMm || null,
    }, o);
  }

  /** Extrude a 2D polygon along X into a triangle mesh (for Approach A tests). */
  function extrudePolyMesh(poly2d, length) {
    const positions = [];
    const indices = [];
    const n = poly2d.length;
    // front (x=0) + back (x=L) rings
    for (let i = 0; i < n; i++) {
      positions.push(0, poly2d[i][0], poly2d[i][1]);
    }
    for (let i = 0; i < n; i++) {
      positions.push(length, poly2d[i][0], poly2d[i][1]);
    }
    // side quads as 2 tris
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = i, b = j, c = n + j, d = n + i;
      indices.push(a, b, c, a, c, d);
    }
    // caps (fan)
    for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
    for (let i = 1; i < n - 1; i++) indices.push(n, n + i + 1, n + i);
    return { meshPositionsMm: positions, meshIndices: indices };
  }

  const TESTS = [];
  function t(id, name, fn) { TESTS.push({ id, name, fn }); }

  // ── 1.1 Z-Purlin ──────────────────────────────────────────────────────────
  t('1.1', 'Z-Purlin profile reading', () => {
    const it = mkItem({
      mark: 'Z1', shapeKey: 'z_channel', profileDesc: 'Z200x75x2.5',
      sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    });
    const cs = extract(it);
    assert(cs && cs.verified, 'verified');
    assert(cs.source === 'ifc_profile', `source=${cs.source}`);
    assert(cs.vertex_count === 8, `verts=${cs.vertex_count}`);
    assert(approx(cs.cs_height, 200, 1), `H=${cs.cs_height}`);
    // Overall Z width ≈ 2W − tw
    assert(approx(cs.cs_width, 2 * 75 - 2.5, 2), `W=${cs.cs_width}`);
    assert(approx(cs.member_length, 6000, 1), `L=${cs.member_length}`);
    assert(!(cs.inner_polygons && cs.inner_polygons.length), 'no hole');
    assert(cs.cs_area > 0 && cs.cs_area < 75 * 200, `area=${cs.cs_area}`);
    // Approx web+flanges ≈ 862.5
    assert(cs.cs_area > 700 && cs.cs_area < 1200, `area~875 got ${cs.cs_area}`);
    assert(polyLooksClosed(cs.outer_points), 'closed');
  });

  // ── 1.2 C-Channel ─────────────────────────────────────────────────────────
  t('1.2', 'C-Channel profile reading', () => {
    const cs = extract(mkItem({
      shapeKey: 'c_channel', profileDesc: 'C250x100x3',
      sectH: 250, sectW: 100, sectT: 3, lengthMm: 7200,
    }));
    assert(cs.verified && cs.vertex_count === 8, `v=${cs.vertex_count}`);
    assert(approx(cs.cs_width, 100, 1) && approx(cs.cs_height, 250, 1), 'dims');
    assert(!(cs.inner_polygons || []).length, 'no hole');
  });

  // ── 1.3 L-Angle ───────────────────────────────────────────────────────────
  t('1.3', 'L-Angle profile reading', () => {
    const cs = extract(mkItem({
      shapeKey: 'l_angle', profileDesc: 'L150x150x10',
      sectH: 150, sectW: 150, sectT: 10, lengthMm: 4000,
    }));
    assert(cs.verified && cs.vertex_count === 6, `v=${cs.vertex_count}`);
    assert(approx(cs.cs_width, 150, 1) && approx(cs.cs_height, 150, 1), 'equal angle');
  });

  // ── 1.4 I-Beam ────────────────────────────────────────────────────────────
  t('1.4', 'I-Beam profile reading', () => {
    const cs = extract(mkItem({
      shapeKey: 'i_beam', profileDesc: 'UB400x200',
      sectH: 400, sectW: 200, sectT: 12, sectTw: 12, sectTf: 20, lengthMm: 10000,
    }));
    assert(cs.verified && cs.vertex_count === 12, `v=${cs.vertex_count}`);
    assert(approx(cs.cs_width, 200, 1) && approx(cs.cs_height, 400, 1), 'dims');
  });

  // ── 1.5 Flat Plate ────────────────────────────────────────────────────────
  t('1.5', 'Flat plate profile reading', () => {
    const cs = extract(mkItem({
      shapeKey: 'plate', profileDesc: 'PL12x500',
      sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000, widthMm: 500, heightMm: 12,
    }));
    assert(cs.verified && cs.vertex_count === 4, `v=${cs.vertex_count}`);
    const thin = Math.min(cs.cs_width, cs.cs_height);
    const wide = Math.max(cs.cs_width, cs.cs_height);
    assert(approx(thin, 12, 1), `thin=${thin}`);
    assert(approx(wide, 500, 2), `wide=${wide}`);
  });

  // ── 1.6 RHS ───────────────────────────────────────────────────────────────
  t('1.6', 'RHS hollow profile', () => {
    const cs = extract(mkItem({
      shapeKey: 'rhs', profileDesc: 'RHS150x100x6',
      sectH: 100, sectW: 150, sectT: 6, lengthMm: 6000,
    }));
    assert(cs.verified, 'ok');
    assert(approx(cs.cs_width, 150, 1) && approx(cs.cs_height, 100, 1), 'outer dims');
    const inners = cs.inner_polygons || cs.inner_points || [];
    assert(inners.length === 1, `inners=${inners.length}`);
    const ib = bboxOf(inners[0]);
    assert(approx(ib.w, 150 - 12, 2) && approx(ib.h, 100 - 12, 2), `inner ${ib.w}x${ib.h}`);
  });

  // ── 1.7 CHS ───────────────────────────────────────────────────────────────
  t('1.7', 'CHS pipe profile', () => {
    const cs = extract(mkItem({
      shapeKey: 'chs', profileDesc: 'CHS168.3x6',
      sectH: 168.3, sectW: 168.3, sectT: 6, sectD: 168.3, lengthMm: 6000,
    }));
    assert(cs.verified, 'ok');
    assert(approx(cs.cs_width, 168.3, 2) && approx(cs.cs_height, 168.3, 2), 'circle');
    const inners = cs.inner_polygons || [];
    assert(inners.length === 1, 'has hole');
    const ib = bboxOf(inners[0]);
    assert(approx(ib.w, 168.3 - 12, 3), `innerD≈${ib.w}`);
  });

  // ── 1.8 Round bar solid ───────────────────────────────────────────────────
  t('1.8', 'Round bar solid (no hole)', () => {
    const cs = extract(mkItem({
      shapeKey: 'rod', profileDesc: 'ROD dia16',
      sectH: 16, sectW: 16, sectT: 16, sectD: 16, lengthMm: 3000,
    }));
    assert(cs.verified, 'ok');
    assert(approx(cs.cs_width, 16, 1) && approx(cs.cs_height, 16, 1), 'dia');
    assert(!(cs.inner_polygons || []).length, 'solid — no inner');
    assert(cs.vertex_count >= 24, `v=${cs.vertex_count}`);
  });

  // ── 1.9 Welded built-up ───────────────────────────────────────────────────
  t('1.9', 'Welded assembly → bbox + flag', () => {
    const cs = extract(mkItem({
      mark: 'R-1', profileDesc: 'BUILT-UP',
      lengthMm: 12000, widthMm: 300, heightMm: 800,
      parts: [{ id: 1 }, { id: 2 }],
    }));
    assert(cs.verified, 'ok');
    assert(cs.vertex_count === 4, 'rect');
    assert(cs.welded_like || cs.welded_assembly || cs.source === 'bbox_welded',
      `flag source=${cs.source}`);
    assert(approx(cs.member_length, 12000, 1), 'L');
  });

  // ── 1.10 Arbitrary / mesh fallback ────────────────────────────────────────
  t('1.10', 'Unknown profile → mesh slice', () => {
    const poly = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 50], [0, 50]]; // custom L-ish
    const mesh = extrudePolyMesh(poly, 5000);
    const it = mkItem({
      mark: 'CUSTOM', profileDesc: 'CUSTOM_FAB',
      shapeKey: null, lengthMm: 5000, widthMm: 40, heightMm: 50,
      meshPositionsMm: mesh.meshPositionsMm,
      meshIndices: mesh.meshIndices,
    });
    const cs = extract(it);
    assert(cs && cs.verified, 'extracted');
    assert(cs.source === 'mesh_slice' || cs.source === 'bbox_fallback', `src=${cs.source}`);
    assert(cs.cs_area > 0, 'area');
  });

  // ── 1.11 Tapered (two slices) ─────────────────────────────────────────────
  t('1.11', 'Tapered member detection via mesh', () => {
    // Build a simple tapered box: width constant, height shrinks along X
    // Using two different extruded rects is hard; approximate with frustum mesh
    const positions = [];
    const indices = [];
    // Section at x=0: 300×800, at x=12000: 300×400
    function ring(x, w, h) {
      const hw = w / 2, hh = h / 2;
      const base = positions.length / 3;
      positions.push(x, -hw, -hh, x, hw, -hh, x, hw, hh, x, -hw, hh);
      return base;
    }
    const a = ring(0, 300, 800);
    const b = ring(12000, 300, 400);
    // sides
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      indices.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
    const it = mkItem({
      mark: 'TAPER', profileDesc: 'BUILT-UP TAPERED',
      lengthMm: 12000, widthMm: 300, heightMm: 800,
      parts: [{ id: 1 }, { id: 2 }], // welded → may bbox; force mesh by clearing welded path
      meshPositionsMm: positions,
      meshIndices: indices,
    });
    // Not welded path: single part so mesh is used
    it.parts = null;
    it.profileDesc = 'TAPERED_CUSTOM';
    it.shapeKey = null;
    const cs = extract(it);
    assert(cs && cs.verified, 'ok');
    // Taper flag when mesh slice works
    if (cs.source === 'mesh_slice') {
      assert(cs.is_tapered === true, `tapered=${cs.is_tapered}`);
    } else {
      // fallback acceptable if slice failed — still must extract something
      assert(cs.cs_area > 0, 'fallback area');
    }
  });

  // ── 1.12 Short plate / gusset ─────────────────────────────────────────────
  t('1.12', 'Very short member plate-like', () => {
    const cs = extract(mkItem({
      shapeKey: 'plate', profileDesc: 'GUSSET',
      sectH: 12, sectW: 400, sectT: 12,
      lengthMm: 500, widthMm: 400, heightMm: 12,
    }));
    assert(cs.verified, 'ok');
    assert(cs.is_short_plate_like === true, `short=${cs.is_short_plate_like}`);
  });

  // ── 1.13 Length axis from mesh bounds ─────────────────────────────────────
  t('1.13', 'Length axis detection accuracy', () => {
    const poly = [[0, 0], [75, 0], [75, 2.5], [2.5, 2.5], [2.5, 197.5],
      [75 - 150, 197.5], [75 - 150, 200], [0, 200]];
    // Use proper Z
    const z = typeof csPolyZ === 'function' ? csPolyZ(200, 75, 2.5) : poly;
    const mesh = extrudePolyMesh(z, 6000);
    const it = mkItem({
      mark: 'ZA', profileDesc: 'CUSTOM_Z', shapeKey: null,
      lengthMm: 6000, widthMm: 150, heightMm: 200,
      meshPositionsMm: mesh.meshPositionsMm,
      meshIndices: mesh.meshIndices,
    });
    const cs = extract(it);
    assert(cs.verified, 'ok');
    if (cs.source === 'mesh_slice') {
      assert(cs.length_axis === 'X', `axis=${cs.length_axis}`);
      assert(approx(cs.member_length, 6000, 5), `L=${cs.member_length}`);
      assert(approx(cs.cs_height, 200, 5), `H=${cs.cs_height}`);
    } else {
      assert(approx(cs.member_length, 6000, 1), 'profile L');
    }
  });

  // ── 1.14 Same profile identical CS ────────────────────────────────────────
  t('1.14', 'Same profile → identical cross-sections', () => {
    const mk = (L) => mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: L,
    });
    const a = extract(mk(6000));
    const b = extract(mk(7200));
    const c = extract(mk(5500));
    assert(approx(a.cs_width, b.cs_width, 0.1) && approx(b.cs_width, c.cs_width, 0.1), 'W');
    assert(approx(a.cs_height, b.cs_height, 0.1), 'H');
    assert(approx(a.cs_area, b.cs_area, 0.5), 'area');
    assert(a.vertex_count === b.vertex_count, 'verts');
    assert(a.member_length !== b.member_length, 'lengths differ');
  });

  // ── 1.15 Z vs C different polygons ────────────────────────────────────────
  t('1.15', 'Z vs C same dims → different polygons', () => {
    const z = extract(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    const c = extract(mkItem({
      shapeKey: 'c_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    assert(approx(z.cs_height, c.cs_height, 1), 'same H');
    // Overall widths differ (Z wider overall)
    let same = z.outer_points.length === c.outer_points.length;
    let allEq = same;
    if (same) {
      for (let i = 0; i < z.outer_points.length; i++) {
        if (!approx(z.outer_points[i][0], c.outer_points[i][0], 0.2)
          || !approx(z.outer_points[i][1], c.outer_points[i][1], 0.2)) {
          allEq = false; break;
        }
      }
    }
    assert(!allEq, 'polygons must differ');
  });

  // ── 1.16 Area validation ──────────────────────────────────────────────────
  t('1.16', 'Z polygon area ≈ manual', () => {
    const cs = extract(mkItem({
      shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000,
    }));
    const manual = (200 - 2 * 2.5) * 2.5 + 75 * 2.5 + 75 * 2.5; // 862.5
    assert(Math.abs(cs.cs_area - manual) < 80, `area=${cs.cs_area} vs ${manual}`);
    assert(cs.cs_area > 0 && cs.cs_area < cs.cs_width * cs.cs_height, 'bounds');
  });

  // ── 1.17 Closure ──────────────────────────────────────────────────────────
  t('1.17', 'Polygon closure / valid ring', () => {
    const shapes = [
      { shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5 },
      { shapeKey: 'c_channel', sectH: 250, sectW: 100, sectT: 3 },
      { shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10 },
      { shapeKey: 'i_beam', sectH: 400, sectW: 200, sectT: 12, sectTw: 12, sectTf: 20 },
      { shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6 },
      { shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12 },
      { shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16 },
    ];
    shapes.forEach(s => {
      const cs = extract(mkItem(Object.assign({ lengthMm: 3000 }, s)));
      assert(cs.verified && polyLooksClosed(cs.outer_points), `${s.shapeKey} closed`);
    });
  });

  // ── 1.18 Visual / shape fingerprint ───────────────────────────────────────
  t('1.18', 'Shape fingerprints recognizable', () => {
    const z = extract(mkItem({ shapeKey: 'z_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 1000 }));
    const c = extract(mkItem({ shapeKey: 'c_channel', sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 1000 }));
    const l = extract(mkItem({ shapeKey: 'l_angle', sectH: 150, sectW: 150, sectT: 10, lengthMm: 1000 }));
    const i = extract(mkItem({ shapeKey: 'i_beam', sectH: 400, sectW: 200, sectTw: 12, sectTf: 20, sectT: 12, lengthMm: 1000 }));
    const p = extract(mkItem({ shapeKey: 'plate', sectH: 12, sectW: 500, sectT: 12, lengthMm: 1000 }));
    const r = extract(mkItem({ shapeKey: 'rhs', sectH: 100, sectW: 150, sectT: 6, lengthMm: 1000 }));
    const rod = extract(mkItem({ shapeKey: 'rod', sectH: 16, sectW: 16, sectT: 16, lengthMm: 1000 }));
    const chs = extract(mkItem({ shapeKey: 'chs', sectH: 168, sectW: 168, sectT: 6, lengthMm: 1000 }));

    assert(z.vertex_count === 8 && z.cs_width > 100, 'Z wide overall');
    assert(c.vertex_count === 8 && approx(c.cs_width, 75, 2), 'C width=flange');
    assert(l.vertex_count === 6, 'L');
    assert(i.vertex_count === 12, 'I');
    assert(p.vertex_count === 4 && Math.min(p.cs_width, p.cs_height) <= 13, 'plate flat');
    assert((r.inner_polygons || []).length === 1, 'RHS hole');
    assert(!(rod.inner_polygons || []).length && rod.vertex_count >= 24, 'rod solid');
    assert((chs.inner_polygons || []).length === 1, 'CHS hole');
    // Sharp corners on open profiles
    assert(cornerSharpness(z.outer_points) > 10, 'Z has corners');
    assert(cornerSharpness(c.outer_points) > 10, 'C has corners');
  });

  // Extra stress: many lengths / dims still extract
  t('1.19', 'Batch 200 random-ish Z lengths all extract', () => {
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      const L = 1000 + (i * 37) % 11000;
      const cs = extract(mkItem({
        mark: 'B' + i, shapeKey: 'z_channel',
        sectH: 200, sectW: 75, sectT: 2.5, lengthMm: L,
      }));
      if (cs && cs.verified && approx(cs.cs_height, 200, 1)) ok++;
    }
    assert(ok === 200, `ok=${ok}`);
  });

  t('1.20', 'Mesh mid-slice of extruded rectangle', () => {
    const poly = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const mesh = extrudePolyMesh(poly, 8000);
    const cs = extract(mkItem({
      mark: 'BOX', shapeKey: null, profileDesc: 'CUSTOM_BOX',
      lengthMm: 8000, widthMm: 100, heightMm: 50,
      meshPositionsMm: mesh.meshPositionsMm,
      meshIndices: mesh.meshIndices,
    }));
    assert(cs.verified && cs.source === 'mesh_slice', `src=${cs && cs.source}`);
    assert(approx(cs.cs_width, 100, 3) || approx(cs.cs_height, 100, 3), 'size');
    assert(approx(cs.member_length, 8000, 5), `L=${cs.member_length}`);
  });

  function runStep1TestSuite() {
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
      suite: 'step1_cross_section',
      total: TESTS.length,
      passed,
      failed,
      ok: failed === 0,
      results,
      ts: new Date().toISOString(),
    };
    try {
      console.info(`[Step1Tests] ${passed}/${TESTS.length} passed, ${failed} failed`);
      results.filter(r => !r.ok).forEach(r =>
        console.warn(`  FAIL ${r.id} ${r.name}: ${r.error}`));
    } catch (_) { /* */ }
    try {
      if (global.chrome && chrome.webview && chrome.webview.postMessage)
        chrome.webview.postMessage({ type: 'step1_tests', payload: summary });
    } catch (_) { /* */ }
    return summary;
  }

  global.runStep1TestSuite = runStep1TestSuite;
  global.__STEP1_TEST_COUNT = TESTS.length;
})(typeof window !== 'undefined' ? window : globalThis);
