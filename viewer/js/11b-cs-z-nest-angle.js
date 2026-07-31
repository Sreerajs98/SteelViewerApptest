/* 11b-cs-z-nest-angle.js — Live tip+joint ground roll (OPEN concave profiles)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  GOAL                                                                ║
 * ║  • Rigid roll about +X only — no ExtrudeGeometry morph               ║
 * ║  • Level TWO contact points onto ground (tip + web joint)            ║
 * ║  • Trigger = GEOMETRY (OPEN + deep concavity) — NEVER profile name   ║
 * ║  • Physics score only — no viewer cosmetic angle bias                ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const CSNZ_EDGE_MIN_MM = 1.0;
/** Deep open profiles need tip+joint sit (matches Step2 "deep" class). */
const CSNZ_LIVE_CONCAVITY_MIN = 0.15;

/**
 * RULE 1 Stage-2 gate — GEOMETRY ONLY (no shapeKey / mark / profileDesc).
 * OPEN + concavity_ratio > threshold → live tip+joint ground search.
 */
function requiresLiveRotateSearch(it) {
  if (!it) return false;
  if (!it.crossSection && typeof extractCrossSection === 'function') {
    try { extractCrossSection(it); } catch (_) { /* */ }
  }
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function') {
    try { analyzeCrossSection(it); } catch (_) { /* */ }
  }
  const an = it.csAnalysis || {};
  const cs = it.crossSection || {};
  const openClosed = String(an.open_closed || cs.open_closed || '').toLowerCase();
  const profileType = String(an.profile_type || '').toUpperCase();
  const isOpen = openClosed === 'open' || profileType === 'OPEN';
  if (!isOpen) return false;
  const conc = Number(an.concavity_ratio != null ? an.concavity_ratio : cs.concavity_ratio);
  if (!isFinite(conc)) return false;
  return conc > CSNZ_LIVE_CONCAVITY_MIN;
}

/**
 * @deprecated Alias — now geometry-based (requiresLiveRotateSearch).
 * Do NOT add name/mark checks here.
 */
function csNzIsZShape(it) {
  return requiresLiveRotateSearch(it);
}

function csNzNormPi(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

function csNzDeg(rad) {
  return (rad * 180) / Math.PI;
}

function csNzPts(outerPoints) {
  const pts = (outerPoints || []).map(p => [
    Number(Array.isArray(p) ? p[0] : p.x) || 0,
    Number(Array.isArray(p) ? p[1] : p.y) || 0,
  ]);
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  }
  return pts;
}

/** y after rotateX: y' = v cos θ − u sin θ  (u≈section-x, v≈section-y) */
function csNzRotY(u, v, theta) {
  return v * Math.cos(theta) - u * Math.sin(theta);
}

/**
 * Physics score: tip+joint same Y and both on global minY.
 * NO cosmetic deg bias.
 */
function csNzContactScore(gap, floatSum) {
  return -(gap * 20 + floatSum * 10);
}

/**
 * Synthetic open-channel polygon from sect dims (fallback when outer_points missing).
 * Dims only — not name-based.
 */
function csNzMakeZChannelPolyMm(it) {
  const Hmm = Math.max(Number(it?.sectH) || Number(it?.heightMm) || 200, 40);
  const Wmm = Math.max(Number(it?.sectW) || Math.round(Hmm * 0.32), 20);
  const Tmm = Math.max(Number(it?.sectT) || Hmm * 0.012, 0.8);
  const Dmm = Number(it?.sectD) > 0 ? Number(it.sectD) : Hmm * 0.085;
  const SCALE = 0.001;
  const H = Math.max(Hmm * SCALE, 0.04);
  const W = Math.max(Wmm * SCALE, 0.03);
  let t = Math.max(Tmm * SCALE, 0.0015);
  t = Math.min(t, W * 0.35);
  const D = Math.max(Dmm * SCALE, 0);
  const hh = H / 2, fw = W;
  const lipH = D > 0 ? Math.min(D, H * 0.30) : 0;
  const a = (55 * Math.PI) / 180;
  const sa = Math.sin(a), ca = Math.cos(a);
  const lipX = lipH > 0 ? Math.min(lipH * (ca / sa), W * 0.45) : 0;
  const nxT = t * sa, nyT = -t * ca;
  const nxB = -t * sa, nyB = t * ca;
  const pts = [];
  const P = (x, y) => pts.push([x, y]);
  P(t / 2, hh);
  P(-fw, hh);
  if (lipH > 0) {
    P(-fw - lipX, hh - lipH);
    P(-fw - lipX + nxT, hh - lipH + nyT);
    P(-fw + t, hh - t);
  } else {
    P(-fw + t, hh - t);
  }
  P(-t / 2, hh - t);
  P(-t / 2, -hh);
  P(fw, -hh);
  if (lipH > 0) {
    P(fw + lipX, -hh + lipH);
    P(fw + lipX + nxB, -hh + lipH + nyB);
    P(fw - t, -hh + t);
  } else {
    P(fw - t, -hh + t);
  }
  P(t / 2, -hh + t);
  return pts.map(([x, y]) => [x / SCALE, y / SCALE]);
}

/**
 * Identify flange tip + flange–web joint contact pairs (left/right).
 */
function csNzTipJointPairsFromPoly(ptsIn) {
  const pts = csNzPts(ptsIn);
  if (pts.length < 4) return [];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  pts.forEach(p => {
    if (p[0] < minU) minU = p[0];
    if (p[0] > maxU) maxU = p[0];
    if (p[1] < minV) minV = p[1];
    if (p[1] > maxV) maxV = p[1];
  });

  const topTip = pts.filter(p => p[1] >= (minV + maxV) / 2)
    .reduce((b, p) => (!b || p[0] < b[0] ? p : b), null);
  const botTip = pts.filter(p => p[1] <= (minV + maxV) / 2)
    .reduce((b, p) => (!b || p[0] > b[0] ? p : b), null);

  const botBand = pts.filter(p => p[1] <= minV + Math.max((maxV - minV) * 0.05, 2));
  const botWebJoint = botBand.slice().sort((a, b) => a[0] - b[0])[0];
  const topBand = pts.filter(p => p[1] >= maxV - Math.max((maxV - minV) * 0.05, 2));
  const topWebJoint = topBand.slice().sort((a, b) => b[0] - a[0])[0];

  const pairs = [];
  const add = (tip, joint, label) => {
    if (!tip || !joint) return;
    if (Math.hypot(tip[0] - joint[0], tip[1] - joint[1]) < CSNZ_EDGE_MIN_MM) return;
    pairs.push({
      tip: [tip[0], tip[1]],
      joint: [joint[0], joint[1]],
      label,
    });
  };
  add(topTip, botWebJoint, 'leftTip_rightWebJoint');
  add(botTip, topWebJoint, 'rightTip_leftWebJoint');
  return pairs;
}

/**
 * Option 2 — direct geometric angle: level tip→joint line onto horizontal.
 * csNzRotY is CLOCKWISE by θ: y' = v·cosθ − u·sinθ
 * → θ = +atan2(Δv, Δu) puts AB on a constant-Y line. Also try θ+π.
 */
function csNzDirectTipJointAngle(ptsIn) {
  const pts = csNzPts(ptsIn);
  const pairs = csNzTipJointPairsFromPoly(pts);
  if (!pts.length || !pairs.length) return null;

  let best = null;
  for (const pair of pairs) {
    const du = pair.joint[0] - pair.tip[0];
    const dv = pair.joint[1] - pair.tip[1];
    const base = Math.atan2(dv, du);
    const trials = [base, base + Math.PI, base - Math.PI];
    for (let ti = 0; ti < trials.length; ti++) {
      const th = csNzNormPi(trials[ti]);
      let minY = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const y = csNzRotY(pts[i][0], pts[i][1], th);
        if (y < minY) minY = y;
      }
      const yT = csNzRotY(pair.tip[0], pair.tip[1], th);
      const yJ = csNzRotY(pair.joint[0], pair.joint[1], th);
      const gap = Math.abs(yT - yJ);
      const floatSum = (yT - minY) + (yJ - minY);
      const score = csNzContactScore(gap, floatSum);
      if (!best || score > best.score) {
        best = {
          nesting_angle: th,
          deg: csNzDeg(th),
          score,
          gap,
          floatSum,
          tip: pair.tip,
          joint: pair.joint,
          label: pair.label,
          source: 'direct_atan2',
        };
      }
    }
  }
  return best;
}

/**
 * Evaluate contact score at angle θ (degrees) for a fixed tip/joint pair.
 */
function csNzEvalPairAtDeg(pts, pair, deg) {
  const th = (deg * Math.PI) / 180;
  let minY = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const y = csNzRotY(pts[i][0], pts[i][1], th);
    if (y < minY) minY = y;
  }
  const yT = csNzRotY(pair.tip[0], pair.tip[1], th);
  const yJ = csNzRotY(pair.joint[0], pair.joint[1], th);
  const gap = Math.abs(yT - yJ);
  const floatSum = (yT - minY) + (yJ - minY);
  return {
    nesting_angle: th,
    deg,
    score: csNzContactScore(gap, floatSum),
    gap,
    floatSum,
    tip: pair.tip,
    joint: pair.joint,
    label: pair.label,
  };
}

/**
 * LIVE rotate: direct atan2 seed + local refine (physics score only).
 * Falls back to coarse ±180° search if direct seed missing.
 */
function csNzLiveRotateFindGroundAngle(ptsIn) {
  const pts = csNzPts(ptsIn);
  const pairs = csNzTipJointPairsFromPoly(pts);
  if (!pts.length || !pairs.length) return null;

  let best = csNzDirectTipJointAngle(pts);

  // Local refine around direct seed (±5°), then fine ±0.2°
  if (best) {
    const pair = { tip: best.tip, joint: best.joint, label: best.label };
    for (let deg = best.deg - 5; deg <= best.deg + 5; deg += 0.1) {
      const hit = csNzEvalPairAtDeg(pts, pair, deg);
      if (hit.score > best.score) best = { ...hit, source: 'direct_refine' };
    }
    for (let deg = best.deg - 0.2; deg <= best.deg + 0.2; deg += 0.02) {
      const hit = csNzEvalPairAtDeg(pts, pair, deg);
      if (hit.score > best.score) best = { ...hit, source: 'direct_fine' };
    }
    return best;
  }

  // Full search fallback (physics only — no deg bias)
  for (const pair of pairs) {
    for (let deg = -180; deg <= 180; deg += 0.25) {
      const hit = csNzEvalPairAtDeg(pts, pair, deg);
      if (!best || hit.score > best.score) best = { ...hit, source: 'search' };
    }
  }
  if (!best) return null;
  const pair = { tip: best.tip, joint: best.joint, label: best.label };
  for (let deg = best.deg - 0.5; deg <= best.deg + 0.5; deg += 0.02) {
    const hit = csNzEvalPairAtDeg(pts, pair, deg);
    if (hit.score > best.score) best = { ...hit, source: 'search_fine' };
  }
  return best;
}

/**
 * Nesting angle from LIVE/direct rotate on CS outer polygon (or sect fallback).
 */
function calculateZNestingAngle(outerPoints, it) {
  const empty = {
    ok: false,
    nesting_angle_rad: 0,
    nesting_angle_deg: 0,
    nest_axis_angle_rad: 0,
    nest_axis_angle_deg: 0,
    flange_web_angle_rad: Math.PI / 2,
    flange_web_angle_deg: 90,
    web_tilt_rad: 0,
    web_tilt_deg: 0,
    contact_a: null,
    contact_b: null,
    source: 'empty',
  };

  // Prefer real Step1 outer_points (any OPEN concave profile)
  let pts = csNzPts(outerPoints);
  if (pts.length < 4 && it?.crossSection?.outer_points)
    pts = csNzPts(it.crossSection.outer_points);
  if (pts.length < 4 && it && typeof extractCrossSection === 'function') {
    try {
      const cs = it.crossSection || extractCrossSection(it);
      if (cs?.outer_points) pts = csNzPts(cs.outer_points);
    } catch (_) { /* */ }
  }
  // Last resort: synthetic channel from sect dims (geometry dims, not names)
  if (pts.length < 4 && it && (it.sectH || it.heightMm) && (it.sectW || it.widthMm)) {
    try { pts = csNzMakeZChannelPolyMm(it); } catch (_) { pts = null; }
  }
  if (!pts || pts.length < 4) return empty;

  const hit = csNzLiveRotateFindGroundAngle(pts);
  if (!hit) return empty;

  const nesting_angle = csNzNormPi(hit.nesting_angle);
  const webAng = Math.PI / 2;
  const web_after = csNzNormPi(webAng + nesting_angle);
  let web_tilt = csNzNormPi(web_after - Math.PI / 2);
  if (Math.abs(web_tilt) > Math.PI / 2) {
    web_tilt = csNzNormPi(web_tilt - Math.sign(web_tilt) * Math.PI);
  }
  const wu = Math.cos(web_after), wv = Math.sin(web_after);
  let nest_axis_world = Math.atan2(wu, wv);
  if (Math.cos(nest_axis_world) < 0)
    nest_axis_world = csNzNormPi(nest_axis_world + Math.PI);

  return {
    ok: true,
    nesting_angle_rad: nesting_angle,
    nesting_angle_deg: +csNzDeg(nesting_angle).toFixed(4),
    nest_axis_angle_rad: nest_axis_world,
    nest_axis_angle_deg: +csNzDeg(nest_axis_world).toFixed(4),
    flange_web_angle_rad: Math.PI / 2,
    flange_web_angle_deg: 90,
    web_tilt_rad: web_tilt,
    web_tilt_deg: +csNzDeg(web_tilt).toFixed(4),
    contact_a: hit.tip,
    contact_b: hit.joint,
    contact_dist: Math.hypot(hit.tip[0] - hit.joint[0], hit.tip[1] - hit.joint[1]),
    contact_gap_mm: +hit.gap.toFixed(4),
    contact_float_mm: +hit.floatSum.toFixed(4),
    contact_label: hit.label,
    live_search_deg: hit.deg,
    source: hit.source || 'live_rotate_tip_joint_ground',
    profile_type: 'OPEN_CONCAVE',
  };
}

function attachZNestingAngleToOrientation(it, orientation_info) {
  if (!requiresLiveRotateSearch(it)) return orientation_info || null;
  const cs = it.crossSection
    || (typeof extractCrossSection === 'function' ? extractCrossSection(it) : null);
  const nest = calculateZNestingAngle(cs?.outer_points, it);
  const oi = orientation_info || it.orientation_info || {};
  oi.profile_type = 'OPEN_CONCAVE';
  oi.nesting_angle_rad = nest.nesting_angle_rad;
  oi.nesting_angle_deg = nest.nesting_angle_deg;
  oi.nest_axis_angle_rad = nest.nest_axis_angle_rad;
  oi.nest_axis_angle_deg = nest.nest_axis_angle_deg;
  oi.flange_web_angle_deg = nest.flange_web_angle_deg;
  oi.web_tilt_deg = nest.web_tilt_deg;
  oi.z_nesting = nest;
  const rn = oi.rotation_needed || { axis: 'none', angle: 0, length_axis: 'X' };
  oi.rotation_needed = {
    ...rn,
    nesting_roll_deg: nest.nesting_angle_deg,
    nesting_roll_rad: nest.nesting_angle_rad,
    nest_axis_angle_rad: nest.nest_axis_angle_rad,
  };
  it.orientation_info = oi;
  if (it.best_orientation) {
    it.best_orientation.nesting_angle_deg = nest.nesting_angle_deg;
    it.best_orientation.nesting_angle_rad = nest.nesting_angle_rad;
    it.best_orientation.nest_axis_angle_rad = nest.nest_axis_angle_rad;
  }
  return oi;
}

/**
 * World AABB from MESH vertex positions only.
 * (setFromObject on a Mesh includes Line edge-children — wrong for ground.)
 */
function csNzMeshWorldBox(obj) {
  if (!obj || typeof THREE === 'undefined') return null;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let any = false;
  obj.updateMatrixWorld(true);
  obj.traverse(ch => {
    if (!ch.isMesh || !ch.geometry) return;
    if (ch.userData && (ch.userData.isMeshEdgeOverlay || ch.userData.skipGroundBox))
      return;
    const pos = ch.geometry.attributes && ch.geometry.attributes.position;
    if (!pos || !pos.count) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      ch.localToWorld(v);
      if (!any) {
        box.min.set(v.x, v.y, v.z);
        box.max.set(v.x, v.y, v.z);
        any = true;
      } else {
        box.expandByPoint(v);
      }
    }
  });
  if (!any) {
    const fallback = new THREE.Box3().setFromObject(obj);
    return isFinite(fallback.min.y) ? fallback : null;
  }
  return box;
}

/**
 * MOVE ONLY (no rotate): translate Y so mesh minY = ground plane.
 */
function csNzSnapObjectToGround(obj) {
  if (!obj || typeof THREE === 'undefined') return null;
  const groundY = (typeof SCENE_GROUND_Y === 'number') ? SCENE_GROUND_Y : 0;
  const keepX = obj.position.x;
  const keepZ = obj.position.z;
  let floor = null;
  let moved = 0;
  for (let pass = 0; pass < 3; pass++) {
    obj.updateMatrixWorld(true);
    const box = csNzMeshWorldBox(obj);
    if (!box || !isFinite(box.min.y)) break;
    const dy = groundY - box.min.y;
    if (Math.abs(dy) > 1e-10) {
      obj.position.y += dy;
      moved += dy;
    }
    obj.position.x = keepX;
    obj.position.z = keepZ;
    obj.updateMatrixWorld(true);
    floor = csNzMeshWorldBox(obj);
    if (floor && Math.abs(floor.min.y - groundY) < 1e-6) break;
  }
  const err = floor ? (floor.min.y - groundY) : null;
  return {
    ok: !!(floor && Math.abs(err) < 1e-4),
    floor_y: floor ? floor.min.y : null,
    minY: floor ? floor.min.y : null,
    moved_y: moved,
    ground_y: groundY,
  };
}

/**
 * Apply tip+joint ground roll, then snap minY→0.
 * Gate: requiresLiveRotateSearch (geometry) — not profile name.
 */
function applyZNestingAngleToObject(obj, it) {
  if (!obj || typeof THREE === 'undefined') return null;
  if (!requiresLiveRotateSearch(it)) return null;
  const keepX = obj.position.x;
  const keepZ = obj.position.z;

  const nest = calculateZNestingAngle(null, it);
  if (it) {
    if (!it.orientation_info) it.orientation_info = {};
    it.orientation_info.z_nesting = nest;
    it.orientation_info.nesting_angle_rad = nest.nesting_angle_rad;
    it.orientation_info.nesting_angle_deg = nest.nesting_angle_deg;
  }
  const ang = Number(nest?.nesting_angle_rad) || 0;

  if (Math.abs(ang) > 1e-5) {
    const qAdd = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), ang);
    obj.quaternion.premultiply(qAdd);
    obj.rotation.setFromQuaternion(obj.quaternion);
  }

  obj.position.x = keepX;
  obj.position.z = keepZ;
  const snap = csNzSnapObjectToGround(obj);

  const info = {
    ok: true,
    applied_rad: ang,
    applied_deg: +csNzDeg(ang).toFixed(4),
    live_search_deg: nest?.live_search_deg,
    contact_a: nest?.contact_a || null,
    contact_b: nest?.contact_b || null,
    contact_label: nest?.contact_label || null,
    contact_gap_mm: nest?.contact_gap_mm,
    contact_float_mm: nest?.contact_float_mm,
    floor_y: snap?.floor_y,
    ground_touch: !!(snap && snap.ok),
    source: nest?.source || 'live_rotate_tip_joint_ground',
    mutates_geometry: false,
  };
  try {
    if (obj.userData) obj.userData.zNestingAngle = info;
    console.info(
      `[live-rotate] roll=${info.applied_deg}° ground=${info.ground_touch}`
      + ` floor_y=${info.floor_y} label=${info.contact_label}`
    );
  } catch (_) { /* */ }
  return info;
}

/** Ground-only snap for open-concave items (pose already correct). */
function snapZItemToGround(obj, it) {
  if (!obj) return null;
  if (it && !requiresLiveRotateSearch(it)) return null;
  return csNzSnapObjectToGround(obj);
}
