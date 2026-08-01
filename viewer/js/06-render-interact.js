/* 06-render-interact.js — render, drag, rotate, place */
function round1(n) { return Math.round(n*10)/10; }
function round2(n) { return Math.round(n*100)/100; }

/** Visual + contact ground plane Y (world). Grid sits a hair below to avoid z-fight. */
const SCENE_GROUND_Y = 0;
const SCENE_GRID_Y = -0.001; // 1mm only — old -0.08 looked like floating

/** Safe-zone accent — distinct from blue container shell (warehouse “load here”). */
const SAFE_ZONE_COLOR = 0x1b9e75;

/**
 * Human-readable safe load zone on the floor:
 * tinted pad + solid border + corner ticks. Blue box stays the container shell.
 */
function addSafeZoneVisual(cont) {
  if (!cont || typeof THREE === 'undefined') return;
  if (typeof getPackEnvelope !== 'function') return;
  const env = getPackEnvelope(cont);
  const eL = env.lengthMm * SCALE;
  const eW = env.widthMm * SCALE;
  if (!(eL > 0.02 && eW > 0.02)) return;

  const light = currentTheme() === 'light';
  const group = new THREE.Group();
  group.name = 'safeZoneVisual';
  group.userData.isSafeZoneOutline = true;
  group.userData.safeZoneColor = SAFE_ZONE_COLOR;

  const cx = (env.minXMm + env.maxXMm) * 0.5 * SCALE;
  const yPad = 0.003; // sit just above floor / grid

  // 1) Floor pad — “steel must stay on this carpet”
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(eL, eW),
    new THREE.MeshBasicMaterial({
      color: SAFE_ZONE_COLOR,
      transparent: true,
      opacity: light ? 0.14 : 0.20,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, yPad, 0);
  pad.userData.isSafeZoneOutline = true;
  group.add(pad);

  // 2) Solid border on floor (clear edge — not dashed)
  const hx = eL * 0.5, hz = eW * 0.5;
  const borderGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx, yPad + 0.001, -hz),
    new THREE.Vector3(hx, yPad + 0.001, -hz),
    new THREE.Vector3(hx, yPad + 0.001, hz),
    new THREE.Vector3(-hx, yPad + 0.001, hz),
    new THREE.Vector3(-hx, yPad + 0.001, -hz),
  ]);
  const border = new THREE.Line(
    borderGeo,
    new THREE.LineBasicMaterial({
      color: SAFE_ZONE_COLOR,
      transparent: true,
      opacity: light ? 0.95 : 0.9,
    })
  );
  border.userData.isSafeZoneOutline = true;
  group.add(border);

  // 3) Corner L-ticks — warehouse floor marks (easy to read in 3D)
  const tick = Math.min(eL, eW) * 0.06;
  const tickH = Math.max(0.04, Math.min(cont.heightMm * SCALE * 0.04, 0.12));
  const corners = [
    [-hx, -hz, 1, 1],
    [hx, -hz, -1, 1],
    [hx, hz, -1, -1],
    [-hx, hz, 1, -1],
  ];
  const tickMat = new THREE.LineBasicMaterial({
    color: SAFE_ZONE_COLOR,
    transparent: true,
    opacity: light ? 1 : 0.95,
  });
  corners.forEach(([x, z, sx, sz]) => {
    const pts = [
      new THREE.Vector3(x + sx * tick, yPad + 0.002, z),
      new THREE.Vector3(x, yPad + 0.002, z),
      new THREE.Vector3(x, yPad + 0.002, z + sz * tick),
    ];
    const arm = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      tickMat
    );
    arm.userData.isSafeZoneOutline = true;
    group.add(arm);
    // short upright so depth reads clearly
    const up = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, yPad, z),
        new THREE.Vector3(x, yPad + tickH, z),
      ]),
      tickMat
    );
    up.userData.isSafeZoneOutline = true;
    group.add(up);
  });

  group.position.set(cx, 0, 0);
  scene.add(group);
}

/** Viewport chip: plain language for blue shell vs green load zone. */
function updateSafeZoneLegend(cont) {
  let el = document.getElementById('safeZoneLegend');
  if (!el) {
    const vp = document.getElementById('viewport');
    if (!vp) return;
    el = document.createElement('div');
    el.id = 'safeZoneLegend';
    el.setAttribute('role', 'status');
    Object.assign(el.style, {
      position: 'absolute',
      left: '12px',
      bottom: '48px',
      zIndex: '6',
      maxWidth: '280px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid var(--border2)',
      background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
      backdropFilter: 'blur(6px)',
      fontSize: '11.5px',
      lineHeight: '1.45',
      color: 'var(--text2)',
      pointerEvents: 'none',
      boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
    });
    vp.appendChild(el);
  }
  if (!cont || typeof getPackEnvelope !== 'function') {
    el.style.display = 'none';
    return;
  }
  const env = getPackEnvelope(cont);
  el.style.display = 'block';
  el.innerHTML =
    `<div style="font-weight:600;color:var(--text);margin-bottom:4px">How to read the box</div>`
    + `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">`
    + `<span style="width:14px;height:3px;background:var(--container-line,#3b82f6);border-radius:2px;flex:0 0 auto"></span>`
    + `<span><b style="color:var(--text)">Blue outline</b> — container walls</span></div>`
    + `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">`
    + `<span style="width:14px;height:10px;background:rgba(27,158,117,0.35);border:1.5px solid #1b9e75;border-radius:2px;flex:0 0 auto"></span>`
    + `<span><b style="color:var(--text)">Green floor</b> — load zone (keep cargo inside)</span></div>`
    + `<div style="margin-top:5px;font-size:10.5px;color:var(--text3)">`
    + `Clearance: ${Math.round(env.clearanceSideMm)} mm sides · `
    + `${Math.round(env.clearanceEndMm)} mm ends · `
    + `${Math.round(env.clearanceTopMm)} mm top</div>`;
}

// ------------------------------------------------------------------
// RENDERING (same for both modes - they produce the same shape of data)
// ------------------------------------------------------------------
function renderContainer(idx) {
  clearScene();
  currentContainerIdx = idx;
  const cont = currentLayout.containers[idx];
  const cL = cont.lengthMm*SCALE, cW = cont.widthMm*SCALE, cH = cont.heightMm*SCALE;

  const contLine = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(cL, cH, cW)),
    new THREE.LineBasicMaterial({
      color: themeSceneHex('container'),
      transparent: true,
      opacity: currentTheme() === 'light' ? 1 : 0.95,
    }));
  contLine.position.set(cL/2, cH/2, 0);
  contLine.userData.isContainerOutline = true;
  scene.add(contLine);

  // Safe load zone — floor pad + solid border (not a second dotted box)
  addSafeZoneVisual(cont);
  updateSafeZoneLegend(cont);

  // Full floor grid — covers container + staging area (not a small pad under the box)
  const gridSize = Math.max(cL * 6, cW * 12, 500);
  const gridDivs = Math.min(100, Math.max(48, Math.round(gridSize / 10)));
  const grid = new THREE.GridHelper(gridSize, gridDivs, themeSceneHex('gridMajor'), themeSceneHex('gridMinor'));
  grid.position.set(cL / 2, SCENE_GRID_Y, 0); // hair below Y=0 — pieces snap to SCENE_GROUND_Y
  scene.add(grid);

  let pieceCount = 0;
  cont.items.forEach(it => {
    const color = COLORS[it.category] ?? COLORS.other;
    const box = makeShape(it, color);
    box.position.set(it.x*SCALE, it.y*SCALE, it.z*SCALE);
    // Keep packer / user orientation (yaw-only, face-roll compose, or absolute).
    applyPackItemRotation(box, it);
    scene.add(box);
    const sid = it.stagingGroupId || findStagingIdForUnit(it);
    if (sid && !it.stagingGroupId) it.stagingGroupId = sid;
    clickable.push({ mesh: box, item: it, stagingGroupId: sid || null });
    pieceCount += it.qty;
  });

  // Gravity / clamp ONLY for unlocked items (user-dragged / legacy).
  // Step8 packPoseLock + restore exactPoseLock keep the pose the packer/user set.
  const inside = clickable.filter(c => !c.outsideContainer);
  const unlocked = inside.filter(c =>
    !c.item?.packPoseLock && !c.item?.exactPoseLock);
  if (unlocked.length) {
    restackWithGravity(unlocked);
    resolveAabbOverlaps(unlocked);
    restackWithGravity(unlocked);
    resolveAabbOverlaps(unlocked);
    restackWithGravity(unlocked);
    clampMeshesInsideContainer(unlocked.map(c => c.mesh), cont);
    clampMeshesInsideContainer(unlocked.map(c => c.mesh), cont);
  }
  // Locked packed items: sync item.x/y/z from mesh only if missing — never move mesh
  inside.forEach(c => {
    if (!c.item?.packPoseLock || !c.mesh) return;
    c.mesh.position.set(
      (c.item.x || 0) * SCALE,
      (c.item.y || 0) * SCALE,
      (c.item.z || 0) * SCALE
    );
  });

  if (idx === 0 && currentLayout.oversized && currentLayout.oversized.length) {
    // Items outside container — render with REAL shapes (makeShape), not plain boxes.
    // When coming from layoutOutside(), items already have x/y/z set.
    // For truly oversized items (bigger than container), cap display size.
    const MAX_DISP = 3000;
    currentLayout.oversized.forEach((it, i) => {
      const itemForRender = {
        ...it,
        lengthMm: it.lengthMm || it.l || 500,
        widthMm:  it.widthMm  || it.w || 200,
        heightMm: it.heightMm || it.h || 200,
        // carry exact section dims for real shape rendering
        shapeKey: it.shapeKey, sectH: it.sectH, sectW: it.sectW,
        sectT: it.sectT, sectD: it.sectD, sectTf: it.sectTf, sectTw: it.sectTw,
        profileShape: it.profileShape,
        unitHeight: it.unitHeight, unitWidth: it.unitWidth,
        gridCols: it.gridCols, gridRows: it.gridRows,
        nested: it.nested, stacked: it.stacked, bundled: it.bundled,
        beamBundle: it.beamBundle, unitDiam: it.unitDiam,
        unitThickness: it.unitThickness, qty: it.qty || 1,
        category: it.category,
        isAssembly: it.isAssembly,
        parts: it.parts,
        pathPointsMm: it.pathPointsMm || null,
        pathDiamMm: it.pathDiamMm || 0,
      };
      const color = COLORS[it.category] ?? COLORS.other; // real color, not red
      const mesh = makeShape(itemForRender, color, 0.93);

      // Use pre-computed position if available (from layoutOutside/layoutPlaceSelected)
      if (it.x !== undefined) {
        mesh.position.set(it.x * SCALE, it.y * SCALE, it.z * SCALE);
      } else {
        // Fallback position: line up outside container along +Z
        const dL = Math.min(Math.max(itemForRender.lengthMm, 1), cont.lengthMm);
        const dH = Math.min(itemForRender.heightMm, MAX_DISP);
        const dW = Math.min(itemForRender.widthMm, MAX_DISP);
        mesh.position.set(
          (dL/2)*SCALE,
          (dH/2)*SCALE,
          (cont.widthMm/2 + 500 + i*(Math.min(dW, 600) + 200))*SCALE
        );
      }
      applyPackItemRotation(mesh, it);
      scene.add(mesh);
      clickable.push({ mesh, item: {
        mark: it.mark, assemblyName: it.assemblyName,
        lengthMm: itemForRender.lengthMm,
        widthMm:  itemForRender.widthMm,
        heightMm: itemForRender.heightMm,
        unitWeightKg: it.weight || it.unitWeightKg || 0,
        qty: it.qty || 1,
        category: it.category,
        profileShape: it.profileShape,
        shapeKey: it.shapeKey, sectH: it.sectH, sectW: it.sectW,
        sectT: it.sectT, sectD: it.sectD,
        unitHeight: it.unitHeight, unitWidth: it.unitWidth,
        marks: it.marks || (it.mark ? [it.mark] : []),
        nestPieces: it.nestPieces || null,
        stagingGroupId: it.stagingGroupId || null,
        packUnitIndex: it.packUnitIndex,
        isAssembly: !!it.isAssembly,
        parts: it.parts || null,
        pathPointsMm: it.pathPointsMm || null,
        pathDiamMm: it.pathDiamMm || 0,
        outsideContainer: true,
        restoredFromOptimise: !!it.restoredFromOptimise,
        exactPoseLock: !!it.exactPoseLock,
      }, outsideContainer: true, stagingGroupId: it.stagingGroupId || null });
      pieceCount += (it.qty || 1);
    });
    // Floor-sit ONLY unlocked (exactPoseLock keeps pre-optimise Y)
    const outsAll = clickable.filter(c => c.outsideContainer);
    const outsFree = outsAll.filter(c => !c.item?.exactPoseLock);
    const groundY = (typeof SCENE_GROUND_Y === 'number') ? SCENE_GROUND_Y : 0;
    // MOVE every free outside piece to ground (geometry verts — no rotate)
    const snapOut = (c) => {
      if (typeof csNzSnapObjectToGround === 'function') {
        const s = csNzSnapObjectToGround(c.mesh);
        if (s && Math.abs(s.moved_y || 0) > 1e-5) {
          try {
            console.info(
              `[ground MOVE] ${c.item?.mark || '?'} dy=${s.moved_y.toFixed(4)}`
              + ` (${(s.moved_y / ((typeof SCALE === 'number') ? SCALE : 0.001)).toFixed(1)} mm)`
            );
          } catch (_) { /* */ }
        }
        return;
      }
      c.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(c.mesh);
      const dy = groundY - box.min.y;
      if (Math.abs(dy) > 1e-5) c.mesh.position.y += dy;
    };
    outsFree.forEach(snapOut);
    if (outsAll.length >= 2) {
      // Assemblies present → wider gap (human leaves walk space between frames)
      const hasAsm = outsAll.some(c =>
        c.item?.isAssembly || c.item?.groupKind === 'welded_assembly'
        || (c.item?.parts && c.item.parts.length >= 2));
      const nMove = deconflictOutsideClickables(outsAll, hasAsm ? 160 : 80);
      try {
        if (nMove > 0) console.info(`[staging] deconflict moved ${nMove} axis-steps (no shape change)`);
      } catch (_) { /* */ }
    }
    // FINAL MOVE pass after deconflict — assemblies must touch ground again
    outsFree.forEach(snapOut);
  }

  // Zoom out enough to see full 40ft box + outside staging lane
  camera.position.set(cL * 1.25, cH * 2.2, cL * 1.05);
  controls.target.set(cL / 2, cH * 0.35, 0);
  controls.update();

  // Update right-panel container stats (null-safe — element may not exist in current layout)
  setEl('contDims', `${cont.lengthMm}x${cont.widthMm}x${cont.heightMm}mm`);
  setEl('pieceCount', pieceCount);
  setEl('weightUtil', `${cont.usedWeightKg} kg / ${cont.maxWeightKg} kg (${cont.weightUtilizationPct}%)`);
  setEl('volUtil', `${cont.volumeUtilizationPct}%`);
  // Update active container card in right panel
  renderContainerList();

  // Shape breakdown - shows how many of each cross-section this container holds
  const shapeCounts = {};
  cont.items.forEach(it => {
    const label = it.profileShape || '(unknown)';
    shapeCounts[label] = (shapeCounts[label] || 0) + (it.qty || 1);
  });
  const shapeSumEl = document.getElementById('shapeSum');
  if (shapeSumEl) {
    const labels = { plate:'Plates', rod:'Rods', z_channel:'Z-purlins',
                     c_channel:'C-channels', l_angle:'L-angles',
                     i_beam:'I-beams', rhs:'Hollow tubes' };
    const rows = Object.entries(shapeCounts)
      .sort((a,b) => b[1]-a[1])
      .map(([k,v]) => `<div style="display:flex;justify-content:space-between"><span>${labels[k]||k}</span><b>${v}</b></div>`)
      .join('');
    shapeSumEl.innerHTML = rows;
  }

  renderTabs();
  document.getElementById('info').style.display = 'none';

  // ── Centre-of-Gravity calculation ───────────────────────────────────────
  // CoG_x = Σ(m_i · x_i) / Σm_i   (longitudinal, along container length)
  // CoG_z = Σ(m_i · z_i) / Σm_i   (lateral, across container width)
  // Flag a warning when either axis deviates more than 10% from the
  // geometric centre of the container.
  (function renderCoG() {
    const cogEl = document.getElementById('cogInfo');
    if (!cogEl) return;
    if (!cont || !cont.items || cont.items.length === 0) { cogEl.innerHTML = ''; return; }

    let totalMass = 0, sumX = 0, sumZ = 0;
    cont.items.forEach(it => {
      const m = it.unitWeightKg || 0;
      totalMass += m;
      sumX += m * (it.x || 0);
      sumZ += m * (it.z || 0);
    });

    if (totalMass <= 0) { cogEl.innerHTML = ''; return; }

    const cogX = sumX / totalMass;   // mm from back wall
    const cogZ = sumZ / totalMass;   // mm from centreline

    const centreX = cont.lengthMm / 2;
    const centreZ = 0;   // z is already relative to centreline
    const cogFrac = (typeof getLoadingRules === 'function')
      ? getLoadingRules().MAX_COG_OFFSET_FRAC
      : 0.10;
    const tolX = cont.lengthMm * cogFrac;
    const tolZ = cont.widthMm  * cogFrac;

    const warnX = Math.abs(cogX - centreX) > tolX;
    const warnZ = Math.abs(cogZ - centreZ) > tolZ;
    const warnStyle = 'color:#E24B4A;font-weight:600';
    const okStyle   = 'color:#1D9E75';

    cogEl.innerHTML = `
      <div style="margin-top:10px;border-top:1px solid #333;padding-top:8px;font-size:11.5px">
        <b style="color:#e8e6df">Centre of Gravity</b><br>
        <span style="${warnX ? warnStyle : okStyle}">
          Longitudinal: ${Math.round(cogX)} mm from back wall
          ${warnX ? ' ⚠ off-centre > 10%' : ' ✓'}
        </span><br>
        <span style="${warnZ ? warnStyle : okStyle}">
          Lateral: ${Math.round(cogZ)} mm from centreline
          ${warnZ ? ' ⚠ off-centre > 10%' : ' ✓'}
        </span>
      </div>`;
  })();
}

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  currentLayout.containers.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.textContent = `Container ${c.containerNumber}`;
    btn.className = i === currentContainerIdx ? 'active' : '';
    btn.onclick = () => renderContainer(i);
    tabsEl.appendChild(btn);
  });
}

function findClickableRoot(obj) {
  let cur = obj;
  while (cur) {
    const found = clickable.find(c => c.mesh === cur);
    if (found) return found;
    cur = cur.parent;
  }
  return null;
}

// ------------------------------------------------------------------
// MANUAL PLACEMENT - select any placed piece, move it (100mm steps) or
// rotate it (90 degree steps), with a live overlap/bounds check after
// every action. Rotation is restricted to 90 degree increments
// deliberately: it keeps the "does this collide" check exact (an
// axis-aligned bounding box after a 90 degree turn is still an exact
// axis-aligned box - no approximation), while still covering the real
// case that matters, turning a piece to face a different way to make it
// fit better.
// ------------------------------------------------------------------
let selected = null;
const MOVE_STEP_MM = 100;

// --- Drag-to-place state (1:1 mouse follow on locked XZ plane) ---
let isDragging = false;
let dragArmed = false; // mousedown on piece; becomes drag after small move
let dragMoved = false;
let dragStartPosition = null;
let dragWasOutside = false;
let dragOffsetXZ = { x: 0, z: 0 };
let dragPlaneY = 0; // locked for whole drag → mouse speed = item speed
let dragStartClient = { x: 0, y: 0 };
const DRAG_THRESHOLD_PX = 5;
const dragPlane = new THREE.Plane();
const dragIntersection = new THREE.Vector3();

// --- Rotation preview widget state (independent mini scene in top-right) ---
let previewScene = null, previewCamera = null, previewRenderer = null;
let previewControls = null, previewMesh = null;
let previewRotation = { x: 0, y: 0, z: 0 };
let previewInitialized = false;
let previewSource = null; // { item, fromStaging, stagingGroup, marks }
let previewDraggingPiece = false;
let previewLastPtr = { x: 0, y: 0 };
/** Rotation widget step in degrees (1 / 5 / 15 / 45 / 90) */
let rotStepDeg = 5;
/** Euler at widget open — Δ readout is from this baseline. */
let previewStartRotation = { x: 0, y: 0, z: 0 };
/** The piece mesh inside preview (not the axes helper). */
let previewShapeMesh = null;

function initRotPreview() {
  if (previewInitialized) return;
  const canvas = document.getElementById('rotPreviewCanvas');
  previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(themeSceneHex('preview'));
  previewCamera = new THREE.PerspectiveCamera(35, 412/300, 0.01, 2000);
  previewCamera.position.set(3, 2, 3);
  previewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  previewRenderer.setSize(412, 300, false);
  previewControls = new THREE.OrbitControls(previewCamera, canvas);
  previewControls.enableZoom = true;
  previewControls.enablePan = false;
  previewControls.mouseButtons = {
    LEFT: -1, // left = free-rotate piece (custom)
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE
  };

  previewScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(5, 10, 7);
  previewScene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dir2.position.set(-5, -3, -7);
  previewScene.add(dir2);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !previewMesh) return;
    previewDraggingPiece = true;
    previewControls.enabled = false;
    previewLastPtr = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!previewDraggingPiece || !previewShapeMesh) return;
    const shape = previewShapeMesh;
    const dx = e.clientX - previewLastPtr.x;
    const dy = e.clientY - previewLastPtr.y;
    previewLastPtr = { x: e.clientX, y: e.clientY };
    // Free rotate any angle (not snapped to 90°)
    shape.rotation.y += dx * 0.012;
    shape.rotation.x += dy * 0.012;
    updateRotDegHud();
  });
  const endDrag = (e) => {
    if (!previewDraggingPiece) return;
    previewDraggingPiece = false;
    previewControls.enabled = true;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  previewInitialized = true;
  animatePreview();
}

function animatePreview() {
  requestAnimationFrame(animatePreview);
  if (previewRenderer && previewControls && previewMesh) {
    previewControls.update();
    previewRenderer.render(previewScene, previewCamera);
  }
}

function rotDeg(rad) {
  return (Number(rad) || 0) * 180 / Math.PI;
}

function rotNormDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function updateRotDegHud() {
  if (!previewShapeMesh) return;
  const shapeMesh = previewShapeMesh;
  const cx = rotDeg(shapeMesh.rotation.x);
  const cy = rotDeg(shapeMesh.rotation.y);
  const cz = rotDeg(shapeMesh.rotation.z);
  const dx = rotNormDeg(cx - rotDeg(previewStartRotation.x));
  const dy = rotNormDeg(cy - rotDeg(previewStartRotation.y));
  const dz = rotNormDeg(cz - rotDeg(previewStartRotation.z));
  const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1) + '°';
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  set('rotHudX', fmt(cx));
  set('rotHudY', fmt(cy));
  set('rotHudZ', fmt(cz));
  set('rotHudDx', (dx >= 0 ? '+' : '') + fmt(dx));
  set('rotHudDy', (dy >= 0 ? '+' : '') + fmt(dy));
  set('rotHudDz', (dz >= 0 ? '+' : '') + fmt(dz));
  previewRotation = { x: shapeMesh.rotation.x, y: shapeMesh.rotation.y, z: shapeMesh.rotation.z };
}

function copyRotDelta() {
  if (!previewShapeMesh) return;
  const shapeMesh = previewShapeMesh;
  const dx = rotNormDeg(rotDeg(shapeMesh.rotation.x) - rotDeg(previewStartRotation.x));
  const dy = rotNormDeg(rotDeg(shapeMesh.rotation.y) - rotDeg(previewStartRotation.y));
  const dz = rotNormDeg(rotDeg(shapeMesh.rotation.z) - rotDeg(previewStartRotation.z));
  const text = `Z nest delta: ΔX=${dx.toFixed(1)}° ΔY=${dy.toFixed(1)}° ΔZ=${dz.toFixed(1)}°`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(text);
  } catch (_) { /* */ }
  try { console.info('[rot]', text); } catch (_) { /* */ }
  if (typeof showToast === 'function') showToast('📋 ' + text, 4500);
}

function showRotPreview(entry) {
  initRotPreview();
  const widget = document.getElementById('rotWidget');
  widget.style.display = 'block';
  document.getElementById('rotWidgetTitle').textContent =
    (entry.item?.mark || 'Item') + ' — rotate & apply';
  const zHint = document.getElementById('rotHudZHint');
  if (zHint) zHint.style.display = 'none';

  if (previewMesh) { previewScene.remove(previewMesh); previewMesh = null; }
  const color = COLORS[entry.item.category] ?? COLORS.other;

  const shapeMesh = makeShape(entry.item, color, 0.95);
  // Start from saved rotation if any
  const marks = entry.item.marks && entry.item.marks.length
    ? entry.item.marks : [entry.item.mark];
  let existing = null;
  for (const m of marks) {
    if (m && userRotations[m]) { existing = userRotations[m]; break; }
  }
  if (existing) shapeMesh.rotation.set(existing.x, existing.y, existing.z);
  else if (entry.mesh) {
    shapeMesh.rotation.copy(entry.mesh.rotation);
  }

  previewMesh = new THREE.Group();
  previewShapeMesh = shapeMesh;
  previewMesh.add(shapeMesh);
  shapeMesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(shapeMesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  // Centre piece in preview
  shapeMesh.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.2);
  previewMesh.add(new THREE.AxesHelper(maxDim * 0.55));
  previewScene.add(previewMesh);

  previewRotation = {
    x: shapeMesh.rotation.x,
    y: shapeMesh.rotation.y,
    z: shapeMesh.rotation.z
  };
  previewStartRotation = { ...previewRotation };
  previewSource = {
    item: entry.item,
    fromStaging: !!entry.fromStaging,
    stagingGroup: entry.stagingGroup || null,
    marks: marks.filter(Boolean),
  };

  const d = maxDim * 2.2;
  previewCamera.position.set(-d * 0.85, d * 0.4, d * 0.55);
  previewControls.minDistance = maxDim * 0.4;
  previewControls.maxDistance = maxDim * 12;
  previewControls.target.set(0, 0, 0);
  previewControls.update();
  setRotStep(rotStepDeg);
  updateRotDegHud();
}

function hideRotPreview() {
  document.getElementById('rotWidget').style.display = 'none';
  if (previewMesh && previewScene) previewScene.remove(previewMesh);
  previewMesh = null;
  previewShapeMesh = null;
  previewSource = null;
}

function rotPreview(axis, sign) {
  if (!previewShapeMesh) return;
  const shapeMesh = previewShapeMesh;
  const s = (sign === -1 || sign === '-') ? -1 : 1;
  const rad = (rotStepDeg * Math.PI / 180) * s;
  if (axis === 'x' || axis === 'y' || axis === 'z') {
    shapeMesh.rotation[axis] += rad;
  }
  updateRotDegHud();
}

function setRotStep(deg) {
  const d = Number(deg);
  if (![1, 5, 15, 45, 90].includes(d)) return;
  rotStepDeg = d;
  [1, 5, 15, 45, 90].forEach(v => {
    const btn = document.getElementById('rotStep' + v);
    if (!btn) return;
    const on = v === rotStepDeg;
    btn.style.borderColor = on ? 'var(--blue)' : '';
    btn.style.background = on ? 'rgba(59,130,246,0.25)' : '';
    btn.style.color = on ? 'var(--text)' : '';
  });
}

function rotPreviewReset() {
  if (!previewShapeMesh) return;
  previewShapeMesh.rotation.set(
    previewStartRotation.x,
    previewStartRotation.y,
    previewStartRotation.z
  );
  updateRotDegHud();
}

function rotPreviewApply(mode) {
  // Persist for Optimise & Place
  const shapeMesh = previewShapeMesh;
  if (!shapeMesh) return;
  const rot = {
    x: shapeMesh.rotation.x,
    y: shapeMesh.rotation.y,
    z: shapeMesh.rotation.z
  };
  const applySet = mode === 'set';

  // Persist for Optimise & Place
  const marks = previewSource?.marks?.length
    ? previewSource.marks
    : (selected?.item?.marks?.length ? selected.item.marks : [selected?.item?.mark || previewSource?.item?.mark]);
  marks.forEach(m => { if (m) userRotations[m] = { ...rot }; });
  if (previewSource?.item?.mark) userRotations[previewSource.item.mark] = { ...rot };

  // Apply to live mesh in scene when present (inside OR outside leftovers)
  if (selected?.mesh) {
    const prevRot = {
      x: selected.mesh.rotation.x,
      y: selected.mesh.rotation.y,
      z: selected.mesh.rotation.z
    };
    selected.mesh.rotation.set(rot.x, rot.y, rot.z);
    settleSelectedToTouch();
    const isInside = !selected.outsideContainer && !selected.item?.outsideContainer;
    if (isInside && !checkSelectedFit()) {
      // Rotation caused overlap / outside — revert mesh, keep saved rot for Optimise
      selected.mesh.rotation.set(prevRot.x, prevRot.y, prevRot.z);
      settleSelectedToTouch();
      checkSelectedFit();
      showToast('⚠ That rotation does not fit here — left as before; saved for Optimise & Place', 4000);
      renderInfoPanel();
      return;
    }
    saveUserRotation(selected);
    renderInfoPanel();
  }

  // Apply to set: all clickable entries sharing marks (inside + outside)
  if (applySet && marks.length) {
    const markSet = new Set(marks);
    clickable.forEach(entry => {
      const im = entry.item?.mark;
      const ims = entry.item?.marks || [];
      if ((im && markSet.has(im)) || ims.some(m => markSet.has(m))) {
        entry.mesh.rotation.set(rot.x, rot.y, rot.z);
      }
    });
    const inside = clickable.filter(c => !c.outsideContainer);
    restackWithGravity(inside);
    resolveAabbOverlaps(inside);
    restackWithGravity(inside);
  }

  showToast(applySet
    ? '✓ Rotation applied to set — Optimise & Place to reload packing'
    : '✓ Rotation saved — Optimise & Place to pack with this orientation', 3200);
}

/** Persist Euler rotation for every mark covered by this selection. */
function saveUserRotation(sel) {
  if (!sel?.mesh || !sel?.item) return;
  const rot = {
    x: sel.mesh.rotation.x,
    y: sel.mesh.rotation.y,
    z: sel.mesh.rotation.z
  };
  const marks = sel.item.marks && sel.item.marks.length
    ? sel.item.marks
    : [sel.item.mark];
  marks.forEach(m => { if (m) userRotations[m] = { ...rot }; });
  // Also key by primary mark string even if marks[] missing
  if (sel.item.mark) userRotations[sel.item.mark] = { ...rot };
}

/** Snapshot rotations from all currently visible clickable meshes. */
function captureVisibleRotations() {
  clickable.forEach(entry => {
    if (!entry?.mesh || !entry?.item?.mark) return;
    const marks = entry.item.marks && entry.item.marks.length
      ? entry.item.marks : [entry.item.mark];
    const rot = {
      x: entry.mesh.rotation.x,
      y: entry.mesh.rotation.y,
      z: entry.mesh.rotation.z
    };
    marks.forEach(m => { if (m) userRotations[m] = { ...rot }; });
  });
}

function applyStoredRotation(mesh, item) {
  if (!mesh || !item) return;
  const marks = item.marks && item.marks.length ? item.marks : [item.mark];
  let rot = null;
  for (const m of marks) {
    if (m && userRotations[m]) { rot = userRotations[m]; break; }
  }
  if (!rot) return;
  mesh.rotation.set(rot.x, rot.y, rot.z);
}

// Returns null if the selected piece's current position/rotation fits the
// container with no overlap, or a short reason string if it doesn't.
function evaluateFit() {
  if (!selected || !currentLayout) return null;
  // Only skip wall checks for pieces that are still outside (inspection / staging)
  if (selectedIsOutside(selected)) return null;

  selected.mesh.updateMatrixWorld(true);
  const cont = currentLayout.containers[currentContainerIdx];
  if (!cont) return null;

  const wallReason = meshOutsideWallsReason(selected.mesh, cont, 0.02);
  if (wallReason) return wallReason;

  const box = new THREE.Box3().setFromObject(selected.mesh);
  const eps = 0.0005; // touch OK; only dig-in counts as overlap
  for (const entry of clickable) {
    if (entry === selected || entry.oversized || entryIsOutside(entry)) continue;
    if (selected.isSubPiece && entry === selected.parent) continue;
    entry.mesh.updateMatrixWorld(true);
    const ob = new THREE.Box3().setFromObject(entry.mesh);
    const overlap =
      box.min.x < ob.max.x - eps && box.max.x > ob.min.x + eps &&
      box.min.y < ob.max.y - eps && box.max.y > ob.min.y + eps &&
      box.min.z < ob.max.z - eps && box.max.z > ob.min.z + eps;
    if (overlap) return 'Overlaps ' + (entry.item?.mark || 'another item');
  }
  return null;
}

/** Convert a mouse event to NDC using the WebGL canvas (not the full window).
 *  Using window.innerWidth/Height made picks miss whenever side panels exist. */
function setMouseFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  mouse.x = ((e.clientX - rect.left) / w) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / h) * 2 + 1;
}

function pickClickable(e) {
  setMouseFromEvent(e);
  raycaster.setFromCamera(mouse, camera);
  // Prefer solid meshes over edge LineSegments when both are hit
  const roots = clickable.map(c => c.mesh);
  const hits = raycaster.intersectObjects(roots, true);
  for (const hit of hits) {
    if (hit.object.isLine || hit.object.isLineSegments) continue;
    const found = findClickableRoot(hit.object);
    if (found) return { found, hitMesh: hit.object };
  }
  // Fallback: allow edge hits if nothing else
  for (const hit of hits) {
    const found = findClickableRoot(hit.object);
    if (found) return { found, hitMesh: hit.object };
  }
  return null;
}

function onMouseDown(e) {
  if (e.button != null && e.button !== 0) return;

  const pick = pickClickable(e);
  if (pick) {
    const bundleRoot = pick.found;
    const hitMesh = pick.hitMesh;
    const isBundlePiece = (hitMesh !== bundleRoot.mesh);
    const wantPiece = selectMode === 'piece' || e.shiftKey;
    if (isBundlePiece && wantPiece) {
      selectItem({
        mesh: hitMesh,
        item: { ...bundleRoot.item, qty: 1, stacked: false, nested: false,
                bundled: false, beamBundle: false, gridCols: undefined,
                gridRows: undefined,
                outsideContainer: !!bundleRoot.outsideContainer || !!bundleRoot.item?.outsideContainer,
                stagingGroupId: bundleRoot.item?.stagingGroupId || bundleRoot.stagingGroupId || null },
        isSubPiece: true,
        parent: bundleRoot,
        outsideContainer: !!bundleRoot.outsideContainer || !!bundleRoot.item?.outsideContainer,
        stagingGroupId: bundleRoot.item?.stagingGroupId || bundleRoot.stagingGroupId || null
      });
    } else {
      selectItem(bundleRoot);
    }
  } else if (!(moveMode && selected?.mesh)) {
    return;
  }

  if (!selected?.mesh) return;

  const isOut = selectedIsOutside(selected);
  // Outside: free-drag option (default ON after Group) — no Move button needed
  if (isOut && !canFreeDragOutside() && !moveMode) {
    if (!isGroupedReady()) showToast('Step 2 first: Group by Shape — then drag sets', 2800);
    else showToast('Turn on “Drag to rearrange” to move sets', 2600);
    return;
  }

  // Arm drag — real move starts after a small mouse movement (click = select only)
  dragArmed = true;
  isDragging = false;
  dragMoved = false;
  dragStartPosition = selected.mesh.position.clone();
  dragWasOutside = isOut;
  dragStartClient = { x: e.clientX, y: e.clientY };

  selected.mesh.updateMatrixWorld(true);
  const b0 = new THREE.Box3().setFromObject(selected.mesh);
  dragPlaneY = (b0.min.y + b0.max.y) * 0.5;
  dragPlane.set(new THREE.Vector3(0, 1, 0), -dragPlaneY);

  setMouseFromEvent(e);
  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(dragPlane, dragIntersection)) {
    dragOffsetXZ.x = selected.mesh.position.x - dragIntersection.x;
    dragOffsetXZ.z = selected.mesh.position.z - dragIntersection.z;
  } else {
    dragOffsetXZ.x = 0;
    dragOffsetXZ.z = 0;
  }

  try { if (e.pointerId != null) renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  // Block OrbitControls for this gesture (click=select / drag=move on the set)
  e.stopImmediatePropagation();
  e.preventDefault();
}

function beginArmedDrag() {
  if (!dragArmed || isDragging || !selected?.mesh) return;
  isDragging = true;
  // User is moving it — unlock packer/restore pose locks
  if (selected.item) {
    selected.item.packPoseLock = false;
    selected.item.exactPoseLock = false;
  }
  if (controls) controls.enabled = false;
  if (renderer?.domElement) renderer.domElement.style.cursor = 'grabbing';
  updateMoveButtonsUI();
}

// Smooth 1:1: mouse XZ drives item; Y only settles onto support. Rules on release.
function onMouseMove(e) {
  if (!dragArmed || !selected?.mesh) return;

  if (!isDragging) {
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    beginArmedDrag();
  }
  if (!isDragging) return;

  setMouseFromEvent(e);
  raycaster.setFromCamera(mouse, camera);
  dragPlane.set(new THREE.Vector3(0, 1, 0), -dragPlaneY);
  if (!raycaster.ray.intersectPlane(dragPlane, dragIntersection)) return;

  const cont = currentLayout?.containers?.[currentContainerIdx];
  // Inside container (or Into-container mode): smooth move + soft wall stop only
  const mustStayInside = !!(moveMode || (cont && !selectedIsOutside(selected)));

  const prevPos = selected.mesh.position.clone();
  selected.mesh.position.x = dragIntersection.x + dragOffsetXZ.x;
  selected.mesh.position.z = dragIntersection.z + dragOffsetXZ.z;
  settleMeshesToTouch([selected.mesh]);

  if (mustStayInside && cont) {
    // Same feel as outside: follow mouse, only block past walls (no revert stutter)
    softClampInsideContainer([selected.mesh], cont);
  } else if (cont && selectedIsOutside(selected) && !moveMode) {
    // Free-drag outside: no half-in / sticking through walls
    if (meshOverlapsContainerVolume(selected.mesh, cont) &&
        !isMeshInsideContainer(selected.mesh, cont, 0.02)) {
      selected.mesh.position.copy(prevPos);
      settleMeshesToTouch([selected.mesh]);
    }
  }

  if (selectedIsOutside(selected) && !moveMode) {
    const ok = !nudgeCollides(selected, [selected.mesh]) && hasFullBaseSupport(selected.mesh, selected);
    tintMesh(selected.mesh, ok ? 0x22c55e : 0xf59e0b);
  } else {
    checkSelectedFit();
  }

  dragMoved = true;
}

function onMouseUp(e) {
  // Click only (never crossed threshold) — keep selection, do not place/validate
  if (dragArmed && !isDragging) {
    dragArmed = false;
    try { if (e && e.pointerId != null) renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (!isDragging) return;

  const wasIntoMove = moveMode;
  isDragging = false;
  dragArmed = false;
  try { if (e && e.pointerId != null) renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}

  if (!selected?.mesh) {
    if (wasIntoMove) moveMode = false;
    updateMoveButtonsUI();
    return;
  }

  settleSelectedToTouch();
  const cont = currentLayout?.containers?.[currentContainerIdx];

  if (dragMoved && dragWasOutside && !wasIntoMove) {
    selected.outsideContainer = true;
    if (selected.item) selected.item.outsideContainer = true;
    // Still cannot leave a free-drag pose sticking through container walls
    if (cont && meshOverlapsContainerVolume(selected.mesh, cont) &&
        !isMeshInsideContainer(selected.mesh, cont, 0.02)) {
      if (dragStartPosition) selected.mesh.position.copy(dragStartPosition);
      settleSelectedToTouch();
      showToast('Use → Into container — item cannot stick outside walls', 3200);
    } else if (!validateOutsidePlacement(selected)) {
      if (dragStartPosition) selected.mesh.position.copy(dragStartPosition);
      settleSelectedToTouch();
      showToast('Need full base support & no overlap — returned', 3200);
    } else if (selected.item) {
      selected.item.x = selected.mesh.position.x / SCALE;
      selected.item.y = selected.mesh.position.y / SCALE;
      selected.item.z = selected.mesh.position.z / SCALE;
      selected.item.outsideContainer = true;
      showToast('✓ Placed', 1800);
    }
  } else if (dragMoved && cont && (wasIntoMove || !dragWasOutside)) {
    clampMeshesInsideContainer([selected.mesh], cont);
    settleMeshesToTouch([selected.mesh]);
    clampMeshesInsideContainer([selected.mesh], cont);
    const fullyIn = isMeshInsideContainer(selected.mesh, cont, 0.02);
    if (!fullyIn) {
      const why = meshOutsideWallsReason(selected.mesh, cont, 0.02)
        || 'Cannot stick outside container walls';
      if (dragStartPosition) selected.mesh.position.copy(dragStartPosition);
      settleSelectedToTouch();
      if (dragWasOutside) setSelectionInsideContainer(selected, false);
      showToast(why + ' — returned', 3200);
    } else {
      setSelectionInsideContainer(selected, true);
      if (selected.item) {
        selected.item.x = selected.mesh.position.x / SCALE;
        selected.item.y = selected.mesh.position.y / SCALE;
        selected.item.z = selected.mesh.position.z / SCALE;
      }
      if (dragWasOutside || wasIntoMove) {
        showToast('✓ Inside container — fully within walls', 2200);
      }
    }
  }

  // Into-container is one-shot; free-drag stays on (checkbox)
  if (wasIntoMove) moveMode = false;

  updateMoveButtonsUI();
  checkSelectedFit();
  renderInfoPanel();
}

function pushSelectedOutOfOverlaps() {
  if (!selected?.mesh) return;
  const mesh = selected.mesh;
  const eps = 0.0005;
  for (let pass = 0; pass < 4; pass++) {
    mesh.updateMatrixWorld(true);
    const a = new THREE.Box3().setFromObject(mesh);
    let moved = false;
    for (const entry of clickable) {
      if (!shouldInteractWith(selected, entry)) continue;
      entry.mesh.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(entry.mesh);
      const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
      const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
      const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
      if (ox <= eps || oy <= eps || oz <= eps) continue;
      let axis = 'x', pen = ox;
      if (oz < pen) { axis = 'z'; pen = oz; }
      if (oy < pen && oy > eps) { /* prefer horizontal for drag */ }
      const ca = axis === 'x' ? (a.min.x + a.max.x) / 2 : (a.min.z + a.max.z) / 2;
      const cb = axis === 'x' ? (b.min.x + b.max.x) / 2 : (b.min.z + b.max.z) / 2;
      const sign = ca >= cb ? 1 : -1;
      if (axis === 'x') mesh.position.x += sign * pen;
      else mesh.position.z += sign * pen;
      mesh.updateMatrixWorld(true);
      a.setFromObject(mesh);
      moved = true;
    }
    if (!moved) break;
  }
}

/** Drop/lift selected so it TOUCHES support — no air gap, no dig-in.
 *  Also snaps X/Z flush against neighbors when nearly touching. */
function settleSelectedToTouch() {
  if (!selected?.mesh) return;
  const mesh = selected.mesh;
  settleMeshesToTouch([mesh]);
  // Horizontal flush: close small gaps only (never snap into overlap)
  const before = mesh.position.clone();
  snapSelectedAxisToTouch('x');
  if (nudgeCollides(selected, [mesh])) mesh.position.copy(before);
  const mid = mesh.position.clone();
  snapSelectedAxisToTouch('z');
  if (nudgeCollides(selected, [mesh])) mesh.position.copy(mid);
}

/** Drop meshes onto support and flush-touch neighbors (same realm: outside or inside). */
function settleMeshesToTouch(meshes) {
  if (!meshes?.length) return;
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(mesh);
    const area = Math.max((box.max.x - box.min.x) * (box.max.z - box.min.z), 1e-8);
    const longSide = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const shortSide = Math.min(box.max.x - box.min.x, box.max.z - box.min.z);
    let support = 0;
    let bestA = 0;
    let longCover = 0;
    let shortCover = 0;
    const moving = new Set(meshes);
    const wantOut = realmOutsideForMesh(mesh);
    for (const entry of clickable) {
      if (!entry?.mesh || moving.has(entry.mesh)) continue;
      if (entryIsOutside(entry) !== wantOut) continue;
      entry.mesh.updateMatrixWorld(true);
      const ob = new THREE.Box3().setFromObject(entry.mesh);
      const ox0 = Math.max(box.min.x, ob.min.x), ox1 = Math.min(box.max.x, ob.max.x);
      const oz0 = Math.max(box.min.z, ob.min.z), oz1 = Math.min(box.max.z, ob.max.z);
      if (ox1 <= ox0 || oz1 <= oz0) continue;
      const a = (ox1 - ox0) * (oz1 - oz0);
      const top = ob.max.y;
      const lc = ((box.max.x - box.min.x) >= (box.max.z - box.min.z)) ? (ox1 - ox0) : (oz1 - oz0);
      const sc = ((box.max.x - box.min.x) >= (box.max.z - box.min.z)) ? (oz1 - oz0) : (ox1 - ox0);
      if (top > support + 1e-5) { support = top; bestA = a; longCover = lc; shortCover = sc; }
      else if (Math.abs(top - support) <= 1e-5) { bestA += a; longCover += lc; shortCover += sc; }
    }
    // Full base only — overhang / larger-on-smaller drops to floor (then collision rejects)
    if (support > 1e-5 && (
      bestA / area < 0.80 ||
      longCover / longSide < 0.80 ||
      shortCover / Math.max(shortSide, 1e-8) < 0.50
    )) support = 0;
    const dy = support - box.min.y;
    if (Math.abs(dy) > 1e-6) mesh.position.y += dy;
  }
}

/** Push a set of meshes out of overlaps with other same-realm pieces. */
function pushMeshesOutOfOverlaps(meshes) {
  if (!meshes?.length) return;
  const moving = new Set(meshes);
  const eps = 0.0005;
  const wantOut = realmOutsideForMesh(meshes[0]);
  for (let pass = 0; pass < 5; pass++) {
    let any = false;
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const a = new THREE.Box3().setFromObject(mesh);
      for (const entry of clickable) {
        if (!entry?.mesh || moving.has(entry.mesh)) continue;
        if (entryIsOutside(entry) !== wantOut) continue;
        entry.mesh.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(entry.mesh);
        const overlap =
          a.min.x < b.max.x - eps && a.max.x > b.min.x + eps &&
          a.min.y < b.max.y - eps && a.max.y > b.min.y + eps &&
          a.min.z < b.max.z - eps && a.max.z > b.min.z + eps;
        if (!overlap) continue;
        const px = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
        const py = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        const pz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
        const aCx = (a.min.x + a.max.x) / 2, bCx = (b.min.x + b.max.x) / 2;
        const aCz = (a.min.z + a.max.z) / 2, bCz = (b.min.z + b.max.z) / 2;
        if (px <= pz && px <= py) {
          mesh.position.x += (aCx >= bCx ? 1 : -1) * (px + eps);
        } else if (pz <= px && pz <= py) {
          mesh.position.z += (aCz >= bCz ? 1 : -1) * (pz + eps);
        } else {
          mesh.position.y += (py + eps); // lift onto top
        }
        any = true;
        mesh.updateMatrixWorld(true);
        a.copy(new THREE.Box3().setFromObject(mesh));
      }
    }
    if (!any) break;
  }
}

/** Snap selected flush to nearest neighbor on one axis (touch, no overlap). */
function snapSelectedAxisToTouch(axis) {
  if (!selected?.mesh) return;
  const mesh = selected.mesh;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const snapMax = 0.08; // 8 cm — pull across small leftover gaps
  let bestGap = Infinity;
  let bestDelta = 0;

  for (const entry of clickable) {
    if (!shouldInteractWith(selected, entry)) continue;
    entry.mesh.updateMatrixWorld(true);
    const ob = new THREE.Box3().setFromObject(entry.mesh);

    // Require substantial overlap on the other two axes
    const axes = axis === 'x'
      ? [['y', box.min.y, box.max.y, ob.min.y, ob.max.y],
         ['z', box.min.z, box.max.z, ob.min.z, ob.max.z]]
      : [['y', box.min.y, box.max.y, ob.min.y, ob.max.y],
         ['x', box.min.x, box.max.x, ob.min.x, ob.max.x]];
    let ok = true;
    for (const [, amin, amax, bmin, bmax] of axes) {
      const o = Math.min(amax, bmax) - Math.max(amin, bmin);
      const span = Math.min(amax - amin, bmax - bmin);
      if (o < span * 0.25) { ok = false; break; }
    }
    if (!ok) continue;

    const a0 = axis === 'x' ? box.min.x : box.min.z;
    const a1 = axis === 'x' ? box.max.x : box.max.z;
    const b0 = axis === 'x' ? ob.min.x : ob.min.z;
    const b1 = axis === 'x' ? ob.max.x : ob.max.z;

    // Gap to the +side of neighbor (our min past their max)
    const gapPos = a0 - b1; // >0 = separate, <0 = dig
    const gapNeg = b0 - a1;
    if (gapPos >= -snapMax && gapPos <= snapMax && Math.abs(gapPos) < Math.abs(bestGap)) {
      bestGap = gapPos;
      bestDelta = -gapPos; // move so a0 == b1
    }
    if (gapNeg >= -snapMax && gapNeg <= snapMax && Math.abs(gapNeg) < Math.abs(bestGap)) {
      bestGap = gapNeg;
      bestDelta = gapNeg; // move so a1 == b0
    }
  }
  if (bestDelta !== 0 && Math.abs(bestDelta) > 1e-6) {
    if (axis === 'x') mesh.position.x += bestDelta;
    else mesh.position.z += bestDelta;
  }
}

function applyVisualGravity(entries) {
  restackWithGravity(entries);
}

/**
 * Drop every piece onto the floor or a real support under its footprint.
 * Processes lowest→highest so nothing rests on mid-air phantoms.
 */
function restackWithGravity(entries) {
  if (!entries || !entries.length) return;
  const floorY = 0;
  const infos = entries.map(e => {
    e.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(e.mesh);
    return { e, box };
  });
  // Flatten to floor first, then stack in order of XZ footprint area (stable base first)
  infos.sort((a, b) => {
    const aa = (a.box.max.x - a.box.min.x) * (a.box.max.z - a.box.min.z);
    const bb = (b.box.max.x - b.box.min.x) * (b.box.max.z - b.box.min.z);
    return bb - aa;
  });

  const placed = [];
  for (const it of infos) {
    it.e.mesh.updateMatrixWorld(true);
    it.box.setFromObject(it.e.mesh);
    const h = it.box.max.y - it.box.min.y;
    const x0 = it.box.min.x, x1 = it.box.max.x;
    const z0 = it.box.min.z, z1 = it.box.max.z;
    const area = Math.max((x1 - x0) * (z1 - z0), 1e-8);

    let support = floorY;
    let bestA = 0;
    for (const o of placed) {
      o.e.mesh.updateMatrixWorld(true);
      o.box.setFromObject(o.e.mesh);
      const ox0 = Math.max(x0, o.box.min.x), ox1 = Math.min(x1, o.box.max.x);
      const oz0 = Math.max(z0, o.box.min.z), oz1 = Math.min(z1, o.box.max.z);
      if (ox1 <= ox0 || oz1 <= oz0) continue;
      const a = (ox1 - ox0) * (oz1 - oz0);
      const top = o.box.max.y;
      if (top > support + 1e-4) {
        support = top;
        bestA = a;
      } else if (Math.abs(top - support) <= 1e-4) {
        bestA += a;
      }
    }
    // Need solid base: ≥80% of footprint area AND ≥80% of the longer side
    const longSide = Math.max(x1 - x0, z1 - z0);
    let longCover = 0;
    if (support > floorY + 1e-4) {
      for (const o of placed) {
        if (Math.abs(o.box.max.y - support) > 1e-3) continue;
        const ox0 = Math.max(x0, o.box.min.x), ox1 = Math.min(x1, o.box.max.x);
        const oz0 = Math.max(z0, o.box.min.z), oz1 = Math.min(z1, o.box.max.z);
        if (ox1 <= ox0 || oz1 <= oz0) continue;
        longCover += (x1 - x0 >= z1 - z0) ? (ox1 - ox0) : (oz1 - oz0);
      }
    }
    if (support > floorY + 1e-4 && (bestA / area < 0.80 || longCover / longSide < 0.80))
      support = floorY;

    const dy = support - it.box.min.y;
    if (Math.abs(dy) > 1e-5) it.e.mesh.position.y += dy;
    it.e.mesh.updateMatrixWorld(true);
    it.box.setFromObject(it.e.mesh);
    // Never sink below floor
    if (it.box.min.y < -1e-4) {
      it.e.mesh.position.y += -it.box.min.y;
      it.e.mesh.updateMatrixWorld(true);
      it.box.setFromObject(it.e.mesh);
    }
    placed.push(it);
  }
}

/**
 * Push apart any two placed meshes whose world AABBs still interpenetrate.
 * Prefer lifting the higher piece; otherwise separate on X or Z (min penetration).
 */
function resolveAabbOverlaps(entries) {
  if (!entries || entries.length < 2) return;
  // Tiny eps: separate dig-in only; final pose is flush (touch), not gapped
  const eps = 1e-4;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    const boxes = entries.map(e => {
      e.mesh.updateMatrixWorld(true);
      return { e, box: new THREE.Box3().setFromObject(e.mesh) };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        const a = A.box, b = B.box;
        const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
        const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
        if (ox <= eps || oy <= eps || oz <= eps) continue;

        let axis = 'y', pen = oy;
        if (ox < pen) { axis = 'x'; pen = ox; }
        if (oz < pen) { axis = 'z'; pen = oz; }
        const push = pen; // exact — leaves faces touching, no extra air gap

        if (axis === 'y') {
          // Prefer horizontal separation when Y-lift would leave a floating overhang
          if (ox > eps * 2 && ox <= oy + 1e-6) {
            const ca = (a.min.x + a.max.x) / 2;
            const cb = (b.min.x + b.max.x) / 2;
            if (ca >= cb) { A.e.mesh.position.x += ox / 2; B.e.mesh.position.x -= ox / 2; }
            else { A.e.mesh.position.x -= ox / 2; B.e.mesh.position.x += ox / 2; }
          } else if (oz > eps * 2 && oz <= oy + 1e-6) {
            const ca = (a.min.z + a.max.z) / 2;
            const cb = (b.min.z + b.max.z) / 2;
            if (ca >= cb) { A.e.mesh.position.z += oz / 2; B.e.mesh.position.z -= oz / 2; }
            else { A.e.mesh.position.z -= oz / 2; B.e.mesh.position.z += oz / 2; }
          } else {
            const ca = (a.min.y + a.max.y) / 2;
            const cb = (b.min.y + b.max.y) / 2;
            if (ca >= cb) A.e.mesh.position.y += push;
            else B.e.mesh.position.y += push;
          }
        } else if (axis === 'x') {
          const ca = (a.min.x + a.max.x) / 2;
          const cb = (b.min.x + b.max.x) / 2;
          if (ca >= cb) { A.e.mesh.position.x += push / 2; B.e.mesh.position.x -= push / 2; }
          else { A.e.mesh.position.x -= push / 2; B.e.mesh.position.x += push / 2; }
        } else {
          const ca = (a.min.z + a.max.z) / 2;
          const cb = (b.min.z + b.max.z) / 2;
          if (ca >= cb) { A.e.mesh.position.z += push / 2; B.e.mesh.position.z -= push / 2; }
          else { A.e.mesh.position.z -= push / 2; B.e.mesh.position.z += push / 2; }
        }
        moved = true;
        A.e.mesh.updateMatrixWorld(true);
        B.e.mesh.updateMatrixWorld(true);
        // Never push pieces through the container walls
        const cont = currentLayout?.containers?.[currentContainerIdx];
        if (cont) clampMeshesInsideContainer([A.e.mesh, B.e.mesh], cont);
        A.e.mesh.updateMatrixWorld(true);
        B.e.mesh.updateMatrixWorld(true);
        A.box.setFromObject(A.e.mesh);
        B.box.setFromObject(B.e.mesh);
      }
    }
    if (!moved) break;
  }
  const contEnd = currentLayout?.containers?.[currentContainerIdx];
  if (contEnd) clampMeshesInsideContainer(entries.map(e => e.mesh), contEnd);
}

function onClick(e) {
  if (dragMoved) { dragMoved = false; return; }
  const pick = pickClickable(e);
  if (!pick) { deselectItem(); return; }
  const bundleRoot = pick.found;
  const hitMesh = pick.hitMesh;
  const isBundlePiece = (hitMesh !== bundleRoot.mesh);
  const wantPiece = selectMode === 'piece' || e.shiftKey;

  if (isBundlePiece && wantPiece) {
    selectItem({
      mesh: hitMesh,
      item: { ...bundleRoot.item, qty: 1, stacked: false, nested: false,
              bundled: false, beamBundle: false, gridCols: undefined,
              gridRows: undefined },
      isSubPiece: true,
      parent: bundleRoot
    });
  } else {
    selectItem(bundleRoot);
  }
}

function selectItem(found) {
  if (selected && selected !== found) tintMesh(selected.mesh, 0x000000);
  selected = found;
  checkSelectedFit();
  renderInfoPanel();
  highlightStagingForSelection(found);
  // Close rotate panel on normal select — reopen only via Rotate button
  hideRotPreview();
  try { renderer?.domElement?.focus({ preventScroll: true }); } catch (_) {}
}

/** Open rotate preview only when user asks (View / Rotate). */
function openRotateForSelection(entry) {
  if (!entry) return;
  showRotPreview(entry);
}

function deselectItem() {
  if (selected) tintMesh(selected.mesh, 0x000000);
  selected = null;
  selectedGroup = null;
  const infoEl = document.getElementById('info');
  if (infoEl) { infoEl.style.display = 'none'; infoEl.innerHTML = ''; }
  const banner = document.getElementById('fitBanner');
  if (banner) { banner.classList.remove('show'); banner.textContent = ''; }
  document.querySelectorAll('.ag-card.scene-selected').forEach(c => c.classList.remove('scene-selected'));
  hideRotPreview();
}

/** Highlight the matching Staging card for the 3D selection. */
function highlightStagingForSelection(entry) {
  document.querySelectorAll('.ag-card.scene-selected').forEach(c => c.classList.remove('scene-selected'));
  if (!entry?.item) return;

  let g = null;
  if (entry.item.stagingGroupId || entry.stagingGroupId) {
    const sid = entry.item.stagingGroupId || entry.stagingGroupId;
    g = assemblyGroups.find(ag => ag.id === sid) || null;
  }
  if (!g) {
    const id = findStagingIdForUnit(entry.item);
    if (id) g = assemblyGroups.find(ag => ag.id === id) || null;
  }
  if (!g) {
    const marks = new Set();
    if (entry.item.mark) marks.add(entry.item.mark);
    (entry.item.marks || []).forEach(m => { if (m) marks.add(m); });
    (entry.item.nestPieces || []).forEach(np => { if (np?.mark) marks.add(np.mark); });
    const bases = [...marks].map(markBase);
    g = assemblyGroups.find(ag => {
      if (marks.has(ag.mark) || bases.includes(markBase(ag.mark))) return true;
      const agMarks = ag.marks || [ag.mark];
      return agMarks.some(m => marks.has(m) || bases.includes(markBase(m)));
    }) || null;
  }

  selectedGroup = g;
  if (!g) return;
  const card = document.querySelector(`.ag-card[data-id="${CSS.escape ? CSS.escape(g.id) : g.id}"]`);
  if (card) {
    card.classList.add('scene-selected');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function tintMesh(mesh, hex) {
  mesh.traverse(obj => {
    if (obj.material && obj.material.emissive) {
      obj.material.emissive.setHex(hex);
      obj.material.emissiveIntensity = hex === 0x000000 ? 0 : 0.6;
    }
  });
}

function rotateSelected(axis) {
  if (!selected) return;
  if (axis === 'x') selected.mesh.rotation.x += Math.PI / 2;
  if (axis === 'y') selected.mesh.rotation.y += Math.PI / 2;
  if (axis === 'z') selected.mesh.rotation.z += Math.PI / 2;
  saveUserRotation(selected);
  settleSelectedToTouch();
  checkSelectedFit();
  renderInfoPanel();
}

// Live fit check: after any move/rotate, look at the selected piece's
// current world-space bounding box vs the container walls and every other
// placed piece. A bright RED emissive tint marks a problem (out-of-bounds
// or overlap), a bright ORANGE tint means the piece is in a valid spot.
function checkSelectedFit() {
  if (!selected || !currentLayout) return false;
  // Outside leftover / staging: no red wall banner. Inside pieces: walls enforced.
  if (selectedIsOutside(selected)) {
    selected.fitProblem = null;
    tintMesh(selected.mesh, 0xff8800);
    const banner = document.getElementById('fitBanner');
    if (banner) { banner.classList.remove('show'); banner.textContent = ''; }
    return true;
  }
  selected.fitProblem = evaluateFit();
  tintMesh(selected.mesh, selected.fitProblem ? 0xff0000 : 0xff8800);
  const banner = document.getElementById('fitBanner');
  if (banner) {
    // Show wall / overlap problems for items that must stay inside container
    if (selected.fitProblem) {
      banner.textContent = '⚠ ' + selected.fitProblem;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
      banner.textContent = '';
    }
  }
  return !selected.fitProblem;
}

function renderInfoPanel() {
  const infoEl = document.getElementById('info');
  if (!infoEl) return;
  if (!selected?.item) {
    infoEl.style.display = 'none';
    infoEl.innerHTML = '';
    return;
  }
  const it = selected.item;
  const L = Math.round(it.lengthMm || it.l || 0);
  const W = Math.round(it.widthMm || it.w || it.unitWidth || 0);
  const H = Math.round(it.heightMm || it.h || it.unitHeight || 0);
  const qty = it.qty || 1;
  const profile = it.profileDesc || it.shapeKey || it.profileShape || '—';
  const cat = it.category || '—';
  const wt = Math.round(it.unitWeightKg || it.weight || 0);
  const where = (selected.outsideContainer || it.outsideContainer) ? 'Outside (inspection)' : 'In container';
  const canMoveOut = isGroupedReady() && (selected.outsideContainer || it.outsideContainer);

  infoEl.style.display = 'block';
  infoEl.innerHTML =
    `<div class="info-mark">${it.mark || 'Item'}</div>` +
    `<div class="info-row">${it.assemblyName || it.name || ''}</div>` +
    `<div class="info-row">Profile: <span>${profile}</span></div>` +
    `<div class="info-row">Size: <span>${L} × ${W} × ${H} mm</span></div>` +
    `<div class="info-row">Qty: <span>${qty}</span> · Wt: <span>${wt} kg</span> · <span>${cat}</span></div>` +
    `<div class="info-row">Location: <span>${where}</span></div>` +
    (it.remarks ? `<div class="info-row">IFC: <span>${it.remarks}</span></div>` : '') +
    `<div>` +
    `<button class="primary" onclick="openRotateForSelection(selected)">Rotate</button>` +
    (canMoveOut
      ? `<span style="font-size:11px;color:var(--text3);margin-left:6px">Drag in 3D to rearrange</span>`
      : '') +
    `<button onclick="deselectItem()">Close</button>` +
    `</div>`;
}

// ------------------------------------------------------------------
// MODE SWITCHING + LOADING
// ------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: Empty container only — items stay in Staging until Optimise.
// Do NOT dump pieces beside / outside the wireframe.
// ═══════════════════════════════════════════════════════════════════════
/**
 * Staging plan footprint after rest-pose (gravity lays largest face down).
 * Plan size ≈ two largest AABB dims — NOT raw IFC L×W (those axes swap).
 * Never morphs geometry; spacing metadata only.
 */
function stagingFootprintMm(u) {
  // Prefer measured rest-pose / pack envelope (matches real mesh after ground sit).
  // IFC L×W×H alone under-sizes assemblies → overlap after Group by Shape.
  const sb = u.stableBundleMm || u.packEnvelopeMm || null;
  const L = Math.max(Number(sb?.l || u.l || u.lengthMm) || 0, 1);
  const W = Math.max(Number(sb?.w || u.w || u.widthMm) || 0, 1);
  const H = Math.max(Number(sb?.h || u.h || u.heightMm) || 0, 1);
  const isAsm = !!(u.isAssembly || u.groupKind === 'welded_assembly'
    || (u.parts && u.parts.length >= 2));
  // Bent rods / thin declared W can still grow in mesh — pad lightly
  let pad = 1.0;
  if (u.pathPointsMm && u.pathPointsMm.length >= 3) pad = 1.15;
  if ((u.qty || 1) > 1 && !isAsm) pad = Math.max(pad, 1.08);
  if (isAsm) pad = Math.max(pad, 1.12); // assembly AABB clearance
  const sorted = [L, W, H].sort((a, b) => b - a);
  return {
    footX: sorted[0] * pad,
    footZ: sorted[1] * pad,
    footY: sorted[2],
  };
}

/**
 * After render: push overlapping OUTSIDE meshes apart using REAL mesh AABB.
 * Locked (exactPoseLock) act as obstacles but are not moved.
 * Unlocked items move — shapes unchanged.
 */
function deconflictOutsideClickables(entries, gapMm) {
  const list = (entries || []).filter(c => c && c.outsideContainer && c.mesh);
  if (list.length < 2) return 0;
  const gap = Math.max(0, (gapMm != null ? gapMm : 80)) * (SCALE || 0.01);
  const items = list.map(c => {
    c.mesh.updateMatrixWorld(true);
    return {
      c,
      box: new THREE.Box3().setFromObject(c.mesh),
      locked: !!(c.item && c.item.exactPoseLock),
    };
  });
  // Locked first (obstacles); unlocked resolve after
  items.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    return a.box.min.z - b.box.min.z || a.box.min.x - b.box.min.x;
  });

  function aabbHit(A, B) {
    return A.max.x > B.min.x + 1e-4 && A.min.x < B.max.x - 1e-4
      && A.max.y > B.min.y + 1e-4 && A.min.y < B.max.y - 1e-4
      && A.max.z > B.min.z + 1e-4 && A.min.z < B.max.z - 1e-4;
  }

  function pushApart(i, j) {
    const A = items[j].box, B = items[i].box;
    const overlapZ = Math.min(A.max.z, B.max.z) - Math.max(A.min.z, B.min.z);
    const overlapX = Math.min(A.max.x, B.max.x) - Math.max(A.min.x, B.min.x);
    // Prefer smaller push; try +X then +Z (staging grows away from container)
    const dx = A.max.x - B.min.x + gap;
    const dz = A.max.z - B.min.z + gap;
    if (overlapX <= overlapZ && dx > 0) {
      items[i].c.mesh.position.x += dx;
    } else if (dz > 0) {
      items[i].c.mesh.position.z += dz;
    } else if (dx > 0) {
      items[i].c.mesh.position.x += dx;
    }
    items[i].c.mesh.updateMatrixWorld(true);
    items[i].box = new THREE.Box3().setFromObject(items[i].c.mesh);
  }

  let moves = 0;
  // Pass A — unlocked vs everyone (locked are walls)
  // Assemblies need more resolve passes (large AABB, many neighbours)
  for (let i = 0; i < items.length; i++) {
    if (items[i].locked) continue;
    const isAsm = !!(items[i].c.item?.isAssembly
      || items[i].c.item?.groupKind === 'welded_assembly'
      || (items[i].c.item?.parts && items[i].c.item.parts.length >= 2));
    const maxPass = isAsm ? 120 : 60;
    for (let pass = 0; pass < maxPass; pass++) {
      let hitAny = false;
      for (let j = 0; j < items.length; j++) {
        if (j === i) continue;
        if (!aabbHit(items[j].box, items[i].box)) continue;
        hitAny = true;
        pushApart(i, j);
        moves++;
      }
      if (!hitAny) break;
    }
    const it = items[i].c.item;
    if (it) {
      it.x = items[i].c.mesh.position.x / SCALE;
      it.y = items[i].c.mesh.position.y / SCALE;
      it.z = items[i].c.mesh.position.z / SCALE;
    }
  }

  // Pass B — locked vs locked only (restore edge cases); later locked may shift
  for (let i = 0; i < items.length; i++) {
    if (!items[i].locked) continue;
    for (let pass = 0; pass < 40; pass++) {
      let hitAny = false;
      for (let j = 0; j < i; j++) {
        if (!items[j].locked) continue;
        if (!aabbHit(items[j].box, items[i].box)) continue;
        hitAny = true;
        pushApart(i, j);
        moves++;
        // soft-unlock so floor/layout can keep this new pose
        if (items[i].c.item) items[i].c.item.exactPoseLock = false;
        items[i].locked = false;
      }
      if (!hitAny) break;
    }
    const it = items[i].c.item;
    if (it) {
      it.x = items[i].c.mesh.position.x / SCALE;
      it.y = items[i].c.mesh.position.y / SCALE;
      it.z = items[i].c.mesh.position.z / SCALE;
    }
  }
  return moves;
}

/** Show items BESIDE the container for inspection (Group by Shape / load).
 *  Order: sheets → C-channels → Z-purlins → L → beams → rods → welded → other
 *  Each staging card → one expandUnits pass on its member items (sidebar ↔ 3D sync). */
function layoutInspection() {
  if (!rawScene) return;
  const spec = rawScene.containerSpec;

  function inspectRank(u) {
    const p = u.profileShape || u.shapeKey || '';
    const c = u.category || '';
    const isAsm = !!(u.isAssembly || u.groupKind === 'welded_assembly'
      || (u.parts && u.parts.length >= 2));
    // Assemblies FIRST — human yard lays rafters/columns as the base row
    if (isAsm && p !== 'z_channel' && p !== 'c_channel') return 0;
    if (p === 'plate' || c === 'plate') return 1;
    if (p === 'c_channel') return 2;
    if (p === 'z_channel') return 3;
    if (p === 'l_angle') return 4;
    if (p === 'i_beam' || c === 'beam') return 5;
    if (p === 'rhs') return 6;
    if (p === 'rod' || p === 'bent_sag_rod' || c === 'rod') return 7;
    if (c === 'purlin') return 3;
    return 8;
  }

  // Prefer staging groups from Group by Shape; fallback = all raw items
  const units = [];
  const groups = (typeof assemblyGroups !== 'undefined' && assemblyGroups.length)
    ? assemblyGroups : [];

  if (groups.length && typeof itemsForStagingGroup === 'function') {
    groups.forEach(g => {
      // Prefer Step7 pack units already on the group — do NOT rebuild/rewrite dims
      const packUnits = (g.packUnits && g.packUnits.length)
        ? g.packUnits
        : (typeof createPackUnits === 'function' ? createPackUnits(g) : null);
      if (packUnits && packUnits.length) {
        if (!g.packUnits || !g.packUnits.length) g.packUnits = packUnits;
        packUnits.forEach(pu => {
          const members = (typeof packUnitToExpandItems === 'function')
            ? packUnitToExpandItems(pu)
            : (pu.memberItems || []);
          if (!members.length) return;
          const partUnits = expandUnits(members, spec);
          partUnits.forEach(u => {
            u.stagingGroupId = g.id;
            u.packUnitIndex = pu.packUnitIndex;
            if (!u.marks || !u.marks.length) u.marks = pu.marks ? [...pu.marks] : [pu.mark];
            if (pu.nestPieces && pu.nestPieces.length && !u.isAssembly) {
              u.nestPieces = pu.nestPieces.map(np => ({ ...np }));
              u.qty = pu.qty;
              // SHAPE SAFE: do NOT inflate u.l / lengthMm from pack envelope
              // Pack envelope is metadata only (for Step8), not member geometry
              u.packEnvelopeMm = {
                l: pu.bundle_bbox?.l || pu.lengthMm || null,
                w: pu.bundle_bbox?.w || pu.widthMm || null,
                h: pu.bundle_bbox?.h || pu.heightMm || null,
              };
              u.weight = pu.weightKg || pu.total_weight || u.weight;
              u.unitWeightKg = pu.weightKg || pu.total_weight || u.unitWeightKg;
            }
            if (pu.isAssembly && pu.parts && !u.parts) {
              u.isAssembly = true;
              u.parts = pu.parts;
            }
            // Assembly spacing must use pack AABB (not understated IFC member dims)
            if (pu.isAssembly || u.isAssembly || g.groupKind === 'welded_assembly') {
              u.isAssembly = true;
              u.groupKind = u.groupKind || 'welded_assembly';
              u.packEnvelopeMm = {
                l: pu.bundle_bbox?.l || pu.stableBundleMm?.l || pu.lengthMm || u.l,
                w: pu.bundle_bbox?.w || pu.stableBundleMm?.w || pu.widthMm || u.w,
                h: pu.bundle_bbox?.h || pu.stableBundleMm?.h || pu.heightMm || u.h,
              };
              if (pu.stableBundleMm) u.stableBundleMm = { ...pu.stableBundleMm };
            }
            u.surfaceTreatment = pu.surfaceTreatment || g.surfaceTreatment;
            u.destination = pu.destination || g.destination;
            u.specialHandling = !!(pu.specialHandling || g.specialHandling);
            u.mutates_geometry = false;
            units.push(u);
          });
        });
        return;
      }
      const members = itemsForStagingGroup(g, rawScene.items);
      if (!members.length) return;
      const partUnits = expandUnits(members, spec);
      partUnits.forEach(u => {
        u.stagingGroupId = g.id;
        if (!u.marks || !u.marks.length) u.marks = g.marks ? [...g.marks] : [g.mark];
        if (g.groupKind === 'welded_assembly' && g.parts && !u.parts) {
          u.isAssembly = true;
          u.parts = g.parts;
        }
        units.push(u);
      });
    });
  } else {
    expandUnits(rawScene.items, spec).forEach(u => units.push(u));
  }

  const sorted = units.slice().sort((a, b) =>
    inspectRank(a) - inspectRank(b) ||
    String(a.profileShape || '').localeCompare(String(b.profileShape || '')) ||
    (b.l * b.w * b.h) - (a.l * a.w * a.h)
  );

  const gap = 350;
  const asmGap = 520; // assemblies: walk space + flange / end-plate overhang
  const outItems = [];
  let zStart = spec.widthMm / 2 + 800;
  let xCursor = 0;
  let rowMaxW = 200;
  let lastRank = -1;

  // Human yard: measure each assembly AFTER ship-pose so spacing = real flat AABB
  // (IFC pitch AABB was causing X-cross piles and false overlaps).
  function ensureAsmFootprint(u) {
    const isAsm = !!(u.isAssembly || u.groupKind === 'welded_assembly'
      || (u.parts && u.parts.length >= 2));
    if (!isAsm) return stagingFootprintMm(u);
    if ((!u.stableBundleMm || !(u.stableBundleMm.l > 0))
        && typeof measureStableBundleMm === 'function') {
      try {
        const sb = measureStableBundleMm({
          ...u,
          qty: 1,
          isAssembly: true,
          groupKind: 'welded_assembly',
        });
        if (sb && sb.l > 0) {
          u.stableBundleMm = sb;
          u.packEnvelopeMm = { l: sb.l, w: sb.w, h: sb.h };
        }
      } catch (_) { /* */ }
    }
    return stagingFootprintMm(u);
  }

  sorted.forEach(u => {
    const rank = inspectRank(u);
    const isAsm = !!(u.isAssembly || u.groupKind === 'welded_assembly'
      || (u.parts && u.parts.length >= 2));
    if (lastRank >= 0 && rank !== lastRank) {
      xCursor = 0;
      zStart += rowMaxW + gap * 1.4;
      rowMaxW = 200;
    }
    lastRank = rank;

    // Keep IFC/construct dims for makeShape — spacing uses rest-pose footprint
    const itemL = u.l || u.lengthMm || 500;
    const itemH = u.h || u.heightMm || 200;
    const itemW = u.w || u.widthMm || 200;
    const fp = ensureAsmFootprint(u);
    const stagingId = u.stagingGroupId || findStagingIdForUnit(u);
    const useGap = isAsm ? asmGap : gap;
    // Assemblies / Z: origin after rest-pose is AABB centre OR bottom —
    // place at y=0 so snap-to-ground cannot leave them floating mid-air.
    const isZ = (typeof requiresLiveRotateSearch === 'function')
      ? requiresLiveRotateSearch(u)
      : ((typeof csNzIsZShape === 'function' && csNzIsZShape(u))
        || /z_channel|z_shape/i.test(String(u.shapeKey || u.profileShape || '')));

    // Assemblies: length along +X (PCA ship pose), side-by-side in +Z —
    // never leave IFC yaw / pitch in staging (that made the X-cross mess).
    const place = {
      ...u,
      x: xCursor + fp.footX / 2,
      y: (isAsm || isZ) ? 0 : fp.footY / 2,
      z: zStart + fp.footZ / 2,
      l: itemL, w: itemW, h: itemH,
      lengthMm: itemL, widthMm: itemW, heightMm: itemH,
      unitWeightKg: u.weight || u.unitWeightKg || 0,
      weight: u.weight || u.unitWeightKg || 0,
      qty: u.qty || 1,
      outsideContainer: true,
      stagingGroupId: stagingId,
      mutates_geometry: false,
    };
    if (isAsm) {
      // Lock yaw to 0 — ship pose already aligned length→X inside makeShape
      place.userRot = { x: 0, y: 0, z: 0 };
      place.packYawOnly = true;
      place.assemblyShipPose = true;
    }
    outItems.push(place);

    // Assemblies: advance along length (X) so next sits in FRONT (door/yard walk),
    // wrap to next Z lane — human lays frames parallel, not crossed.
    if (isAsm) {
      xCursor += fp.footX + useGap;
      rowMaxW = Math.max(rowMaxW, fp.footZ);
      if (xCursor > Math.max(spec.lengthMm * 2.2, fp.footX * 1.5)) {
        xCursor = 0;
        zStart += rowMaxW + useGap;
        rowMaxW = 200;
      }
    } else {
      xCursor += fp.footX + useGap;
      rowMaxW = Math.max(rowMaxW, fp.footZ);
      if (xCursor > spec.lengthMm * 3) {
        xCursor = 0;
        zStart += rowMaxW + useGap;
        rowMaxW = 200;
      }
    }
  });

  currentLayout = {
    containers: [{
      containerNumber: 1,
      lengthMm: spec.lengthMm, widthMm: spec.widthMm, heightMm: spec.heightMm,
      maxWeightKg: spec.maxWeightKg || 26000,
      usedWeightKg: 0, weightUtilizationPct: 0, volumeUtilizationPct: 0,
      items: [],
    }],
    oversized: outItems,
    isOutsideView: true,
    isGroupedView: true,
  };
  currentContainerIdx = 0;
  currentMode = 'outside';
  const bq = document.getElementById('btnQuick');
  const bo = document.getElementById('btnOptimize');
  if (bq) bq.classList.remove('active');
  if (bo) bo.classList.remove('active');
  renderContainer(0);
}

/** Load / ungrouped: each IFC mark alone — no cross-mark nesting, no shape rows. */
function layoutOutside() {
  if (!rawScene) return;
  const spec = rawScene.containerSpec;
  const gap = 280;
  const outItems = [];
  let zStart = spec.widthMm / 2 + 800;
  let xCursor = 0;
  let rowMaxW = 200;

  // Expand ONE mark at a time so Z/C/L of different marks are not pre-grouped
  (rawScene.items || []).forEach(it => {
    const units = expandUnits([it], spec);
    units.forEach(u => {
      // Construction dims for makeShape (unchanged)
      const itemL = u.l || u.lengthMm || it.lengthMm || 500;
      const itemH = u.h || u.heightMm || it.heightMm || 200;
      const itemW = u.w || u.widthMm || it.widthMm || 200;
      // Spacing: rest-pose plan footprint (two largest dims)
      const fp = stagingFootprintMm({ ...u, lengthMm: itemL, widthMm: itemW, heightMm: itemH });
      const stagingId = findStagingIdForUnit(u, it.mark);
      // Z / assemblies: place on ground plane (y=0). Nest/assembly origin
      // ≠ bbox centre — footY/2 would float until snap; start at ground.
      const isZ = (typeof requiresLiveRotateSearch === 'function')
        ? (requiresLiveRotateSearch(u) || requiresLiveRotateSearch(it))
        : (((typeof csNzIsZShape === 'function')
            && (csNzIsZShape(u) || csNzIsZShape(it)))
          || /z_channel|z_shape/i.test(String(
            u.shapeKey || u.profileShape || it.shapeKey || it.profileShape || '')));
      const isAsm = !!(u.isAssembly || it.isAssembly
        || (u.parts && u.parts.length >= 2) || (it.parts && it.parts.length >= 2));
      outItems.push({
        ...u,
        mark: u.mark || it.mark,
        marks: u.marks || [it.mark],
        x: xCursor + fp.footX / 2,
        y: (isZ || isAsm) ? 0 : fp.footY / 2,
        z: zStart + fp.footZ / 2,
        l: itemL, w: itemW, h: itemH,
        lengthMm: itemL, widthMm: itemW, heightMm: itemH,
        unitWeightKg: u.weight || u.unitWeightKg || it.unitWeightKg || 0,
        weight: u.weight || u.unitWeightKg || it.unitWeightKg || 0,
        qty: u.qty || it.qty || 1,
        outsideContainer: true,
        stagingGroupId: stagingId,
        mutates_geometry: false,
      });
      xCursor += fp.footX + gap;
      rowMaxW = Math.max(rowMaxW, fp.footZ);
      if (xCursor > spec.lengthMm * 2.5) {
        xCursor = 0;
        zStart += rowMaxW + gap;
        rowMaxW = 200;
      }
    });
  });

  currentLayout = {
    containers: [{
      containerNumber: 1,
      lengthMm: spec.lengthMm, widthMm: spec.widthMm, heightMm: spec.heightMm,
      maxWeightKg: spec.maxWeightKg || 26000,
      usedWeightKg: 0, weightUtilizationPct: 0, volumeUtilizationPct: 0,
      items: [],
    }],
    oversized: outItems,
    isOutsideView: true,
    isGroupedView: false,
  };
  currentContainerIdx = 0;
  currentMode = 'outside';
  const bq = document.getElementById('btnQuick');
  const bo = document.getElementById('btnOptimize');
  if (bq) bq.classList.remove('active');
  if (bo) bo.classList.remove('active');
  renderContainer(0);
}

/** Map a 3D unit back to a staging card id (for click → sidebar highlight). */
function markBase(m) {
  return String(m || '').replace(/-[zsp]\d+$/i, '');
}

function findStagingIdForUnit(u, fallbackMark) {
  const candidates = new Set();
  if (fallbackMark) candidates.add(fallbackMark);
  if (u?.mark) candidates.add(u.mark);
  (u?.marks || []).forEach(m => candidates.add(m));
  (u?.nestPieces || []).forEach(np => { if (np?.mark) candidates.add(np.mark); });
  const bases = [...candidates].map(markBase).filter(Boolean);

  const g = assemblyGroups.find(ag => {
    if (u?.stagingGroupId && ag.id === u.stagingGroupId) return true;
    if (candidates.has(ag.mark) || bases.includes(markBase(ag.mark))) return true;
    const agMarks = ag.marks || [ag.mark];
    if (agMarks.some(m => candidates.has(m) || bases.includes(markBase(m)))) return true;
    // Split packs: FOO-z1 ↔ staging FOO
    if (bases.some(b => agMarks.some(m => markBase(m) === b))) return true;
    return false;
  });
  return g?.id || null;
}

// layoutOutside is the load view; layoutInspection is Group-by-Shape view.
// (kept name used by groupByShape / View)

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: Place ONLY checked groups into container
// ═══════════════════════════════════════════════════════════════════════
function csPackSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Apply packer rotation onto a mesh that already has makeShape rest-pose. */
function applyPackItemRotation(mesh, it) {
  if (!mesh || !it) return;
  if (!it.userRot) {
    if (typeof applyStoredRotation === 'function') applyStoredRotation(mesh, it);
    return;
  }
  const ur = it.userRot;
  if (it.packComposeRot) {
    // Face-roll / tip delta composed on top of rest-pose (yard trial)
    if (typeof THREE !== 'undefined') {
      const e = new THREE.Euler(ur.x || 0, ur.y || 0, ur.z || 0, 'XYZ');
      const qAdd = new THREE.Quaternion().setFromEuler(e);
      mesh.quaternion.premultiply(qAdd);
      mesh.rotation.setFromQuaternion(mesh.quaternion);
    } else {
      mesh.rotation.x += ur.x || 0;
      mesh.rotation.y += ur.y || 0;
      mesh.rotation.z += ur.z || 0;
    }
  } else if (it.packYawOnly !== false) {
    mesh.rotation.y += (ur.y || 0);
  } else {
    mesh.rotation.set(ur.x || 0, ur.y || 0, ur.z || 0);
  }
}

/**
 * Live Pack theatre: for each heaviest-first unit, show every orient + slot
 * try (rotate / move ghost), then commit or reject.
 */
async function animatePackPlacementReveal(packedContainers, keepOutside, placementSteps) {
  const finalCont = (packedContainers && packedContainers[0])
    ? { ...packedContainers[0] }
    : null;
  if (!finalCont) return;

  const steps = (placementSteps || []).slice();
  const finalItems = (finalCont.items || []).slice();
  const byMark = new Map();
  finalItems.forEach(it => {
    const marks = it.marks && it.marks.length ? it.marks : [it.mark];
    marks.forEach(m => { if (m) byMark.set(m, it); });
    if (it.mark) byMark.set(it.mark, it);
  });
  const outsideByMark = new Map();
  (keepOutside || []).forEach(it => {
    const marks = it.marks && it.marks.length ? it.marks : [it.mark];
    marks.forEach(m => { if (m) outsideByMark.set(m, it); });
    if (it.mark) outsideByMark.set(it.mark, it);
  });

  const live = {
    ...finalCont,
    items: [],
    usedWeightKg: 0,
    weightUtilizationPct: 0,
    volumeUtilizationPct: 0,
  };
  const remainingOutside = (keepOutside || []).slice();
  currentLayout = { containers: [live], oversized: remainingOutside };
  currentContainerIdx = 0;
  renderContainer(0);

  const maxKg = finalCont.maxWeightKg || 26000;
  const Lmax = finalCont.lengthMm || 12000;
  const Wmax = finalCont.widthMm || 2350;
  const cv = Lmax * Wmax * (finalCont.heightMm || 2690);
  let wSum = 0;
  let vSum = 0;
  let unitIdx = 0;
  let ghost = null;
  let unitSrc = null;

  function syncLive(extraOutside) {
    const outs = extraOutside != null ? extraOutside : remainingOutside;
    currentLayout = { containers: [live], oversized: outs };
    renderContainer(0);
  }

  function ghostItemFrom(step, src) {
    const fl = step.l || src.packFootprintL || src.l || src.lengthMm || 1000;
    const fw = step.w || src.packFootprintW || src.w || src.widthMm || 200;
    const fh = step.h || src.packFootprintH || src.h || src.heightMm || 200;
    const x0 = (step.x != null) ? step.x + fl / 2 : Lmax / 2;
    const z0 = (step.z != null)
      ? (step.z + fw / 2 - Wmax / 2)
      : 0;
    const y0 = (step.y0 != null) ? step.y0 + fh / 2 : fh / 2;
    return {
      ...src,
      mark: (src.mark || step.mark || '?') + ' · TRY',
      x: x0,
      y: y0,
      z: z0,
      packFootprintL: fl,
      packFootprintW: fw,
      packFootprintH: fh,
      userRot: step.rot
        ? { x: step.rot.x || 0, y: step.rot.y || 0, z: step.rot.z || 0 }
        : { x: 0, y: 0, z: 0 },
      packYawOnly: step.packComposeRot ? false : (step.packYawOnly !== false),
      packComposeRot: !!step.packComposeRot,
      packPoseLock: true,
      isPackGhost: true,
      category: src.category || 'other',
    };
  }

  function setGhost(step) {
    if (!unitSrc) return;
    ghost = ghostItemFrom(step, unitSrc);
    // Ghost sits in live.items temporarily (amber toast only — same mesh path)
    const committed = live.items.filter(it => !it.isPackGhost);
    live.items = [...committed, ghost];
    syncLive(remainingOutside.filter(o => o.mark !== unitSrc.mark
      && !(unitSrc.marks || []).includes(o.mark)));
  }

  function clearGhost() {
    ghost = null;
    live.items = live.items.filter(it => !it.isPackGhost);
  }

  for (let si = 0; si < steps.length; si++) {
    const s = steps[si];
    const typ = s.type || (s.mark ? 'commit' : '');

    if (typ === 'unit_start') {
      unitIdx++;
      clearGhost();
      unitSrc = byMark.get(s.mark)
        || outsideByMark.get(s.mark)
        || {
          mark: s.mark,
          marks: s.marks,
          l: s.l, w: s.w, h: s.h,
          lengthMm: s.l, widthMm: s.w, heightMm: s.h,
          packFootprintL: s.l, packFootprintW: s.w, packFootprintH: s.h,
          unitWeightKg: s.weight || 0,
          isAssembly: !!s.isAssembly,
          category: 'beam',
        };
      try {
        showToast(
          `① #${unitIdx} · ${Math.round(s.weight || 0)} kg · ${s.mark}`
          + (s.isAssembly || s.floorAnchor ? ' · BASE try' : ''),
          900
        );
      } catch (_) { /* */ }
      // Preview at door-centre before first orient
      setGhost({
        mark: s.mark, l: s.l, w: s.w, h: s.h,
        x: 100, z: 100, y0: 0,
        rot: { x: 0, y: 0, z: 0 },
        packYawOnly: true,
      });
      await csPackSleep(380);
      continue;
    }

    if (typ === 'orient') {
      try {
        showToast(
          `↻ rotate ${s.tag} · base ${Math.round((s.baseArea || 0) / 1e4) / 100} m²`
          + ` · ${Math.round(s.l)}×${Math.round(s.w)}×${Math.round(s.h)}`,
          700
        );
      } catch (_) { /* */ }
      setGhost({
        ...s,
        x: (Lmax - (s.l || 1000)) / 2,
        z: (Wmax - (s.w || 200)) / 2,
        y0: 0,
      });
      await csPackSleep(s.packComposeRot ? 520 : 400);
      continue;
    }

    if (typ === 'slot') {
      setGhost(s);
      try {
        showToast(
          s.ok
            ? `✓ slot ${s.tag} · bearing ${Math.round((s.supportFrac || 0) * 100)}%`
            : `✗ ${s.tag} · ${s.reason || 'no'}`,
          280
        );
      } catch (_) { /* */ }
      await csPackSleep(s.ok ? 220 : 160);
      continue;
    }

    if (typ === 'orient_fail') {
      try {
        showToast(`↻ ${s.tag || '?'} fail · ${s.reason || ''}`, 260);
      } catch (_) { /* */ }
      await csPackSleep(140);
      continue;
    }

    if (typ === 'accept') {
      // Preview chosen pose before commit step adds the real item
      setGhost(s);
      try {
        showToast(`★ best ${s.tag} · bearing ${Math.round((s.supportFrac || 0) * 100)}%`, 400);
      } catch (_) { /* */ }
      await csPackSleep(360);
      continue;
    }

    if (typ === 'commit') {
      const finalIt = byMark.get(s.mark);
      clearGhost();
      if (finalIt && !live.items.some(it => it.mark === finalIt.mark)) {
        live.items.push(finalIt);
        wSum += (finalIt.unitWeightKg || finalIt.weight || 0);
        vSum += (finalIt.packFootprintL || finalIt.lengthMm || finalIt.l || 1)
          * (finalIt.packFootprintW || finalIt.widthMm || finalIt.w || 1)
          * (finalIt.packFootprintH || finalIt.heightMm || finalIt.h || 1);
        live.usedWeightKg = typeof round2 === 'function' ? round2(wSum) : +wSum.toFixed(2);
        live.weightUtilizationPct = typeof round1 === 'function'
          ? round1(wSum / maxKg * 100) : +(wSum / maxKg * 100).toFixed(1);
        live.volumeUtilizationPct = typeof round1 === 'function'
          ? round1(vSum / cv * 100) : +(vSum / cv * 100).toFixed(1);
        for (let i = remainingOutside.length - 1; i >= 0; i--) {
          const o = remainingOutside[i];
          if (o.mark === s.mark || (o.marks || []).includes(s.mark)
              || (finalIt.marks || []).includes(o.mark))
            remainingOutside.splice(i, 1);
        }
        syncLive();
        try {
          showToast(
            `✔ SEAT ${s.tag || finalIt.packOrientTag || ''} · ${s.mark}`,
            500
          );
        } catch (_) { /* */ }
        await csPackSleep(480);
      }
      continue;
    }

    if (typ === 'reject') {
      clearGhost();
      syncLive();
      try {
        showToast(`✘ OUT · ${s.mark} · ${s.reason || 'no fit'}`, 700);
      } catch (_) { /* */ }
      await csPackSleep(420);
      continue;
    }

    // Legacy steps without type — treat as commit reveal
    if (s.mark && byMark.has(s.mark)) {
      const finalIt = byMark.get(s.mark);
      if (finalIt && !live.items.some(it => it.mark === finalIt.mark)) {
        live.items.push(finalIt);
        syncLive();
        await csPackSleep(300);
      }
    }
  }

  clearGhost();
  currentLayout = {
    containers: packedContainers,
    oversized: keepOutside || [],
  };
  renderContainer(0);
}

async function layoutPlaceSelected() {
  if (!rawScene) return;
  if (!requireGrouped('Optimise')) return;
  const btn = document.getElementById('btnOptimisePlace');
  if (btn && btn.dataset.packing === '1') return; // re-entry guard
  const animate = !!(document.getElementById('animatePackBox')?.checked);
  const spec = rawScene.containerSpec;

  // Capture EXACT world pose + shape snapshot BEFORE re-pack (for unfit restore)
  const prevPose = {};
  clickable.forEach(c => {
    if (!c?.mesh || !c?.item) return;
    c.mesh.updateMatrixWorld(true);
    const marks = c.item.marks && c.item.marks.length ? c.item.marks : [c.item.mark];
    const pose = {
      x: c.mesh.position.x / SCALE,
      y: c.mesh.position.y / SCALE,
      z: c.mesh.position.z / SCALE,
      rot: { x: c.mesh.rotation.x, y: c.mesh.rotation.y, z: c.mesh.rotation.z },
      outside: !!c.outsideContainer,
      // Deep-enough shape snapshot — restore must NEVER use packer dims
      item: {
        ...c.item,
        marks: marks.filter(Boolean),
        nestPieces: c.item.nestPieces
          ? c.item.nestPieces.map(np => ({ ...np }))
          : null,
        parts: c.item.parts || null,
        pathPointsMm: c.item.pathPointsMm || null,
      },
    };
    marks.forEach(m => { if (m) prevPose[m] = pose; });
  });

  // Capture any rotations the user applied while items were outside
  captureVisibleRotations();

  // FIRST: fix pack numbers — #1 heaviest, #2 next… then Optimise in that order
  if (typeof renumberCheckOrderByWeight === 'function')
    renumberCheckOrderByWeight();
  else if (typeof renumberCheckOrder === 'function')
    renumberCheckOrder();

  const checkedGroups = assemblyGroups
    .filter(g => g.checked && g.state !== 'oversized')
    .slice()
    .sort((a, b) => (a.checkOrder || 9999) - (b.checkOrder || 9999));
  // Safety: if numbers missing, fall back to weight sort
  if (checkedGroups.some(g => !(g.checkOrder > 0))
      && typeof sortStagingGroupsByWeight === 'function')
    sortStagingGroupsByWeight(checkedGroups);

  const markOrder = new Map();
  checkedGroups.forEach((g, i) => {
    const marks = g.marks && g.marks.length ? g.marks : [g.mark];
    marks.forEach(m => {
      if (!m) return;
      if (!markOrder.has(m)) markOrder.set(m, g.checkOrder || (i + 1));
    });
  });
  const checkedMarks = new Set(markOrder.keys());

  if (checkedMarks.size === 0) {
    showToast('Select items first — numbered heaviest=#1, then Optimise', 3200);
    return;
  }

  // Refresh list so UI shows #1… before pack runs
  if (typeof renderStagingList === 'function') renderStagingList();
  if (typeof updateSelectAllBox === 'function') updateSelectAllBox();

  // Items / pack units follow weight numbers (#1 first)
  const selectedItems = [];
  const seenItem = new Set();
  checkedGroups.forEach(g => {
    const marks = g.marks && g.marks.length ? g.marks : [g.mark];
    marks.forEach(m => {
      if (!m || seenItem.has(m)) return;
      const it = rawScene.items.find(x => x.mark === m);
      if (!it) return;
      seenItem.add(m);
      selectedItems.push(it);
    });
  });

  // Already-inside unchecked pieces become packer seeds (new items pack around them)
  const seedItems = [];
  const seededMarks = new Set();
  Object.keys(prevPose).forEach(m => {
    if (checkedMarks.has(m)) return;
    const prev = prevPose[m];
    if (!prev || prev.outside) return;
    seedItems.push({
      ...prev.item,
      x: prev.x, y: prev.y, z: prev.z,
      userRot: prev.rot,
    });
    seededMarks.add(m);
  });

  // STEP 8: pack units in #1→#n order (already weight-ranked)
  const packUnits = [];
  checkedGroups.forEach(g => {
    const pus = g.packUnits || (typeof createPackUnits === 'function' ? createPackUnits(g) : []);
    const gw = Math.max(0, Number(g.sortWeightKg || g.weightKg) || 0);
    const r1 = g.rule1_orientation
      || (g.stabilityInfo && g.stabilityInfo.rule1_orientation)
      || null;
    // Within a group: heavier pack units first (single assemblies already 1-each)
    const orderedPu = (pus || []).slice().sort((a, b) =>
      (b.total_weight || b.weightKg || 0) - (a.total_weight || a.weightKg || 0));
    orderedPu.forEach(pu => {
      if (!(pu.total_weight > 0) && !(pu.weightKg > 0) && gw > 0) {
        pu.total_weight = gw;
        pu.weightKg = gw;
      }
      // Stage A/B → Stage C: carry Rule1 gravity pose into packer
      if (r1 && !pu.rule1_orientation) pu.rule1_orientation = r1;
      if (g.stabilityInfo && !pu.stabilityInfo) pu.stabilityInfo = g.stabilityInfo;
      if (r1 && r1.two_point_base) pu.two_point_base = true;
      pu._groupWeightKg = gw;
      pu._groupKind = g.groupKind;
      pu._checkOrder = g.checkOrder || 0;
      packUnits.push(pu);
    });
  });
  // Keep UI number order; only break ties with packer tier/weight
  if (typeof cs8SortHeavyAnchor === 'function')
    cs8SortHeavyAnchor(packUnits, spec.lengthMm);
  // Re-assert: among same tier, honour checkOrder (#1 before #2)
  packUnits.sort((a, b) => {
    const oa = a._checkOrder || 0;
    const ob = b._checkOrder || 0;
    if (oa > 0 && ob > 0 && oa !== ob) return oa - ob;
    return 0; // leave cs8SortHeavyAnchor relative order
  });

  try {
    const top = packUnits.slice(0, 5).map(pu =>
      `#${pu._checkOrder || '?'}:${pu.mark || '?'}:${Math.round(pu.total_weight || pu.weightKg || 0)}kg`);
    console.info('[Optimise try-order]', top.join(' → '), '… (#1=heaviest)');
  } catch (_) { /* */ }

  if (btn) {
    btn.dataset.packing = '1';
    btn.disabled = true;
    btn.style.opacity = '0.55';
    btn.textContent = animate
      ? 'Optimising (live)…'
      : 'Optimising (heavy-first)…';
  }

  let packedLayout;
  try {
    packedLayout = layoutOptimized(selectedItems, spec, userRotations, {
      maxContainers: 1,
      seedItems,
      // markOrder NOT used for placement — Heavy-Anchoring ignores click Order
      markOrder: null,
      packUnits: packUnits.length ? packUnits : undefined,
      stagingGroups: checkedGroups,
      pass2: true, // bundle filler after heavy floor anchors
      strictWeightSort: true,
    });
  } catch (err) {
    if (btn) {
      btn.dataset.packing = '';
      btn.disabled = false;
      btn.style.opacity = '';
      btn.innerHTML = '✓ Optimise &amp; Move Selected to Container';
    }
    showToast('Optimise failed — see console', 4000);
    console.error(err);
    return;
  }

  // Real mesh check: if packed pose sticks outside walls, reject → keep previous location
  (packedLayout.containers || []).forEach(c => {
    const keep = [];
    const reject = [];
    (c.items || []).forEach(it => {
      const marks = [it.mark, ...(it.marks || [])].filter(Boolean);
      const isSeed = marks.some(m => seededMarks.has(m));
      if (isSeed || itemPoseFitsInContainer(it, c)) keep.push(it);
      else reject.push(it);
    });
    c.items = keep;
    if (reject.length) {
      packedLayout.oversized = (packedLayout.oversized || []).concat(reject);
    }
  });

  // STEP 9 — validate rules; violating placements → oversized (restore below)
  if (typeof enforceValidationOnLayout === 'function') {
    enforceValidationOnLayout(packedLayout, {
      stagingGroups: checkedGroups,
      pipeline: ['orient', 'group', 'nest', 'pack'],
    });
  }

  // Update staging cards: placed vs needs-rotate
  const placedMarks = new Set();
  (packedLayout.containers || []).forEach(c => {
    (c.items || []).forEach(it => {
      if (it.mark) placedMarks.add(it.mark);
      (it.marks || []).forEach(m => placedMarks.add(m));
    });
  });
  seededMarks.forEach(m => placedMarks.add(m));

  // Any checked mark not placed → treat as unfit (restore exact pose)
  const needsRotate = [...(packedLayout.oversized || [])];
  const needsRotateMarks = new Set();
  needsRotate.forEach(u => {
    [u.mark, ...(u.marks || [])].filter(Boolean).forEach(m => needsRotateMarks.add(m));
  });
  checkedMarks.forEach(m => {
    if (placedMarks.has(m) || needsRotateMarks.has(m)) return;
    needsRotateMarks.add(m);
    needsRotate.push({ mark: m, marks: [m], fitReason: 'no_fit' });
  });

  // Map Constraint Override Log (fitReason) → staging cards
  const reasonByMark = new Map();
  needsRotate.forEach(u => {
    const code = u.fitReason || 'no_fit';
    const msg = u.fitReasonMsg || code;
    [u.mark, ...(u.marks || [])].filter(Boolean).forEach(m => {
      if (!reasonByMark.has(m)) reasonByMark.set(m, { code, msg, weight: u.weight || u.unitWeightKg || 0 });
    });
  });

  assemblyGroups.forEach(g => {
    const marks = g.marks && g.marks.length ? g.marks : [g.mark];
    const anyPlaced = marks.some(m => placedMarks.has(m));
    const anyNeedsRot = marks.some(m => needsRotateMarks.has(m));
    if (anyPlaced && (g.checked || marks.some(m => seededMarks.has(m)))) {
      g.state = 'placed';
      g.containerId = activeContainerId || 'C1';
      g.needsRotate = false;
      g.fitReason = null;
      g.fitReasonMsg = null;
    } else if (anyNeedsRot && g.checked) {
      g.state = 'unplaced';
      g.needsRotate = true;
      g.containerId = null;
      let reason = null;
      marks.forEach(m => { if (!reason && reasonByMark.has(m)) reason = reasonByMark.get(m); });
      g.fitReason = reason ? reason.code : 'no_fit';
      g.fitReasonMsg = reason ? reason.msg : 'No fit in container';
    }
  });

  let packedContainers = packedLayout.containers || [];
  if (!packedContainers.length && rawScene.containerSpec) {
    const s = rawScene.containerSpec;
    packedContainers = [{
      containerNumber: 1,
      lengthMm: s.lengthMm, widthMm: s.widthMm, heightMm: s.heightMm,
      maxWeightKg: s.maxWeightKg,
      usedWeightKg: 0, weightUtilizationPct: 0, volumeUtilizationPct: 0,
      items: [],
    }];
  }

  // Failed / previous-outside leftovers stay at previous world pose (Step 9 restore)
  let keepOutside = [];
  if (typeof restoreUnfitToPrevPose === 'function') {
    keepOutside = restoreUnfitToPrevPose(needsRotate, prevPose, placedMarks, spec);
  } else {
    needsRotate.forEach(u => {
      const marks = [u.mark, ...(u.marks || [])].filter(Boolean);
      marks.forEach(m => {
        if (!m || placedMarks.has(m)) return;
        const prev = prevPose[m];
        keepOutside.push({
          ...(prev?.item || u),
          mark: m,
          x: prev ? prev.x : (u.x || 0),
          y: prev ? prev.y : ((u.heightMm || u.h || 200) / 2),
          z: prev ? prev.z : ((spec.widthMm / 2) + 800),
          userRot: prev?.rot || null,
          outsideContainer: true,
          needsRotate: true,
          restoredFromOptimise: true,
        });
      });
    });
  }
  // Keep other previously-outside unchecked items where they were
  const seenKeep = new Set(keepOutside.map(it => it.mark).filter(Boolean));
  Object.keys(prevPose).forEach(m => {
    if (checkedMarks.has(m) || placedMarks.has(m) || seenKeep.has(m)) return;
    if (!prevPose[m].outside) return;
    seenKeep.add(m);
    const prev = prevPose[m];
    keepOutside.push({
      ...prev.item,
      mark: m,
      x: prev.x, y: prev.y, z: prev.z,
      userRot: prev.rot,
      outsideContainer: true,
      needsRotate: false,
    });
  });

  currentContainerIdx = 0;

  try {
    const steps = packedLayout.placementSteps || [];
    const hasTrials = steps.some(s => s && (s.type === 'unit_start' || s.type === 'orient'));
    if (animate && packedContainers.length && (hasTrials || (packedContainers[0].items || []).length)) {
      await animatePackPlacementReveal(
        packedContainers,
        keepOutside,
        steps
      );
    } else {
      currentLayout = {
        containers: packedContainers,
        oversized: keepOutside,
      };
      renderContainer(0);
    }
  } finally {
    if (btn) {
      btn.dataset.packing = '';
      btn.innerHTML = '✓ Optimise &amp; Move Selected to Container';
      btn.style.opacity = '';
    }
    if (typeof updateWorkflowUI === 'function') updateWorkflowUI();
  }

  renderStagingList();
  updateStagingFooter();
  syncSidebarContainersFromLayout();

  const nPlaced = [...placedMarks].filter(m => checkedMarks.has(m)).length;
  const nRot = needsRotateMarks.size;
  const p2 = packedLayout.packPasses || {};
  const passHint = p2.pass2
    ? ` · Pass2 fill+${p2.filled || 0}`
    : '';
  // Constraint Override Log — heaviest rejects first (why beam stayed outside)
  const rejectLog = [...reasonByMark.entries()]
    .map(([mark, r]) => ({ mark, ...r }))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));
  if (nRot > 0) {
    const top = rejectLog.slice(0, 2)
      .map(r => `${r.mark}: ${r.code}`)
      .join(' · ');
    showToast(
      `⚠ ${nRot} outside (heavy-first). ${nPlaced} placed${passHint}`
      + (top ? ` — ${top}` : ''),
      7000
    );
    try {
      console.warn('[Constraint Override Log]', rejectLog);
    } catch (_) { /* */ }
  } else {
    showToast(
      `✓ ${nPlaced} placed · Heavy-Anchor (weight→length) + Floor ≥80%${passHint}`,
      3400
    );
  }
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('btnQuick').classList.toggle('active', mode === 'quick');
  document.getElementById('btnOptimize').classList.toggle('active', mode === 'optimize');
  if (!rawScene) return;

  if (mode === 'optimize') {
    runOptimizeKeepingLeftovers();
    return;
  }

  currentLayout = layoutQuick(rawScene.items, rawScene.containerSpec);
  currentContainerIdx = 0;
  renderContainer(0);
}

/** Snapshot EXACT world pose + shape of every visible piece (by mark). */
function captureCurrentPoses() {
  const prevPose = {};
  clickable.forEach(c => {
    if (!c?.mesh || !c?.item) return;
    c.mesh.updateMatrixWorld(true);
    const marks = c.item.marks && c.item.marks.length ? c.item.marks : [c.item.mark];
    const pose = {
      x: c.mesh.position.x / SCALE,
      y: c.mesh.position.y / SCALE,
      z: c.mesh.position.z / SCALE,
      rot: { x: c.mesh.rotation.x, y: c.mesh.rotation.y, z: c.mesh.rotation.z },
      outside: !!c.outsideContainer,
      item: {
        ...c.item,
        marks: marks.filter(Boolean),
        nestPieces: c.item.nestPieces
          ? c.item.nestPieces.map(np => ({ ...np }))
          : null,
        parts: c.item.parts || null,
        pathPointsMm: c.item.pathPointsMm || null,
      },
    };
    marks.forEach(m => { if (m) prevPose[m] = pose; });
  });
  return prevPose;
}

/**
 * Optimise packing — items that fit go inside; leftovers stay at their
 * ORIGINAL world pose (not dumped in a new line). User may Rotate them
 * outside and Move / arrow them into the container afterwards.
 */
function runOptimizeKeepingLeftovers() {
  if (!rawScene) return;
  const spec = rawScene.containerSpec;
  captureVisibleRotations();
  const prevPose = captureCurrentPoses();

  const packedLayout = layoutOptimized(rawScene.items, spec, userRotations, {
    maxContainers: 1,
  });

  // STEP 9 — validate; reject violators → oversized → restore pose
  if (typeof enforceValidationOnLayout === 'function') {
    enforceValidationOnLayout(packedLayout, {
      stagingGroups: (typeof assemblyGroups !== 'undefined') ? assemblyGroups : null,
      pipeline: ['orient', 'group', 'nest', 'pack'],
    });
  }

  const placedMarks = new Set();
  (packedLayout.containers || []).forEach(c => {
    (c.items || []).forEach(it => {
      if (it.mark) placedMarks.add(it.mark);
      (it.marks || []).forEach(m => { if (m) placedMarks.add(m); });
    });
  });

  let packedContainers = packedLayout.containers || [];
  if (!packedContainers.length) {
    packedContainers = [{
      containerNumber: 1,
      lengthMm: spec.lengthMm, widthMm: spec.widthMm, heightMm: spec.heightMm,
      maxWeightKg: spec.maxWeightKg || 26000,
      usedWeightKg: 0, weightUtilizationPct: 0, volumeUtilizationPct: 0,
      items: [],
    }];
  }

  // Exact pre-optimise restore — shape/size unchanged
  const unfit = [...(packedLayout.oversized || [])];
  (rawScene.items || []).forEach(it => {
    if (!it.mark || placedMarks.has(it.mark)) return;
    if (unfit.some(u => u.mark === it.mark || (u.marks || []).includes(it.mark))) return;
    unfit.push({ mark: it.mark, marks: [it.mark], fitReason: 'no_fit' });
  });

  let keepOutside = (typeof restoreUnfitToPrevPose === 'function')
    ? restoreUnfitToPrevPose(unfit, prevPose, placedMarks, spec)
    : [];
  const seenKeep = new Set();
  keepOutside.forEach(it => {
    [it.mark, ...(it.marks || [])].filter(Boolean).forEach(m => seenKeep.add(m));
  });

  // Update staging cards
  if (assemblyGroups && assemblyGroups.length) {
    assemblyGroups.forEach(g => {
      const marks = g.marks && g.marks.length ? g.marks : [g.mark];
      const anyPlaced = marks.some(m => placedMarks.has(m));
      const anyOut = marks.some(m => seenKeep.has(m));
      if (anyPlaced) {
        g.state = 'placed';
        g.containerId = activeContainerId || 'C1';
        g.needsRotate = false;
      } else if (anyOut) {
        g.state = 'unplaced';
        g.containerId = null;
        g.needsRotate = !!keepOutside.find(k =>
          (k.mark === g.mark || (k.marks || []).some(m => marks.includes(m))) && k.needsRotate);
      }
    });
  }

  currentLayout = {
    containers: packedContainers,
    oversized: keepOutside,
  };
  currentContainerIdx = 0;
  renderContainer(0);
  renderStagingList();
  updateStagingFooter();
  if (typeof syncSidebarContainersFromLayout === 'function') syncSidebarContainersFromLayout();

  const nIn = placedMarks.size;
  const nOut = keepOutside.length;
  if (nOut > 0) {
    showToast(
      `✓ ${nIn} inside · ${nOut} left at original position — Rotate / Move them into the container`,
      5500
    );
  } else {
    showToast(`✓ All items packed inside (${nIn})`, 3000);
  }
}
