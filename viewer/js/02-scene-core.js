/* 02-scene-core.js — SCALE, theme, Three init, container clamps */

const SCALE = 1/100; // mm -> scene units
const COLORS = { beam:0x378ADD, rod:0x1D9E75, plate:0xEF9F27, purlin:0x7F77DD, other:0x888780 };
const OVERSIZED_COLOR = 0xE24B4A;

// Null-safe DOM helpers — new 3-panel layout removed some old element IDs.
// These prevent "Cannot read properties of null" crashes when legacy code
// tries to update elements that no longer exist in the HTML.
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el && val !== null && val !== undefined) el.textContent = val;
}
function setElStyle(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = val;
}

let scene, camera, renderer, controls, raycaster, mouse;
let clickable = [];
let rawScene = null;      // { jobNo, bldgNo, phaseNo, customer, containerSpec, items[] }
let currentLayout = null; // { containers:[...], oversized:[...] }
let currentMode = 'quick';
let dataIssues = [];      // items excluded for having invalid/garbage dimensions or weight
let currentContainerIdx = 0;

/** Read CSS theme colour tokens as Three.js hex ints. */
function themeSceneHex(which) {
  const root = getComputedStyle(document.documentElement);
  const map = {
    scene: '--scene-bg',
    preview: '--preview-bg',
    gridMajor: '--grid-major',
    gridMinor: '--grid-minor',
    container: '--container-line',
  };
  const raw = (root.getPropertyValue(map[which] || '--scene-bg') || '#111318').trim();
  const hex = raw.replace('#', '');
  return parseInt(hex.length === 3
    ? hex.split('').map(c => c + c).join('')
    : hex, 16);
}

/**
 * GridHelper (r128) bakes colours into geometry vertex colours — material.color
 * updates do nothing. Rewrite the color attribute for theme switches.
 */
function setGridHelperColors(grid, majorHex, minorHex) {
  const colors = grid.geometry && grid.geometry.getAttribute('color');
  if (!colors || colors.count < 4) return;
  const color1 = new THREE.Color(majorHex);
  const color2 = new THREE.Color(minorHex);
  const divisions = (colors.count / 4) - 1;
  const center = divisions / 2;
  let j = 0;
  for (let i = 0; i <= divisions; i++) {
    const c = i === center ? color1 : color2;
    for (let n = 0; n < 4; n++, j++) colors.setXYZ(j, c.r, c.g, c.b);
  }
  colors.needsUpdate = true;
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * Steel body material. Near-opaque + depthWrite = clean MSAA edges.
 * Always-transparent mats (even at 0.95) cause the jagged “sawtooth” look.
 */
function makeSteelMaterial(color, opacity) {
  let op = opacity != null ? opacity : 0.95;
  const light = currentTheme() === 'light';
  // Light theme: prefer solid surfaces for definition
  if (light && op >= 0.9) op = 1;
  const opaque = op >= 0.985;
  return new THREE.MeshStandardMaterial({
    color,
    opacity: opaque ? 1 : op,
    transparent: !opaque,
    depthWrite: true,
    metalness: light ? 0.28 : 0.18,
    roughness: light ? 0.4 : 0.5,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
  });
}

/** Edge overlay — light theme keeps lines soft (line AA is weak; fill MSAA does the work). */
function themeEdgeStyle(baseOpacity) {
  const base = baseOpacity != null ? baseOpacity : 0.3;
  if (currentTheme() === 'light') {
    return { color: 0x334155, opacity: Math.min(0.45, base * 1.1 + 0.06) };
  }
  return { color: 0x000000, opacity: base };
}

/** Shared mesh silhouette lines (theme-aware). */
function makeEdgeOverlay(sourceGeo, thresholdAngle, baseOpacity) {
  const geo = thresholdAngle != null
    ? new THREE.EdgesGeometry(sourceGeo, thresholdAngle)
    : new THREE.EdgesGeometry(sourceGeo);
  const s = themeEdgeStyle(baseOpacity != null ? baseOpacity : 0.3);
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: s.color,
      opacity: s.opacity,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    })
  );
  lines.userData.isMeshEdgeOverlay = true;
  lines.userData.edgeBaseOpacity = baseOpacity != null ? baseOpacity : 0.3;
  return lines;
}

function refreshMeshEdgeOverlays() {
  if (!scene) return;
  scene.traverse(obj => {
    if (!obj.isLineSegments || !obj.material) return;
    if (obj.userData && obj.userData.isContainerOutline) return;
    if (obj.type === 'GridHelper') return;
    // Mesh child edges (silhouette) — skip other line helpers
    if (!(obj.userData && obj.userData.isMeshEdgeOverlay) && !(obj.parent && obj.parent.isMesh))
      return;
    const base = (obj.userData && obj.userData.edgeBaseOpacity != null)
      ? obj.userData.edgeBaseOpacity : 0.3;
    const s = themeEdgeStyle(base);
    if (obj.material.color) obj.material.color.setHex(s.color);
    obj.material.opacity = s.opacity;
    obj.material.transparent = true;
  });
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('steelViewerTheme', t); } catch (e) {}
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = t === 'light' ? 'Dark' : 'Light';
    btn.title = t === 'light'
      ? 'Switch to dark theme'
      : 'Switch to light (system default) theme';
  }
  if (typeof THREE !== 'undefined') {
    if (scene) scene.background = new THREE.Color(themeSceneHex('scene'));
    if (typeof previewScene !== 'undefined' && previewScene)
      previewScene.background = new THREE.Color(themeSceneHex('preview'));
    if (scene) {
      const major = themeSceneHex('gridMajor');
      const minor = themeSceneHex('gridMinor');
      const contCol = themeSceneHex('container');
      // Rebuild lights for theme contrast (form/definition)
      [...scene.children].forEach(c => { if (c.isLight) scene.remove(c); });
      addLights();
      scene.traverse(obj => {
        if (obj.type === 'GridHelper') {
          setGridHelperColors(obj, major, minor);
          return;
        }
        if (obj.userData && obj.userData.isSafeZoneOutline && obj.material && obj.material.color) {
          const safeCol = obj.userData.safeZoneColor
            || (obj.parent && obj.parent.userData && obj.parent.userData.safeZoneColor)
            || 0x1b9e75;
          obj.material.color.setHex(safeCol);
          // Floor pad stays softer; lines stay stronger
          if (obj.isMesh) obj.material.opacity = t === 'light' ? 0.14 : 0.20;
          else obj.material.opacity = t === 'light' ? 0.95 : 0.9;
          obj.material.transparent = true;
          return;
        }
        if (obj.userData && obj.userData.isContainerOutline
            && obj.material && obj.material.color) {
          obj.material.color.setHex(contCol);
          obj.material.opacity = t === 'light' ? 1 : 0.95;
          obj.material.transparent = true;
        }
      });
      refreshMeshEdgeOverlays();
    }
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

// ------------------------------------------------------------------
// THREE.JS BOILERPLATE
// ------------------------------------------------------------------
function resizeRendererToViewport() {
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap || !renderer || !camera) return;
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // updateStyle=true keeps CSS size = layout size while buffer uses devicePixelRatio
  // (updateStyle=false was stretching/softening the canvas → jagged diagonals)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, true);
  const el = renderer.domElement;
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.display = 'block';
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(themeSceneHex('scene'));
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true, // less z-fight shimmer on grid / thin plates
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  document.getElementById('canvas-wrap').appendChild(renderer.domElement);
  resizeRendererToViewport();
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableKeys = false; // arrows move pieces, not the camera
  addLights();
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  // Pointer capture phase — before OrbitControls. Move ON disables orbit rotate.
  renderer.domElement.addEventListener('pointerdown', onMouseDown, true);
  renderer.domElement.addEventListener('pointermove', onMouseMove);
  renderer.domElement.addEventListener('pointerup', onMouseUp);
  renderer.domElement.addEventListener('pointercancel', onMouseUp);
  renderer.domElement.addEventListener('click', onClick);
  window.addEventListener('pointermove', onMouseMove);
  window.addEventListener('pointerup', onMouseUp);
  // Make canvas focusable so arrow keys reach our handler after click
  renderer.domElement.tabIndex = 0;
  renderer.domElement.style.outline = 'none';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.addEventListener('pointerdown', () => {
    try { renderer.domElement.focus({ preventScroll: true }); } catch (_) {}
  });
  window.addEventListener('resize', resizeRendererToViewport);

  // Block browser Ctrl+wheel page zoom so side panels stay fixed size.
  // While dragging a piece, still allow 3D zoom (scroll) so user can check placement.
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); return; }
    if (!isDragging || !controls || !camera) return;
    // Manual dolly zoom while piece-dragging (Orbit may miss wheel under pointer capture)
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    const target = controls.target.clone();
    const offset = camera.position.clone().sub(target);
    const dist = offset.length();
    const factor = delta > 0 ? 1.08 : 1 / 1.08;
    const newDist = Math.min(Math.max(dist * factor, 2), 2000);
    offset.setLength(newDist);
    camera.position.copy(target).add(offset);
    controls.update();
  }, { passive: false });

  // Arrow keys = sideways on floor. PageUp/Down or Q/E = raise / lower (Y).
  document.addEventListener('keydown', (e) => {
    if (!selected?.mesh) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const stepMm = e.shiftKey ? 5 : 40;
    const step = stepMm * SCALE;
    const key = e.key;
    const code = e.code;

    // ── Vertical raise / lower ──
    let dirY = 0;
    if (key === 'PageUp' || code === 'PageUp' || key === 'q' || key === 'Q' || code === 'KeyQ') dirY = 1;
    else if (key === 'PageDown' || code === 'PageDown' || key === 'e' || key === 'E' || code === 'KeyE') dirY = -1;
    if (dirY !== 0) {
      e.preventDefault();
      e.stopPropagation();
      const meshes = meshesForNudge(selected);
      const oldPos = meshes.map(m => m.position.clone());
      const contK = currentLayout?.containers?.[currentContainerIdx];
      const stayInside = !!(moveMode || (contK && !selectedIsOutside(selected)));

      meshes.forEach(m => { m.position.y += dirY * step; });
      settleMeshesToTouch(meshes);
      if (stayInside && contK) {
        // Soft wall stop (floor / roof) — smooth like outside, no snap-back fight
        clampMeshesInsideContainer(meshes, contK);
      } else {
        meshes.forEach(m => {
          m.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(m);
          if (box.min.y < 0) m.position.y += -box.min.y;
        });
      }

      if (nudgeCollides(selected, meshes)) {
        pushMeshesOutOfOverlaps(meshes);
        if (stayInside && contK) clampMeshesInsideContainer(meshes, contK);
        if (nudgeCollides(selected, meshes)) {
          meshes.forEach((m, i) => m.position.copy(oldPos[i]));
          if (stayInside && contK) clampMeshesInsideContainer(meshes, contK);
        }
      }
      checkSelectedFit();
      renderInfoPanel();
      return;
    }

    let dirScreenUp = 0, dirScreenRight = 0;
    if (key === 'ArrowUp' || code === 'ArrowUp') dirScreenUp = 1;
    else if (key === 'ArrowDown' || code === 'ArrowDown') dirScreenUp = -1;
    else if (key === 'ArrowRight' || code === 'ArrowRight') dirScreenRight = 1;
    else if (key === 'ArrowLeft' || code === 'ArrowLeft') dirScreenRight = -1;
    else return;
    e.preventDefault();
    e.stopPropagation();

    camera.updateMatrixWorld(true);
    const ewm = camera.matrixWorld.elements;
    let screenRight = new THREE.Vector3(ewm[0], 0, ewm[2]);
    let screenUp = new THREE.Vector3(-ewm[8], 0, -ewm[10]);
    if (screenUp.lengthSq() < 1e-8) screenUp.set(ewm[4], 0, ewm[6]);
    if (screenRight.lengthSq() < 1e-8) screenRight.set(1, 0, 0);
    screenUp.normalize();
    screenRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), screenUp);
    if (screenRight.lengthSq() < 1e-8) screenRight.set(1, 0, 0);
    screenRight.normalize();
    screenUp = new THREE.Vector3().crossVectors(screenRight, new THREE.Vector3(0, 1, 0)).normalize();

    const move = new THREE.Vector3()
      .addScaledVector(screenUp, dirScreenUp * step)
      .addScaledVector(screenRight, dirScreenRight * step);

    const meshes = meshesForNudge(selected);
    const oldPos = meshes.map(m => m.position.clone());
    const contK = currentLayout?.containers?.[currentContainerIdx];
    const stayInside = !!(moveMode || (contK && !selectedIsOutside(selected)));
    const outsideRearrange = selectedIsOutside(selected) && !moveMode;

    // Smooth move (same feel as outside): translate → settle Y → soft wall clamp only
    meshes.forEach(m => { m.position.x += move.x; m.position.z += move.z; });
    settleMeshesToTouch(meshes);
    if (stayInside && contK) {
      clampMeshesInsideContainer(meshes, contK);
    }

    if (nudgeCollides(selected, meshes)) {
      pushMeshesOutOfOverlaps(meshes);
      settleMeshesToTouch(meshes);
      if (stayInside && contK) clampMeshesInsideContainer(meshes, contK);
      if (nudgeCollides(selected, meshes)) {
        meshes.forEach((m, i) => m.position.copy(oldPos[i]));
        settleMeshesToTouch(meshes);
        if (stayInside && contK) clampMeshesInsideContainer(meshes, contK);
      }
    }

    // Outside rearrange: support / overlap rules
    if (outsideRearrange) {
      if (!validateOutsidePlacement(selected)) {
        meshes.forEach((m, i) => m.position.copy(oldPos[i]));
        settleMeshesToTouch(meshes);
        showToast('Need full base support (no overhang) & no overlap — returned', 2500);
      } else if (contK && meshOverlapsContainerVolume(meshes[0], contK) &&
                 !meshes.every(m => isMeshInsideContainer(m, contK, 0.02))) {
        meshes.forEach((m, i) => m.position.copy(oldPos[i]));
        settleMeshesToTouch(meshes);
        showToast('Use → Into container — cannot stick through walls', 2800);
      }
    }
    // Inside: walls already soft-clamped — no hard snap-back (smooth slide along walls)

    checkSelectedFit();
    renderInfoPanel();
  }, true);

  animate();
}

/** Meshes moved by arrow nudge — whole set when selectMode is Set. */
function meshesForNudge(sel) {
  if (!sel?.mesh) return [];
  if (selectMode === 'piece' || sel.isSubPiece) return [sel.mesh];
  const marks = new Set();
  if (sel.item?.mark) marks.add(sel.item.mark);
  (sel.item?.marks || []).forEach(m => { if (m) marks.add(m); });
  const group = [];
  const seen = new Set();
  for (const entry of clickable) {
    if (!entry?.mesh || seen.has(entry.mesh)) continue;
    const im = entry.item?.mark;
    const ims = entry.item?.marks || [];
    const match = (im && marks.has(im)) || ims.some(m => marks.has(m));
    const sameOutside = !!entry.outsideContainer === !!(sel.outsideContainer || sel.item?.outsideContainer);
    if (match && sameOutside) {
      seen.add(entry.mesh);
      group.push(entry.mesh);
    }
  }
  return group.length ? group : [sel.mesh];
}

function clampMeshesInsideContainer(meshes, cont) {
  if (!cont || !meshes?.length) return;
  // Safe-zone envelope (ops clearance) — not the outer blue-box walls
  const env = (typeof getPackEnvelopeWorld === 'function')
    ? getPackEnvelopeWorld(cont)
    : null;
  const contMinX = env ? env.minX : 0;
  const contMaxX = env ? env.maxX : cont.lengthMm * SCALE;
  const contMinZ = env ? env.minZ : -cont.widthMm * SCALE / 2;
  const contMaxZ = env ? env.maxZ : cont.widthMm * SCALE / 2;
  const contMinY = env ? env.minY : 0;
  const contMaxY = env ? env.maxY : cont.heightMm * SCALE;
  const spanX = contMaxX - contMinX;
  const spanZ = contMaxZ - contMinZ;
  const spanY = contMaxY - contMinY;

  // Nested / rotated groups may need a few passes after each axis shift
  for (let pass = 0; pass < 3; pass++) {
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const sizeX = box.max.x - box.min.x;
      const sizeZ = box.max.z - box.min.z;
      const sizeY = box.max.y - box.min.y;

      // If piece is larger than a container axis, centre it (still won't fully fit)
      if (sizeX > spanX + 1e-6) {
        mesh.position.x += ((contMinX + contMaxX) * 0.5) - ((box.min.x + box.max.x) * 0.5);
      } else {
        if (box.min.x < contMinX) mesh.position.x += contMinX - box.min.x;
        if (box.max.x > contMaxX) mesh.position.x -= box.max.x - contMaxX;
      }

      mesh.updateMatrixWorld(true);
      const boxZ = new THREE.Box3().setFromObject(mesh);
      if (sizeZ > spanZ + 1e-6) {
        mesh.position.z += ((contMinZ + contMaxZ) * 0.5) - ((boxZ.min.z + boxZ.max.z) * 0.5);
      } else {
        if (boxZ.min.z < contMinZ) mesh.position.z += contMinZ - boxZ.min.z;
        if (boxZ.max.z > contMaxZ) mesh.position.z -= boxZ.max.z - contMaxZ;
      }

      mesh.updateMatrixWorld(true);
      const boxY = new THREE.Box3().setFromObject(mesh);
      if (sizeY > spanY + 1e-6) {
        mesh.position.y += ((contMinY + contMaxY) * 0.5) - ((boxY.min.y + boxY.max.y) * 0.5);
      } else {
        if (boxY.min.y < contMinY) mesh.position.y += contMinY - boxY.min.y;
        if (boxY.max.y > contMaxY) mesh.position.y -= boxY.max.y - contMaxY;
      }
    }
  }
}

/**
 * True only when the whole mesh AABB sits inside ALL container walls
 * (floor, roof, left, right, front, back) — no sticking out.
 */
function isMeshInsideContainer(mesh, cont, epsWorld) {
  if (!mesh || !cont) return false;
  const eps = epsWorld != null ? epsWorld : 0.02; // ~2 mm
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const env = (typeof getPackEnvelopeWorld === 'function')
    ? getPackEnvelopeWorld(cont)
    : null;
  const contMinX = env ? env.minX : 0;
  const contMaxX = env ? env.maxX : cont.lengthMm * SCALE;
  const contMinZ = env ? env.minZ : -cont.widthMm * SCALE / 2;
  const contMaxZ = env ? env.maxZ : cont.widthMm * SCALE / 2;
  const contMinY = env ? env.minY : 0;
  const contMaxY = env ? env.maxY : cont.heightMm * SCALE;
  return !(
    box.min.x < contMinX - eps || box.max.x > contMaxX + eps ||
    box.min.z < contMinZ - eps || box.max.z > contMaxZ + eps ||
    box.min.y < contMinY - eps || box.max.y > contMaxY + eps
  );
}

/** Which walls the mesh sticks past — for UI toast / banner. */
function meshOutsideWallsReason(mesh, cont, epsWorld) {
  if (!mesh || !cont) return 'Outside container';
  const eps = epsWorld != null ? epsWorld : 0.02;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const env = (typeof getPackEnvelopeWorld === 'function')
    ? getPackEnvelopeWorld(cont)
    : null;
  const contMinX = env ? env.minX : 0;
  const contMaxX = env ? env.maxX : cont.lengthMm * SCALE;
  const contMinZ = env ? env.minZ : -cont.widthMm * SCALE / 2;
  const contMaxZ = env ? env.maxZ : cont.widthMm * SCALE / 2;
  const contMinY = env ? env.minY : 0;
  const contMaxY = env ? env.maxY : cont.heightMm * SCALE;
  const sides = [];
  if (box.min.x < contMinX - eps) sides.push('end (−X)');
  if (box.max.x > contMaxX + eps) sides.push('end (+X)');
  if (box.min.z < contMinZ - eps) sides.push('left');
  if (box.max.z > contMaxZ + eps) sides.push('right');
  if (box.min.y < contMinY - eps) sides.push('bottom');
  if (box.max.y > contMaxY + eps) sides.push('top');
  if (!sides.length) return null;
  return 'Cannot leave safe-zone (' + sides.join(', ') + ')';
}

/** Dispose a temporary makeShape mesh (geometry + materials). */
function disposeTempMesh(mesh) {
  if (!mesh) return;
  mesh.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

/**
 * Packer footprint (mm) vs container — authoritative for face-roll poses.
 * Returns true/false, or null if footprint unknown.
 */
function packFootprintFitsInContainer(it, cont) {
  if (!it || !cont) return null;
  const fl = Number(it.packFootprintL) || 0;
  const fw = Number(it.packFootprintW) || 0;
  const fh = Number(it.packFootprintH) || 0;
  if (!(fl > 0 && fw > 0 && fh > 0)) return null;
  const L = Math.max(1, Number(cont.lengthMm) || 0);
  const W = Math.max(1, Number(cont.widthMm) || 0);
  const H = Math.max(1, Number(cont.heightMm) || 0);
  const eps = 5; // mm
  if (fl > L + eps || fw > W + eps || fh > H + eps) return false;
  const x = Number(it.x) || 0;
  const y = Number(it.y) || 0;
  const z = Number(it.z) || 0;
  if (x - fl / 2 < -eps || x + fl / 2 > L + eps) return false;
  if (z - fw / 2 < -W / 2 - eps || z + fw / 2 > W / 2 + eps) return false;
  if (y - fh / 2 < -eps || y + fh / 2 > H + eps) return false;
  return true;
}

/**
 * Build the item at its packed pose and check vs container.
 * Face-roll: trust packer footprint (compose can disagree with makeShape rest-pose).
 * Yaw-only: real mesh AABB check.
 */
function itemPoseFitsInContainer(it, cont) {
  if (!it || !cont) return false;
  // Face-roll / sole upright / welded assemblies: packer AABB is the contract —
  // IFC mesh may still carry residual roof-pitch that makeShape cannot undo here.
  const assemblyPack = !!(it.isAssembly || it.groupKind === 'welded_assembly'
    || it.groupKind === 'assembly_single'
    || (it.parts && it.parts.length > 1)
    || /RAFTER|COLUMN|PORTAL|FRAME|RF\d|CL\d/i.test(
      String(it.assemblyName || it.mark || '') + ' '
      + ((it.marks || []).join(' '))));
  // Foreman / Step8 locked poses: trust packer footprint (mesh may be pitched)
  if (it.packPoseLock || it.packComposeRot || assemblyPack
      || (it.packOrientTag && /Rx|Rz|yaw/i.test(String(it.packOrientTag)))) {
    const fp = packFootprintFitsInContainer(it, cont);
    if (fp != null) return fp;
  }
  const mesh = makeShape({
    ...it,
    lengthMm: it.lengthMm || it.l || 500,
    widthMm:  it.widthMm  || it.w || 200,
    heightMm: it.heightMm || it.h || 200,
    qty: it.qty || 1,
  }, 0xffffff, 1);
  mesh.position.set((it.x || 0) * SCALE, (it.y || 0) * SCALE, (it.z || 0) * SCALE);
  if (typeof applyPackItemRotation === 'function')
    applyPackItemRotation(mesh, it);
  else if (it.userRot) {
    if (it.packComposeRot && typeof THREE !== 'undefined') {
      const e = new THREE.Euler(it.userRot.x || 0, it.userRot.y || 0, it.userRot.z || 0, 'XYZ');
      mesh.quaternion.premultiply(new THREE.Quaternion().setFromEuler(e));
      mesh.rotation.setFromQuaternion(mesh.quaternion);
    } else if (it.packYawOnly !== false)
      mesh.rotation.y += (it.userRot.y || 0);
    else
      mesh.rotation.set(it.userRot.x || 0, it.userRot.y || 0, it.userRot.z || 0);
  } else {
    applyStoredRotation(mesh, it);
  }
  mesh.updateMatrixWorld(true);
  const ok = isMeshInsideContainer(mesh, cont, 0.02);
  disposeTempMesh(mesh);
  return ok;
}

/** Soft wall stop only — keeps movement smooth (slide along walls, no snap-back). */
function softClampInsideContainer(meshes, cont) {
  if (!cont || !meshes?.length) return;
  clampMeshesInsideContainer(meshes, cont);
}

/** After place/release: settle + clamp; mark inside only if fully within walls. */
function enforceMoveInsideContainer(sel, meshes) {
  const cont = currentLayout?.containers?.[currentContainerIdx];
  if (!cont || !meshes?.length) return false;
  settleMeshesToTouch(meshes);
  clampMeshesInsideContainer(meshes, cont);
  const allIn = meshes.every(m => isMeshInsideContainer(m, cont, 0.02));
  if (allIn) setSelectionInsideContainer(sel, true);
  return allIn;
}

function nudgeCollides(sel, meshes) {
  const eps = 0.0005;
  const moving = new Set(meshes);
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    for (const entry of clickable) {
      if (!entry?.mesh || moving.has(entry.mesh)) continue;
      if (!shouldInteractWith(sel, entry)) continue;
      entry.mesh.updateMatrixWorld(true);
      const ob = new THREE.Box3().setFromObject(entry.mesh);
      if (box.min.x < ob.max.x - eps && box.max.x > ob.min.x + eps &&
          box.min.y < ob.max.y - eps && box.max.y > ob.min.y + eps &&
          box.min.z < ob.max.z - eps && box.max.z > ob.min.z + eps) {
        return true;
      }
    }
  }
  return false;
}

function entryIsOutside(entry) {
  if (!entry) return false;
  // Explicit flag wins (item may sit inside wireframe even during Group view)
  if (entry.outsideContainer === false || entry.item?.outsideContainer === false) return false;
  if (entry.outsideContainer === true || entry.item?.outsideContainer === true) return true;
  if (currentLayout?.isOutsideView || currentLayout?.isGroupedView || currentMode === 'outside') return true;
  return false;
}

function selectedIsOutside(sel) {
  if (!sel) return false;
  if (sel.outsideContainer === false || sel.item?.outsideContainer === false) return false;
  if (sel.parent && (sel.parent.outsideContainer === false || sel.parent.item?.outsideContainer === false)) return false;
  if (sel.outsideContainer === true || sel.item?.outsideContainer === true || sel.parent?.outsideContainer === true) return true;
  // Untagged pieces in Group / load inspection live beside the container
  if (currentLayout?.isOutsideView || currentLayout?.isGroupedView || currentMode === 'outside') return true;
  return false;
}

/** True if mesh AABB overlaps the container volume at all (any wall penetration / entry). */
function meshOverlapsContainerVolume(mesh, cont, epsWorld) {
  if (!mesh || !cont) return false;
  const eps = epsWorld != null ? epsWorld : 0.02;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const contMinX = 0, contMaxX = cont.lengthMm * SCALE;
  const contMinZ = -cont.widthMm * SCALE / 2, contMaxZ = cont.widthMm * SCALE / 2;
  const contMinY = 0, contMaxY = cont.heightMm * SCALE;
  return !(
    box.max.x < contMinX + eps || box.min.x > contMaxX - eps ||
    box.max.z < contMinZ + eps || box.min.z > contMaxZ - eps ||
    box.max.y < contMinY + eps || box.min.y > contMaxY - eps
  );
}

/** Mark selection + clickable entry as inside / outside container. */
function setSelectionInsideContainer(sel, inside) {
  if (!sel) return;
  const flag = !inside;
  sel.outsideContainer = flag;
  if (sel.item) sel.item.outsideContainer = flag;
  const entry = clickable.find(c => c.mesh === sel.mesh);
  if (entry) {
    entry.outsideContainer = flag;
    if (entry.item) entry.item.outsideContainer = flag;
  }
}

/** Inside pieces only collide/support with inside; outside sets with outside. */
function shouldInteractWith(sel, entry) {
  if (!sel || !entry?.mesh || entry === sel) return false;
  if (sel.isSubPiece && entry === sel.parent) return false;
  return entryIsOutside(entry) === selectedIsOutside(sel);
}

function realmOutsideForMesh(mesh) {
  const e = clickable.find(c => c.mesh === mesh);
  if (e) return entryIsOutside(e);
  if (selected?.mesh === mesh) return selectedIsOutside(selected);
  return false;
}

/**
 * Full base support: on floor, OR ≥80% footprint + ≥80% long side on what is below.
 * Smaller set on larger set → OK. Larger on smaller (overhang) → reject.
 */
function hasFullBaseSupport(mesh, sel) {
  if (!mesh) return false;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.min.y <= 0.08) return true; // resting on floor

  const area = Math.max((box.max.x - box.min.x) * (box.max.z - box.min.z), 1e-8);
  const longSide = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const shortSide = Math.min(box.max.x - box.min.x, box.max.z - box.min.z);
  let support = 0, bestA = 0, longCover = 0, shortCover = 0;

  for (const entry of clickable) {
    if (!shouldInteractWith(sel, entry)) continue;
    entry.mesh.updateMatrixWorld(true);
    const ob = new THREE.Box3().setFromObject(entry.mesh);
    const ox0 = Math.max(box.min.x, ob.min.x), ox1 = Math.min(box.max.x, ob.max.x);
    const oz0 = Math.max(box.min.z, ob.min.z), oz1 = Math.min(box.max.z, ob.max.z);
    if (ox1 <= ox0 || oz1 <= oz0) continue;
    const a = (ox1 - ox0) * (oz1 - oz0);
    const top = ob.max.y;
    const lc = ((box.max.x - box.min.x) >= (box.max.z - box.min.z)) ? (ox1 - ox0) : (oz1 - oz0);
    const sc = ((box.max.x - box.min.x) >= (box.max.z - box.min.z)) ? (oz1 - oz0) : (ox1 - ox0);
    if (top > support + 1e-5) {
      support = top; bestA = a; longCover = lc; shortCover = sc;
    } else if (Math.abs(top - support) <= 1e-5) {
      bestA += a; longCover += lc; shortCover += sc;
    }
  }
  if (support <= 1e-5) return false;
  if (Math.abs(support - box.min.y) > 0.12) return false; // floating / dig
  if (bestA / area < 0.80) return false;
  if (longCover / longSide < 0.80) return false;
  if (shortCover / Math.max(shortSide, 1e-8) < 0.50) return false;
  return true;
}

/** After dragging outside sets: no overlap + full base support. */
function validateOutsidePlacement(sel) {
  if (!sel?.mesh) return false;
  const meshes = meshesForNudge(sel);
  settleMeshesToTouch(meshes);
  if (nudgeCollides(sel, meshes)) return false;
  for (const m of meshes) {
    if (!hasFullBaseSupport(m, sel)) return false;
  }
  return true;
}

function addLights() {
  const light = currentTheme() === 'light';
  // Light theme: slightly less flat ambient + stronger key/fill → clearer form
  scene.add(new THREE.AmbientLight(0xffffff, light ? 0.52 : 0.65));
  const key = new THREE.DirectionalLight(0xffffff, light ? 0.95 : 0.7);
  key.position.set(80, 150, 100);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, light ? 0.38 : 0.18);
  fill.position.set(-70, 90, -50);
  scene.add(fill);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function clearScene() {
  while (scene.children.length) scene.remove(scene.children[0]);
  addLights();
  clickable = [];
  selected = null;
  document.getElementById('info').style.display = 'none';
}
