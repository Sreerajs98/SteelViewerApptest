/* 00-loading-rules.js — Container Safe-Zone (ops clearance)
 *
 * Spec dims (e.g. 12000×2350×2690) = INTERNAL usable volume (blue box).
 * Pack / drag / collide against an inset envelope — do NOT thicken the mesh.
 *
 * Inner load line: 2.5mm from shell (side / end / top) · Bundle gap 20mm · CoG ≤10%
 */

const LOADING_RULES = {
  WALL_CLEARANCE_SIDE_MM: 2.5,  // left / right — green inner line
  WALL_CLEARANCE_END_MM: 2.5,   // door + closed end
  WALL_CLEARANCE_TOP_MM: 2.5,   // ceiling / header
  FLOOR_CLEARANCE_MM: 0,        // steel on floor / dunnage modeled separately
  MIN_BUNDLE_GAP_MM: 20,        // between separate pack units (not nest offset)
  SKID_HEIGHT_MM: 100,          // timber skid under pack-unit bbox (metadata)
  MAX_COG_OFFSET_FRAC: 0.10,    // soft CoG band (matches UI)
  ALLOW_TOUCHING_WALL: false,
  // ── Rule #1 Floor Anchor Policy (Pass 1 foundation — CoG down) ─────────
  FLOOR_ANCHOR_SUPPORT_MIN: 0.80, // ≥80% bearing on floor / skid / base cargo
  FLOOR_ANCHOR_YAW_LONGITUDINAL_ONLY: true, // 0° / 180° only (no 90° cross-load)
};

/**
 * Effective rules — LOADING_RULES base, overridden by PACK_CONFIG.clearance when present.
 */
function getLoadingRules() {
  const r = {
    WALL_CLEARANCE_SIDE_MM: LOADING_RULES.WALL_CLEARANCE_SIDE_MM,
    WALL_CLEARANCE_END_MM: LOADING_RULES.WALL_CLEARANCE_END_MM,
    WALL_CLEARANCE_TOP_MM: LOADING_RULES.WALL_CLEARANCE_TOP_MM,
    FLOOR_CLEARANCE_MM: LOADING_RULES.FLOOR_CLEARANCE_MM,
    MIN_BUNDLE_GAP_MM: LOADING_RULES.MIN_BUNDLE_GAP_MM,
    SKID_HEIGHT_MM: LOADING_RULES.SKID_HEIGHT_MM,
    MAX_COG_OFFSET_FRAC: LOADING_RULES.MAX_COG_OFFSET_FRAC,
    ALLOW_TOUCHING_WALL: LOADING_RULES.ALLOW_TOUCHING_WALL,
    FLOOR_ANCHOR_SUPPORT_MIN: LOADING_RULES.FLOOR_ANCHOR_SUPPORT_MIN,
    FLOOR_ANCHOR_YAW_LONGITUDINAL_ONLY:
      !!LOADING_RULES.FLOOR_ANCHOR_YAW_LONGITUDINAL_ONLY,
  };
  try {
    if (typeof PACK_CONFIG !== 'undefined' && PACK_CONFIG && PACK_CONFIG.clearance) {
      const c = PACK_CONFIG.clearance;
      if (c.bundle_to_wall_side_mm != null && isFinite(c.bundle_to_wall_side_mm))
        r.WALL_CLEARANCE_SIDE_MM = +c.bundle_to_wall_side_mm;
      else if (c.bundle_to_wall_mm != null && isFinite(c.bundle_to_wall_mm))
        r.WALL_CLEARANCE_SIDE_MM = +c.bundle_to_wall_mm;
      if (c.bundle_to_wall_end_mm != null && isFinite(c.bundle_to_wall_end_mm))
        r.WALL_CLEARANCE_END_MM = +c.bundle_to_wall_end_mm;
      if (c.bundle_to_wall_top_mm != null && isFinite(c.bundle_to_wall_top_mm))
        r.WALL_CLEARANCE_TOP_MM = +c.bundle_to_wall_top_mm;
      if (c.floor_clearance_mm != null && isFinite(c.floor_clearance_mm))
        r.FLOOR_CLEARANCE_MM = +c.floor_clearance_mm;
      if (c.bundle_to_bundle_mm != null && isFinite(c.bundle_to_bundle_mm))
        r.MIN_BUNDLE_GAP_MM = +c.bundle_to_bundle_mm;
      if (c.skid_height_mm != null && isFinite(c.skid_height_mm))
        r.SKID_HEIGHT_MM = +c.skid_height_mm;
    }
    if (typeof PACK_CONFIG !== 'undefined' && PACK_CONFIG && PACK_CONFIG.cog) {
      if (PACK_CONFIG.cog.max_offset_frac != null && isFinite(PACK_CONFIG.cog.max_offset_frac))
        r.MAX_COG_OFFSET_FRAC = +PACK_CONFIG.cog.max_offset_frac;
    }
    if (typeof PACK_CONFIG !== 'undefined' && PACK_CONFIG && PACK_CONFIG.support) {
      const s = PACK_CONFIG.support;
      if (s.floor_anchor_min_frac != null && isFinite(s.floor_anchor_min_frac))
        r.FLOOR_ANCHOR_SUPPORT_MIN = +s.floor_anchor_min_frac;
    }
    if (typeof PACK_CONFIG !== 'undefined' && PACK_CONFIG && PACK_CONFIG.floor_anchor) {
      const fa = PACK_CONFIG.floor_anchor;
      if (fa.support_min_frac != null && isFinite(fa.support_min_frac))
        r.FLOOR_ANCHOR_SUPPORT_MIN = +fa.support_min_frac;
      if (fa.yaw_longitudinal_only != null)
        r.FLOOR_ANCHOR_YAW_LONGITUDINAL_ONLY = !!fa.yaw_longitudinal_only;
    }
  } catch (_) { /* */ }
  return r;
}

/**
 * Safe packing envelope in millimetres (packer space: X 0→L, Z 0→W, Y 0→H).
 * Outer dims stay on the blue box; cargo must stay inside min/max.
 */
function getPackEnvelope(specOrCont) {
  const rules = getLoadingRules();
  const L = Math.max(0, Number(specOrCont?.lengthMm) || 0);
  const W = Math.max(0, Number(specOrCont?.widthMm) || 0);
  const H = Math.max(0, Number(specOrCont?.heightMm) || 0);

  let end = Math.max(0, rules.WALL_CLEARANCE_END_MM);
  let side = Math.max(0, rules.WALL_CLEARANCE_SIDE_MM);
  let top = Math.max(0, rules.WALL_CLEARANCE_TOP_MM);
  let floor = Math.max(0, rules.FLOOR_CLEARANCE_MM);

  // Never invert envelope if clearances exceed dims
  if (2 * end >= L) end = Math.max(0, Math.floor((L - 1) / 2));
  if (2 * side >= W) side = Math.max(0, Math.floor((W - 1) / 2));
  if (top + floor >= H) {
    top = Math.min(top, Math.max(0, H - 1));
    floor = Math.max(0, H - top - 1);
  }

  const minXMm = end;
  const maxXMm = L - end;
  const minZMm = side;
  const maxZMm = W - side;
  const minYMm = floor;
  const maxYMm = H - top;

  return {
    outerLengthMm: L,
    outerWidthMm: W,
    outerHeightMm: H,
    clearanceEndMm: end,
    clearanceSideMm: side,
    clearanceTopMm: top,
    clearanceFloorMm: floor,
    minXMm, maxXMm, minZMm, maxZMm, minYMm, maxYMm,
    lengthMm: Math.max(0, maxXMm - minXMm),
    widthMm: Math.max(0, maxZMm - minZMm),
    heightMm: Math.max(0, maxYMm - minYMm),
    bundleGapMm: Math.max(0, rules.MIN_BUNDLE_GAP_MM),
    maxCogOffsetFrac: rules.MAX_COG_OFFSET_FRAC,
    allowTouchingWall: !!rules.ALLOW_TOUCHING_WALL,
  };
}

/**
 * Safe envelope in Three.js world units (matches scene: X 0→L, Z −W/2→+W/2, Y 0→H).
 */
function getPackEnvelopeWorld(specOrCont) {
  const e = getPackEnvelope(specOrCont);
  const S = (typeof SCALE !== 'undefined' && SCALE > 0) ? SCALE : 0.001;
  const halfW = e.outerWidthMm * 0.5;
  return {
    ...e,
    minX: e.minXMm * S,
    maxX: e.maxXMm * S,
    minZ: (-halfW + e.clearanceSideMm) * S,
    maxZ: (halfW - e.clearanceSideMm) * S,
    minY: e.minYMm * S,
    maxY: e.maxYMm * S,
  };
}
