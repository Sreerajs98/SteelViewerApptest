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
    + `Clearance: ${(+env.clearanceSideMm).toFixed(1)} mm sides · `
    + `${(+env.clearanceEndMm).toFixed(1)} mm ends · `
    + `${(+env.clearanceTopMm).toFixed(1)} mm top</div>`;
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
    // Nest packs: same Group-By shape inputs (sect/qty/nestPieces/nest angle).
    // Do NOT zero nesting_angle — that is what makes the nested Z bundle look.
    let shapeIt = it;
    if (typeof packItemKeepGroupByPose === 'function' && packItemKeepGroupByPose(it)) {
      const isNest = !!(it.nestPieces && it.nestPieces.length)
        || /^nest_/i.test(String(it.groupKind || ''));
      const hasGq = !!(it._groupByQuat && (it._groupByQuat.w != null));
      const sectH = Math.max(+it.sectH || +it.unitHeight || 0, 0);
      const sectW = Math.max(+it.sectW || +it.unitWidth || 0, 0);
      let memberL = Math.max(+it.lengthMm || +it.l || 0, 0);
      if (it.nestPieces && it.nestPieces.length) {
        memberL = Math.max(memberL, ...it.nestPieces.map(np => +np.lengthMm || 0));
      }
      shapeIt = {
        ...it,
        lengthMm: memberL || it.lengthMm,
        widthMm: (isNest ? sectW : null) || it.widthMm,
        heightMm: (isNest ? sectH : null) || it.heightMm,
        unitHeight: (isNest ? sectH : null) || it.unitHeight,
        unitWidth: (isNest ? sectW : null) || it.unitWidth,
        qty: Math.max(1, +it.qty || (it.nestPieces && it.nestPieces.length) || 1),
        nestPieces: it.nestPieces ? it.nestPieces.map(np => ({ ...np })) : null,
        nestingInfo: it.nestingInfo ? { ...it.nestingInfo } : null,
        nestMethod: it.nestMethod || null,
        nestingOffsetMm: it.nestingOffsetMm || it.nesting_offset || null,
        orientation_info: it.orientation_info ? { ...it.orientation_info } : null,
        // Nests: keep bundle. Frozen assemblies: skip re-PCA — apply _groupByQuat.
        _keepGroupByBundle: isNest,
        _skipStability: !isNest && hasGq,
        _yardStraighten: !isNest && !hasGq
          && !!(it._freezeGroupByPose || it.packYawOnly || it._yardStraighten),
        _freezeGroupByPose: !!it._freezeGroupByPose || hasGq,
        packPoseLock: true,
        packYawOnly: true,
      };
    }
    // Twin rafters: real IFC mesh, forced upright to pack footprint (L×H×W).
    // Proxy box only if align cannot reach steel W×H (pitched IFC leftover).
    let box;
    const pairLane = !!(it._pairLaneLock || it._pairPreferIfcMesh
      || /rafter_pair/i.test(String(it.packOrientTag || '')));
    if (pairLane && typeof THREE !== 'undefined') {
      const L = Math.max(+it.packFootprintL || +it.l || +it.lengthMm || 1000, 100);
      const H = Math.max(
        +(it.stableBundleMm && it.stableBundleMm.h)
        || +it.packFootprintH || +it.h || +it.heightMm || 500, 50);
      const W = Math.max(+it._pairVisW
        || (it.stableBundleMm && +it.stableBundleMm.w)
        || 200, 80);
      // Build real IFC assembly (skip nest-keep reshape that zeros parts)
      const ifcIt = {
        ...it,
        _keepGroupByBundle: false,
        _skipStability: true,
        _yardStraighten: true,
        assemblyShipPose: true,
        packYawOnly: true,
        packFootprintL: L,
        packFootprintW: W,
        packFootprintH: H,
        qty: 1,
      };
      box = makeShape(ifcIt, color);
      // Ship-prep upright, then ALWAYS align to packer L×H×W (steel seat)
      if (typeof csShipPrepMesh === 'function') {
        try { csShipPrepMesh(box, ifcIt); }
        catch (_) { /* */ }
      }
      {
        const prevL = it.packFootprintL, prevW = it.packFootprintW, prevH = it.packFootprintH;
        it.packFootprintL = L; it.packFootprintW = W; it.packFootprintH = H;
        if (typeof alignMeshToPackFootprint === 'function')
          alignMeshToPackFootprint(box, it);
        it.packFootprintL = prevL; it.packFootprintW = prevW; it.packFootprintH = prevH;
      }
      const yaw = (it.userRot && it.userRot.y) || 0;
      if (Math.abs(yaw) > 1e-9) {
        box.quaternion.premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
        box.rotation.setFromQuaternion(box.quaternion);
      }
      box.updateMatrixWorld(true);
      let bb0 = new THREE.Box3().setFromObject(box);
      const sc0 = SCALE;
      let meshW0 = (bb0.max.z - bb0.min.z) / sc0;
      let meshH0 = (bb0.max.y - bb0.min.y) / sc0;
      // Stiffeners / end plates can fatten W; keep IFC if web height is upright
      const uprightOk = meshH0 >= H * 0.55 && meshH0 <= H * 1.65
        && meshW0 <= Math.max(W * 3.8, 720) && meshW0 < meshH0 * 1.15;
      if (!uprightOk && typeof makeBox === 'function') {
        box = makeBox(L, H, W, color, 0.92);
        if (Math.abs(yaw) > 1e-9) {
          box.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          box.rotation.setFromQuaternion(box.quaternion);
        }
        it._pairUsedBoxProxy = true;
      } else {
        it._pairUsedBoxProxy = false;
      }
      it._orientLocked = true;
      it._lockedQuaternion = box.quaternion.clone();
      it._keepGroupByBundle = false;
      it._pairVisW = W;
    } else {
      box = makeShape(shapeIt, color);
      if (typeof applyGroupByFrozenQuat === 'function')
        applyGroupByFrozenQuat(box, it);
      applyPackItemRotation(box, shapeIt);
      if (shapeIt._keepGroupByBundle || shapeIt._freezeGroupByPose || it._groupByQuat) {
        it._keepGroupByBundle = !!shapeIt._keepGroupByBundle;
        it._orientLocked = true;
        if (typeof THREE !== 'undefined')
          it._lockedQuaternion = box.quaternion.clone();
      }
    }
    const seatX = it._packerSeatX0 != null ? it._packerSeatX0
      : (it._packerSeatX != null ? it._packerSeatX : it.x);
    const seatZ = it._packerSeatZ0 != null ? it._packerSeatZ0
      : (it._packerSeatZ != null ? it._packerSeatZ : it.z);
    box.position.set(seatX * SCALE, (it.y || 0) * SCALE, seatZ * SCALE);
    snapMeshToPackerFootY(box, it);
    if (typeof isFloorCargoItem === 'function' ? isFloorCargoItem(it)
        : (it.floorAnchor || it.y == null
          || (it.packFootprintH > 0 && it.y <= it.packFootprintH * 0.55))) {
      if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(box, 0);
    }
    scene.add(box);
    const sid = it.stagingGroupId || findStagingIdForUnit(it);
    if (sid && !it.stagingGroupId) it.stagingGroupId = sid;
    clickable.push({ mesh: box, item: it, stagingGroupId: sid || null });
    pieceCount += it.qty;
  });

  // Yard settle: ALL inside cargo (incl. packPoseLock) — heavy→floor, no float,
  // no mesh AABB dig-in. Packer seats are a hint; real steel must sit & clear.
  const inside = clickable.filter(c => !c.outsideContainer);
  if (inside.length && typeof yardSettlePackedMeshes === 'function') {
    yardSettlePackedMeshes(inside, cont);
  } else if (inside.length) {
    const unlocked = inside.filter(c =>
      !c.item?.packPoseLock && !c.item?.exactPoseLock);
    if (unlocked.length) {
      restackWithGravity(unlocked);
      resolveAabbOverlaps(unlocked);
      restackWithGravity(unlocked);
    }
    inside.forEach(c => {
      if (!c.item?.packPoseLock || !c.mesh) return;
      c.mesh.position.set(
        (c.item.x || 0) * SCALE,
        (c.item.y || 0) * SCALE,
        (c.item.z || 0) * SCALE
      );
      snapMeshToPackerFootY(c.mesh, c.item);
    });
  }

  // Absolute last: immutable packer seats + clear mesh dig-in for twin lanes
  if (inside.length && typeof forceImmutablePackerLaneSeats === 'function')
    forceImmutablePackerLaneSeats(inside, cont);

  if (idx === 0 && currentLayout.oversized && currentLayout.oversized.length) {
    // Items outside container — render with REAL shapes (makeShape), not plain boxes.
    // When coming from layoutOutside(), items already have x/y/z set.
    // For truly oversized items (bigger than container), cap display size.
    const MAX_DISP = 3000;
    currentLayout.oversized.forEach((it, i) => {
      const yardView = !!(currentLayout?.isGroupedView || currentLayout?.isOutsideView
        || it._yardStraighten || it.outsideContainer);
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
        // Yard: makeShape → groundOrient uses ortho straighten (no pitch lean)
        _yardStraighten: yardView || !!it._yardStraighten,
        assemblyShipPose: !!it.assemblyShipPose || !!it.isAssembly,
      };
      // needs_ship_prep → red tint (honest yard QA); else category color
      const color = (it.needs_ship_prep && !it._shipPrepped)
        ? 0xcc2222
        : (COLORS[it.category] ?? COLORS.other);
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
      // Ship Prep: load-ready pose (class router). Z keeps nest; assemblies tip+flat.
      if (yardView && !it.exactPoseLock && !it.restoredFromOptimise
          && typeof csShipPrepMesh === 'function') {
        const prep = csShipPrepMesh(mesh, itemForRender);
        if (itemForRender.stableBundleMm) it.stableBundleMm = itemForRender.stableBundleMm;
        if (itemForRender._groupByQuat) it._groupByQuat = itemForRender._groupByQuat;
        if (itemForRender._shipPrepped) it._shipPrepped = true;
        if (itemForRender._freezeGroupByPose) it._freezeGroupByPose = true;
        it.needs_ship_prep = !(prep && prep.ok);
        if (typeof stampGroupByQuatOnStaging === 'function')
          stampGroupByQuatOnStaging(it, mesh);
      } else if (typeof nailMeshToGroundY === 'function') {
        nailMeshToGroundY(mesh, 0);
      }
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
        _groupByQuat: it._groupByQuat || itemForRender._groupByQuat || null,
        _freezeGroupByPose: !!(it._freezeGroupByPose || itemForRender._freezeGroupByPose),
        stableBundleMm: it.stableBundleMm || itemForRender.stableBundleMm || null,
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
  // Heavy first (shipping rule), then largest XZ footprint as stable base
  infos.sort((a, b) => {
    const wa = yardItemWeightKg(a.e.item);
    const wb = yardItemWeightKg(b.e.item);
    if (Math.abs(wb - wa) > 1) return wb - wa;
    const aa = (a.box.max.x - a.box.min.x) * (a.box.max.z - a.box.min.z);
    const bb = (b.box.max.x - b.box.min.x) * (b.box.max.z - b.box.min.z);
    return bb - aa;
  });

  const placed = [];
  for (const it of infos) {
    it.e.mesh.updateMatrixWorld(true);
    it.box.setFromObject(it.e.mesh);
    const item = it.e.item;
    // Ship Prep floor assemblies: NEVER raise onto cradles / other cargo
    const absFloor = !!(item && (item.floorAnchor || item.baseLayerLock
      || (item._shipPrepped && item.isAssembly)
      || (item.anchorTier != null && item.anchorTier <= 1
        && (item._freezeGroupByPose || item._shipPrepped))));
    if (absFloor) {
      if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(it.e.mesh, 0);
      else if (isFinite(it.box.min.y)) it.e.mesh.position.y -= it.box.min.y;
      it.e.mesh.updateMatrixWorld(true);
      it.box.setFromObject(it.e.mesh);
      placed.push(it);
      continue;
    }

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
    const lock = !!(item && (item.packPoseLock || item.floorAnchor
      || item._orientLocked));
    // packPoseLock: DROP only. Raising onto fat IFC assembly AABBs parks
    // Z/C nests as a mid-air sheet (looks like no gravity; CLI still float=0
    // because mesh tip rests on the oversized assembly box).
    if (lock && dy > 1e-5) {
      if (item && typeof isFloorCargoItem === 'function' && isFloorCargoItem(item)
          && typeof nailMeshToGroundY === 'function')
        nailMeshToGroundY(it.e.mesh, 0);
      else if (typeof snapMeshToPackerFootY === 'function')
        snapMeshToPackerFootY(it.e.mesh, item);
    } else if (Math.abs(dy) > 1e-5) {
      it.e.mesh.position.y += dy;
    }
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
  const scR = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
  const floorBand = 400 * scR; // ~400mm — both near floor → prefer XZ, not Y float
  // More passes: packPoseLock cargo still digs into neighbors after nail/tip-level
  for (let pass = 0; pass < 24; pass++) {
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
        // Touch OK (flush); only separate real dig-in
        if (ox <= eps || oy <= eps || oz <= eps) continue;

        const bothFloor = a.min.y < floorBand && b.min.y < floorBand;
        const lockA = !!(A.e.item && (A.e.item.packPoseLock || A.e.item._orientLocked
          || A.e.item.floorAnchor));
        const lockB = !!(B.e.item && (B.e.item.packPoseLock || B.e.item._orientLocked
          || B.e.item.floorAnchor));
        let axis = 'y', pen = oy;
        if (ox < pen) { axis = 'x'; pen = ox; }
        if (oz < pen) { axis = 'z'; pen = oz; }
        // Floor / packer-locked: never Y-lift into mid-air — shove in X/Z
        if ((bothFloor || lockA || lockB) && (ox > eps || oz > eps)) {
          axis = (ox <= oz || oz <= eps) ? (ox > eps ? 'x' : 'z') : 'z';
          if (ox > eps && oz > eps) axis = ox <= oz ? 'x' : 'z';
          pen = axis === 'x' ? ox : oz;
        }
        const push = pen;
        const wA = yardItemWeightKg(A.e.item);
        const wB = yardItemWeightKg(B.e.item);
        // Heavier stays; lighter moves (shipping: heavy bottom / anchored)
        const moveA = wA <= wB;

        if (axis === 'y') {
          if (ox > eps * 2 && ox <= oy + 1e-6) {
            axis = 'x';
          } else if (oz > eps * 2 && oz <= oy + 1e-6) {
            axis = 'z';
          } else {
            if (moveA) A.e.mesh.position.y += push;
            else B.e.mesh.position.y += push;
            moved = true;
            A.e.mesh.updateMatrixWorld(true);
            B.e.mesh.updateMatrixWorld(true);
            A.box.setFromObject(A.e.mesh);
            B.box.setFromObject(B.e.mesh);
            continue;
          }
        }
        if (axis === 'x') {
          if (moveA) A.e.mesh.position.x += (a.min.x + a.max.x >= b.min.x + b.max.x ? push : -push);
          else B.e.mesh.position.x += (b.min.x + b.max.x >= a.min.x + a.max.x ? push : -push);
        } else {
          if (moveA) A.e.mesh.position.z += (a.min.z + a.max.z >= b.min.z + b.max.z ? push : -push);
          else B.e.mesh.position.z += (b.min.z + b.max.z >= a.min.z + a.max.z ? push : -push);
        }
        moved = true;
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

    // Yard pieces: length along +X, horizontal, ground-stable.
    // Z-purlins: keep legacy nest / Rule1 pose (no PCA yard straighten).
    const place = {
      ...u,
      x: xCursor + fp.footX / 2,
      // Universal ground: all yard items start on floor (nail after orient)
      y: 0,
      z: zStart + fp.footZ / 2,
      l: itemL, w: itemW, h: itemH,
      lengthMm: itemL, widthMm: itemW, heightMm: itemH,
      unitWeightKg: u.weight || u.unitWeightKg || 0,
      weight: u.weight || u.unitWeightKg || 0,
      qty: u.qty || 1,
      outsideContainer: true,
      stagingGroupId: stagingId,
      mutates_geometry: false,
      // Group-By: straighten non-Z. Z keeps old nest / Rule1 live-rotate.
      _yardStraighten: !isZ,
      // Nest bundles only — single Z still runs Rule1 live-rotate
      _keepGroupByBundle: !!(isZ && (
        (u.nestPieces && u.nestPieces.length > 1)
        || (u.qty || 1) > 1
        || String(u.groupKind || '').toLowerCase() === 'nest_z')),
      userRot: { x: 0, y: 0, z: 0 },
      packYawOnly: true,
    };
    if (isAsm) place.assemblyShipPose = true;
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
        // Universal ground: plates/beams/nests start on floor too
        y: 0,
        z: zStart + fp.footZ / 2,
        l: itemL, w: itemW, h: itemH,
        lengthMm: itemL, widthMm: itemW, heightMm: itemH,
        unitWeightKg: u.weight || u.unitWeightKg || it.unitWeightKg || 0,
        weight: u.weight || u.unitWeightKg || it.unitWeightKg || 0,
        qty: u.qty || it.qty || 1,
        outsideContainer: true,
        stagingGroupId: stagingId,
        mutates_geometry: false,
        // Z-purlins: legacy nest / Rule1 only (no PCA yard straighten)
        _yardStraighten: !isZ,
        _keepGroupByBundle: !!(isZ && (
          (u.nestPieces && u.nestPieces.length > 1)
          || (u.qty || it.qty || 1) > 1
          || String(u.groupKind || it.groupKind || '').toLowerCase() === 'nest_z')),
        userRot: { x: 0, y: 0, z: 0 },
        packYawOnly: true,
        assemblyShipPose: isAsm,
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

/**
 * Align rest-pose mesh AABB to packer footprint (fixes double-rotation:
 * rest-pose already rolled + blind Rx90 compose → flat again / wall poke).
 */
function alignMeshToPackFootprint(mesh, it) {
  if (!mesh || !it || typeof THREE === 'undefined') return false;
  const tL = Number(it.packFootprintL) || 0;
  const tW = Number(it.packFootprintW) || 0;
  const tH = Number(it.packFootprintH) || 0;
  if (!(tL > 0 && tW > 0 && tH > 0)) return false;
  const target = [tL, tH, tW]; // world X,Y,Z mm
  const tol = Math.max(80, Math.min(tL, tW, tH) * 0.08);
  const wantFlat = typeof packItemNeedsFlatAlign === 'function'
    && packItemNeedsFlatAlign(it);
  // Twin / ship-prep rafters: tall thin footprint — punish pitched-flat hard
  const wantUpright = !wantFlat && tH > tW * 2.2 && tH > 800;

  const measure = () => {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const s = new THREE.Vector3();
    box.getSize(s);
    const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
    return [s.x / sc, s.y / sc, s.z / sc];
  };
  // Nests/braces: punish tall poses hard — AABB L1 match alone kept IFC roof
  // pitch (diagonal purple sheet) when footprint H was also wrong/tall.
  const errOf = (d) => {
    const eL = Math.abs(d[0] - target[0]);
    const eH = Math.abs(d[1] - target[1]);
    const eW = Math.abs(d[2] - target[2]);
    if (wantUpright) {
      const fatPen = Math.max(0, d[2] - tW * 1.6) * 24;
      const shortPen = Math.max(0, tH * 0.65 - d[1]) * 30;
      return eH * 5 + eW * 8 + eL + fatPen + shortPen;
    }
    if (!wantFlat) return eL + eH + eW;
    const tallPen = Math.max(0, d[1] - target[1]) * 14
      + Math.max(0, d[1] - Math.min(tL, tW, tH) * 1.35) * 20;
    return eH * 10 + eL + eW + tallPen;
  };

  const qRest = mesh.quaternion.clone();
  let d0 = measure();
  let best = { err: errOf(d0), q: qRest.clone(), h: d0[1] };
  // Already flat + footprint OK → keep. Pitched-but-AABB-ok must NOT early-out.
  if (wantFlat) {
    if (d0[1] <= target[1] * 1.25 && best.err <= tol * 3) return true;
  } else if (best.err <= tol * 3) {
    return true;
  }

  const ur = it.userRot || {};
  const trials = [
    { x: ur.x || 0, y: ur.y || 0, z: ur.z || 0 },
    { x: 0, y: 0, z: 0 },
    { x: Math.PI / 2, y: 0, z: 0 },
    { x: -Math.PI / 2, y: 0, z: 0 },
    { x: Math.PI, y: 0, z: 0 },
    { x: 0, y: 0, z: Math.PI / 2 },
    { x: 0, y: 0, z: -Math.PI / 2 },
    { x: Math.PI / 2, y: Math.PI, z: 0 },
    { x: -Math.PI / 2, y: Math.PI, z: 0 },
    { x: Math.PI / 2, y: Math.PI / 2, z: 0 },
    { x: -Math.PI / 2, y: Math.PI / 2, z: 0 },
    { x: Math.PI / 2, y: -Math.PI / 2, z: 0 },
    { x: -Math.PI / 2, y: -Math.PI / 2, z: 0 },
    { x: 0, y: Math.PI / 2, z: Math.PI / 2 },
    { x: 0, y: -Math.PI / 2, z: Math.PI / 2 },
    { x: 0, y: Math.PI / 2, z: -Math.PI / 2 },
  ];
  // Fine pitch-cancel for assemblies only — small yaw on nests re-locks roof slope
  if (!wantFlat) {
    [-30, -20, -15, -10, -5, 5, 10, 15, 20, 30].forEach(d => {
      const r = d * Math.PI / 180;
      trials.push({ x: 0, y: r, z: 0 });
      trials.push({ x: 0, y: 0, z: r });
      trials.push({ x: Math.PI / 2, y: r, z: 0 });
      trials.push({ x: ur.x || 0, y: (ur.y || 0) + r, z: ur.z || 0 });
    });
  } else {
    // Tiny flatten only (±8°) around axis-aligned candidates
    [-8, -4, 4, 8].forEach(d => {
      const r = d * Math.PI / 180;
      trials.push({ x: Math.PI / 2 + r, y: 0, z: 0 });
      trials.push({ x: -Math.PI / 2 + r, y: 0, z: 0 });
      trials.push({ x: (ur.x || 0) + r, y: ur.y || 0, z: ur.z || 0 });
    });
  }
  for (let i = 0; i < trials.length; i++) {
    const t = trials[i];
    mesh.quaternion.copy(qRest);
    const e = new THREE.Euler(t.x, t.y, t.z, 'XYZ');
    mesh.quaternion.premultiply(new THREE.Quaternion().setFromEuler(e));
    mesh.rotation.setFromQuaternion(mesh.quaternion);
    const d = measure();
    const err = errOf(d);
    if (err < best.err - 1e-6 || (Math.abs(err - best.err) <= 1e-6 && d[1] < best.h)) {
      best = { err, q: mesh.quaternion.clone(), h: d[1] };
    }
    if (err <= tol && (!wantFlat || d[1] <= target[1] * 1.3)) break;
  }
  mesh.quaternion.copy(best.q);
  mesh.rotation.setFromQuaternion(mesh.quaternion);
  return best.err <= tol * 4;
}

/**
 * Seat mesh so world min.y matches packer foot Y (support surface).
 * Packer stores item.y as AABB center; makeShape rest-pose is often floor-sat
 * (origin ≠ center). Without this, packPoseLock items float by ~H/2.
 * X/Z untouched (wall clearances stay).
 */
function snapMeshToPackerFootY(mesh, it) {
  if (!mesh || !it || typeof THREE === 'undefined') return 0;
  const fh = it.packFootprintH || it.heightMm || it.h || 0;
  const yCenter = it.y != null ? it.y : fh / 2;
  const y0mm = yCenter - fh / 2; // packer support / floor (or shelf)
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (!isFinite(box.min.y) || !isFinite(box.max.y)) return 0;
  const dy = y0mm * sc - box.min.y;
  if (Math.abs(dy) > 1e-5) mesh.position.y += dy;
  return dy;
}

/** Always nail mesh AABB minY → ground (scene Y). Real-world floor contact. */
function nailMeshToGroundY(mesh, groundY) {
  if (!mesh || typeof THREE === 'undefined') return 0;
  const g = (typeof groundY === 'number') ? groundY
    : ((typeof SCENE_GROUND_Y === 'number') ? SCENE_GROUND_Y : 0);
  mesh.updateMatrixWorld(true);
  if (typeof csNzSnapObjectToGround === 'function' && Math.abs(g) < 1e-9) {
    const s = csNzSnapObjectToGround(mesh);
    return (s && s.moved_y) || 0;
  }
  const box = new THREE.Box3().setFromObject(mesh);
  if (!isFinite(box.min.y)) return 0;
  const dy = g - box.min.y;
  if (Math.abs(dy) > 1e-6) mesh.position.y += dy;
  return dy;
}

/**
 * Floor cargo? Prefer live seat over packFootprintH (plates often fh≪mesh H).
 * Used by render + settle so every floor piece nails minY→0.
 */
function isFloorCargoItem(it) {
  if (!it) return false;
  if (it.floorAnchor || it.baseLayerLock) return true;
  if (it.anchorTier != null && Number(it.anchorTier) <= 1) return true;
  const fh = Number(it.packFootprintH) || Number(it.heightMm) || Number(it.h) || 0;
  const y = it.y != null ? Number(it.y) : null;
  if (y == null) return true; // yard / unknown → treat as floor until stacked
  if (fh > 0) {
    // Center at/near half-height, or packer foot ≤ 50mm
    if (y <= fh * 0.55 + 1e-6) return true;
    if ((y - fh / 2) <= 50) return true;
  } else if (y <= 50) {
    return true;
  }
  return false;
}

/** Restore Group By rigid orientation (before packer yaw). */
function applyGroupByFrozenQuat(mesh, it) {
  if (!mesh || !it || !it._groupByQuat || typeof THREE === 'undefined') return false;
  const q = it._groupByQuat;
  if (!(Math.abs(q.w) > 0 || Math.abs(q.x) > 0 || Math.abs(q.y) > 0 || Math.abs(q.z) > 0))
    return false;
  mesh.quaternion.set(q.x || 0, q.y || 0, q.z || 0, q.w != null ? q.w : 1);
  mesh.rotation.setFromQuaternion(mesh.quaternion);
  mesh.updateMatrixWorld(true);
  return true;
}

/** Persist Group By quat onto staging pack units / items (Optimise freeze). */
function stampGroupByQuatOnStaging(it, mesh) {
  if (!it || !mesh || typeof THREE === 'undefined') return;
  const q = mesh.quaternion;
  const gq = { x: q.x, y: q.y, z: q.z, w: q.w };
  it._groupByQuat = gq;
  it._freezeGroupByPose = true;
  it._orientLocked = true;
  it._lockedQuaternion = mesh.quaternion.clone();
  try {
    const marks = it.marks && it.marks.length ? it.marks : [it.mark];
    if (typeof assemblyGroups !== 'undefined' && assemblyGroups) {
      assemblyGroups.forEach(g => {
        const gMarks = g.marks && g.marks.length ? g.marks : [g.mark];
        const hit = marks.some(m => m && gMarks.includes(m))
          || (it.stagingGroupId && g.id === it.stagingGroupId);
        if (!hit) return;
        g._groupByQuat = { ...gq };
        g._freezeGroupByPose = true;
        (g.packUnits || []).forEach(pu => {
          pu._groupByQuat = { ...gq };
          pu._freezeGroupByPose = true;
        });
      });
    }
  } catch (_) { /* */ }
}

/** Piece weight for yard order (heavier stays lower). */
function yardItemWeightKg(it) {
  if (!it) return 0;
  return Math.max(
    0,
    Number(it.unitWeightKg) || Number(it.weight) || Number(it.weightKg) || 0
  );
}

/**
 * Shipping-yard settle after Optimise:
 *  1) Align assembly meshes to pack footprint (cancel residual IFC pitch)
 *  2) Heavy → light gravity onto real mesh supports (no mid-air)
 *  3) Separate mesh AABB overlaps
 *  4) Clamp inside walls; write world pose back to item
 */
/**
 * Final authority for twin / foreman floor seats.
 * Uses immutable _packerSeat* and pushes meshes apart until AABBs clear.
 */
function forceImmutablePackerLaneSeats(entries, cont) {
  if (!entries || !entries.length || typeof THREE === 'undefined') return;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  const halfW = (((cont && cont.widthMm) || 2438) * sc) / 2;
  const gapM = 0.05;
  const list = entries.filter(e => e && e.mesh && e.item && !e.outsideContainer);
  // ONLY twin-rafter lanes — never all items that happen to have a seat stamp
  const locked = list.filter(c => {
    const it = c.item;
    return !!(it._pairLaneLock || it._pairPreferIfcMesh || it._usePackFootprintProxy
      || /rafter_pair/i.test(String(it.packOrientTag || '')));
  });
  if (locked.length < 1) return;

  function seatCenter(mesh, xMm, zMm) {
    mesh.position.x = xMm * sc;
    mesh.position.z = zMm * sc;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.x)) return;
    mesh.position.x += (xMm * sc) - (box.min.x + box.max.x) * 0.5;
    mesh.position.z += (zMm * sc) - (box.min.z + box.max.z) * 0.5;
    mesh.updateMatrixWorld(true);
  }

  locked.forEach(c => {
    const it = c.item;
    // Prefer frozen original seats (never corrupted by fat-mesh shove)
    const x = it._packerSeatX0 != null ? Number(it._packerSeatX0)
      : (it._packerSeatX != null ? Number(it._packerSeatX) : Number(it.x) || 0);
    const z = it._packerSeatZ0 != null ? Number(it._packerSeatZ0)
      : (it._packerSeatZ != null ? Number(it._packerSeatZ) : Number(it.z) || 0);
    if (it._lockedQuaternion) {
      c.mesh.quaternion.copy(it._lockedQuaternion);
      c.mesh.rotation.setFromQuaternion(c.mesh.quaternion);
    }
    seatCenter(c.mesh, x, z);
    if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
    it.x = x;
    it.z = z;
    it._packerSeatX = x;
    it._packerSeatZ = z;
  });

  locked.sort((a, b) => {
    const za = a.item._packerSeatZ0 != null ? a.item._packerSeatZ0
      : (a.item._packerSeatZ != null ? a.item._packerSeatZ : (a.item.z || 0));
    const zb = b.item._packerSeatZ0 != null ? b.item._packerSeatZ0
      : (b.item._packerSeatZ != null ? b.item._packerSeatZ : (b.item.z || 0));
    return za - zb;
  });
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < locked.length; i++) {
      for (let j = i + 1; j < locked.length; j++) {
        const A = locked[i], B = locked[j];
        A.mesh.updateMatrixWorld(true);
        B.mesh.updateMatrixWorld(true);
        const ba = new THREE.Box3().setFromObject(A.mesh);
        let bb = new THREE.Box3().setFromObject(B.mesh);
        const ox = Math.min(ba.max.x, bb.max.x) - Math.max(ba.min.x, bb.min.x);
        const oy = Math.min(ba.max.y, bb.max.y) - Math.max(ba.min.y, bb.min.y);
        const oz = Math.min(ba.max.z, bb.max.z) - Math.max(ba.min.z, bb.min.z);
        if (!(ox > 0.02 && oy > 0.02 && oz > 0.02)) continue;
        const need = (ba.max.z + gapM) - bb.min.z;
        if (need <= 0) continue;
        B.mesh.position.z += need;
        B.mesh.updateMatrixWorld(true);
        bb = new THREE.Box3().setFromObject(B.mesh);
        if (bb.max.z > halfW - 0.002) {
          B.mesh.position.z -= (bb.max.z - (halfW - 0.002));
          B.mesh.updateMatrixWorld(true);
          bb = new THREE.Box3().setFromObject(B.mesh);
        }
        if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(B.mesh, 0);
        // Update live item.z for display — do NOT clobber _packerSeatZ0
        const cz = ((bb.min.z + bb.max.z) * 0.5) / sc;
        B.item.z = cz;
        B.item._packerSeatZ = cz;
        moved = true;
      }
    }
    if (!moved) break;
  }
  try {
    console.info('[LANE-SEAT] z0='
      + locked.map(c => Math.round(
        c.item._packerSeatZ0 != null ? c.item._packerSeatZ0 : c.item.z || 0
      )).join(',')
      + ' meshZ='
      + locked.map(c => {
        c.mesh.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(c.mesh);
        return Math.round(((b.min.z + b.max.z) * 0.5) / sc);
      }).join(','));
  } catch (_) { /* */ }
}

function yardSettlePackedMeshes(entries, cont) {
  if (!entries || !entries.length || typeof THREE === 'undefined') return;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  const list = entries.filter(e => e && e.mesh && e.item && !e.outsideContainer);
  if (!list.length) return;

  function yardLaneLocked(it) {
    if (!it) return false;
    // Twin rafter lanes only — never lock every stamped seat
    if (it._pairLaneLock || it._pairPreferIfcMesh || it._usePackFootprintProxy)
      return true;
    if (/rafter_pair/i.test(String(it.packOrientTag || ''))) return true;
    return false;
  }

  // Snapshot IMMUTABLE packer seats (prefer Z0/X0)
  const packerXZ = new Map();
  list.forEach(c => {
    const it = c.item;
    const sx = it._packerSeatX0 != null ? Number(it._packerSeatX0)
      : (it._packerSeatX != null ? Number(it._packerSeatX) : Number(it.x) || 0);
    const sz = it._packerSeatZ0 != null ? Number(it._packerSeatZ0)
      : (it._packerSeatZ != null ? Number(it._packerSeatZ) : Number(it.z) || 0);
    packerXZ.set(c, {
      x: sx,
      z: sz,
      lock: yardLaneLocked(it),
    });
  });

  // Heaviest first — they claim the floor; light goods stack / fill gaps
  list.sort((a, b) => yardItemWeightKg(b.item) - yardItemWeightKg(a.item));

  list.forEach(c => {
    const it = c.item;
    // Keep current mesh rotation (already applied by renderContainer).
    // Re-seat XZ to packer lane; Y settled by gravity on real mesh AABB.
    c.mesh.position.x = (it.x || 0) * sc;
    c.mesh.position.z = (it.z || 0) * sc;
    const keepPose = typeof packItemKeepGroupByPose === 'function'
      ? packItemKeepGroupByPose(it)
      : (typeof packItemNeedsFlatAlign === 'function' && packItemNeedsFlatAlign(it));
    const asm = !!(it.isAssembly || it.groupKind === 'welded_assembly'
      || (it.parts && it.parts.length > 1));
    // Freeze / nest / yaw-only: NEVER footprint-realign — that re-engineered Group By.
    // Legacy only: unlocked assemblies may still align to pack seat.
    if (asm && !keepPose && !it._freezeGroupByPose && !it.packYawOnly
        && typeof alignMeshToPackFootprint === 'function') {
      alignMeshToPackFootprint(c.mesh, it);
      it._orientLocked = true;
      if (typeof THREE !== 'undefined')
        it._lockedQuaternion = c.mesh.quaternion.clone();
    }
    // Restore locked orient if render already froze it (nests locked in applyPackItemRotation)
    if (it._orientLocked && it._lockedQuaternion && typeof THREE !== 'undefined') {
      c.mesh.quaternion.copy(it._lockedQuaternion);
      c.mesh.rotation.setFromQuaternion(c.mesh.quaternion);
    }
    snapMeshToPackerFootY(c.mesh, it);
    // Floor cargo: hard nail mesh minY → 0 (plates/nests/assemblies)
    if (isFloorCargoItem(it) && typeof nailMeshToGroundY === 'function')
      nailMeshToGroundY(c.mesh, 0);
    // Ship Prep tip-level ownership: kill residual see-saw on long floor assemblies
    const floorAsm = !!(it.floorAnchor || it._shipPrepped || it.isAssembly
      || it.groupKind === 'welded_assembly');
    const lenMm = Math.max(+it.packFootprintL || 0, +it.lengthMm || 0, +it.l || 0, 0);
    if (floorAsm && lenMm >= 4000 && !/^nest_/i.test(String(it.groupKind || ''))
        && typeof csShipPrepTipGapMm === 'function'
        && typeof csShipPrepTipLevel === 'function') {
      const tg0 = csShipPrepTipGapMm(c.mesh);
      if (tg0 > 120) {
        csShipPrepTipLevel(c.mesh, c.mesh.position.x, c.mesh.position.z);
        if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
        if (it._orientLocked && typeof THREE !== 'undefined')
          it._lockedQuaternion = c.mesh.quaternion.clone();
        if (it._groupByQuat) {
          const q = c.mesh.quaternion;
          it._groupByQuat = { x: q.x, y: q.y, z: q.z, w: q.w };
        }
      }
    }
  });

  // Gravity / AABB resolve for FILLERS only — lane-locked rafters keep packer XZ
  const fillers = list.filter(c => !yardLaneLocked(c.item));
  const lockedLane = list.filter(c => yardLaneLocked(c.item));
  if (fillers.length) {
    restackWithGravity(fillers);
    resolveAabbOverlaps(fillers);
    restackWithGravity(fillers);
    resolveAabbOverlaps(fillers);
  }
  // Locked: Y only (nail to floor) — never lateral shove into twin
  lockedLane.forEach(c => {
    const snap = packerXZ.get(c);
    if (snap) {
      c.mesh.position.x = snap.x * sc;
      c.mesh.position.z = snap.z * sc;
    }
    if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
  });

  if (cont && typeof clampMeshesInsideContainer === 'function') {
    // Clamp fillers; re-seat locked after clamp
    clampMeshesInsideContainer(fillers.map(c => c.mesh), cont);
    lockedLane.forEach(c => {
      const snap = packerXZ.get(c);
      if (!snap) return;
      c.mesh.position.x = snap.x * sc;
      c.mesh.position.z = snap.z * sc;
      if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
    });
  }

  // Chronic mesh dig-in → eject fillers only (never eject pair lanes)
  yardEjectChronicOverlaps(fillers, cont);
  {
    const remain = fillers.filter(c => !c.outsideContainer);
    if (remain.length) {
      restackWithGravity(remain);
      resolveAabbOverlaps(remain);
      restackWithGravity(remain);
      if (cont && typeof clampMeshesInsideContainer === 'function')
        clampMeshesInsideContainer(remain.map(c => c.mesh), cont);
    }
  }

  yardShoveFloorToHome(
    list.filter(c => !c.outsideContainer && !yardLaneLocked(c.item)),
    cont
  );
  {
    const afterShove = fillers.filter(c => !c.outsideContainer);
    if (afterShove.length) {
      resolveAabbOverlaps(afterShove);
      restackWithGravity(afterShove);
    }
  }

  // Seat locked meshes so WORLD AABB centre == packer XZ, then clear dig-ins
  function seatAabbCenterToPacker(mesh, xMm, zMm) {
    mesh.position.x = xMm * sc;
    mesh.position.z = zMm * sc;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (!isFinite(box.min.x)) return;
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    mesh.position.x += (xMm * sc) - cx;
    mesh.position.z += (zMm * sc) - cz;
    mesh.updateMatrixWorld(true);
  }
  const halfW = (((cont && cont.widthMm) || 2438) * sc) / 2;
  const gapM = 0.04; // 40mm visual clear
  const lockedAlive = lockedLane.filter(c => !c.outsideContainer);
  lockedAlive.forEach(c => {
    const snap = packerXZ.get(c);
    if (!snap) return;
    seatAabbCenterToPacker(c.mesh, snap.x, snap.z);
    if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
    c.item.x = snap.x;
    c.item.z = snap.z;
  });
  // Push later twin clear of earlier (by packer Z) until mesh AABBs don't dig in
  lockedAlive.sort((a, b) => {
    const za = (packerXZ.get(a) && packerXZ.get(a).z) || 0;
    const zb = (packerXZ.get(b) && packerXZ.get(b).z) || 0;
    return za - zb;
  });
  for (let i = 0; i < lockedAlive.length; i++) {
    for (let j = i + 1; j < lockedAlive.length; j++) {
      const A = lockedAlive[i], B = lockedAlive[j];
      A.mesh.updateMatrixWorld(true);
      B.mesh.updateMatrixWorld(true);
      let ba = new THREE.Box3().setFromObject(A.mesh);
      let bb = new THREE.Box3().setFromObject(B.mesh);
      const ox = Math.min(ba.max.x, bb.max.x) - Math.max(ba.min.x, bb.min.x);
      const oy = Math.min(ba.max.y, bb.max.y) - Math.max(ba.min.y, bb.min.y);
      const oz = Math.min(ba.max.z, bb.max.z) - Math.max(ba.min.z, bb.min.z);
      if (!(ox > 0.01 && oy > 0.01 && oz > 0.01)) continue;
      // Move B in +Z (away from home wall) so bb.min.z = ba.max.z + gap
      const need = (ba.max.z + gapM) - bb.min.z;
      if (need > 0) {
        B.mesh.position.z += need;
        B.mesh.updateMatrixWorld(true);
        bb = new THREE.Box3().setFromObject(B.mesh);
        if (bb.max.z > halfW - 0.002) {
          B.mesh.position.z -= (bb.max.z - (halfW - 0.002));
          B.mesh.updateMatrixWorld(true);
          bb = new THREE.Box3().setFromObject(B.mesh);
        }
        if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(B.mesh, 0);
        const snapB = packerXZ.get(B);
        const cz = ((bb.min.z + bb.max.z) * 0.5) / sc;
        B.item.z = cz;
        if (snapB) snapB.z = cz;
      }
    }
  }

  // Nail any unsupported mid-air piece to the floor (shipping: no float)
  const finalList = list.filter(c => !c.outsideContainer);
  finalList.forEach(c => {
    c.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c.mesh);
    if (!(box.min.y > 0.03)) return;
    let supported = false;
    for (let i = 0; i < finalList.length; i++) {
      const o = finalList[i];
      if (o === c) continue;
      o.mesh.updateMatrixWorld(true);
      const ob = new THREE.Box3().setFromObject(o.mesh);
      const ox = Math.min(box.max.x, ob.max.x) - Math.max(box.min.x, ob.min.x);
      const oz = Math.min(box.max.z, ob.max.z) - Math.max(box.min.z, ob.min.z);
      if (ox > 0.01 && oz > 0.01 && Math.abs(ob.max.y - box.min.y) <= 0.04) {
        supported = true;
        break;
      }
    }
    if (!supported) {
      c.mesh.position.y -= box.min.y;
      c.mesh.updateMatrixWorld(true);
    }
  });

  // After yard settle: restore packer orientation. Quaternion restore shifts the
  // world AABB → must re-seat foot Y to packer, then gravity-drop unsupported
  // seats (snap alone used to re-float when packer Y was wrong; packer floor
  // seats are trustworthy now, and gravity after snap kills residual air gaps).
  function restoreLockedOrients(entries) {
    (entries || []).forEach(c => {
      const it = c.item;
      if (!it || (!it.packOrientTag && !it._orientLocked)) return;
      if (it._lockedQuaternion && typeof THREE !== 'undefined') {
        c.mesh.quaternion.copy(it._lockedQuaternion);
        c.mesh.rotation.setFromQuaternion(c.mesh.quaternion);
      }
      c.mesh.updateMatrixWorld(true);
    });
  }
  function packerFootY0mm(it) {
    const fh = Number(it.packFootprintH) || Number(it.heightMm) || Number(it.h) || 0;
    const yCenter = it.y != null ? Number(it.y) : fh / 2;
    return yCenter - fh / 2;
  }
  /** Trust packer foot — never leave cargo on fat mesh “shelves”. */
  function forcePackerFeet(entries) {
    const foreman = !!(typeof currentLayout !== 'undefined' && currentLayout
      && (currentLayout.packStrategy === 'foreman_space_first'
        || (currentLayout.packPasses && currentLayout.packPasses.foreman)));
    const Hmax = (typeof currentLayout !== 'undefined' && currentLayout
      && currentLayout.containers && currentLayout.containers[0]
      && currentLayout.containers[0].heightMm)
      || (typeof rawScene !== 'undefined' && rawScene && rawScene.containerSpec
        && rawScene.containerSpec.heightMm)
      || 2591;
    (entries || []).forEach(c => {
      if (!c || !c.mesh || !c.item) return;
      const it = c.item;
      if (!foreman && !(it.packPoseLock || it._orientLocked
          || it.floorAnchor || it.packOrientTag))
        return;
      const fh = Number(it.packFootprintH) || Number(it.heightMm) || Number(it.h) || 0;
      const asm = !!(it.isAssembly || it.groupKind === 'welded_assembly'
        || it.groupKind === 'assembly_single');
      // Tall assemblies must sit on the floor — never on a 200mm nest “shelf”
      if (asm && fh > Hmax * 0.40) {
        const y0 = packerFootY0mm(it);
        if (y0 > 50) {
          it.y = fh / 2;
          it.floorAnchor = true;
        }
      }
      if (isFloorCargoItem(it) && typeof nailMeshToGroundY === 'function') {
        nailMeshToGroundY(c.mesh, 0);
      } else {
        snapMeshToPackerFootY(c.mesh, it);
      }
    });
  }
  function reseatAfterOrientRestore(entries) {
    restoreLockedOrients(entries);
    forcePackerFeet(entries);
    // Gravity only for unlocked leftovers — locked seats stay on packer Y
    const unlocked = (entries || []).filter(c =>
      c && c.item && !c.item.packPoseLock && !c.item._orientLocked && !c.item.floorAnchor);
    if (unlocked.length) restackWithGravity(unlocked);
  }
  function nailUnsupportedToFloor(entries) {
    (entries || []).forEach(c => {
      if (!c || c.outsideContainer || !c.mesh) return;
      const it = c.item;
      // Floor cargo: always live mesh minY → 0 (never trust fh mismatch)
      if (it && isFloorCargoItem(it)) {
        if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
        else {
          c.mesh.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(c.mesh);
          if (isFinite(box.min.y)) c.mesh.position.y -= box.min.y;
        }
        return;
      }
      c.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(c.mesh);
      if (!(box.min.y > 0.03)) return;
      let supported = false;
      for (let i = 0; i < entries.length; i++) {
        const o = entries[i];
        if (o === c || o.outsideContainer) continue;
        o.mesh.updateMatrixWorld(true);
        const ob = new THREE.Box3().setFromObject(o.mesh);
        const ox = Math.min(box.max.x, ob.max.x) - Math.max(box.min.x, ob.min.x);
        const oz = Math.min(box.max.z, ob.max.z) - Math.max(box.min.z, ob.min.z);
        if (ox > 0.01 && oz > 0.01 && Math.abs(ob.max.y - box.min.y) <= 0.04) {
          supported = true;
          break;
        }
      }
      if (supported) {
        // Stacked on real mesh — keep; optionally seat to packer shelf
        if (it && (it.packPoseLock || it._orientLocked))
          snapMeshToPackerFootY(c.mesh, it);
        return;
      }
      // Mid-air with no support → drop to floor (universal ground)
      if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
      else {
        c.mesh.position.y -= box.min.y;
        c.mesh.updateMatrixWorld(true);
      }
    });
  }
  const settled = list.filter(c => !c.outsideContainer);
  if (settled.length) {
    // Orient restore for fillers; locked keep quat already applied at render
    const settledFill = settled.filter(c => !yardLaneLocked(c.item));
    if (settledFill.length) {
      reseatAfterOrientRestore(settledFill);
      reseatAfterOrientRestore(settledFill);
    }
  }
  nailUnsupportedToFloor(settled.filter(c => !yardLaneLocked(c.item)));
  forcePackerFeet(settled.filter(c => !yardLaneLocked(c.item)));

  // Absolute last: re-seat pair lanes after any filler motion, clear mesh dig-in
  {
    const lockedEnd = list.filter(c => !c.outsideContainer && yardLaneLocked(c.item));
    lockedEnd.forEach(c => {
      const snap = packerXZ.get(c);
      if (!snap) return;
      if (c.item._lockedQuaternion && typeof THREE !== 'undefined') {
        c.mesh.quaternion.copy(c.item._lockedQuaternion);
        c.mesh.rotation.setFromQuaternion(c.mesh.quaternion);
      }
      seatAabbCenterToPacker(c.mesh, snap.x, snap.z);
      if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(c.mesh, 0);
    });
    lockedEnd.sort((a, b) => {
      const za = (packerXZ.get(a) && packerXZ.get(a).z) || 0;
      const zb = (packerXZ.get(b) && packerXZ.get(b).z) || 0;
      return za - zb;
    });
    for (let i = 0; i < lockedEnd.length; i++) {
      for (let j = i + 1; j < lockedEnd.length; j++) {
        const A = lockedEnd[i], B = lockedEnd[j];
        A.mesh.updateMatrixWorld(true);
        B.mesh.updateMatrixWorld(true);
        const ba = new THREE.Box3().setFromObject(A.mesh);
        let bb = new THREE.Box3().setFromObject(B.mesh);
        const ox = Math.min(ba.max.x, bb.max.x) - Math.max(ba.min.x, bb.min.x);
        const oy = Math.min(ba.max.y, bb.max.y) - Math.max(ba.min.y, bb.min.y);
        const oz = Math.min(ba.max.z, bb.max.z) - Math.max(ba.min.z, bb.min.z);
        if (!(ox > 0.01 && oy > 0.01 && oz > 0.01)) continue;
        const need = (ba.max.z + gapM) - bb.min.z;
        if (need <= 0) continue;
        B.mesh.position.z += need;
        B.mesh.updateMatrixWorld(true);
        bb = new THREE.Box3().setFromObject(B.mesh);
        if (bb.max.z > halfW - 0.002) {
          B.mesh.position.z -= (bb.max.z - (halfW - 0.002));
          B.mesh.updateMatrixWorld(true);
          bb = new THREE.Box3().setFromObject(B.mesh);
        }
        if (typeof nailMeshToGroundY === 'function') nailMeshToGroundY(B.mesh, 0);
        const snapB = packerXZ.get(B);
        const cz = ((bb.min.z + bb.max.z) * 0.5) / sc;
        B.item.z = cz;
        if (snapB) snapB.z = cz;
      }
    }
  }

  // Sync packer records to settled mesh (keeps later Optimise/seed honest)
  list.filter(c => !c.outsideContainer).forEach(c => {
    const it = c.item;
    c.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c.mesh);
    if (!isFinite(box.min.x)) return;
    const cx = (box.min.x + box.max.x) * 0.5 / sc;
    const cy = (box.min.y + box.max.y) * 0.5 / sc;
    const cz = (box.min.z + box.max.z) * 0.5 / sc;
    const snap = packerXZ.get(c);
    if (snap && snap.lock) {
      // Keep lane XZ (may have been nudged clear of twin); Y from live mesh
      it.x = snap.x;
      it.z = snap.z;
      it.y = cy;
    } else {
      it.x = cx;
      it.y = cy;
      it.z = cz;
    }
    // Do NOT overwrite packer footprints from pitched mesh AABB when orient-locked
    if (!it._orientLocked && !it.packOrientTag) {
      it.packFootprintL = (box.max.x - box.min.x) / sc;
      it.packFootprintW = (box.max.z - box.min.z) / sc;
      it.packFootprintH = (box.max.y - box.min.y) / sc;
    }
    it.packPoseLock = true;
    it.yardSettled = true;
  });
}

/**
 * Slide near-floor pieces toward container home (door-end X→0, wall Z→-W/2)
 * in small steps while keeping mesh AABB clear — denser floor utilization.
 */
function yardShoveFloorToHome(entries, cont) {
  if (!entries || !entries.length || !cont || typeof THREE === 'undefined') return;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  const L = (cont.lengthMm || 12000) * sc;
  const halfW = ((cont.widthMm || 2438) * sc) / 2;
  const floorBand = 0.45;
  const step = 0.04; // 40mm
  const list = entries.filter(e => e && e.mesh && !e.outsideContainer);
  // Heaviest first stay put; shove lighter around them
  list.sort((a, b) => yardItemWeightKg(b.item) - yardItemWeightKg(a.item));

  function boxesExcept(skip) {
    return list.filter(e => e !== skip).map(e => {
      e.mesh.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(e.mesh);
    });
  }
  function clearAt(mesh, others) {
    mesh.updateMatrixWorld(true);
    const a = new THREE.Box3().setFromObject(mesh);
    const eps = 1e-3;
    for (let i = 0; i < others.length; i++) {
      const b = others[i];
      if (a.max.x > b.min.x + eps && a.min.x < b.max.x - eps
          && a.max.y > b.min.y + eps && a.min.y < b.max.y - eps
          && a.max.z > b.min.z + eps && a.min.z < b.max.z - eps)
        return false;
    }
    // Inside walls
    if (a.min.x < -eps || a.max.x > L + eps) return false;
    if (a.min.z < -halfW - eps || a.max.z > halfW + eps) return false;
    return true;
  }

  list.forEach(c => {
    c.mesh.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(c.mesh);
    if (box.min.y > floorBand) return; // stacked — don't shove
    for (let pass = 0; pass < 32; pass++) {
      const others = boxesExcept(c);
      let moved = false;
      // Toward door end (X↓)
      c.mesh.position.x -= step;
      if (clearAt(c.mesh, others)) moved = true;
      else c.mesh.position.x += step;
      // Toward home wall (Z more negative)
      c.mesh.position.z -= step;
      if (clearAt(c.mesh, others)) moved = true;
      else c.mesh.position.z += step;
      if (!moved) break;
    }
    // Density shove must not lift floor cargo — re-nail after XZ slide
    if (c.item && typeof isFloorCargoItem === 'function' && isFloorCargoItem(c.item)
        && typeof nailMeshToGroundY === 'function')
      nailMeshToGroundY(c.mesh, 0);
  });
}

/**
 * After yard settle: try lateral shove to clear dig-in first; eject only when
 * interpenetration is severe and shove fails (keeps space utilization high).
 */
function yardEjectChronicOverlaps(entries, cont) {
  if (!entries || entries.length < 2 || typeof THREE === 'undefined') return;
  // Foreman AABB pack: footprints are already validated — mesh dig-in is shove-only
  // (eject was wiping 60%+ of a valid foreman load).
  const foreman = !!(typeof currentLayout !== 'undefined' && currentLayout
    && (currentLayout.packStrategy === 'foreman_space_first'
      || (currentLayout.packPasses && currentLayout.packPasses.foreman)));
  if (foreman) return;
  const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.001;
  const minPen = 0.12; // 120 mm — ignore nest flush / hairline
  const L = ((cont && cont.lengthMm) || 12000) * sc;
  const halfW = (((cont && cont.widthMm) || 2438) * sc) / 2;
  const alive = () => entries.filter(e => e && e.mesh && !e.outsideContainer);

  function overlapFrac(a, b) {
    const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
    const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
    const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
    if (!(ox > minPen && oy > minPen && oz > minPen)) return 0;
    const vol = ox * oy * oz;
    const volA = Math.max((a.max.x - a.min.x) * (a.max.y - a.min.y) * (a.max.z - a.min.z), 1e-9);
    const volB = Math.max((b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z), 1e-9);
    return vol / Math.min(volA, volB);
  }
  function clearOf(mesh, others) {
    mesh.updateMatrixWorld(true);
    const a = new THREE.Box3().setFromObject(mesh);
    const eps = 2e-3;
    if (a.min.x < -eps || a.max.x > L + eps) return false;
    if (a.min.z < -halfW - eps || a.max.z > halfW + eps) return false;
    for (let i = 0; i < others.length; i++) {
      const b = others[i];
      if (a.max.x > b.min.x + eps && a.min.x < b.max.x - eps
          && a.max.y > b.min.y + eps && a.min.y < b.max.y - eps
          && a.max.z > b.min.z + eps && a.min.z < b.max.z - eps)
        return false;
    }
    return true;
  }
  /** Push lighter piece on X/Z up to 8×50mm to clear dig-in without eject. */
  function tryShoveClear(victim, otherBox) {
    const step = 0.05;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const others = alive().filter(e => e !== victim).map(e => {
      e.mesh.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(e.mesh);
    });
    const ox0 = victim.mesh.position.x;
    const oz0 = victim.mesh.position.z;
    for (let d = 0; d < dirs.length; d++) {
      for (let k = 1; k <= 10; k++) {
        victim.mesh.position.x = ox0 + dirs[d][0] * step * k;
        victim.mesh.position.z = oz0 + dirs[d][1] * step * k;
        if (clearOf(victim.mesh, others)) {
          victim.mesh.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(victim.mesh);
          if (isFinite(box.min.y) && box.min.y > 1e-4)
            victim.mesh.position.y -= box.min.y;
          return true;
        }
      }
    }
    victim.mesh.position.x = ox0;
    victim.mesh.position.z = oz0;
    return false;
  }

  let guard = 0;
  while (guard++ < 24) {
    const cur = alive();
    const boxes = cur.map(e => {
      e.mesh.updateMatrixWorld(true);
      return { e, box: new THREE.Box3().setFromObject(e.mesh) };
    });
    let victim = null;
    let otherBox = null;
    let bestVol = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box, b = boxes[j].box;
        const frac = overlapFrac(a, b);
        // Severe dig-in only (≥22%); light plates need ≥35%
        if (frac < 0.22) continue;
        const eA = boxes[i].e, eB = boxes[j].e;
        const wA = yardItemWeightKg(eA.item), wB = yardItemWeightKg(eB.item);
        if (Math.min(wA, wB) < 40 && frac < 0.35) continue;
        const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
        const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
        const vol = ox * oy * oz;
        if (vol > bestVol) {
          bestVol = vol;
          const asmA = !!(eA.item && (eA.item.isAssembly || eA.item.groupKind === 'welded_assembly'));
          const asmB = !!(eB.item && (eB.item.isAssembly || eB.item.groupKind === 'welded_assembly'));
          // Prefer keeping nest L stacks / heavy assemblies inside
          const nestA = /nest_[lcz]|l_angle|z_channel|c_channel/i.test(
            String(eA.item?.groupKind || '') + ' ' + (eA.item?.shapeKey || ''));
          const nestB = /nest_[lcz]|l_angle|z_channel|c_channel/i.test(
            String(eB.item?.groupKind || '') + ' ' + (eB.item?.shapeKey || ''));
          if (asmA && !asmB) { victim = eB; otherBox = a; }
          else if (asmB && !asmA) { victim = eA; otherBox = b; }
          else if (nestA && !nestB) { victim = eB; otherBox = a; }
          else if (nestB && !nestA) { victim = eA; otherBox = b; }
          else if (wA <= wB) { victim = eA; otherBox = b; }
          else { victim = eB; otherBox = a; }
        }
      }
    }
    if (!victim) break;
    // Prefer shove over eject — keep util high (no gravity here; avoids thrash)
    if (tryShoveClear(victim, otherBox)) continue;
    victim.outsideContainer = true;
    if (victim.item) {
      victim.item.outsideContainer = true;
      victim.item.packPoseLock = false;
      victim.item.needsRotate = true;
      victim.item.fitReason = 'YARD_OVERLAP_EJECT';
      victim.item.fitReasonMsg = 'Mesh overlap after yard settle — left outside';
    }
    // Park beside container for inspection
    const W = (cont && cont.widthMm) || 2438;
    victim.mesh.position.z = (W / 2 + 1200) * sc;
    victim.mesh.position.y = 0;
    victim.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(victim.mesh);
    if (isFinite(box.min.y)) victim.mesh.position.y -= box.min.y;
    // Drop from active container item list
    if (currentLayout && currentLayout.containers) {
      currentLayout.containers.forEach(c => {
        if (!c.items) return;
        c.items = c.items.filter(it => it !== victim.item
          && !(victim.item && it.mark && it.mark === victim.item.mark));
      });
      if (!currentLayout.oversized) currentLayout.oversized = [];
      if (victim.item && !currentLayout.oversized.includes(victim.item))
        currentLayout.oversized.push(victim.item);
    }
  }
}

/**
 * Map packer packOrientTag → Euler. Rest-pose (X/Z) stays in makeShape;
 * packer tags usually only change YAW. Rx/Rz tags used when packComposeRot.
 */
function packOrientTagToRot(it) {
  const tag = String((it && it.packOrientTag) || '');
  let x = 0;
  let y = 0;
  let z = 0;
  if (tag === 'rule1_yaw180' || tag === 'yaw180' || /yaw180/i.test(tag)) {
    y = Math.PI;
  }
  if (/Rx270/i.test(tag)) x = -Math.PI / 2;
  else if (/Rx90/i.test(tag) || tag === 'upright') x = Math.PI / 2;
  if (/Rz270/i.test(tag)) z = -Math.PI / 2;
  else if (/Rz90/i.test(tag)) z = Math.PI / 2;
  return { x, y, z };
}

/**
 * Group By is source of truth at Optimise:
 *  • Z/C/L nests + flange braces — keep nest bundle / nest roll
 *  • Frozen assemblies — yaw only (face rebuilt via _yardStraighten in makeShape)
 * Optimise must NOT Rx/Rz / footprint-realign these.
 */
function packItemKeepGroupByPose(it) {
  if (!it) return false;
  if (it._keepGroupByBundle || it._freezeGroupByPose || it._groupByQuat) return true;
  const gk = String(it.groupKind || '').toLowerCase();
  const sk = String(it.shapeKey || it.profileShape || '').toLowerCase();
  if (/^nest_[zcl]$/.test(gk)) return true;
  if (sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle') return true;
  if (/FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE/i.test(
    String(it.mark || '') + ' ' + ((it.marks || []).join(' '))))
    return true;
  return false;
}

/** @deprecated use packItemKeepGroupByPose — name kept for call sites */
function packItemNeedsFlatAlign(it) {
  return packItemKeepGroupByPose(it);
}

/** Apply packer rotation onto a mesh that already has makeShape rest-pose. */
function applyPackItemRotation(mesh, it) {
  if (!mesh || !it) return;

  // If no user rotation was manually applied, derive from packOrientTag
  if (!it.userRot && it.packOrientTag) {
    it.userRot = packOrientTagToRot(it);
  }

  function lockOrient() {
    it._orientLocked = true;
    if (typeof THREE !== 'undefined')
      it._lockedQuaternion = mesh.quaternion.clone();
  }

  // Nest / frozen assembly: KEEP Group-By rest-pose. Yaw only.
  // Do NOT alignMeshToPackFootprint or re-apply X/Z — that tipped / diagonalized.
  // CRITICAL: never use mesh.rotation.y += … after setting quaternion — Euler
  // rewrite destroys pitch/roll and makes cargo look diagonal / floating.
  if (packItemKeepGroupByPose(it) || it._freezeGroupByPose || it._groupByQuat) {
    if (typeof applyGroupByFrozenQuat === 'function')
      applyGroupByFrozenQuat(mesh, it);
    const tagYaw = packOrientTagToRot(it).y || 0;
    const urYaw = (it.userRot && it.userRot.y) || 0;
    // userRot already carries packOrientTag yaw when set by packer — don't double
    const yaw = it.userRot ? urYaw : tagYaw;
    if (Math.abs(yaw) > 1e-9 && typeof THREE !== 'undefined') {
      const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), yaw);
      mesh.quaternion.premultiply(qYaw);
      mesh.rotation.setFromQuaternion(mesh.quaternion);
    }
    mesh.updateMatrixWorld(true);
    lockOrient();
    return;
  }

  if (!it.userRot) {
    if (typeof applyStoredRotation === 'function') applyStoredRotation(mesh, it);
    if (it.packOrientTag) lockOrient();
    return;
  }
  const ur = it.userRot;
  if (it.packComposeRot) {
    // Prefer footprint-aligned face roll (avoids rest-pose × Rx90 cancellation)
    if (it.packFootprintL > 0 && it.packFootprintW > 0 && it.packFootprintH > 0) {
      if (alignMeshToPackFootprint(mesh, it)) {
        lockOrient();
        return;
      }
    }
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
    // Quaternion world yaw — never Euler += (destroys rest pitch/roll)
    const yaw = ur.y || 0;
    if (Math.abs(yaw) > 1e-9 && typeof THREE !== 'undefined') {
      const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), yaw);
      mesh.quaternion.premultiply(qYaw);
      mesh.rotation.setFromQuaternion(mesh.quaternion);
    }
  } else {
    mesh.rotation.set(ur.x || 0, ur.y || 0, ur.z || 0);
  }

  if (it.packOrientTag) lockOrient();
}

/**
 * Pack place theatre: show only final seats (commit) one-by-one.
 * No orient / rotate / slot-try ghost — user only sees placed pieces.
 */
async function animatePackPlacementReveal(packedContainers, keepOutside, placementSteps, packMeta) {
  const finalCont = (packedContainers && packedContainers[0])
    ? { ...packedContainers[0] }
    : null;
  if (!finalCont) return;
  const meta = packMeta || {};

  const steps = (placementSteps || []).slice();
  const finalItems = (finalCont.items || []).slice();
  // Key by unique pack-unit id first — twins often share the same mark string
  const byMark = new Map();
  finalItems.forEach(it => {
    if (it._fmUid) byMark.set(`uid:${it._fmUid}`, it);
    const marks = it.marks && it.marks.length ? it.marks : [it.mark];
    marks.forEach(m => { if (m) byMark.set(m, it); });
    if (it.mark) byMark.set(it.mark, it);
  });
  function resolveCommitItem(s) {
    if (s && s._fmUid && byMark.has(`uid:${s._fmUid}`))
      return byMark.get(`uid:${s._fmUid}`);
    if (s && s.mark && byMark.has(s.mark)) return byMark.get(s.mark);
    return null;
  }

  const live = {
    ...finalCont,
    items: [],
    usedWeightKg: 0,
    weightUtilizationPct: 0,
    volumeUtilizationPct: 0,
  };
  const remainingOutside = (keepOutside || []).slice();
  currentLayout = {
    containers: [live],
    oversized: remainingOutside,
    packStrategy: meta.packStrategy || meta.strategy || 'foreman_space_first',
    packPasses: meta.packPasses || { foreman: true },
    foremanReport: meta.foremanReport || null,
  };
  currentContainerIdx = 0;
  renderContainer(0);

  const maxKg = finalCont.maxWeightKg || 26000;
  const Lmax = finalCont.lengthMm || 12000;
  const Wmax = finalCont.widthMm || 2350;
  const cv = Lmax * Wmax * (finalCont.heightMm || 2690);
  let wSum = 0;
  let vSum = 0;
  let seatIdx = 0;

  function syncLive(extraOutside) {
    const outs = extraOutside != null ? extraOutside : remainingOutside;
    currentLayout = {
      containers: [live],
      oversized: outs,
      packStrategy: meta.packStrategy || meta.strategy || 'foreman_space_first',
      packPasses: meta.packPasses || { foreman: true },
      foremanReport: meta.foremanReport || null,
    };
    renderContainer(0);
  }

  // Place-only: ignore orient / slot / accept / unit_start theatre noise
  const placeSteps = steps.filter(s =>
    s && (s.type === 'commit' || s.type === 'reject'
      || (!s.type && s.mark && byMark.has(s.mark))));

  for (let si = 0; si < placeSteps.length; si++) {
    const s = placeSteps[si];
    const typ = s.type || (s.mark ? 'commit' : '');

    if (typ === 'commit') {
      const finalIt = resolveCommitItem(s) || byMark.get(s.mark);
      if (finalIt && !live.items.some(it =>
        it === finalIt
        || (finalIt._fmUid && it._fmUid === finalIt._fmUid))) {
        seatIdx++;
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
          showToast(`✔ #${seatIdx} · ${s.mark}`, 450);
        } catch (_) { /* */ }
        await csPackSleep(420);
      }
      continue;
    }

    if (typ === 'reject') {
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

  currentLayout = {
    containers: packedContainers,
    oversized: keepOutside || [],
    packStrategy: meta.packStrategy || meta.strategy || 'foreman_space_first',
    packPasses: meta.packPasses || { foreman: true },
    foremanReport: meta.foremanReport || null,
  };
  renderContainer(0);
}

async function layoutPlaceSelected() {
  runOptimizeKeepingLeftovers();
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
    const q = c.mesh.quaternion;
    const pose = {
      x: c.mesh.position.x / SCALE,
      y: c.mesh.position.y / SCALE,
      z: c.mesh.position.z / SCALE,
      rot: { x: c.mesh.rotation.x, y: c.mesh.rotation.y, z: c.mesh.rotation.z },
      quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      outside: !!c.outsideContainer,
      item: {
        ...c.item,
        marks: marks.filter(Boolean),
        nestPieces: c.item.nestPieces
          ? c.item.nestPieces.map(np => ({ ...np }))
          : null,
        parts: c.item.parts || null,
        pathPointsMm: c.item.pathPointsMm || null,
        _groupByQuat: c.item._groupByQuat || {
          x: q.x, y: q.y, z: q.z, w: q.w,
        },
      },
    };
    marks.forEach(m => { if (m) prevPose[m] = pose; });
  });
  return prevPose;
}

/**
 * Optimise & Place — Pack V2 (twins + stacks).
 * Checked staging groups → BuildUnits → PackWithTwins → seats in container;
 * leftovers stay outside with honest fitReason.
 */
function runOptimizeKeepingLeftovers() {
  if (!rawScene) return null;
  if (typeof requireGrouped === 'function' && !requireGrouped('Optimise'))
    return null;
  if (typeof csPackV2RunOptimise !== 'function') {
    if (typeof showToast === 'function')
      showToast('Pack V2 not loaded', 3000);
    return null;
  }

  const groups = (typeof assemblyGroups !== 'undefined' && assemblyGroups)
    ? assemblyGroups : [];
  const checked = groups.filter(g => g && g.checked && g.state !== 'oversized');
  if (!checked.length) {
    if (typeof showToast === 'function')
      showToast('Select sets first — click 1, 2, 3… then Optimise & Place', 3200);
    return null;
  }

  // Freeze Group By orientations from the current yard view
  try {
    if (typeof captureVisibleRotations === 'function')
      captureVisibleRotations();
  } catch (_) { /* */ }
  try {
    if (typeof clickable !== 'undefined' && clickable
        && typeof stampGroupByQuatOnStaging === 'function') {
      clickable.forEach(c => {
        if (c && c.mesh && c.item)
          stampGroupByQuatOnStaging(c.item, c.mesh);
      });
    }
  } catch (_) { /* */ }

  const result = csPackV2RunOptimise({
    groups,
    containerSpec: rawScene.containerSpec,
    enableStacks: true,
    checkedOnly: true,
  });

  if (!result || !result.layout) {
    if (typeof showToast === 'function')
      showToast((result && result.toast) || 'Optimise failed', 3500);
    return result;
  }

  currentLayout = result.layout;
  currentContainerIdx = 0;
  currentMode = 'optimize';

  // Staging card states from placed / leftover items
  const placedByGroup = new Set();
  const leftByGroup = new Map();
  (result.placedItems || []).forEach(it => {
    if (it.stagingGroupId) placedByGroup.add(it.stagingGroupId);
  });
  (result.leftoverItems || []).forEach(it => {
    if (!it.stagingGroupId) return;
    if (!leftByGroup.has(it.stagingGroupId))
      leftByGroup.set(it.stagingGroupId, it);
  });

  const contId = (typeof activeContainerId !== 'undefined' && activeContainerId)
    ? activeContainerId : 'C1';
  groups.forEach(g => {
    if (!g || !g.checked) return;
    if (placedByGroup.has(g.id)) {
      g.state = 'placed';
      g.containerId = contId;
      g.needsRotate = false;
      g.fitReason = null;
      g.stackFailReason = null;
    } else if (leftByGroup.has(g.id)) {
      const left = leftByGroup.get(g.id);
      g.state = 'unplaced';
      g.containerId = null;
      g.fitReason = left.fitReason || null;
      g.stackFailReason = left.stackFailReason || null;
      g.needsRotate = false;
    }
  });

  try { renderContainer(0); } catch (_) { /* */ }
  try { if (typeof renderStagingList === 'function') renderStagingList(); } catch (_) { /* */ }
  try { if (typeof updateStagingFooter === 'function') updateStagingFooter(); } catch (_) { /* */ }
  try {
    if (typeof syncSidebarContainersFromLayout === 'function')
      syncSidebarContainersFromLayout();
  } catch (_) { /* */ }
  try { if (typeof updateWorkflowUI === 'function') updateWorkflowUI(); } catch (_) { /* */ }

  if (typeof showToast === 'function')
    showToast(result.toast || 'Pack V2 done', 4500);

  try {
    if (result.report && typeof csPackV2PublishPackReport === 'function')
      csPackV2PublishPackReport(result.report, { updateDom: true, replaceStats: false });
  } catch (_) { /* */ }

  try {
    if (typeof csPackV2SoakInspect === 'function') {
      const soak = csPackV2SoakInspect(result, {
        containerSpec: rawScene.containerSpec,
      });
      result.soak = soak;
      if (typeof window !== 'undefined')
        window.__lastPackV2Soak = soak;
      if (!soak.ok && typeof showToast === 'function')
        showToast('⚠ ' + (soak.summary || 'Soak gate fail'), 5000);
    }
  } catch (_) { /* */ }

  try {
    if (typeof window !== 'undefined')
      window.__lastPackV2Optimise = result;
  } catch (_) { /* */ }
  return result;
}
