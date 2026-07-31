/* 99-cs-z-ground-measure.js — Headless: make Z, MOVE to ground, report dy */
function runZGroundMeasureSuite() {
  const results = [];
  function t(id, name, fn) { results.push({ id, name, fn }); }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assert');
  }

  t('ZG.1', 'makeShape Z then MOVE to ground — measure dy', () => {
    assert(typeof makeShape === 'function', 'makeShape');
    assert(typeof csNzSnapObjectToGround === 'function', 'snap');
    assert(typeof THREE !== 'undefined', 'THREE');

    const it = {
      mark: 'Z-MEASURE',
      shapeKey: 'z_channel',
      profileShape: 'z_channel',
      category: 'purlin',
      sectH: 200, sectW: 75, sectT: 2.5, sectD: 17,
      lengthMm: 6000, heightMm: 200, widthMm: 75, qty: 1,
    };

    const mesh = makeShape(it, 0x8866aa, 1);
    assert(mesh, 'mesh');

    // Simulate layoutOutside centre placement (causes float before snap)
    const footY = 200; // mm typical staging
    const SCALE_L = (typeof SCALE === 'number') ? SCALE : 0.001;
    mesh.position.set(1, (footY / 2) * SCALE_L, 2);
    mesh.updateMatrixWorld(true);

    const boxBefore = (typeof csNzMeshWorldBox === 'function')
      ? csNzMeshWorldBox(mesh)
      : new THREE.Box3().setFromObject(mesh);
    const minBefore = boxBefore.min.y;

    const snap = csNzSnapObjectToGround(mesh);
    mesh.updateMatrixWorld(true);
    const boxAfter = (typeof csNzMeshWorldBox === 'function')
      ? csNzMeshWorldBox(mesh)
      : new THREE.Box3().setFromObject(mesh);
    const minAfter = boxAfter.min.y;
    const groundY = (typeof SCENE_GROUND_Y === 'number') ? SCENE_GROUND_Y : 0;

    const measure = {
      minY_before_move: +minBefore.toFixed(6),
      minY_after_move: +minAfter.toFixed(6),
      moved_y: snap?.moved_y != null ? +snap.moved_y.toFixed(6) : +(groundY - minBefore).toFixed(6),
      moved_y_mm: +(((snap?.moved_y != null ? snap.moved_y : (groundY - minBefore)) / SCALE_L)).toFixed(3),
      ground_y: groundY,
      ground_touch: Math.abs(minAfter - groundY) < 1e-4,
      nest_deg: it.orientation_info?.nesting_angle_deg
        || mesh.userData?.zNestingAngle?.applied_deg
        || null,
    };

    // Attach for suite summary
    globalThis.__Z_GROUND_MEASURE = measure;

    assert(measure.ground_touch, `still floating minY=${minAfter}`);
    assert(Math.abs(measure.moved_y) > 0 || Math.abs(minBefore - groundY) < 1e-4, 'move recorded');
  });

  t('ZG.2', 'second MOVE is ~0 (already on ground)', () => {
    const it = {
      mark: 'Z-MEASURE2',
      shapeKey: 'z_channel', profileShape: 'z_channel', category: 'purlin',
      sectH: 200, sectW: 75, sectT: 2.5, lengthMm: 6000, qty: 1,
    };
    const mesh = makeShape(it, 0x8866aa, 1);
    csNzSnapObjectToGround(mesh);
    const snap2 = csNzSnapObjectToGround(mesh);
    assert(Math.abs(snap2.moved_y || 0) < 1e-5, `second move ${snap2.moved_y}`);
    assert(snap2.ok, 'ok');
  });

  let passed = 0, failed = 0;
  const rows = [];
  for (const tc of results) {
    const row = { id: tc.id, name: tc.name, ok: false, error: null };
    try { tc.fn(); row.ok = true; passed++; }
    catch (e) { row.ok = false; row.error = String(e && e.message ? e.message : e); failed++; }
    rows.push(row);
  }

  const summary = {
    suite: 'z_ground_measure',
    ok: failed === 0,
    passed, failed, total: results.length,
    measure: globalThis.__Z_GROUND_MEASURE || null,
    results: rows,
    ts: new Date().toISOString(),
  };
  try {
    console.info(`[ZGroundMeasure] ${passed}/${results.length} |`, summary.measure);
  } catch (_) { /* */ }
  return summary;
}

try {
  if (typeof window !== 'undefined') window.runZGroundMeasureSuite = runZGroundMeasureSuite;
} catch (_) { /* */ }
