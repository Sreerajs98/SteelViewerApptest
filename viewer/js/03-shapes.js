/* 03-shapes.js — primitives, profiles, makeShape */

function makeBox(l, h, w, color, opacity) {
  const geo = new THREE.BoxGeometry(Math.max(l*SCALE,0.05), Math.max(h*SCALE,0.05), Math.max(w*SCALE,0.05));
  const mesh = new THREE.Mesh(geo, makeSteelMaterial(color, opacity ?? 0.95));
  mesh.add(makeEdgeOverlay(geo, undefined, 0.3));
  return mesh;
}

// A round bar/rod - drawn as a cylinder with a sensible max radius so a
// data-quality issue (e.g. an angled brace whose bounding box gave a huge
// cross-section) doesn't render as a giant tube. Real steel rods are rarely
// wider than ~150mm; anything larger visually is capped for clarity while
// packing still uses the true dimensions.
function makeRod(l, h, w, color, opacity) {
  const rawR = (w + h) / 4;
  const cappedR = Math.min(rawR, 150); // cap visual radius at 150mm
  const radius = Math.max(cappedR * SCALE, 0.03);
  const geo = new THREE.CylinderGeometry(radius, radius, Math.max(l*SCALE, 0.05), 16);
  const mesh = new THREE.Mesh(geo, makeSteelMaterial(color, opacity ?? 0.95));
  mesh.rotation.z = Math.PI / 2;
  mesh.add(makeEdgeOverlay(geo, undefined, 0.25));
  return mesh;
}

/** True for bent sag / SAG_ROD_ASSY (not straight ROD_BRACE). */
function isBentSagRodItem(it) {
  const n = `${it?.assemblyName || ''} ${it?.mark || ''} ${it?.profileDesc || ''} ${it?.name || ''}`.toUpperCase();
  if (it?.profileShape === 'bent_sag_rod' || it?.shapeKey === 'bent_sag_rod') return true;
  if (it?.pathPointsMm && it.pathPointsMm.length >= 3) return true;
  return /BEND_?SAG|BENT_?SAG|SAG_?BEND|SAG_?BENT|BENDSAGROD|BENTSAGROD/.test(n)
    || /SAG[_\s-]*ROD|SAGROD/.test(n);
}

function bentSagRodDiamMm(lengthMm, heightMm, widthMm, sect, pathDiam) {
  if (pathDiam > 0 && pathDiam <= 40) return pathDiam;
  if (sect?.sectH > 0 && sect.sectH <= 40) return sect.sectH;
  if (sect?.sectT > 0 && sect.sectT <= 40) return sect.sectT;
  if (sect?.pathDiamMm > 0 && sect.pathDiamMm <= 40) return sect.pathDiamMm;
  const cross = [heightMm, widthMm].filter(v => v > 0).sort((a, b) => a - b);
  let d = cross[0] || 12;
  if (d > 40 && lengthMm > 0) d = 12;
  return Math.max(6, Math.min(d, 36));
}

/**
 * Bent sag rod — reference shape: short near-horizontal → long diagonal → vertical drop.
 * Prefer exact IFC centerline (pathPointsMm); else dogleg from L/W/H/∅.
 */
function makeBentSagRod(lengthMm, heightMm, widthMm, color, opacity, sect, pathPointsMm, pathDiamMm) {
  const diam = bentSagRodDiamMm(lengthMm, heightMm, widthMm, sect, pathDiamMm || sect?.pathDiamMm);
  let pts = Array.isArray(pathPointsMm) && pathPointsMm.length >= 3
    ? pathPointsMm.map(p => [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0])
    : null;

  if (!pts) {
    // short near-horizontal → steep diagonal → VERTICAL end (not Z)
    const dims = [lengthMm, heightMm, widthMm].filter(v => v > diam * 2).sort((a, b) => b - a);
    const span = dims[0] || Math.max(lengthMm || 0, diam * 20, 80);
    let drop = dims[1] || Math.max(span * 0.7, diam * 18);
    if (drop <= diam * 2.5) drop = Math.max(span * 0.7, diam * 18);
    const L1 = Math.min(Math.max(span * 0.14, diam * 8), span * 0.2);
    const L3 = Math.min(Math.max(drop * 0.28, diam * 8), drop * 0.4);
    const run = Math.max(span - L1, span * 0.55);
    const rise = Math.max(drop - L3, drop * 0.5);
    const th = Math.atan2(rise, run);
    const a1 = (10 * Math.PI) / 180;
    const y0 = L1 * Math.sin(a1) + rise + L3;
    const x1 = L1 * Math.cos(a1);
    const y1 = y0 - L1 * Math.sin(a1);
    const x2 = x1 + run;
    pts = [[0, y0, 0], [x1, y1, 0], [x2, L3, 0], [x2, 0, 0]];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(p => {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    });
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    pts = pts.map(p => [p[0] - cx, p[1] - cy, 0]);
  }

  const rBend = Math.max(diam * 1.5, 8);
  const path = new THREE.CurvePath();
  const sc = SCALE;
  const work = pts.map(p => p.slice());
  for (let i = 1; i < work.length; i++) {
    const a = work[i - 1], b = work[i];
    const hasNext = i < work.length - 1;
    if (!hasNext) {
      path.add(new THREE.LineCurve3(
        new THREE.Vector3(a[0] * sc, a[1] * sc, a[2] * sc),
        new THREE.Vector3(b[0] * sc, b[1] * sc, b[2] * sc)
      ));
      continue;
    }
    const c = work[i + 1];
    const v1x = a[0] - b[0], v1y = a[1] - b[1], v1z = a[2] - b[2];
    const v2x = c[0] - b[0], v2y = c[1] - b[1], v2z = c[2] - b[2];
    const l1 = Math.hypot(v1x, v1y, v1z) || 1;
    const l2 = Math.hypot(v2x, v2y, v2z) || 1;
    const trim = Math.min(rBend, l1 * 0.35, l2 * 0.35);
    const pIn = [b[0] + v1x / l1 * trim, b[1] + v1y / l1 * trim, b[2] + v1z / l1 * trim];
    const pOut = [b[0] + v2x / l2 * trim, b[1] + v2y / l2 * trim, b[2] + v2z / l2 * trim];
    path.add(new THREE.LineCurve3(
      new THREE.Vector3(a[0] * sc, a[1] * sc, a[2] * sc),
      new THREE.Vector3(pIn[0] * sc, pIn[1] * sc, pIn[2] * sc)
    ));
    path.add(new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(pIn[0] * sc, pIn[1] * sc, pIn[2] * sc),
      new THREE.Vector3(b[0] * sc, b[1] * sc, b[2] * sc),
      new THREE.Vector3(pOut[0] * sc, pOut[1] * sc, pOut[2] * sc)
    ));
    work[i] = pOut;
  }

  let developed = 0;
  for (let i = 1; i < pts.length; i++) {
    developed += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  }
  const radius = Math.max((diam / 2) * sc * 0.98, 0.012);
  const segs = Math.max(80, Math.floor(Math.max(developed, lengthMm || 100) / 15));
  // Smooth round bar (not IFC faceted circle mesh)
  const geo = new THREE.TubeGeometry(path, segs, radius, 20, false);
  const mesh = new THREE.Mesh(geo, makeSteelMaterial(color, Math.min(opacity ?? 0.98, 1)));
  mesh.add(makeEdgeOverlay(geo, 30, 0.2));
  const box = new THREE.Box3().setFromObject(mesh);
  const ctr = new THREE.Vector3();
  box.getCenter(ctr);
  mesh.position.sub(ctr);
  return mesh;
}

function makeBentSagRodBundle(it, color, opacity) {
  const group = new THREE.Group();
  const n = Math.min(Math.max(it.qty || 1, 1), 48);
  const sect = (it.shapeKey || it.sectH > 0) ? it : null;
  const diam = it.pathDiamMm || it.unitDiam || bentSagRodDiamMm(it.lengthMm, it.heightMm, it.widthMm, sect, it.pathDiamMm);
  // Clear gap between rods (like other bundles) — avoid mesh overlap
  const d = Math.max(diam * SCALE, 0.04);
  const pitch = d * 1.55;
  const stepY = pitch * Math.sqrt(3) / 2;
  const cols = Math.max(1, it.gridCols || Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, it.gridRows || Math.ceil(n / cols));
  const totalW = (cols - 1) * pitch + (rows > 1 ? pitch * 0.5 : 0);
  const totalH = (rows - 1) * stepY;
  let placed = 0;
  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (placed >= n) break outer;
      const m = makeBentSagRod(
        it.lengthMm, it.heightMm || it.unitHeight, it.widthMm || it.unitWidth,
        color, Math.min(opacity ?? 0.95, 1), sect, it.pathPointsMm, it.pathDiamMm || diam
      );
      const shiftZ = (r % 2 === 1) ? pitch * 0.5 : 0;
      m.position.z = c * pitch + shiftZ - totalW / 2;
      m.position.y += r * stepY - totalH / 2;
      group.add(m);
      placed++;
    }
  }
  recenterGroupAabb(group);
  return group;
}

// A bundle of N identical round rods in a HEXAGONAL close-pack layout -
// the tightest packing for equal circles (rebar / rod yard photo).
// Odd rows shift by d/2; row pitch = d·√3/2.
function makeRodBundle(l, unitDiam, cols, rows, qty, color, opacity) {
  const group = new THREE.Group();
  const totalToShow = Math.min(qty || 1, 120);
  const nCols = Math.max(1, cols || Math.ceil(Math.sqrt(totalToShow)));
  const nRows = Math.max(1, rows || Math.ceil(totalToShow / nCols));
  const r = Math.max(unitDiam / 2 * SCALE, 0.02);
  const d = Math.max(unitDiam * SCALE, r * 2);
  const stepY = d * Math.sqrt(3) / 2;
  const stepZ = d;
  const totalH = (nRows - 1) * stepY + d;
  const totalW = (nCols - 1) * stepZ + d + d / 2;

  let placed = 0;
  outer: for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < nCols; j++) {
      if (placed >= totalToShow) break outer;
      const geo = new THREE.CylinderGeometry(r, r, Math.max(l * SCALE, 0.05), 16);
      const rod = new THREE.Mesh(geo, makeSteelMaterial(color, opacity ?? 0.95));
      rod.rotation.z = Math.PI / 2;
      const shiftZ = (i % 2 === 1) ? d / 2 : 0;
      rod.position.y = i * stepY + d / 2 - totalH / 2;
      rod.position.z = j * stepZ + d / 2 + shiftZ - totalW / 2;
      group.add(rod);
      placed++;
    }
  }
  return group;
}

// A flat plate/sheet pack — compact multi-column stacks (not one tall tower).
function makePlateStack(l, w, singleThickness, qty, color, opacity, cols, rows) {
  const group = new THREE.Group();
  const n = Math.max(1, qty || 1);
  let nRows = rows > 0 ? rows : n;
  let nCols = cols > 0 ? cols : 1;
  if (!(cols > 0 && rows > 0)) {
    // Sets of ~6 sheets stacked in one place (grouping rule)
    nRows = Math.min(n, 6);
    nCols = Math.ceil(n / nRows);
  }
  const slabH = Math.max(singleThickness * SCALE, 0.008);
  const gap = slabH * 0.12;
  const drawH = Math.max(slabH - gap, 0.006);
  const colW = Math.max(w * SCALE, 0.05);
  const len = Math.max(l * SCALE, 0.05);
  const packH = nRows * slabH;
  const packW = nCols * colW;
  const showMax = Math.min(n, 80);
  let placed = 0;
  outer: for (let j = 0; j < nCols; j++) {
    for (let i = 0; i < nRows; i++) {
      if (placed >= showMax) break outer;
      const geo = new THREE.BoxGeometry(len, drawH, colW * 0.98);
      const slab = new THREE.Mesh(geo, makeSteelMaterial(color, opacity ?? 0.95));
      slab.position.y = -packH / 2 + i * slabH + drawH / 2;
      slab.position.z = -packW / 2 + j * colW + colW / 2;
      slab.add(makeEdgeOverlay(geo, undefined, 0.3));
      group.add(slab);
      placed++;
    }
  }
  return group;
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOMETRY FUNCTIONS
//
// THREE.js ExtrudeGeometry draws the 2-D shape in the X-Y plane and extrudes
// it along the Z axis. After extrusion we rotate the mesh so the piece lies
// along the world X axis (length direction) and the cross-section faces the
// viewer correctly.
//
// SHAPE COORDINATE CONVENTION (before extrusion):
//   Shape X  →  after rotation becomes world Z  (horizontal, width)
//   Shape Y  →  after rotation becomes world Y  (vertical, height)
//   Extrude Z →  after rotation becomes world X  (length along container)
//
// rotation.x = -π/2 rotates the extruded Z-axis → world X-axis.
// The cross-section you draw in shape X-Y appears as it would on a cut end.
//
// So draw the section as you see it looking at the cut end:
//   Shape X = left/right (horizontal)   → world Z after rotation
//   Shape Y = up/down   (vertical)      → world Y after rotation
// ══════════════════════════════════════════════════════════════════════════════

/** Extrude a 2D cross-section along the piece length (world X axis). */
function extrudeAlongLength(shape2D, lengthWorld, color, opacity) {
  const geo = new THREE.ExtrudeGeometry(shape2D, {
    depth: lengthWorld,
    bevelEnabled: false
  });
  // Centre the extrusion so piece centre = (0,0,0)
  geo.translate(0, 0, -lengthWorld / 2);

  const mat = makeSteelMaterial(color, opacity ?? 0.93);
  mat.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat);

  // Map extrude-Z → world X (length). Bake into geometry so mesh.rotation
  // stays (0,0,0) — userRot / capture must NOT overwrite a baked -PI/2.
  mesh.rotation.y = -Math.PI / 2;
  mesh.updateMatrix();
  mesh.geometry.applyMatrix4(mesh.matrix);
  mesh.rotation.set(0, 0, 0);
  mesh.position.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();

  // Mandatory silhouette edges (after bake so edges match final verts)
  mesh.add(makeEdgeOverlay(mesh.geometry, undefined, 0.55));
  return mesh;
}

// ── Dimension resolver ────────────────────────────────────────────────────────
// Resolves exact section dimensions from the IFC-extracted 'sect' object
// (populated by C# ProfileDescParser) or falls back to shape-aware estimates.
// CRITICAL: Cold-formed Z/C wall thickness ≈ 1-2% of H (1.5-3mm).
//           Hot-rolled I/H/L wall thickness ≈ 9-12% of H (much thicker).
//           Using the hot-rolled fraction for cold-formed = 9x too thick → wrong shape!
function _sdim(sect, bb_h, bb_w, shapeHint) {
  const isCold = (shapeHint === 'z_channel' || shapeHint === 'c_channel' || shapeHint === 'l_angle');

  // Prefer exact section H; never trust a huge assembly bbox as web height.
  let Hmm = sect?.sectH > 0 ? sect.sectH : bb_h;
  if (!(sect?.sectH > 0) && isCold) {
    const a = Math.max(bb_h || 0, bb_w || 0);
    const b = Math.min(bb_h || 0, bb_w || 0);
    // Typical cold-formed web 80–400 mm. If bbox looks like an assembly envelope, clamp.
    if (a > 0 && a <= 420) Hmm = a;
    else if (b >= 80 && b <= 420) Hmm = b;
    else Hmm = Math.min(Math.max(a > 0 ? a : 200, 100), 300);
  }
  const H = Math.max(Hmm * SCALE, 0.04);

  let W;
  if (sect?.sectW > 0) {
    W = Math.max(sect.sectW * SCALE, 0.03);
  } else if (isCold) {
    // ALWAYS proportion of web — never raw bbox W (causes twisted Z across IFCs)
    W = Math.max(H * 0.32, 0.03);
  } else {
    W = Math.max((bb_w || bb_h || 100) * SCALE, 0.03);
  }
  // Keep drawable flange: must clear wall thickness
  W = Math.max(W, H * 0.22);

  let t_real, tf, tw;
  if (sect?.sectT > 0) {
    t_real = sect.sectT * SCALE;
  } else {
    t_real = isCold
      ? Math.max(H * 0.012, 0.0015)
      : Math.max(H * 0.09,  0.006);
  }
  // Exact T: tiny drawable floor. Estimated: thicker visual floor.
  let t = (sect?.sectT > 0) ? Math.max(t_real, 0.010) : Math.max(t_real, H * 0.045);
  // Never thicker than ~35% of flange — self-intersecting ExtrudeGeometry looks twisted
  t = Math.min(t, W * 0.35);

  tf = sect?.sectTf > 0 ? sect.sectTf * SCALE : Math.max(H * 0.10, 0.008);
  tw = sect?.sectTw > 0 ? sect.sectTw * SCALE : Math.max(H * 0.07, 0.005);
  let D = sect?.sectD > 0 ? sect.sectD * SCALE : Math.max(H * 0.085, 0.005);
  D = Math.min(D, H * 0.30, W * 0.55);
  return { H, W, t, tf, tw, D };
}

// ─────────────────────────────────────────────────────────────────────────────
// I-BEAM / H-BEAM
//
// Cross-section (looking at cut end, Shape X = horizontal, Shape Y = vertical):
//
//   ─────────────────   Y = +H/2   top flange, width W
//        │     │                   web, width tw
//   ─────────────────   Y = -H/2   bottom flange
//
// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════
// ALL SHAPES USE CCW WINDING (positive signed area).
// CCW = counter-clockwise = Three.js fills interior correctly.
// Start at bottom-left corner, trace: LEFT→UP→RIGHT→DOWN (CCW).
// ══════════════════════════════════════════════════════════════════════

// ── I-BEAM ────────────────────────────────────────────────────────────
function makeIBeam(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, tf, tw } = _sdim(sect, h, w, 'i_beam');
  const hw = W / 2, hh = H / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw,   -hh);
  s.lineTo( hw,   -hh);
  s.lineTo( hw,   -hh + tf);
  s.lineTo( tw/2, -hh + tf);
  s.lineTo( tw/2,  hh - tf);
  s.lineTo( hw,    hh - tf);
  s.lineTo( hw,    hh);
  s.lineTo(-hw,    hh);
  s.lineTo(-hw,    hh - tf);
  s.lineTo(-tw/2,  hh - tf);
  s.lineTo(-tw/2, -hh + tf);
  s.lineTo(-hw,   -hh + tf);
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}

// ── C-CHANNEL (web LEFT, opening RIGHT) ──────────────────────────────
// ── C-CHANNEL (web LEFT, opening RIGHT) ──────────────────────────────
// Web inner corners at SAME Y as outer — no diagonal step artifact.
// C-CHANNEL: web on LEFT (-Z world), flanges go RIGHT (+Z world)
// After rotation.y=-PI/2: shape +X → world -Z, shape -X → world +Z
// So web must be at shape +X (→ world -Z = LEFT from camera)
// and flanges at shape -X (→ world +Z = RIGHT from camera)
function makeChannel(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t, D } = _sdim(sect, h, w, 'c_channel');
  const hh = H / 2, hw = W / 2;
  const s = new THREE.Shape();
  // Web at +hw (RIGHT in shape = LEFT in world after rotation)
  // Flanges at -hw (LEFT in shape = RIGHT in world after rotation)
  s.moveTo( hw,   -hh);         // web outer bot-right
  s.lineTo(-hw,   -hh);         // bot flange outer (goes LEFT in shape = RIGHT in world)
  if (D > 0) { s.lineTo(-hw, -hh+D); s.lineTo(-hw+t, -hh+D); }
  s.lineTo(-hw+t, -hh);         // inner bot (SAME Y)
  s.lineTo( hw-t, -hh);         // web inner bot (SAME Y)
  s.lineTo( hw-t,  hh);         // web inner top (SAME Y)
  s.lineTo(-hw+t,  hh);         // inner top (SAME Y)
  if (D > 0) { s.lineTo(-hw+t, hh-D); s.lineTo(-hw, hh-D); }
  s.lineTo(-hw,    hh);         // top flange outer
  s.lineTo( hw,    hh);         // web outer top-right
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}

// C-CHANNEL MIRROR: web RIGHT, opening LEFT (for box-nesting pairs)
function makeChannelMirror(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t, D } = _sdim(sect, h, w, 'c_channel');
  const hh = H / 2, hw = W / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw,   -hh);
  s.lineTo( hw,   -hh);
  if (D > 0) { s.lineTo(hw, -hh+D); s.lineTo(hw-t, -hh+D); }
  s.lineTo( hw-t, -hh);
  s.lineTo(-hw+t, -hh);
  s.lineTo(-hw+t,  hh);
  s.lineTo( hw-t,  hh);
  if (D > 0) { s.lineTo(hw-t, hh-D); s.lineTo(hw, hh-D); }
  s.lineTo( hw,    hh);
  s.lineTo(-hw,    hh);
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}

// ── Z-PURLIN (top flange LEFT in shape = RIGHT in world) ──────────────
//
//        ════════╲  top flange + lip flares OUT & DOWN (away from web)
//               │
//             ╱════════  bottom flange + lip flares OUT & UP (away from web)
//
// Lips bend OUTWARD (not toward the web). ~55° from horizontal.
// D = lip height (vertical). Outward reach = D · cot(α).
// After rotation.y=-PI/2: shape -X → world +Z (RIGHT from camera).
function makeZChannel(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t, D } = _sdim(sect, h, w, 'z_channel');
  const hh = H / 2, fw = W;
  const lipH = D > 0 ? Math.min(D, H * 0.30) : 0;
  // Angle from horizontal; lip flares outward away from web
  const a = (55 * Math.PI) / 180;
  const sa = Math.sin(a), ca = Math.cos(a);
  // Cap outward reach so ExtrudeGeometry never self-intersects (twisted look)
  const lipX = lipH > 0 ? Math.min(lipH * (ca / sa), W * 0.45) : 0;
  // Thickness normals (into material, toward web)
  // Top-left outer dir u=(-ca,-sa); n = (sa, -ca)
  // Bot-right outer dir u=( ca, sa); n = (-sa, ca)
  const nxT = t * sa, nyT = -t * ca;
  const nxB = -t * sa, nyB = t * ca;

  const s = new THREE.Shape();
  s.moveTo( t/2,  hh);
  s.lineTo(-fw,   hh);                                      // top flange outer tip
  if (lipH > 0) {
    s.lineTo(-fw - lipX,           hh - lipH);              // lip outer tip (OUT + DOWN)
    s.lineTo(-fw - lipX + nxT,     hh - lipH + nyT);        // lip tip thickness
    s.lineTo(-fw + t,              hh - t);                 // back to flange underside
  } else {
    s.lineTo(-fw + t, hh - t);
  }
  s.lineTo(-t/2,  hh - t);
  s.lineTo(-t/2, -hh);
  s.lineTo( fw,  -hh);                                      // bot flange outer tip
  if (lipH > 0) {
    s.lineTo( fw + lipX,           -hh + lipH);             // lip outer tip (OUT + UP)
    s.lineTo( fw + lipX + nxB,     -hh + lipH + nyB);       // lip tip thickness
    s.lineTo( fw - t,              -hh + t);                // back to flange topside
  } else {
    s.lineTo( fw - t, -hh + t);
  }
  s.lineTo( t/2, -hh + t);
  s.lineTo( t/2,  hh);
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}

// Z-PURLIN MIRROR: flanges swapped (for contour-nesting pairs)
function makeZChannelMirror(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t, D } = _sdim(sect, h, w, 'z_channel');
  const hh = H / 2, fw = W;
  const lipH = D > 0 ? Math.min(D, H * 0.30) : 0;
  const a = (55 * Math.PI) / 180;
  const sa = Math.sin(a), ca = Math.cos(a);
  const lipX = lipH > 0 ? Math.min(lipH * (ca / sa), W * 0.45) : 0;
  // Top-right outer: u=(ca,-sa); n=(-sa,-ca) into material (toward web = -x)
  // Bot-left  outer: u=(-ca,sa); n=(sa, ca)  into material (toward web = +x)
  const nxT = -t * sa, nyT = -t * ca;
  const nxB =  t * sa, nyB =  t * ca;

  const s = new THREE.Shape();
  s.moveTo(-t/2,  hh);
  s.lineTo( fw,   hh);
  if (lipH > 0) {
    s.lineTo( fw + lipX,           hh - lipH);              // OUT + DOWN
    s.lineTo( fw + lipX + nxT,     hh - lipH + nyT);
    s.lineTo( fw - t,              hh - t);
  } else {
    s.lineTo( fw - t, hh - t);
  }
  s.lineTo( t/2,  hh - t);
  s.lineTo( t/2, -hh);
  s.lineTo(-fw,  -hh);
  if (lipH > 0) {
    s.lineTo(-fw - lipX,           -hh + lipH);             // OUT + UP
    s.lineTo(-fw - lipX + nxB,     -hh + lipH + nyB);
    s.lineTo(-fw + t,              -hh + t);
  } else {
    s.lineTo(-fw + t, -hh + t);
  }
  s.lineTo(-t/2, -hh + t);
  s.lineTo(-t/2,  hh);
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}


// ── L-ANGLE (vertical leg LEFT, horizontal leg BOTTOM) ────────────────
// CCW: bottom-left → right → up inner → left inner → down → close
function makeLAngle(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t } = _sdim(sect, h, w, 'l_angle');
  const hw = W / 2, hh = H / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw,   -hh);
  s.lineTo( hw,   -hh);
  s.lineTo( hw,   -hh + t);
  s.lineTo(-hw+t, -hh + t);
  s.lineTo(-hw+t,  hh);
  s.lineTo(-hw,    hh);
  s.closePath();
  return extrudeAlongLength(s, L, color, opacity);
}

// ─────────────────────────────────────────────────────────────────────────────
// RHS / SHS (Rectangular / Square Hollow Section)
// ─────────────────────────────────────────────────────────────────────────────
function makeRHS(l, h, w, color, opacity, sect) {
  const L = Math.max(l * SCALE, 0.05);
  const { H, W, t } = _sdim(sect, h, w, 'rhs');
  const hw = W / 2, hh = H / 2;

  const outer = new THREE.Shape();
  outer.moveTo(-hw,  hh); outer.lineTo( hw,  hh);
  outer.lineTo( hw, -hh); outer.lineTo(-hw, -hh);
  outer.closePath();

  if (hw - t > 0.002 && hh - t > 0.002) {
    const hole = new THREE.Path();
    hole.moveTo(-hw+t,  hh-t); hole.lineTo( hw-t,  hh-t);
    hole.lineTo( hw-t, -hh+t); hole.lineTo(-hw+t, -hh+t);
    hole.closePath();
    outer.holes.push(hole);
  }
  return extrudeAlongLength(outer, L, color, opacity);
}


// Parses Tekla's part Description into shape + exact section dims when possible.
//   "200Z18" → { shape:'z_channel', H:200, T:1.8 }
//   "120C20" → { shape:'c_channel', H:120, T:2.0 }
function detectFromDescription(desc) {
  if (!desc || typeof desc !== 'string') return null;
  // Strip suffixes so "200Z18-GALV" / "Z200/1.8 (custom)" still match
  let d = desc.trim().toUpperCase();
  d = d.replace(/\s*\(.*\)\s*$/, '').replace(/\s+[SA]\d{2,4}[A-Z]?\s*$/i, '');
  d = d.replace(/\s*[-_]?(GALV|GALVANISED|GALVANIZED|HDG|PAINT|PRIMER|CUSTOM|SPECIAL|STD)\s*$/i, '');
  d = d.replace(/[-_][A-Z]\s*$/, '').trim();

  if (/HEX_?NUT|WASHER|BOLT|SCREW|NUT_?WASHER/.test(d)) return null;
  if (/^PL\s*\d+(?:\.\d+)?\s*[X*]\s*\d/.test(d)) return { shape: 'plate' };
  if (/^(?:ROD|D)\s*\d+(?:\.\d+)?(?:$|_)/.test(d)) return { shape: 'rod' };

  // "Z200X75X2.5" / "Z200*75*2.5" (H × flange × thickness)
  let m = d.match(/^Z\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const H = parseFloat(m[1]), W = parseFloat(m[2]);
    let t = parseFloat(m[3]); if (t > 10) t /= 10;
    return { shape: 'z_channel', H, W, T: t, D: Math.round(H * 0.085) };
  }
  // "200X75X2.5Z" trailing Z
  m = d.match(/^(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*Z\b/);
  if (m) {
    const H = parseFloat(m[1]), W = parseFloat(m[2]);
    let t = parseFloat(m[3]); if (t > 10) t /= 10;
    return { shape: 'z_channel', H, W, T: t, D: Math.round(H * 0.085) };
  }
  // "200Z18" / "200Z1.8" OR "Z200/1.8" / "Z200-18" / "Z200X2.5"
  m = d.match(/^(\d+)\s*Z\s*(\d+(?:\.\d+)?)/);
  if (!m) m = d.match(/^Z\s*(\d+)\s*[/\-]\s*(\d+(?:\.\d+)?)/);
  if (!m) m = d.match(/^Z\s*(\d+)\s*[X*×]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    let t = parseFloat(m[2]); if (t > 10) t /= 10; // "18" → 1.8 mm
    const H = parseFloat(m[1]);
    return { shape: 'z_channel', H, T: t, W: Math.round(H * 0.32), D: Math.round(H * 0.085) };
  }
  m = d.match(/^(\d+)\s*C\s*(\d+(?:\.\d+)?)/);
  if (!m) m = d.match(/^C\s*(\d+)\s*[/\-]\s*(\d+(?:\.\d+)?)/);
  if (m) {
    let t = parseFloat(m[2]); if (t > 10) t /= 10;
    const H = parseFloat(m[1]);
    return { shape: 'c_channel', H, T: t, W: Math.round(H * 0.32), D: Math.round(H * 0.085) };
  }
  m = d.match(/^L\s*(\d+(?:\.\d+)?)\s*[X*]\s*(\d+(?:\.\d+)?)(?:\s*[X*]\s*(\d+(?:\.\d+)?))?/);
  if (m) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    const t = m[3] ? parseFloat(m[3]) : b;
    const H = m[3] ? Math.max(a, b) : a;
    const W = m[3] ? Math.min(a, b) : a;
    return { shape: 'l_angle', H, W, T: t };
  }
  if (/^(?:SHS|RHS)\s*\d/.test(d)) return { shape: 'rhs' };
  if (/^(?:H|IPE|HEA|HEB|UB|UC|W)\s*\d/.test(d)) return { shape: 'i_beam' };
  // Panel / sheet: "3000*200" / "3000X200" (L*W mm, thin plate)
  m = d.match(/^(\d+(?:\.\d+)?)\s*[X*]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (a > 0 && b > 0 && Math.max(a, b) >= 100)
      return { shape: 'plate', H: Math.min(a, b), W: Math.max(a, b), T: Math.min(a, b) };
  }

  return null;
}

/** Bare cold-form "200x75x2.5" / "200×75×2.5" dims (no shape letter). */
function parseColdFormHwt(desc) {
  if (!desc || typeof desc !== 'string') return null;
  let d = desc.trim().toUpperCase();
  d = d.replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*[-_]?(GALV|GALVANISED|GALVANIZED|HDG|PAINT|PRIMER|CUSTOM|SPECIAL|STD)\s*$/i, '')
    .trim();
  const m = d.match(/^(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const H = parseFloat(m[1]), W = parseFloat(m[2]);
  let T = parseFloat(m[3]); if (T > 10) T /= 10;
  // Web × flange × thin wall — reject plate-like triples
  if (!(H >= 75 && W >= 25 && W < H && T > 0 && T <= 8)) return null;
  return { H, W, T, D: Math.round(H * 0.085) };
}

/**
 * Resolve shape/sect from item OR single part (IFC often leaves parent empty).
 * Part Description ALWAYS beats assembly-name guess (GIRT≠always Z; ANGLE≠always L).
 */
function resolveItemProfile(it) {
  if (!it) return null;
  const part0 = (it.parts && it.parts.length === 1) ? it.parts[0] : null;
  let shapeKey = it.shapeKey || (part0 && part0.shapeKey) || null;
  let profileDesc = it.profileDesc || (part0 && part0.profileDesc) || '';
  let sectH = Number(it.sectH || (part0 && part0.sectH) || 0) || 0;
  let sectW = Number(it.sectW || (part0 && part0.sectW) || 0) || 0;
  let sectT = Number(it.sectT || (part0 && part0.sectT) || 0) || 0;
  let sectD = Number(it.sectD || (part0 && part0.sectD) || 0) || 0;
  let sectTf = Number(it.sectTf || (part0 && part0.sectTf) || 0) || 0;
  let sectTw = Number(it.sectTw || (part0 && part0.sectTw) || 0) || 0;

  const fromDesc = profileDesc ? detectFromDescription(profileDesc) : null;
  if (fromDesc && fromDesc.shape) {
    shapeKey = shapeKey || fromDesc.shape;
    if (!(sectH > 0) && fromDesc.H) sectH = fromDesc.H;
    if (!(sectW > 0) && fromDesc.W) sectW = fromDesc.W;
    if (!(sectT > 0) && fromDesc.T) sectT = fromDesc.T;
    if (!(sectD > 0) && fromDesc.D) sectD = fromDesc.D;
  }
  // Already known Z/C but desc is bare "200x75x2.5" (no Z/C letter) — fill dims
  if (!(sectT > 0) && profileDesc && (shapeKey === 'z_channel' || shapeKey === 'c_channel'
      || /z_channel|c_channel/i.test(String(it.profileShape || '')))) {
    const dims = parseColdFormHwt(profileDesc);
    if (dims) {
      if (!(sectH > 0) && dims.H) sectH = dims.H;
      if (!(sectW > 0) && dims.W) sectW = dims.W;
      if (!(sectT > 0) && dims.T) sectT = dims.T;
      if (!(sectD > 0) && dims.D) sectD = dims.D;
    }
  }
  // Name guess ONLY when still unknown
  if (!shapeKey) {
    const fromName = detectFromName(it.assemblyName);
    if (fromName && fromName.shape) shapeKey = fromName.shape;
  }
  const profileShape = it.profileShape || shapeKey || null;
  return {
    shapeKey, profileShape, profileDesc,
    sectH, sectW, sectT, sectD, sectTf, sectTw,
    fromPart: !!(part0 && (part0.shapeKey || part0.profileDesc)),
  };
}

const CS_ANALYTIC_SHAPES = {
  z_channel: 1, c_channel: 1, l_angle: 1, plate: 1,
  rod: 1, rhs: 1, i_beam: 1, h_beam: 1, bent_sag_rod: 1, chs: 1,
};

// Fallback: guess a shape from the assembly name when the part Description
// wasn't available (e.g. older build without Description extraction, or a
// non-Tekla IFC exporter). Tekla naming conventions used at ACERO:
//   ROD_BRACE_ASSY / BRACE_ROD -> rod
//   GIRT / PURLIN               -> Z-purlin (most common cold-formed)
//   ANGLE / L_BRACE             -> L-angle
//   PLT / PLATE / SHIM / SHEET / FLANGE -> plate
//   COLUMN / RAFTER / BEAM / TUBE -> I-beam
function detectFromName(name) {
  if (!name || typeof name !== 'string') return null;
  const n = name.toUpperCase();
  // Bent sag / SAG_ROD_ASSY before generic ROD
  if (/BEND_?SAG|BENT_?SAG|SAG_?BEND|SAG_?BENT|BENDSAGROD|BENTSAGROD/.test(n)
      || /SAG[_\s-]*ROD|SAGROD/.test(n))
    return { shape: 'bent_sag_rod' };
  if (/ROD_?BRACE|BRACE_?ROD|^ROD\b/.test(n)) return { shape: 'rod' };
  if (/CHANNEL|CEE/.test(n)) return { shape: 'c_channel' };
  // GIRT can be C or Z — only guess Z when no part Description (200C18 / 200Z18)
  if (/PURLIN/.test(n)) return { shape: 'z_channel' };
  if (/GIRT/.test(n)) return { shape: 'z_channel' }; // fallback only; part desc wins upstream
  if (/L_?ANGLE|^ANGLE/.test(n)) return { shape: 'l_angle' };
  if (/PLT|PLATE|SHIM|SHEET|FLANGE|STIFFENER|END_?PLT|PANEL/.test(n)) return { shape: 'plate' };
  if (/COLUMN|RAFTER|^BEAM|^TUBE/.test(n)) return { shape: 'i_beam' };
  return null;
}

// Combined: try the exact Description first, then fall back to the
// assembly-name convention. Returns null only when both fail.
function detectProfileShape(desc, assemblyName) {
  return detectFromDescription(desc) || detectFromName(assemblyName);
}

// A bundle of nested channels shown as several flat slabs offset from each
// other - visually cleaner than trying to render each full extrusion, and
// clearly shows the "tucked-inside-each-other" stacking pattern.
// A bundle of N identical C-channels arranged in a rows × cols grid,
/** Shift a Group so its world AABB is centred on the origin (base = -h/2). */
function recenterGroupAabb(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const c = new THREE.Vector3();
  box.getCenter(c);
  if (c.lengthSq() < 1e-12) return box;
  group.children.forEach(ch => {
    if (ch.matrixAutoUpdate === false) {
      // IFC transform parts: translation lives in matrix, not position
      ch.matrix.elements[12] -= c.x;
      ch.matrix.elements[13] -= c.y;
      ch.matrix.elements[14] -= c.z;
      ch.position.setFromMatrixPosition(ch.matrix);
    } else {
      ch.position.x -= c.x;
      ch.position.y -= c.y;
      ch.position.z -= c.z;
    }
  });
  group.updateMatrixWorld(true);
  return box;
}

// Mesh-only world AABB (ignore edge LineSegments — they skew nest snaps)
function channelMeshBox(root) {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone();
    b.applyMatrix4(o.matrixWorld);
    box.union(b);
  });
  return box;
}

// ── C-CHANNEL nest ─────────────────────────────────────────────────────
//
// Bottom OPEN (U, rot.x=+π/2) + top CLOSED (inverted, rot.x=-π/2).
// Same size, shifted by wall thickness t:
//   LEFT:  bottom flange OUTSIDE, top INSIDE — bottom flange tip touches top lip
//   RIGHT: top OUTSIDE, bottom INSIDE          — opposite of left
// Vertical: top tips on bottom inner web, top web on bottom flange tips.
// Snap uses mesh AABB only so edges cannot leave residual overlap.
function makeChannelBundle(l, unitH, unitW, cols, rows, qty, color, opacity, sect) {
  const group = new THREE.Group();
  const n = Math.max(1, qty || 1);
  const totalToShow = Math.min(n, 120);

  const dims = _sdim(sect, unitH, unitW, 'c_channel');
  const t = Math.max(dims.t, 0.010);
  const hair = Math.max(t * 0.02, 0.0002); // tiny visual separation, not a gap

  const probe = makeChannel(l, unitH, unitW, color, opacity, sect);
  probe.rotation.x = Math.PI / 2;
  const psz = new THREE.Vector3();
  channelMeshBox(probe).getSize(psz);
  probe.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });

  const pieceH = Math.max(psz.y, dims.W, 0.03);
  const pieceW = Math.max(psz.z, dims.H, 0.04);

  const nPairs = Math.ceil(n / 2);
  let nCols = (cols > 0) ? cols : Math.max(1, Math.ceil(Math.sqrt(nPairs)));
  let nPairRows = (rows > 0) ? rows : Math.ceil(nPairs / nCols);
  if (nCols * nPairRows < nPairs) nPairRows = Math.ceil(nPairs / nCols);

  // Extra right shift (user: a little more)
  const zNudge = t * 6;
  const pairW = pieceW + t + zNudge;
  const colGap = Math.max(pieceW * 0.06, t * 3, 0.012);
  const packW = nCols * pairW + Math.max(0, nCols - 1) * colGap;
  const stackGap = Math.max(t * 0.1, 0.0003);

  const colTop = new Array(nCols).fill(0);
  let placed = 0;
  let pairIdx = 0;

  outer: for (let r = 0; r < nPairRows; r++) {
    for (let c = 0; c < nCols; c++) {
      if (placed >= totalToShow || pairIdx >= nPairs) break outer;

      const zPair = -packW / 2 + c * (pairW + colGap) + pairW / 2;
      const zBot = zPair - t; // leave room for top nudge to the right
      const yBot = colTop[c] + pieceH / 2;

      // BOTTOM — opening UP
      const bottom = makeChannel(l, unitH, unitW, color, opacity, sect);
      bottom.rotation.x = Math.PI / 2;
      bottom.position.set(0, yBot, zBot);
      group.add(bottom);
      placed++;
      pairIdx++;

      let top = null;
      if (placed < totalToShow && placed < n) {
        // TOP — inverted; shift further +Z (user blue-line nudge)
        top = makeChannel(l, unitH, unitW, color, opacity, sect);
        top.rotation.x = -Math.PI / 2;
        top.position.set(0, yBot + t, zBot + t + zNudge);
        group.add(top);
        placed++;

        const bb = channelMeshBox(bottom);

        // Vertical: bottom flange TOP (lip) touches top web underside — no dig-in
        let tb = channelMeshBox(top);
        top.position.y += (bb.max.y + hair) - (tb.max.y - t);

        // Lateral: base nest (t) + extra right nudge (zNudge) from user mark
        tb = channelMeshBox(top);
        top.position.z += (bb.min.z + t + zNudge + hair) - tb.min.z;
      }

      const pairBox = channelMeshBox(bottom);
      if (top) pairBox.union(channelMeshBox(top));
      colTop[c] = pairBox.max.y + stackGap;
    }
  }

  recenterGroupAabb(group);
  return group;
}

// ── L-ANGLE nested bundle (real-world photo: same orientation, nest by t) ─
//
// Each L tucks into the crotch of the one below — step = rendered wall
// thickness (measured), NOT full leg size. Touch, never penetrate.
function makeLAngleBundle(it, color, opacity) {
  const group = new THREE.Group();
  const qty  = it.qty || 1;
  const l    = it.lengthMm;
  const sect = (it.shapeKey || it.sectH > 0) ? it : null;

  const Hmm = sect?.sectH > 0 ? sect.sectH : (it.unitHeight || it.heightMm);
  const Wmm = sect?.sectW > 0 ? sect.sectW : (it.unitWidth  || it.widthMm);

  // Probe real mesh so nest step matches drawn wall thickness
  const probe = makeLAngle(l, Hmm, Wmm, color, opacity, sect);
  probe.updateMatrixWorld(true);
  const psz = new THREE.Vector3();
  new THREE.Box3().setFromObject(probe).getSize(psz);
  probe.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });

  const dims = _sdim(sect, Hmm, Wmm, 'l_angle');
  const H = Math.max(psz.y, dims.H);
  const W = Math.max(psz.z, dims.W);
  // Step6 offset for spacing only — L profile geometry unchanged
  const nestInfo = (typeof resolveNestingInfo === 'function')
    ? resolveNestingInfo(it) : (it.nestingInfo || null);
  const nestOffMm = nestInfo?.nesting_offset > 0
    ? nestInfo.nesting_offset
    : (it.nestingOffsetMm > 0 ? it.nestingOffsetMm : 0);
  const step = nestOffMm > 0
    ? nestOffMm * SCALE
    : (Math.max(dims.t, 0.012) + 0.006);
  const isInterlock = !!(nestInfo && nestInfo.method === 'INTERLOCK_NEST');
  // L-angles: ALWAYS stack on horizontal leg (Y-only). Never Y+Z diagonal stair —
  // that leaves the bundle looking 45°-tilted on a corner after rest-pose.
  const nestMode = (typeof chooseStableNestMode === 'function')
    ? chooseStableNestMode(it, qty || 1)
    : (isInterlock ? 'collision_flip' : 'stack_up');
  const stackUp = nestMode !== 'diagonal_same';

  // Compact nest — one column. Show full pack-unit qty (Step7 caps SET_SIZE).
  // Soft GPU guard only — do not silently drop at 12 while INTERLOCK allows 16.
  const SOFT_MAX = 24;
  const N_stack  = Math.min(Math.max(qty || 1, 1), SOFT_MAX);
  const N_stacks = 1; // one set = one column
  const totalToShow = N_stack;
  if ((qty || 1) > SOFT_MAX) {
    try {
      console.warn(`[L-bundle] capping display ${qty} → ${SOFT_MAX} (pack unit oversized)`);
    } catch (_) { /* */ }
  }

  // True INTERLOCK for L: collision-fit + alternate 180° when flip allowed
  // Slide maps to world Y or Z from CS nest_direction (not always Y).
  if (isInterlock && nestMode === 'collision_flip'
      && typeof computeInterlockWorldYPlacements === 'function') {
    const fit = computeInterlockWorldYPlacements(it, N_stack);
    const bundleH = (fit.bundle_height_mm > 0
      ? fit.bundle_height_mm
      : (Hmm + (N_stack - 1) * (nestOffMm || 1))) * SCALE;
    const bundleW = (fit.bundle_width_mm > 0
      ? fit.bundle_width_mm
      : Wmm) * SCALE;
    const allowFlip = !!(it.nestMethod?.alternate_flip
      || nestInfo?.alternate_flip
      || it.csAnalysis?.can_flip);
    for (let k = 0; k < N_stack && k < totalToShow; k++) {
      const pl = fit.placements[k] || {
        y_offset_mm: k * (nestOffMm || 0),
        z_offset_mm: 0,
        flip: allowFlip && (k % 2) === 1,
      };
      const piece = makeLAngle(l, Hmm, Wmm, color, opacity, sect);
      const flip = allowFlip && !!(pl.flip || (k % 2) === 1);
      piece.position.y = -bundleH / 2 + H / 2 + (pl.y_offset_mm || 0) * SCALE;
      piece.position.z = -bundleW / 2 + W / 2 + (pl.z_offset_mm || 0) * SCALE;
      if (flip) piece.rotation.x += Math.PI;
      piece.userData.nestFlip = flip;
      group.add(piece);
    }
    if (typeof refineInterlockNestGroup === 'function')
      refineInterlockNestGroup(group, it);
    else recenterGroupAabb(group);
    return group; // rest-pose via makeShape → ensureStableShape
  }

  // Face-down stack: grow on Y only (horizontal leg stays on ground plane)
  const colW = W;
  const colH = H + Math.max(0, N_stack - 1) * step;
  const gap  = Math.max(dims.t * 4, 0.04);
  const bundleW = N_stacks * colW + Math.max(0, N_stacks - 1) * gap;
  const bundleH = colH;

  let placed = 0;
  outer: for (let s = 0; s < N_stacks; s++) {
    const baseZ = s * (colW + gap) - bundleW / 2 + colW / 2;
    for (let k = 0; k < N_stack; k++) {
      if (placed >= totalToShow) break outer;
      const pZ = baseZ; // no lateral stair
      const pY = -bundleH / 2 + H / 2 + k * step;

      const piece = makeLAngle(l, Hmm, Wmm, color, opacity, sect);
      piece.position.y = pY;
      piece.position.z = pZ;
      group.add(piece);
      placed++;
    }
  }
  recenterGroupAabb(group);
  return group; // rest-pose via makeShape → ensureStableShape
}

// Router: picks the right shape function per item. If a real profile
// shape was detected from the IFC part Description (z_channel, c_channel,
// l_angle, i_beam, plate, rod, rhs), that always wins over the raw
// category guess. Bundle grids continue to work for all shape types.
// All top-level results get CoG rest-pose via ensureStableShape (rigid only).
function makeShape(it, color, opacity) {
  const mesh = makeShapeRaw(it, color, opacity);
  if (typeof ensureStableShape === 'function') return ensureStableShape(mesh, it);
  return mesh;
}

function makeShapeRaw(it, color, opacity) {
  // Promote part profile (parent often empty in IFC) before any routing
  const resolved = typeof resolveItemProfile === 'function' ? resolveItemProfile(it) : null;
  if (resolved && (resolved.shapeKey || resolved.sectH > 0 || resolved.profileDesc)) {
    it = Object.assign({}, it, {
      shapeKey: resolved.shapeKey || it.shapeKey,
      profileShape: resolved.profileShape || it.profileShape || resolved.shapeKey,
      profileDesc: resolved.profileDesc || it.profileDesc,
      sectH: it.sectH > 0 ? it.sectH : resolved.sectH,
      sectW: it.sectW > 0 ? it.sectW : resolved.sectW,
      sectT: it.sectT > 0 ? it.sectT : resolved.sectT,
      sectD: it.sectD > 0 ? it.sectD : resolved.sectD,
      sectTf: it.sectTf > 0 ? it.sectTf : resolved.sectTf,
      sectTw: it.sectTw > 0 ? it.sectTw : resolved.sectTw,
    });
  }

  // Bent sag rod FIRST — IFC path must win over assembly/box fallbacks
  if ((it.profileShape === 'bent_sag_rod' || it.shapeKey === 'bent_sag_rod' || isBentSagRodItem(it))
      && !it._assemblyChild) {
    const sect = (it.shapeKey || it.sectH > 0) ? it : null;
    const useH = it.unitHeight > 0 ? it.unitHeight : it.heightMm;
    const useW = it.unitWidth  > 0 ? it.unitWidth  : it.widthMm;
    if (it.qty > 1 || (it.bundled && (it.gridCols || it.gridRows)))
      return makeBentSagRodBundle(it, color, opacity);
    return makeBentSagRod(
      it.lengthMm, useH, useW, color, opacity, sect,
      it.pathPointsMm, it.pathDiamMm
    );
  }

  // Single-part known profiles → analytic nest shapes (Z/C/L/plate/rod…).
  // Do NOT send these through makeIfcAssembly — that shows building pose / skips yard nest.
  const sk0 = it.shapeKey || it.profileShape || '';
  const singlePartAnalytic = !!(it.parts && it.parts.length === 1 && CS_ANALYTIC_SHAPES[sk0]);

  // Assembly / xBIM: multi-part welded OR unknown single-part only
  if (it.isAssembly && it.parts && it.parts.length >= 1 && !it._assemblyChild
      && !singlePartAnalytic) {
    if ((it.qty || 1) > 1
        && typeof makeTaperedAssemblyBundle === 'function'
        && (typeof isTaperedOrNonUniformItem !== 'function'
          || isTaperedOrNonUniformItem(it)
          || it.nestMethod?.method === 'PER_MARK_STACK'
          || it.crossSection?.is_tapered)) {
      return makeTaperedAssemblyBundle(it, color, opacity);
    }
    return makeIfcAssembly(it, color, opacity);
  }

  const p    = it.profileShape || it.shapeKey;
  // sect = exact cross-section dims from C# ProfileDescParser (carried via expandUnits)
  const sect = (it.shapeKey || it.sectH > 0) ? it : null;

  // For single pieces, use unitHeight/unitWidth if available (set by expandUnits
  // from exact section dims) rather than raw bounding-box heightMm/widthMm.
  // For Z/C sections the bbox is ~2-3x too wide.
  const useH = it.unitHeight > 0 ? it.unitHeight : it.heightMm;
  const useW = it.unitWidth  > 0 ? it.unitWidth  : it.widthMm;

  if (p === 'z_channel') {
    if (it.qty > 1) return makeZPurlinBundle(it, color, opacity);
    return makeZChannel(it.lengthMm, useH, useW, color, opacity, sect);
  }
  if (p === 'l_angle') {
    if (it.qty > 1) return makeLAngleBundle(it, color, opacity);
    return makeLAngle(it.lengthMm, useH, useW, color, opacity, sect);
  }
  if (p === 'rhs') {
    if (it.gridCols && it.gridRows && it.qty > 1)
      return makeShapeBundle((l,h,w,c,op) => makeRHS(l,h,w,c,op,sect), it, color, opacity);
    return makeRHS(it.lengthMm, useH, useW, color, opacity, sect);
  }
  if (p === 'c_channel') {
    if (it.qty > 1)
      return makeChannelBundle(it.channelLength || it.lengthMm, it.unitHeight || it.heightMm,
                               it.unitWidth || it.widthMm, it.gridCols || 0, it.gridRows || 0, it.qty, color, opacity, sect);
    // Single C: laid flat, opening UP (matches nest pair base)
    const mesh = makeChannel(it.lengthMm, useH, useW, color, opacity, sect);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }
  if (p === 'i_beam') {
    if (it.gridCols && it.gridRows && it.qty > 1)
      return makeBeamBundle(it.lengthMm, it.unitHeight || it.heightMm, it.unitWidth || it.widthMm,
                            it.gridCols, it.gridRows, it.qty, color, opacity, sect);
    return makeIBeam(it.lengthMm, useH, useW, color, opacity, sect);
  }
  // Bent sag rod only — IFC centerline or dogleg (short / diagonal / vertical)
  if (p === 'bent_sag_rod' || isBentSagRodItem(it)) {
    if (it.qty > 1 || (it.bundled && (it.gridCols || it.gridRows)))
      return makeBentSagRodBundle(it, color, opacity);
    return makeBentSagRod(
      it.lengthMm, useH, useW, color, opacity, sect,
      it.pathPointsMm, it.pathDiamMm
    );
  }
  if (p === 'rod') {
    if (it.qty > 1 || (it.bundled && it.unitDiam))
      return makeRodBundle(it.lengthMm, it.unitDiam || Math.min(it.heightMm, it.widthMm) || 12,
                           it.gridCols || 0, it.gridRows || 0, it.qty, color, opacity);
    const diam = sect?.sectH > 0 ? sect.sectH : Math.min(it.heightMm, it.widthMm);
    return makeRod(it.lengthMm, diam, diam, color, opacity);
  }
  if (p === 'plate') {
    if (it.stacked) {
      // unitThickness is set correctly by expandUnits (min of h,w)
      const t = it.unitThickness > 0 ? it.unitThickness
               : (sect?.sectH > 0 ? sect.sectH : Math.min(it.heightMm, it.widthMm));
      // plate width = unitWidth (set correctly) or larger of h,w
      const pw = it.unitWidth > 0 ? it.unitWidth : Math.max(it.heightMm, it.widthMm);
      return makePlateStack(it.lengthMm, pw, t, it.qty, color, opacity, it.gridCols || 0, it.gridRows || 0);
    }
    // Single plate: smallest dim = thickness
    const t = Math.min(it.heightMm, it.widthMm);
    const pw = Math.max(it.heightMm, it.widthMm);
    return makeBox(it.lengthMm, t, pw, color, opacity);
  }

  // Category fallbacks
  if (it.category === 'rod') {
    if (isBentSagRodItem(it)) {
      if (it.qty > 1 || (it.bundled && (it.gridCols || it.gridRows)))
        return makeBentSagRodBundle(it, color, opacity);
      return makeBentSagRod(
        it.lengthMm, useH, useW, color, opacity, sect,
        it.pathPointsMm, it.pathDiamMm
      );
    }
    if (it.qty > 1 || (it.bundled && it.unitDiam))
      return makeRodBundle(it.lengthMm, it.unitDiam || Math.min(it.heightMm, it.widthMm) || 12,
                           it.gridCols || 0, it.gridRows || 0, it.qty, color, opacity);
    return makeRod(it.lengthMm, it.heightMm, it.widthMm, color, opacity);
  }
  if (it.category === 'plate') {
    if (it.stacked) {
      const t = it.unitThickness > 0 ? it.unitThickness : Math.min(it.heightMm, it.widthMm);
      const pw = it.unitWidth > 0 ? it.unitWidth : Math.max(it.heightMm, it.widthMm);
      return makePlateStack(it.lengthMm, pw, t, it.qty, color, opacity, it.gridCols || 0, it.gridRows || 0);
    }
    const t = Math.min(it.heightMm, it.widthMm);
    const pw = Math.max(it.heightMm, it.widthMm);
    return makeBox(it.lengthMm, t, pw, color, opacity);
  }
  if (it.category === 'beam') {
    if (it.beamBundle && it.unitHeight && it.unitWidth && it.gridCols && it.gridRows)
      return makeBeamBundle(it.lengthMm, it.unitHeight, it.unitWidth, it.gridCols, it.gridRows, it.qty, color, opacity, sect);
    return makeIBeam(it.lengthMm, useH, useW, color, opacity, sect);
  }
  if (it.category === 'purlin') {
    if (it.nested && it.qty > 1) {
      if (it.profileShape === 'z_channel') return makeZPurlinBundle(it, color, opacity);
      if (it.profileShape === 'l_angle') return makeLAngleBundle(it, color, opacity);
      if (it.profileShape === 'c_channel' || (it.unitWidth && it.unitHeight)) {
        return makeChannelBundle(it.channelLength || it.lengthMm, it.unitHeight || useH, it.unitWidth || useW,
                                 it.gridCols || 0, it.gridRows || 0, it.qty, color, opacity, sect);
      }
    }
    if (it.profileShape === 'c_channel') {
      const mesh = makeChannel(it.lengthMm, useH, useW, color, opacity, sect);
      mesh.rotation.x = Math.PI / 2;
      return mesh;
    }
    if (it.profileShape === 'l_angle') return makeLAngle(it.lengthMm, useH, useW, color, opacity, sect);
    if (it.profileShape === 'z_channel') return makeZChannel(it.lengthMm, useH, useW, color, opacity, sect);
    // Unknown purlin → Z (most common cold-formed), not a flat C fallback
    return makeZChannel(it.lengthMm, useH, useW, color, opacity, sect);
  }
  return makeBox(it.lengthMm, it.heightMm, it.widthMm, color, opacity);
}
