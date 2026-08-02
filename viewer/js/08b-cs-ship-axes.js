/* 08b-cs-ship-axes.js — Assembly shipping-pose pack dims (metadata only)
 *
 * Called from 17-cs-pack-units / 15b-cs-ship-prep / PackV2 Step1.
 * Remaps pitched / axis-swapped world AABB → shipping L×flangeW×webH.
 * Does NOT remorph meshes or Group By yard quats.
 */

const CS8_SHIP_CONT_W = 2438;
const CS8_SHIP_CONT_H = 2690;
const CS8_SHIP_CONT_L = 12192;
const CS8_SHIP_EPS = 1;

function cs8ShipContainerCaps(ctx) {
  let W = CS8_SHIP_CONT_W;
  let H = CS8_SHIP_CONT_H;
  let L = CS8_SHIP_CONT_L;
  try {
    const spec = (ctx && ctx.containerSpec)
      || (typeof rawScene !== 'undefined' && rawScene && rawScene.containerSpec)
      || null;
    if (spec) {
      if (+spec.widthMm > 500) W = +spec.widthMm;
      if (+spec.heightMm > 500) H = +spec.heightMm;
      if (+spec.lengthMm > 500) L = +spec.lengthMm;
    }
  } catch (_) { /* */ }
  return { W, H, L };
}

/** Prefer explicit IFC shipping fields when present and sane. */
function cs8ShipFromExplicitFields(ctx) {
  if (!ctx) return null;
  const l = +ctx.shippingLengthMm || +ctx.ShippingLengthMm || 0;
  const w = +ctx.shippingWidthMm || +ctx.ShippingWidthMm
    || +ctx.flangeWidthMm || +ctx.FlangeWidthMm || 0;
  const h = +ctx.shippingHeightMm || +ctx.ShippingHeightMm || 0;
  if (l > 500 && w > 20 && w <= CS8_SHIP_CONT_W + 50 && h > 20 && h <= CS8_SHIP_CONT_H + 200)
    return { l, w, h, source: 'shipping_fields' };
  return null;
}

function cs8ShipHintFlangeW(ctx, dims) {
  const c = ctx || {};
  const fromField = +c.flangeWidthMm || +c.FlangeWidthMm
    || +c.shippingWidthMm || +c.ShippingWidthMm || 0;
  if (fromField >= 40 && fromField <= 600) return fromField;

  const sectW = +c.sectW || 0;
  const unitW = +c.unitWidth || 0;
  // Ignore Tekla mark-derived nonsense (e.g. mark "604.2A-6" → 6)
  if (sectW >= 40 && sectW <= 450) return sectW;
  if (unitW >= 40 && unitW <= 450) return unitW;

  // Smallest axis often = flange when classic 200×11607×2507 swap
  const sorted = [+dims.l || 0, +dims.w || 0, +dims.h || 0]
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  if (sorted.length && sorted[0] >= 40 && sorted[0] <= 450) return sorted[0];

  // Parts: max flange plate width (middle box dim of flange parts)
  let partFl = 0;
  (c.parts || []).forEach(p => {
    if (!p) return;
    const kind = String(p.partKind || p.PartKind || '').toLowerCase();
    const name = String(p.name || p.Name || p.profileDesc || '');
    const isFl = kind === 'flange' || /\bFL\b|FLANGE/i.test(name);
    if (!isFl) return;
    const a = [+p.widthMm || +p.WidthMm || 0, +p.heightMm || +p.HeightMm || 0,
      +p.boxXMm || +p.BoxXMm || 0, +p.boxYMm || +p.BoxYMm || 0,
      +p.boxZMm || +p.BoxZMm || 0].filter(v => v > 1).sort((x, y) => x - y);
    // flange plate: thin × width × length — take mid as seat width
    if (a.length >= 2 && a[1] >= 40 && a[1] <= 600) partFl = Math.max(partFl, a[1]);
  });
  if (partFl >= 40) return partFl;
  return 0;
}

function cs8ShipHintWebH(ctx, dims, flangeW) {
  const c = ctx || {};
  const fromField = +c.shippingHeightMm || +c.ShippingHeightMm || 0;
  if (fromField >= 80 && fromField <= CS8_SHIP_CONT_H + 200) return fromField;

  const gap = +c.flangeClearGapMm || +c.FlangeClearGapMm || 0;
  if (gap >= 80 && gap <= CS8_SHIP_CONT_H) return gap;

  const sectH = +c.sectH || 0;
  const unitH = +c.unitHeight || 0;
  if (sectH >= 80 && sectH <= 2690) return sectH;
  if (unitH >= 80 && unitH <= 2690) return unitH;

  const sorted = [+dims.l || 0, +dims.w || 0, +dims.h || 0]
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  // middle axis often = web depth on pitched AABB
  if (sorted.length >= 3) {
    const mid = sorted[1];
    if (mid >= 80 && mid <= CS8_SHIP_CONT_H + 200 && Math.abs(mid - flangeW) > 30)
      return mid;
  }
  if (sorted.length >= 2) {
    const cand = sorted[sorted.length - 2];
    if (cand >= 80 && cand <= CS8_SHIP_CONT_H + 200) return cand;
  }
  return 0;
}

function cs8ShipHintSpanL(ctx, dims) {
  const c = ctx || {};
  const fromField = +c.shippingLengthMm || +c.ShippingLengthMm || 0;
  if (fromField > 500) return fromField;

  let partMax = 0;
  (c.parts || []).forEach(p => {
    if (!p) return;
    partMax = Math.max(partMax,
      +p.lengthMm || +p.LengthMm || 0,
      +p.boxXMm || +p.BoxXMm || 0);
  });
  const maxDim = Math.max(+dims.l || 0, +dims.w || 0, +dims.h || 0, partMax,
    +c.lengthMaxMm || 0, +c.lengthMm || 0);
  return maxDim > 500 ? maxDim : 0;
}

function cs8ShipNeedsRemap(l, w, h, caps) {
  const W = caps.W;
  if (!(l > 0 && w > 0 && h > 0)) return false;
  // Plan width exceeds container → must remap (world/pitched AABB)
  if (w > W + CS8_SHIP_EPS) return true;
  // Near-square fat plan AABB (two long horizontal axes)
  if (l > W * 0.5 && w > W * 0.5
      && Math.abs(l - w) / Math.max(l, w) < 0.35)
    return true;
  // Classic IFC swap: flange-thin on L, span on W (200×11607×2507)
  if (l < 500 && w > W && h > 200) return true;
  // Span parked on height while width is flange-thin
  if (l < 500 && h > W && w >= 40 && w <= 450) return true;
  // True tall column (H > clear) with sane plan W → do NOT remap
  return false;
}

/**
 * Normalize assembly world/IFC LWH → shipping seat.
 * @returns {{ l, w, h, source }|null} null if already sane / cannot remap
 */
function cs8NormalizeAssemblyShipAxes(l, w, h, ctx) {
  const caps = cs8ShipContainerCaps(ctx);
  const explicit = cs8ShipFromExplicitFields(ctx);
  if (explicit) return explicit;

  let L = Math.max(+l || 0, 0);
  let W = Math.max(+w || 0, 0);
  let H = Math.max(+h || 0, 0);
  if (!(L > 0 && W > 0 && H > 0)) return null;

  if (!cs8ShipNeedsRemap(L, W, H, caps)) {
    // Already shipping-like — still return normalized copy when caller expects object
    return { l: L, w: W, h: H, source: 'already_sane' };
  }

  const dims = { l: L, w: W, h: H };
  const flangeW = cs8ShipHintFlangeW(ctx, dims);
  const webH = cs8ShipHintWebH(ctx, dims, flangeW);
  const spanL = cs8ShipHintSpanL(ctx, dims);

  const outL = spanL > 500 ? spanL : Math.max(L, W, H);
  let outW = flangeW >= 40 ? flangeW : 0;
  let outH = webH >= 80 ? webH : 0;

  // Fallback: sort axes — small=flange, mid=web, large=span
  const sorted = [L, W, H].slice().sort((a, b) => a - b);
  if (!(outW >= 40)) {
    if (sorted[0] >= 40 && sorted[0] <= 450) outW = sorted[0];
    else outW = Math.min(200, Math.max(80, sorted[0] || 200));
  }
  if (!(outH >= 80)) {
    if (sorted[1] >= 80 && sorted[1] <= caps.H + 200) outH = sorted[1];
    else outH = Math.min(caps.H, Math.max(200, sorted[1] || 400));
  }

  // If "web" still looks like a plan span, clamp using clear height
  if (outH > caps.H + 50 && sorted[1] <= caps.H + 50) outH = sorted[1];
  if (outW > caps.W) outW = Math.min(outW, 320);

  if (!(outL > 500 && outW >= 40 && outH >= 80)) return null;

  return {
    l: outL,
    w: outW,
    h: outH,
    source: 'ship_axes',
    pitchedFrom: { l: L, w: W, h: H },
  };
}

/**
 * Scrub pitched mesh/IFC envelope using construct seat hints.
 * @param {object} sb  {l,w,h} current envelope
 * @param {object} item pack unit / scene item (hints)
 * @param {number} memberL preferred span
 * @param {number} cW construct / flange width hint
 * @param {number} cH construct / web height hint
 * @returns {{ l, w, h, source, pitchedFrom }|null}
 */
function cs8SanitizePitchedAssemblyEnvelope(sb, item, memberL, cW, cH) {
  if (!sb) return null;
  const caps = cs8ShipContainerCaps(item);
  const cur = {
    l: Math.max(+sb.l || 0, 1),
    w: Math.max(+sb.w || 0, 1),
    h: Math.max(+sb.h || 0, 1),
  };

  const ctx = Object.assign({}, item || {}, {
    sectW: (item && (+item.sectW || 0)) || +cW || 0,
    sectH: (item && (+item.sectH || 0)) || +cH || 0,
    lengthMm: Math.max(+memberL || 0, +(item && item.lengthMm) || 0, cur.l),
  });

  // Prefer explicit shipping fields
  const explicit = cs8ShipFromExplicitFields(ctx);
  if (explicit) {
    return {
      l: explicit.l,
      w: explicit.w,
      h: explicit.h,
      source: 'shipping_fields',
      pitchedFrom: { l: cur.l, w: cur.w, h: cur.h },
    };
  }

  const needs = cs8ShipNeedsRemap(cur.l, cur.w, cur.h, caps)
    || cur.w > caps.W + CS8_SHIP_EPS
    || cur.h > caps.H + CS8_SHIP_EPS;

  if (!needs) return null;

  const ax = cs8NormalizeAssemblyShipAxes(
    Math.max(+memberL || 0, cur.l),
    Math.max(+cW || 0, cur.w),
    Math.max(+cH || 0, cur.h),
    ctx
  );
  if (!ax) return null;

  // Prefer construct hints when sane
  let outW = ax.w;
  let outH = ax.h;
  let outL = Math.max(ax.l, +memberL || 0);
  if (+cW >= 40 && +cW <= 450) outW = +cW;
  if (+cH >= 80 && +cH <= caps.H + 200) outH = +cH;

  if (outW > caps.W + CS8_SHIP_EPS || outH > caps.H + 400) return null;

  return {
    l: outL,
    w: outW,
    h: outH,
    source: 'ship_sanitize',
    pitchedFrom: { l: cur.l, w: cur.w, h: cur.h },
  };
}

/** True when plan footprint is absurd for a 40ft floor seat. */
function cs8IsAbsurdAssemblyFootprint(l, w, h, ctx) {
  const caps = cs8ShipContainerCaps(ctx);
  return !!(w > caps.W + CS8_SHIP_EPS
    || (l > caps.W * 0.5 && w > caps.W * 0.5
      && Math.abs(l - w) / Math.max(l, w, 1) < 0.35));
}

/**
 * Self-test. Console: cs8ShipAxesSelfTest()
 */
function cs8ShipAxesSelfTest() {
  const results = [];
  function check(id, cond, detail) {
    results.push({ id, ok: !!cond, detail: detail || '' });
  }

  // Classic RF axis swap: 200 × 11607 × 2507 → L=span W=flange H=web
  const ax1 = cs8NormalizeAssemblyShipAxes(200, 11607, 2507, {
    sectW: 200, sectH: 2507, mark: 'RF012',
  });
  check('A1', ax1 && ax1.l > 10000 && ax1.w <= 320 && ax1.h > 2000 && ax1.h < 2700,
    ax1 ? `${Math.round(ax1.l)}x${Math.round(ax1.w)}x${Math.round(ax1.h)}` : 'null');

  // Near-square fat world AABB
  const ax2 = cs8NormalizeAssemblyShipAxes(11864, 11608, 2608, {
    sectW: 200, sectH: 2500, flangeClearGapMm: 2500,
  });
  check('A2', ax2 && ax2.w <= 400 && ax2.l > 10000 && !cs8IsAbsurdAssemblyFootprint(ax2.l, ax2.w, ax2.h),
    ax2 ? `${Math.round(ax2.l)}x${Math.round(ax2.w)}x${Math.round(ax2.h)}` : 'null');

  // Already sane — keep
  const ax3 = cs8NormalizeAssemblyShipAxes(11600, 200, 2508, { sectW: 200, sectH: 2508 });
  check('A3', ax3 && ax3.w === 200 && ax3.l === 11600,
    ax3 ? `${ax3.l}x${ax3.w}x${ax3.h}` : 'null');

  // Explicit shipping fields win
  const ax4 = cs8NormalizeAssemblyShipAxes(11864, 11608, 2608, {
    shippingLengthMm: 11000, shippingWidthMm: 210, shippingHeightMm: 2400,
  });
  check('A4', ax4 && ax4.source === 'shipping_fields' && ax4.w === 210,
    ax4 ? `${ax4.source} ${ax4.w}` : 'null');

  // Sanitize pitched sb
  const scrub = cs8SanitizePitchedAssemblyEnvelope(
    { l: 11864, w: 11608, h: 2608 },
    { sectW: 200, sectH: 2500 },
    11864, 200, 2500
  );
  check('A5', scrub && scrub.w <= 320 && scrub.l > 10000,
    scrub ? `${Math.round(scrub.l)}x${Math.round(scrub.w)}x${Math.round(scrub.h)}` : 'null');

  // True tall column stays tall (honest HEIGHT later) when hints say so
  const ax5 = cs8NormalizeAssemblyShipAxes(4700, 810, 4800, {
    sectW: 810, sectH: 4800,
  });
  check('A6', ax5 && ax5.h > 4000,
    ax5 ? `${Math.round(ax5.l)}x${Math.round(ax5.w)}x${Math.round(ax5.h)}` : 'null');

  const passed = results.filter(x => x.ok).length;
  const out = { ok: passed === results.length, passed, total: results.length, results };
  try { console.info('[ShipAxes] self-test', out); } catch (_) { /* */ }
  return out;
}
