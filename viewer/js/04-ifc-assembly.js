/* 04-ifc-assembly.js — makeIfcAssembly + bundles */

/**
 * IFC multi-part assembly: each part keeps exact IFC profile / size / angle / transform.
 * Packing does NOT use part dims — only the overall assembly AABB (Option 3).
 */
function makeIfcAssembly(it, color, opacity) {
  const group = new THREE.Group();
  // Web-first: design WEB from IFC, then flanges / stiffeners / other parts
  const kindRank = (p) => {
    const k = String(p.partKind || '').toLowerCase();
    if (k === 'web' || /\bWEB\b|\bWB\d/i.test(`${p.name||''} ${p.profileDesc||''}`)) return 0;
    if (k === 'flange' || /FLANGE|\bFL\d/i.test(`${p.name||''} ${p.profileDesc||''}`)) return 1;
    if (k === 'stiff') return 3;
    return 2;
  };
  const parts = (it.parts || []).slice().sort((a, b) => kindRank(a) - kindRank(b));
  // Flange brace / L-angle: NEVER use xBIM wafer tessellation — solid analytic L
  const asmNameBlob = `${it.assemblyName || ''} ${it.mark || ''} ${it.profileDesc || ''} ${it.shapeKey || ''}`;
  const partL = parts.some(p => {
    const pd = String(p.profileDesc || '');
    const nm = `${p.name || ''} ${pd}`;
    return (p.shapeKey === 'l_angle')
      || /^\s*L\s*\d/i.test(pd) || /\bL\d{2,}/i.test(pd)
      || /FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE/i.test(nm);
  });
  const isLAngleAsm = it.shapeKey === 'l_angle' || it.profileShape === 'l_angle'
    || it.groupKind === 'nest_l'
    || /FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE/i.test(asmNameBlob)
    || (typeof detectFromName === 'function' && detectFromName(asmNameBlob)?.shape === 'l_angle')
    || (typeof detectFromDescription === 'function'
      && detectFromDescription(it.profileDesc || '')?.shape === 'l_angle')
    || partL;
  if (isLAngleAsm && typeof makeLAngle === 'function' && !it._assemblyChild) {
    const p0 = parts[0] || {};
    const sect = {
      shapeKey: 'l_angle',
      sectH: it.sectH || p0.sectH || 0,
      sectW: it.sectW || p0.sectW || 0,
      sectT: it.sectT || p0.sectT || 0,
    };
    if (!(sect.sectH > 0) && typeof detectFromDescription === 'function') {
      const d = detectFromDescription(it.profileDesc || p0.profileDesc || '');
      if (d && d.shape === 'l_angle') {
        if (d.H) sect.sectH = d.H;
        if (d.W) sect.sectW = d.W;
        if (d.T) sect.sectT = d.T;
      }
    }
    const L = Math.max(it.lengthMm || p0.lengthMm || 0, 50);
    const H = sect.sectH || it.unitHeight || it.heightMm || 40;
    const W = sect.sectW || it.unitWidth || it.widthMm || H;
    const child = {
      ...it,
      shapeKey: 'l_angle',
      profileShape: 'l_angle',
      sectH: H, sectW: W, sectT: sect.sectT || it.sectT || 0,
      lengthMm: L, heightMm: H, widthMm: W,
      unitHeight: H, unitWidth: W,
      isAssembly: false,
      parts: null,
    };
    if ((it.qty || 1) > 1 || (it.bundled && (it.gridCols || it.gridRows))) {
      if (typeof makeLAngleBundle === 'function')
        return makeLAngleBundle(child, color, opacity);
    }
    return makeLAngle(L, H, W, color, opacity, child);
  }
  const isRafterOrColumnAsm = /RAFTER|COLUMN/i.test(`${it.assemblyName || ''} ${it.mark || ''}`);
  const isWebP = (p) =>
    String(p.partKind || '').toLowerCase() === 'web'
    || /\bWEB\b|\bWB\d/i.test(`${p.name || ''} ${p.profileDesc || ''}`);
  const isFlangeP = (p) =>
    String(p.partKind || '').toLowerCase() === 'flange'
    || /FLANGE|\bFL\d/i.test(`${p.name || ''} ${p.profileDesc || ''}`);

  function partCenterMm(p) {
    if (p.hasIfcTransform && Array.isArray(p.transform) && p.transform.length >= 16)
      return new THREE.Vector3(+p.transform[12] || 0, +p.transform[13] || 0, +p.transform[14] || 0);
    return new THREE.Vector3(+(p.offsetXMm || 0), +(p.offsetYMm || 0), +(p.offsetZMm || 0));
  }
  function partAxes(p) {
    const t = p.transform;
    if (!p.hasIfcTransform || !Array.isArray(t) || t.length < 16) {
      return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    }
    return [
      new THREE.Vector3(+t[0], +t[1], +t[2]).normalize(),
      new THREE.Vector3(+t[4], +t[5], +t[6]).normalize(),
      new THREE.Vector3(+t[8], +t[9], +t[10]).normalize(),
    ];
  }
  function partDimsArr(p) {
    return [
      Math.max(p.lengthMm || 0, 1),
      Math.max(p.heightMm || 0, 1),
      Math.max(p.widthMm || 0, 1),
    ];
  }

  function flangeThickMm(f) {
    if (+f.thicknessMm > 0.5) return +f.thicknessMm;
    const d = partDimsArr(f);
    return Math.min(d[0], d[1], d[2]);
  }

  function flangeHalfAlong(f, D) {
    const fd = partDimsArr(f);
    const fa = partAxes(f);
    let half = 0;
    for (let i = 0; i < 3; i++) {
      half += 0.5 * fd[i] * Math.abs(fa[i].dot(D));
    }
    if (half > 0.25) return half;
    return 0.5 * flangeThickMm(f);
  }

  /**
   * Rafter/column ONLY: CUT web overhang past flange inner faces and do not
   * show the cut piece (thazhe overhang). Between-flange verts stay put.
   */
  function cutWebToFlangeGap(mesh, webPart, flanges) {
    if (!mesh?.geometry || !webPart || !flanges || flanges.length < 2) return;

    // Depth = web SECTION HEIGHT (mid extent), not span
    const dims = partDimsArr(webPart);
    const axes = partAxes(webPart);
    const order = [0, 1, 2].sort((a, b) => dims[b] - dims[a]);
    const D = axes[order[1]].clone().normalize();
    const longAx = axes[order[0]];

    const cents = flanges.map(partCenterMm);
    let iA = 0, iB = 1, bestD = -1;
    for (let i = 0; i < cents.length; i++) {
      for (let j = i + 1; j < cents.length; j++) {
        const d = cents[i].distanceTo(cents[j]);
        if (d > bestD) { bestD = d; iA = i; iB = j; }
      }
    }
    if (bestD >= 40) {
      const pair = cents[iB].clone().sub(cents[iA]).normalize();
      if (Math.abs(pair.dot(longAx)) < 0.55 && Math.abs(pair.dot(D)) > 0.5) {
        if (pair.dot(D) < 0) D.copy(pair).negate();
        else D.copy(pair);
      }
    }

    const projs = flanges.map(f => ({
      p: partCenterMm(f).dot(D),
      half: flangeHalfAlong(f, D),
    }));
    let loP = Math.min(...projs.map(x => x.p));
    let hiP = Math.max(...projs.map(x => x.p));
    if (hiP - loP < 40) {
      if (bestD < 40) return;
      D.copy(cents[iB]).sub(cents[iA]).normalize();
      if (Math.abs(D.dot(longAx)) > 0.7) return;
      for (let i = 0; i < flanges.length; i++) {
        projs[i].p = cents[i].dot(D);
        projs[i].half = flangeHalfAlong(flanges[i], D);
      }
      loP = Math.min(...projs.map(x => x.p));
      hiP = Math.max(...projs.map(x => x.p));
      if (hiP - loP < 40) return;
    }

    const midP = 0.5 * (loP + hiP);
    const bot = projs.filter(x => x.p <= midP);
    const top = projs.filter(x => x.p > midP);
    if (!bot.length || !top.length) return;

    let botInner = Math.max(...bot.map(x => x.p + x.half));
    let topInner = Math.min(...top.map(x => x.p - x.half));
    let clearGapMm = topInner - botInner;
    const csharpGap = +(it.flangeClearGapMm || 0);
    if (!(clearGapMm > 20) && csharpGap > 20) {
      const mid = 0.5 * (loP + hiP);
      botInner = mid - 0.5 * csharpGap;
      topInner = mid + 0.5 * csharpGap;
      clearGapMm = csharpGap;
    }
    if (!(clearGapMm > 20)) return;

    mesh.updateMatrix();
    const mat = mesh.matrix.clone();
    const inv = mat.clone().invert();
    const pos = mesh.geometry.attributes.position;
    if (!pos) return;
    const orig = new Float32Array(pos.array);
    const v = new THREE.Vector3();
    const loS = botInner * SCALE, hiS = topInner * SCALE;

    // CUT overhang onto flange inners — cut piece not shown
    let nCut = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      const t = v.dot(D);
      let t2 = t;
      if (t < loS) { t2 = loS; nCut++; }
      else if (t > hiS) { t2 = hiS; nCut++; }
      if (t2 !== t) {
        v.addScaledVector(D, t2 - t);
        v.applyMatrix4(inv);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
    }
    if (nCut === 0) {
      let minT = Infinity, maxT = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mat);
        const t = v.dot(D);
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }
      const ext = maxT - minT;
      if (ext > 1e-6 && ext / SCALE < clearGapMm - 2) {
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mat);
          const t = v.dot(D);
          const t2 = loS + ((t - minT) / ext) * (hiS - loS);
          v.addScaledVector(D, t2 - t);
          v.applyMatrix4(inv);
          pos.setXYZ(i, v.x, v.y, v.z);
        }
      }
    }

    let min2 = Infinity, max2 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      const t = v.dot(D);
      if (t < min2) min2 = t;
      if (t > max2) max2 = t;
    }
    if ((max2 - min2) < Math.max(15 * SCALE, clearGapMm * SCALE * 0.5)) {
      pos.array.set(orig);
      pos.needsUpdate = true;
      return;
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.children.forEach(ch => {
      if (ch.isLineSegments && ch.geometry) {
        ch.geometry.dispose();
        ch.geometry = new THREE.EdgesGeometry(mesh.geometry, 30);
      }
    });

    const pBot = new THREE.Plane(D.clone(), -loS);
    const pTop = new THREE.Plane(D.clone().negate(), hiS);
    const applyClip = (m) => {
      if (!m) return;
      m.clippingPlanes = [pBot, pTop];
      m.clipShadows = true;
      m.needsUpdate = true;
    };
    applyClip(mesh.material);
    mesh.children.forEach(ch => applyClip(ch.material));
  }

  function resolvePlateThicknessMm(p) {
    const cands = [];
    const push = (v) => { v = +v || 0; if (v > 0.5 && v <= 80) cands.push(v); };
    push(p.thicknessMm);
    push(p.sectT);
    push(p.sectH); // Tekla sometimes puts plate T in H
    push(p.profileExtrudeMm);
    if (cands.length) return Math.min(...cands);
    const dims = [p.lengthMm, p.heightMm, p.widthMm].map(Number).filter(v => v > 0.5);
    if (!dims.length) return 0;
    const m = Math.min(...dims);
    return m <= 80 ? m : 0;
  }

  /** Rafter/column plates: force mesh-local L/H/W so thinnest axis = true T. */
  function dimsWithCorrectThickness(p) {
    let L = Math.max(+p.lengthMm || 1, 1);
    let H = Math.max(+p.heightMm || 1, 1);
    let W = Math.max(+p.widthMm || 1, 1);
    const T = resolvePlateThicknessMm(p);
    if (T > 0.5) {
      const arr = [
        { k: 'L', v: L }, { k: 'H', v: H }, { k: 'W', v: W }
      ].sort((a, b) => a.v - b.v);
      // Prefer axis already nearest to T; else the smallest
      let pick = arr[0];
      for (const d of arr) {
        if (Math.abs(d.v - T) / T < 0.75) { pick = d; break; }
      }
      if (pick.k === 'L') L = T;
      else if (pick.k === 'H') H = T;
      else W = T;
    }
    return { L, H, W, T };
  }

  /** IFC face profile → extruded plate (tapered web etc.). Exact IFC geometry. */
  function makePlateFromIfcProfile(p, col, opac) {
    const pts = p.profilePointsMm;
    let deep = Math.max(p.profileExtrudeMm || 0, 0);
    const T = resolvePlateThicknessMm(p);
    // Extrude must be plate thickness — never web height / flange width
    if (T > 0.5 && (deep < 0.5 || deep > 80 || Math.abs(deep - T) / T > 0.5))
      deep = T;
    else if (deep > 80 && T > 0.5)
      deep = T;
    if (!Array.isArray(pts) || pts.length < 3 || deep < 0.5) return null;
    const shape = new THREE.Shape();
    let started = false;
    for (let i = 0; i < pts.length; i++) {
      const x = (+pts[i][0] || 0) * SCALE;
      const y = (+pts[i][1] || 0) * SCALE;
      if (!started) { shape.moveTo(x, y); started = true; }
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: deep * SCALE,
      bevelEnabled: false,
      curveSegments: 1,
    });
    // Centre on extrude axis (Z) like BoxGeometry
    geo.translate(0, 0, -deep * SCALE * 0.5);
    const mesh = new THREE.Mesh(geo, makeSteelMaterial(col, opac ?? 0.95));
    mesh.add(makeEdgeOverlay(geo, 30, 0.3));
    mesh.userData.ifcPartKind = p.partKind || 'web';
    mesh.userData.ifcSlopeDeg = p.slopeDeg || 0;
    mesh.userData.ifcThicknessMm = deep;
    return mesh;
  }

  function resolvePartShape(p) {
    const t = String(p.ifcType || '').toUpperCase();
    const nm = `${p.name || ''} ${p.profileDesc || ''}`.toUpperCase();
    const prof = String(p.profileDesc || '');
    // Profile / shape family wins — L-angle & flange brace must NOT become plate wafers
    let skEarly = p.shapeKey
      || (typeof detectFromDescription === 'function'
        ? detectFromDescription(prof)?.shape : null)
      || (typeof detectFromName === 'function'
        ? detectFromName(`${p.name || ''} ${prof}`)?.shape : null);
    if (skEarly === 'l_angle'
        || /FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE/i.test(nm)
        || /^\s*L\s*\d/i.test(prof) || /\bL\d{2,}X\d/i.test(prof))
      return 'l_angle';

    // Tekla plate-built marks (rafter drawing: FL####, WB####, PL####, EP####, BP####)
    // Bare FLANGE / FL#### only — not "FLANGE BRACE"
    if (/\bFL\d|\bWB\d|\bWEB\b|\bPL\d|\bEP\d|\bBP\d|\bST\d|SGP|SSP|SWC|STIFFENER|\bSTIFF\b|END_?PLT/.test(nm)
        || (/\bFLANGE\b/.test(nm) && !/BRACE/.test(nm)))
      return 'plate';
    if (t.includes('PLATE') && skEarly !== 'l_angle') return 'plate';

    const rolled = /IPE|HEA|HEB|UB\s*\d|UC\s*\d/i.test(p.profileDesc || '');
    if (rolled) return 'i_beam';

    let sk = skEarly || p.shapeKey || (detectFromDescription(p.profileDesc)?.shape) || null;
    if (sk === 'plate') return 'plate';
    if (sk === 'i_beam' && !/\bFL\d|\bWB\d/.test(nm)) return 'i_beam';

    // Plate-built assembly (has FL+WB or FL+stiff): remaining members are plates
    const parts = it.parts || [];
    const hasFl = parts.some(q => /\bFL\d|FLANGE/i.test(`${q.name||''} ${q.profileDesc||''}`));
    const hasWb = parts.some(q => /\bWB\d|\bWEB\b/i.test(`${q.name||''} ${q.profileDesc||''}`));
    const hasStiff = parts.some(q =>
      /\bPL\d|\bEP\d|\bBP\d|SSP|SWC|STIFFENER|\bSTIFF\b/i.test(`${q.name||''} ${q.profileDesc||''}`));
    if ((hasFl && hasWb) || (hasFl && hasStiff)) return 'plate';

    if (!sk || sk === 'unknown') {
      if (t.includes('BEAM') || t.includes('COLUMN') || t.includes('MEMBER')) sk = 'i_beam';
    }
    if (!sk || sk === 'unknown') {
      sk = detectFromName(p.name)?.shape
        || detectFromName(it.assemblyName)?.shape
        || detectFromName(it.mark)?.shape
        || null;
    }
    // Do not force RAFTER name → i_beam when this is a plate-built assembly
    if (sk === 'i_beam' && (hasFl || hasWb)) return 'plate';
    return sk;
  }

  function partExtents(p) {
    const bx = Math.max(p.boxXMm || 0, 0);
    const by = Math.max(p.boxYMm || 0, 0);
    const bz = Math.max(p.boxZMm || 0, 0);
    return [bx, by, bz].filter(v => v > 0).sort((a, b) => b - a);
  }

  function partBeamDims(p) {
    const ext = partExtents(p);
    const L = Math.max(p.lengthMm || 0, ext[0] || 10);
    const H = (p.sectH > 0) ? p.sectH
            : (ext[1] || p.heightMm || 100);
    const W = (p.sectW > 0) ? p.sectW
            : (ext[2] || ext[1] || p.widthMm || Math.max(H * 0.4, 50));
    return { L, H, W };
  }

  function partPlateDims(p) {
    const bx = Math.max(p.boxXMm || 0, 1);
    const by = Math.max(p.boxYMm || 0, 1);
    const bz = Math.max(p.boxZMm || 0, 1);
    const t = Math.min(bx, by, bz);
    const others = [bx, by, bz].filter(v => Math.abs(v - t) > 0.5).sort((a, b) => b - a);
    return {
      L: others[0] || Math.max(p.lengthMm || 0, 10),
      W: others[1] || others[0] || Math.max(p.widthMm || 0, 10),
      T: Math.max(t, p.sectT || p.sectH || 2),
    };
  }

  /** Align makeShape extrusion (+X) with the part's longest Three-space AABB axis. */
  function orientAlongLongBox(mesh, p) {
    const bx = p.boxXMm || 0, by = p.boxYMm || 0, bz = p.boxZMm || 0;
    if (by >= bx && by >= bz) mesh.rotation.z += Math.PI / 2;
    else if (bz >= bx && bz >= by) mesh.rotation.y += -Math.PI / 2;
  }

  function applyIfcTransform(mesh, p) {
    const t = p.transform;
    if (!p.hasIfcTransform || !Array.isArray(t) || t.length < 16) return false;
    const m = new THREE.Matrix4();
    const e = t.map(Number);
    e[12] *= SCALE; e[13] *= SCALE; e[14] *= SCALE;
    m.fromArray(e);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(m);
    mesh.updateMatrixWorld(true);
    return true;
  }

  function makeMeshFromXbim(p, col, opac) {
    const pos = p.meshPositionsMm;
    const idx = p.meshIndices;
    if (!Array.isArray(pos) || pos.length < 9 || !Array.isArray(idx) || idx.length < 3) return null;
    const arr = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i++) arr[i] = (+pos[i] || 0) * SCALE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geo.setIndex(idx.map(n => n | 0));
    geo.computeVertexNormals();
    const mat = makeSteelMaterial(col, opac ?? 0.95);
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.add(makeEdgeOverlay(geo, 30, 0.3));
    mesh.userData.ifcPartKind = p.partKind || 'other';
    mesh.userData.xbimMesh = true;
    return mesh;
  }

  // Exact IFC geometry per part (shape / angle / size). Packing uses assembly AABB only.
  for (const p of parts) {
    const shapeKey = resolvePartShape(p);
    const ox = (p.offsetXMm || 0) * SCALE;
    const oy = (p.offsetYMm || 0) * SCALE;
    const oz = (p.offsetZMm || 0) * SCALE;
    const hasXf = !!(p.hasIfcTransform && Array.isArray(p.transform) && p.transform.length >= 16);

    let mesh = null;

    // Prefer xBIM tessellation ONLY for non-L parts. L / flange brace xBIM
    // meshes are thin wafer stacks (IFC sweep tessellation) — use analytic L.
    if (shapeKey !== 'l_angle')
      mesh = makeMeshFromXbim(p, color, opacity);

    if (!mesh && shapeKey === 'i_beam') {
      const { L, H, W } = partBeamDims(p);
      const sect = {
        shapeKey: 'i_beam',
        sectH: p.sectH || H,
        sectW: p.sectW || W,
        sectTf: p.sectTf || 0,
        sectTw: p.sectTw || 0,
      };
      mesh = makeIBeam(L, H, W, color, opacity, sect);
      if (!hasXf) orientAlongLongBox(mesh, p);
    } else if (!mesh && shapeKey === 'c_channel') {
      const { L, H, W } = partBeamDims(p);
      mesh = makeChannel(L, p.sectH || H, p.sectW || W, color, opacity, {
        shapeKey: 'c_channel', sectH: p.sectH || H, sectW: p.sectW || W,
        sectT: p.sectT || 0, sectD: p.sectD || 0,
      });
      if (!hasXf) {
        mesh.rotation.x = Math.PI / 2;
        orientAlongLongBox(mesh, p);
      }
    } else if (!mesh && shapeKey === 'z_channel') {
      const { L, H, W } = partBeamDims(p);
      mesh = makeZChannel(L, p.sectH || H, p.sectW || W, color, opacity, {
        shapeKey: 'z_channel', sectH: p.sectH || H, sectW: p.sectW || W,
        sectT: p.sectT || 0, sectD: p.sectD || 0,
      });
      if (!hasXf) orientAlongLongBox(mesh, p);
    } else if (!mesh && shapeKey === 'plate') {
      // Web-first: prefer IFC extruded face profile (size / taper / thickness)
      mesh = makePlateFromIfcProfile(p, color, opacity);
      if (!mesh && hasXf) {
        if (isRafterOrColumnAsm) {
          const { L, H, W } = dimsWithCorrectThickness(p);
          mesh = makeBox(L, H, W, color, opacity);
        } else {
          mesh = makeBox(
            Math.max(p.lengthMm || 1, 1),
            Math.max(p.heightMm || 1, 1),
            Math.max(p.widthMm || 1, 1),
            color, opacity);
        }
      } else if (!mesh) {
        const bx = Math.max(p.boxXMm || 0, 0);
        const by = Math.max(p.boxYMm || 0, 0);
        const bz = Math.max(p.boxZMm || 0, 0);
        const tPrefer = resolvePlateThicknessMm(p)
          || Math.max(p.sectT || 0, p.sectH > 0 && p.sectH <= 80 ? p.sectH : 0);
        if (bx > 0.5 && by > 0.5 && bz > 0.5) {
          let sx = bx, sy = by, sz = bz;
          if (tPrefer > 0.5) {
            const dims = [
              { k: 'x', v: sx }, { k: 'y', v: sy }, { k: 'z', v: sz }
            ].sort((a, b) => a.v - b.v);
            if (dims[0].v > 0) {
              if (dims[0].k === 'x') sx = tPrefer;
              else if (dims[0].k === 'y') sy = tPrefer;
              else sz = tPrefer;
            }
          }
          mesh = makeBox(sx, sy, sz, color, opacity);
        } else if (isRafterOrColumnAsm) {
          const { L, H, W } = dimsWithCorrectThickness(p);
          mesh = makeBox(L, H, W, color, opacity);
        } else {
          const { L, W, T } = partPlateDims(p);
          mesh = makeBox(L, Math.max(T, tPrefer || T), W, color, opacity);
        }
      }
    } else if (!mesh && (shapeKey === 'l_angle' || shapeKey === 'rhs' || shapeKey === 'rod')) {
      const { L, H, W } = partBeamDims(p);
      const childIt = {
        _assemblyChild: true,
        profileShape: shapeKey, shapeKey,
        sectH: p.sectH || H, sectW: p.sectW || W, sectT: p.sectT || 0,
        lengthMm: L, widthMm: W, heightMm: H,
        unitHeight: H, unitWidth: W, qty: 1, category: it.category || 'other',
      };
      try { mesh = makeShape(childIt, color, opacity); } catch (_) { mesh = null; }
      if (mesh && !hasXf) orientAlongLongBox(mesh, p);
    }

    if (!mesh) {
      const t = String(p.ifcType || '').toUpperCase();
      const nm = `${p.name || ''} ${p.profileDesc || ''}`;
      const plateBuilt = /\bFL\d|FLANGE|\bWB\d|\bWEB\b|\bPL\d|\bEP\d|\bBP\d|\bST\d|SGP|SSP|SWC|STIFFENER/i.test(nm)
        || t.includes('PLATE')
        || (it.parts || []).some(q =>
            /\bFL\d|\bWB\d/i.test(`${q.name||''} ${q.profileDesc||''}`));
      if (plateBuilt || shapeKey === 'plate') {
        mesh = makePlateFromIfcProfile(p, color, opacity);
        if (!mesh && hasXf) {
          if (isRafterOrColumnAsm) {
            const { L, H, W } = dimsWithCorrectThickness(p);
            mesh = makeBox(L, H, W, color, opacity);
          } else {
            mesh = makeBox(
              Math.max(p.lengthMm || 1, 1),
              Math.max(p.heightMm || 1, 1),
              Math.max(p.widthMm || 1, 1),
              color, opacity);
          }
        } else if (!mesh) {
          if (isRafterOrColumnAsm) {
            const { L, H, W } = dimsWithCorrectThickness(p);
            mesh = makeBox(L, H, W, color, opacity);
          } else {
            const bx = Math.max(p.boxXMm || 0, 1);
            const by = Math.max(p.boxYMm || 0, 1);
            const bz = Math.max(p.boxZMm || 0, 1);
            mesh = makeBox(bx, by, bz, color, opacity);
          }
        }
      } else if (t.includes('BEAM') || t.includes('COLUMN') || t.includes('MEMBER')
          || /RAFTER|COLUMN|BEAM/.test(String(it.assemblyName || '').toUpperCase())) {
        const { L, H, W } = partBeamDims(p);
        mesh = makeIBeam(L, H, W, color, opacity, { shapeKey: 'i_beam', sectH: H, sectW: W });
        if (!hasXf) orientAlongLongBox(mesh, p);
      } else {
        const { L, W, T } = partPlateDims(p);
        mesh = makeBox(L, T, W, color, opacity);
      }
    }

    if (!mesh) continue;
    group.add(mesh);
    if (mesh.userData && mesh.userData.xbimMesh) {
      // xBIM verts already assembly-relative (exact IFC pose/size/angle) — no offset snap
      mesh.updateMatrix();
    } else if (!applyIfcTransform(mesh, p)) {
      mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(mesh);
      const c = new THREE.Vector3();
      bb.getCenter(c);
      mesh.position.x += ox - c.x;
      mesh.position.y += oy - c.y;
      mesh.position.z += oz - c.z;
      mesh.updateMatrix();
    }
    // Rafter/column: CUT web overhang only when not using exact xBIM mesh
    if (isRafterOrColumnAsm && isWebP(p) && !(mesh.userData && mesh.userData.xbimMesh)) {
      const fls = parts.filter(isFlangeP);
      if (fls.length >= 2) cutWebToFlangeGap(mesh, p, fls);
    }
  }

  recenterGroupAabb(group);
  return group;
}

// ── Generic bundle helper (L-angle, RHS, I-beam grid, etc.) ─────────────────
// Each piece is a real extruded cross-section placed at its own grid slot.
function makeShapeBundle(shapeFn, it, color, opacity) {
  const group = new THREE.Group();
  const cols = it.gridCols, rows = it.gridRows;
  const unitH = it.unitHeight || it.heightMm, unitW = it.unitWidth || it.widthMm;

  const stepY = unitH * SCALE;
  const stepZ = unitW * SCALE;
  const totalH = rows * stepY;
  const totalW = cols * stepZ;
  const totalToShow = Math.min(it.qty, 100);

  let placed = 0;
  outer: for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (placed >= totalToShow) break outer;
      const posY = i * stepY + stepY / 2 - totalH / 2;
      const posZ = j * stepZ + stepZ / 2 - totalW / 2;
      const piece = shapeFn(it.lengthMm, unitH, unitW, color, opacity);
      piece.position.y = posY;
      piece.position.z = posZ;
      group.add(piece);
      placed++;
    }
  }
  return group;
}

// ── Z-purlin nested bundle (yard nest: same direction, flange-on-flange) ──
//
// Same thickness only (2.5 / 2.0 / 1.5 are separate sets). Mixed length OK:
// longest first, each next piece nests by ~wall thickness (touch, no dig-in).
function makeZPurlinBundle(it, color, opacity) {
  const group = new THREE.Group();
  const l = it.lengthMm || it.l || 1000;

  // Build piece list or fall back to identical qty
  let pieces = [];
  if (it.nestPieces && it.nestPieces.length) {
    it.nestPieces.forEach(np => {
      const n = Math.max(1, np.qty || 1);
      for (let i = 0; i < n; i++) pieces.push({ ...np, qty: 1 });
    });
  } else {
    const qty = it.qty || 1;
    const Hmm = it.sectH > 0 ? it.sectH : (it.unitHeight || it.heightMm);
    const Wmm = it.sectW > 0 ? it.sectW : (it.unitWidth || it.widthMm);
    for (let i = 0; i < qty; i++) {
      pieces.push({
        sectH: Hmm, sectW: Wmm, sectT: it.sectT || 0, sectD: it.sectD || 0,
        lengthMm: l, qty: 1
      });
    }
  }
  // Keep one thickness per nest (grouping/pack should already split; guard here)
  if (pieces.length > 1) {
    const tTol = 0.15;
    const t0 = Number(pieces[0].sectT) || Number(it.sectT) || 0;
    if (t0 > 0) {
      const sameT = pieces.filter(p => {
        const t = Number(p.sectT) || 0;
        return !(t > 0) || Math.abs(t - t0) <= tTol;
      });
      if (sameT.length < pieces.length) {
        try {
          console.warn(
            `[Z-bundle] dropping ${pieces.length - sameT.length} pcs with different thickness`
            + ` (keep T≈${t0})`
          );
        } catch (_) { /* */ }
        pieces = sameT;
      }
    }
  }
  // Longest first (outside). Show FULL pack-unit — Step7 already caps SET_SIZE
  // (INTERLOCK up to 16). Never silently drop pieces (old hard-cap was 12).
  pieces.sort((a, b) => (b.lengthMm || 0) - (a.lengthMm || 0)
    || (b.sectH || 0) - (a.sectH || 0));
  const SOFT_MAX = 24; // above Step7 max (HEX 18 / INTERLOCK 16)
  if (pieces.length > SOFT_MAX) {
    try {
      console.warn(`[Z-bundle] capping display ${pieces.length} → ${SOFT_MAX} (pack unit oversized)`);
    } catch (_) { /* */ }
    pieces = pieces.slice(0, SOFT_MAX);
  }

  // Single column only — never multi-col sprawl inside a set
  const columns = [[]];
  for (const piece of pieces) {
    const sect = {
      shapeKey: 'z_channel',
      sectH: piece.sectH, sectW: piece.sectW,
      sectT: piece.sectT, sectD: piece.sectD
    };
    const dims = _sdim(sect, piece.sectH, piece.sectW || piece.sectH * 0.32, 'z_channel');
    const step = dims.t;
    const c = columns[0];
    if (c.length === 0) c.baseH = dims.H;
    c.push({ piece, sect, dims, step, k: c.length });
  }

  // Step6/stability: POSITION + rigid group pose only — makeZChannel never rebuilt
  const nestInfo = (typeof resolveNestingInfo === 'function')
    ? resolveNestingInfo(it)
    : (it.nestingInfo || null);
  const nestOffMm = (nestInfo && nestInfo.nesting_offset > 0)
    ? nestInfo.nesting_offset
    : (it.nestingOffsetMm > 0 ? it.nestingOffsetMm : 0);
  const isInterlock = !!(nestInfo && nestInfo.method === 'INTERLOCK_NEST');
  const nestMode = (typeof chooseStableNestMode === 'function')
    ? chooseStableNestMode(it, columns[0].length)
    : (isInterlock ? 'collision_flip' : 'diagonal_same');
  // Never strip nest roll — Group-By nested Z look REQUIRES nesting_angle / offsets.
  const skipNestRoll = false;

  // Rest-pose CoG stability applied once in makeShape → ensureStableShape
  function finishStable(g) {
    recenterGroupAabb(g);
    return g;
  }

  // ── TRUE INTERLOCK: collision-fit + mandatory alternate 180° ───────────
  if (isInterlock && nestMode === 'collision_flip'
      && typeof computeInterlockWorldYPlacements === 'function') {
    const col = columns[0];
    if (!col.length) return group;
    const fit = computeInterlockWorldYPlacements(it, col.length);
    const H0 = col[0].baseH || col[0].dims.H;
    const W0 = col[0].dims.W;
    const bundleHmm = fit.bundle_height_mm > 0
      ? fit.bundle_height_mm
      : (H0 / SCALE);
    const bundleWmm = fit.bundle_width_mm > 0
      ? fit.bundle_width_mm
      : (W0 / SCALE);
    const bundleH = bundleHmm * SCALE;
    const bundleW = bundleWmm * SCALE;
    const allowFlip = !!(it.nestMethod?.alternate_flip
      || nestInfo?.alternate_flip
      || it.csAnalysis?.can_flip);
    col.forEach((slot, k) => {
      const H = slot.dims.H;
      const W = slot.dims.W;
      const plen = slot.piece.lengthMm || l;
      const mesh = makeZChannel(
        plen, slot.piece.sectH, slot.piece.sectW || slot.piece.sectH * 0.32,
        color, opacity, slot.sect
      );
      const pl = fit.placements[k] || {
        y_offset_mm: k * (nestOffMm || 0),
        z_offset_mm: 0,
        flip: allowFlip && (k % 2) === 1,
      };
      const flip = allowFlip && !!(pl.flip || (k % 2) === 1);
      mesh.position.y = -bundleH / 2 + H / 2 + (pl.y_offset_mm || 0) * SCALE;
      mesh.position.z = -bundleW / 2 + W / 2 + (pl.z_offset_mm || 0) * SCALE;
      if (flip) mesh.rotation.x += Math.PI;
      // Nesting Angle: two-point ground (Step3) — OFF when packing Group-By bundle
      const nestRoll = skipNestRoll
        ? 0
        : (Number(it.orientation_info?.nesting_angle_rad) || 0);
      if (Math.abs(nestRoll) > 1e-5) mesh.rotation.x += nestRoll;
      mesh.userData.nestFlip = flip;
      group.add(mesh);
    });
    if (typeof refineInterlockNestGroup === 'function')
      refineInterlockNestGroup(group, it);
    else recenterGroupAabb(group);
    return finishStable(group);
  }

  // Z nest stack — along tilted nest axis when Step7 provides it (leveled web).
  // Each piece keeps two-point ground pose; offset is NOT pure AABB horizontal.
  {
    let bundleW = 0, bundleH = 0;
    const gap = 0.04;
    const clearMm = (nestInfo && nestInfo.clearance_mm != null)
      ? nestInfo.clearance_mm : 3;
    const tWorld = columns[0][0]?.dims.t || 0;
    const stackStepMm = (tWorld / SCALE) + clearMm;
    const step0 = nestOffMm > 0
      ? nestOffMm * SCALE
      : Math.max(stackStepMm, 0.5) * SCALE;
    // Keep Group-By nest offsets (tilted axis / step). Only tip-joint ROLL is skipped.
    const useTilt = !!(nestInfo && nestInfo.use_tilted_nest_axis);
    const axis = useTilt ? (Number(nestInfo.nest_axis_angle_rad) || 0) : 0;
    const stepY = useTilt ? step0 * Math.cos(axis) : step0;
    const stepZ = useTilt ? step0 * Math.sin(axis) : 0;
    const nestRoll = skipNestRoll
      ? 0
      : ((typeof calculateZNestingAngle === 'function'
        && it.orientation_info?.nesting_angle_rad != null)
        ? Number(it.orientation_info.nesting_angle_rad) || 0
        : 0);

    columns.forEach((col, si) => {
      if (!col.length) return;
      const W0 = col[0].dims.W;
      const H0 = col[0].dims.H;
      const colW = W0 + Math.max(0, col.length - 1) * Math.abs(stepZ);
      const colH = H0 + Math.max(0, col.length - 1) * Math.abs(stepY);
      bundleH = Math.max(bundleH, colH);
      bundleW += colW + (si > 0 ? gap : 0);
    });

    let xOff = -bundleW / 2;
    columns.forEach((col) => {
      if (!col.length) return;
      const W0 = col[0].dims.W;
      const H0 = col[0].baseH || col[0].dims.H;
      const colW = W0 + Math.max(0, col.length - 1) * Math.abs(stepZ);
      const baseZ = xOff + W0 / 2;
      col.forEach((slot, k) => {
        const H = slot.dims.H;
        const plen = slot.piece.lengthMm || l;
        const mesh = makeZChannel(
          plen, slot.piece.sectH, slot.piece.sectW || slot.piece.sectH * 0.32,
          color, opacity, slot.sect
        );
        if (Math.abs(nestRoll) > 1e-5) mesh.rotation.x += nestRoll;
        mesh.position.y = -bundleH / 2 + H / 2 + k * stepY;
        mesh.position.z = baseZ + k * stepZ;
        group.add(mesh);
      });
      xOff += colW + gap;
    });
    recenterGroupAabb(group);
    return finishStable(group);
  }
}

// A bundle of N identical I-beams arranged in a rows × cols grid, each
// beam a real I-section extrusion. When qty is small this looks like a
// simple vertical stack; larger qtys become multiple columns of stacks
// (matching how a container-load of identical rafters actually ships).
function makeBeamBundle(l, unitH, unitW, cols, rows, qty, color, opacity, sect) {
  const group = new THREE.Group();
  const totalToShow = Math.min(qty, 60);
  const stepY = unitH * SCALE;
  const stepZ = unitW * SCALE;
  const totalH = rows * stepY;
  const totalW = cols * stepZ;

  let placed = 0;
  outer: for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (placed >= totalToShow) break outer;
      const beam = makeIBeam(l, unitH, unitW, color, opacity, sect);
      beam.position.y = i * stepY + stepY/2 - totalH/2;
      beam.position.z = j * stepZ + stepZ/2 - totalW/2;
      group.add(beam);
      placed++;
    }
  }
  return group;
}

// ------------------------------------------------------------------
// DATA HELPERS
// ------------------------------------------------------------------
