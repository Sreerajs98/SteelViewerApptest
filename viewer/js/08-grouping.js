/* 08-grouping.js — Complete Grouping & Pack Units (container density)
 *
 * AIM: max fill / min void. Group by packing family + section + surface + destination.
 * Mark ignored except welded_assembly.
 *
 * Step 1: classifyFamily
 * Step 2: stage merge key (NO length for nest_z/c/l)
 * Pack units: STEP 7 lives in 17-cs-pack-units.js (createPackUnits override).
 * Legacy helpers below kept as fallback if Step7 script not loaded.
 */

const GROUP_H_TOL_MM = 2;
const GROUP_T_TOL_MM = 0.15;
const GROUP_LEN_BIN_MM = 50;
const GROUP_BEAM_LEN_BIN_MM = 100;
const GROUP_MAX_BUNDLE_KG = 3000;
const GROUP_MAX_ROD_KG = 2000;
const GROUP_MAX_SET = 12;

// ── Section resolve (for dims / shape render — not for mark merge) ───────────

function resolveItemSection(it) {
  // Prefer full profile resolve (part Description + HxWxT cold-form parse)
  if (typeof resolveItemProfile === 'function') {
    const r = resolveItemProfile(it);
    if (r) {
      let shapeKey = r.shapeKey || r.profileShape || it.shapeKey || it.profileShape || null;
      let sectH = r.sectH || 0, sectW = r.sectW || 0, sectT = r.sectT || 0;
      let sectD = r.sectD || 0, sectTf = r.sectTf || 0, sectTw = r.sectTw || 0;
      if ((it.pathPointsMm && it.pathPointsMm.length >= 3)
          || (typeof isBentSagRodItem === 'function' && isBentSagRodItem(it))
          || shapeKey === 'bent_sag_rod') {
        shapeKey = 'bent_sag_rod';
        if (it.pathDiamMm > 0) {
          sectH = it.pathDiamMm; sectW = it.pathDiamMm; sectT = it.pathDiamMm;
        }
      }
      return { shapeKey, sectH, sectW, sectT, sectD, sectTf, sectTw };
    }
  }

  let shapeKey = it.shapeKey || it.profileShape || null;
  let sectH = it.sectH || 0, sectW = it.sectW || 0, sectT = it.sectT || 0;
  let sectD = it.sectD || 0, sectTf = it.sectTf || 0, sectTw = it.sectTw || 0;

  if (!(sectT > 0) || !(sectH > 0) || !shapeKey) {
    const parsed = typeof detectFromDescription === 'function'
      ? detectFromDescription(it.profileDesc) : null;
    if (parsed) {
      if (!shapeKey && parsed.shape) shapeKey = parsed.shape;
      if (!(sectH > 0) && parsed.H) sectH = parsed.H;
      if (!(sectW > 0) && parsed.W) sectW = parsed.W;
      if (!(sectT > 0) && parsed.T) sectT = parsed.T;
      if (!(sectD > 0) && parsed.D) sectD = parsed.D;
    }
  }
  if (!shapeKey && typeof detectProfileShape === 'function') {
    const det = detectProfileShape(it.profileDesc, it.assemblyName);
    if (det && det.shape) shapeKey = det.shape;
  }
  if ((it.pathPointsMm && it.pathPointsMm.length >= 3)
      || (typeof isBentSagRodItem === 'function' && isBentSagRodItem(it))
      || shapeKey === 'bent_sag_rod') {
    shapeKey = 'bent_sag_rod';
    if (it.pathDiamMm > 0) {
      sectH = it.pathDiamMm; sectW = it.pathDiamMm; sectT = it.pathDiamMm;
    }
  }
  return { shapeKey, sectH, sectW, sectT, sectD, sectTf, sectTw };
}

function partCount(it) {
  return (it.parts && it.parts.length) ? it.parts.length : 0;
}

function profileText(it) {
  return String(it.profileDesc || '').toUpperCase();
}

function hBin(mm) {
  if (!(mm > 0)) return 0;
  return Math.round(mm / GROUP_H_TOL_MM) * GROUP_H_TOL_MM;
}

function tBin(mm) {
  if (!(mm > 0)) return '-';
  return (Math.round(mm / GROUP_T_TOL_MM) * GROUP_T_TOL_MM).toFixed(2);
}

/** Match CS grouper floor-bin (±0.15 → step 0.30) so fallback keys don't drift. */
function nestTBin(mm) {
  if (!(mm > 0)) return '-';
  const tStep = Math.max(GROUP_T_TOL_MM * 2, 1e-6);
  return (Math.floor(mm / tStep + 1e-9) * tStep).toFixed(2);
}

function nestStrategyKeyForMerge(it) {
  if (typeof csgNestStrategyKey === 'function') return csgNestStrategyKey(it);
  let nm = it?.nestMethod || null;
  if (!nm && typeof decideNestMethod === 'function') nm = decideNestMethod(it);
  const m = nm?.method || 'NESTNONE';
  return nm?.alternate_flip ? `${m}+FLIP` : m;
}

function lenBin(mm, step) {
  const s = step || GROUP_LEN_BIN_MM;
  return Math.round((mm || 0) / s) * s;
}

// ── Surface / destination / special ─────────────────────────────────────────

function normalizeSurface(raw) {
  const s = String(raw || '').toUpperCase();
  if (/POWDER/.test(s)) return 'POWDER_COATED';
  if (/SPECIAL|EPOXY|FIRE/.test(s)) return 'SPECIAL_COATING';
  if (/GALV|HDG|HOT.?DIP/.test(s)) return 'GALVANIZED';
  if (/PAINT|PRIMER|TOP.?COAT|COATED/.test(s)) return 'PAINTED';
  if (/BARE|MILL|NONE|UNCOAT/.test(s)) return 'BARE';
  if (s && s !== 'BARE') return s.replace(/\s+/g, '_');
  return 'BARE';
}

function resolveSurface(it) {
  if (it.surfaceTreatment) return normalizeSurface(it.surfaceTreatment);
  const blob = `${it.profileDesc || ''} ${it.remarks || ''}`;
  return normalizeSurface(blob);
}

function resolveDestination(it) {
  if (it.destination && String(it.destination).trim())
    return String(it.destination).trim().toUpperCase();
  if (it.phaseTags && it.phaseTags.length)
    return 'PHASE-' + it.phaseTags.map(p => Number(p).toFixed(2).replace(/\.?0+$/, '')).join('+');
  try {
    if (typeof rawScene !== 'undefined' && rawScene) {
      if (rawScene.bldgNo) return String(rawScene.bldgNo).trim().toUpperCase();
      if (rawScene.phaseNo) return 'PHASE-' + String(rawScene.phaseNo).trim();
    }
  } catch (_) { /* */ }
  return 'DEFAULT';
}

function resolveSpecialHandling(it) {
  if (it.specialHandling === true) return true;
  const s = `${it.remarks || ''} ${it.profileDesc || ''}`.toUpperCase();
  return /FRAGILE|NO[\s_-]?STACK|SPECIAL|PRE[\s_-]?ATTACH|INSULATION|SHEETING/.test(s);
}

function looksWeldedMark(it) {
  const mark = String(it.mark || '').trim().toUpperCase();
  const name = String(it.assemblyName || '').toUpperCase();
  if (/RAFTER|COLUMN|FRAME|PORTAL|GIRDER|TRUSS/.test(name)) return true;
  // R-1 / C-1 / F-1 style — not bare profile tokens
  if (/^[RCF][-_]?\d/.test(mark)) return true;
  if (/^R\d/.test(mark) || /^C\d/.test(mark) || /^F\d/.test(mark)) return true;
  return false;
}

function isNestableShapeKey(sk) {
  return sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle'
    || sk === 'plate' || sk === 'rod' || sk === 'bent_sag_rod'
    || sk === 'rhs' || sk === 'i_beam' || sk === 'h_beam';
}

// ── STEP 1: Family classification ───────────────────────────────────────────

/**
 * @returns {string} nest_z|nest_c|nest_l|stack_plate|bundle_rod|bundle_bent|
 *                   bundle_rhs|bundle_beam|welded_assembly|loose_small
 */
function classifyFamily(it) {
  const sec = resolveItemSection(it);
  const sk = sec.shapeKey || '';
  const nParts = partCount(it);
  const prof = profileText(it);
  const nameBlob = `${it.assemblyName || ''} ${it.mark || ''} ${prof}`.toUpperCase();
  const isSagRodAssy = sk === 'bent_sag_rod'
    || (it.pathPointsMm && it.pathPointsMm.length >= 3)
    || /SAG[_\s-]*ROD|SAGROD|BEND_?SAG|BENT_?SAG/.test(nameBlob);

  // SAG_ROD_ASSY — always bent bundle (never welded multi-part mesh)
  if (isSagRodAssy) return 'bundle_bent';

  const singleNestable = nParts <= 1 && (
    sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle'
    || sk === 'plate' || sk === 'rod' || sk === 'bent_sag_rod'
    || sk === 'rhs' || sk === 'i_beam' || sk === 'h_beam'
    || /(?:^|[^A-Z])Z\d|\dZ\d|Z-?\d/i.test(prof)
    || /(?:^|[^A-Z])C\d|\dC\d|CHANNEL/i.test(prof)
    || /\bL\d|ANGLE/i.test(prof)
  );

  // Welded — but single-mesh clear Z/C/L stays nestable
  if (!singleNestable) {
    if (nParts >= 2) return 'welded_assembly';
    if (/BUILT[\s-]?UP/.test(prof)) return 'welded_assembly';
    if (looksWeldedMark(it) && !isNestableShapeKey(sk)) return 'welded_assembly';
  }

  if (sk === 'bent_sag_rod' || (it.pathPointsMm && it.pathPointsMm.length >= 3))
    return 'bundle_bent';
  if (sk === 'z_channel' || /(?:^|[^A-Z0-9])Z\d|\dZ\d|ZPUR|Z-?PURLIN/i.test(prof))
    return 'nest_z';
  if (sk === 'c_channel' || /CHANNEL|(?:^|[^A-Z0-9])C\d|\dC\d/i.test(prof))
    return 'nest_c';
  if (sk === 'l_angle' || /\bL\d|ANGLE|EQUAL.?ANGLE/i.test(prof))
    return 'nest_l';
  if (sk === 'plate' || it.category === 'plate' || /\bPL(ATE)?\b|\bFL\d|FLAT/i.test(prof))
    return 'stack_plate';
  if (sk === 'rod' || it.category === 'rod' || /\bROD\b|ROUND.?BAR|SAG.?ROD/i.test(prof)) {
    if (/BENT|BEND/.test(prof) || (it.pathDiamMm > 0 && it.pathPointsMm?.length >= 3))
      return 'bundle_bent';
    return 'bundle_rod';
  }
  if (sk === 'rhs' || /\bRHS\b|\bSHS\b|\bCHS\b|\bTUBE\b|\bHSS\b/i.test(prof))
    return 'bundle_rhs';
  if (sk === 'i_beam' || sk === 'h_beam' || it.category === 'beam'
      || /\bUB\d|\bUC\d|\bIPE\d|\bHEA\d|\bHEB\d|\bHEM\d/i.test(prof))
    return 'bundle_beam';

  if (looksWeldedMark(it) || /BUILT[\s-]?UP/.test(prof) || nParts >= 2)
    return 'welded_assembly';

  return 'loose_small';
}

/** @deprecated alias used by older callers */
function classifyForGrouping(it) {
  return classifyFamily(it);
}

// ── STEP 2: Stage merge key ─────────────────────────────────────────────────

function stageMergeKey(it) {
  const family = classifyFamily(it);
  const sec = resolveItemSection(it);
  const surf = resolveSurface(it);
  const dest = resolveDestination(it);
  const special = resolveSpecialHandling(it) ? 'SPEC' : 'NORM';
  const H = hBin(sec.sectH || it.heightMm);
  const W = hBin(sec.sectW || it.widthMm);
  const T = tBin(sec.sectT);
  const L50 = lenBin(it.lengthMm, GROUP_LEN_BIN_MM);
  const L100 = lenBin(it.lengthMm, GROUP_BEAM_LEN_BIN_MM);

  switch (family) {
    case 'nest_z':
    case 'nest_c':
    case 'nest_l': {
      // Length NOT in key — packer creates length-aware pack units
      // Align with CS path: floor T-bin + nest strategy (INTERLOCK ≠ PARALLEL)
      let tNest = nestTBin(sec.sectT);
      if (tNest === '-') {
        const pd = String(it.profileDesc || '').trim().toUpperCase().replace(/\s+/g, '');
        tNest = pd ? `P${pd.slice(0, 24)}` : 'Tunk';
      }
      const nestKey = nestStrategyKeyForMerge(it);
      return `${family}|H${H}|W${W}|T${tNest}|${nestKey}|${surf}|${dest}|${special}`;
    }
    case 'stack_plate': {
      const th = tBin(sec.sectH > 0 && sec.sectH <= 80 ? sec.sectH : sec.sectT
        || Math.min(it.heightMm || 99, it.widthMm || 99));
      const planA = hBin(Math.max(it.widthMm || 0, it.heightMm || 0));
      const planB = hBin(Math.min(it.widthMm || 0, it.heightMm || 0));
      const strip = Math.max(it.lengthMm || 0, planA) > planA * 2.5;
      return strip
        ? `${family}|th${th}|A${planA}|B${planB}|L${L50}|${surf}|${dest}|${special}`
        : `${family}|th${th}|A${planA}|B${planB}|${surf}|${dest}|${special}`;
    }
    case 'bundle_rod':
      return `${family}|D${hBin(sec.sectH || sec.sectT || it.heightMm)}|L${L50}|${surf}|${dest}|${special}`;
    case 'bundle_bent':
      return `${family}|D${hBin(it.pathDiamMm || sec.sectH || sec.sectT)}|${surf}|${dest}|${special}`;
    case 'bundle_rhs':
      return `${family}|H${H}|W${W}|L${L50}|${surf}|${dest}|${special}`;
    case 'bundle_beam':
      return `${family}|H${H}|W${W}|L${L100}|${surf}|${dest}|${special}`;
    case 'welded_assembly':
      return `welded|${String(it.mark || '').toUpperCase()}`;
    case 'loose_small':
    default:
      return `loose|${dest}|${special}`;
  }
}

function realWorldGroupKey(it) {
  return stageMergeKey(it);
}

function strategyForFamily(family) {
  if (family.startsWith('nest_')) return 'Bundle';
  if (family === 'stack_plate') return 'Stack';
  if (family.startsWith('bundle_')) return 'Bundle';
  if (family === 'loose_small') return 'Loose';
  return 'SingleUnit';
}

function categoryForFamily(family, it) {
  if (family === 'stack_plate') return 'plate';
  if (family === 'nest_z' || family === 'nest_c' || family === 'nest_l') return 'purlin';
  if (family === 'bundle_rod' || family === 'bundle_bent') return 'rod';
  if (family === 'bundle_beam' || family === 'welded_assembly') return it.category || 'beam';
  if (family === 'bundle_rhs') return 'other';
  return 'other';
}

function shapeKeyForFamily(family, sec) {
  if (family === 'nest_z') return 'z_channel';
  if (family === 'nest_c') return 'c_channel';
  if (family === 'nest_l') return 'l_angle';
  if (family === 'stack_plate') return 'plate';
  if (family === 'bundle_rod') return 'rod';
  if (family === 'bundle_bent') return 'bent_sag_rod';
  if (family === 'bundle_rhs') return 'rhs';
  if (family === 'bundle_beam') return 'i_beam';
  return sec.shapeKey || null;
}

function expandToPieces(items) {
  const pieces = [];
  (items || []).forEach(it => {
    const n = Math.max(1, it.qty || 1);
    for (let i = 0; i < n; i++) {
      pieces.push({ ...it, qty: 1, _pieceIdx: i });
    }
  });
  return pieces;
}

function formatLenRange(minL, maxL) {
  if (!(maxL > 0)) return '';
  if (!(minL > 0) || Math.abs(maxL - minL) < 1)
    return `${(maxL / 1000).toFixed(1)} m`;
  return `${(minL / 1000).toFixed(1)}–${(maxL / 1000).toFixed(1)} m`;
}

function buildStageCard(pieces, family, key) {
  const first = pieces[0];
  const sec = resolveItemSection(first);
  const sk = shapeKeyForFamily(family, sec) || sec.shapeKey;
  const surf = resolveSurface(first);
  const dest = resolveDestination(first);
  const special = resolveSpecialHandling(first);
  let qty = 0, weightKg = 0, maxL = 0, minL = Infinity, maxW = 0, maxH = 0;
  const marks = [];
  const byMark = new Map();
  let parts = null;
  let pathPointsMm = null;
  let pathDiamMm = 0;

  pieces.forEach(p => {
    qty += 1;
    weightKg += Math.max(0, p.unitWeightKg || 0);
    maxL = Math.max(maxL, p.lengthMm || 0);
    if (p.lengthMm > 0) minL = Math.min(minL, p.lengthMm);
    maxW = Math.max(maxW, p.widthMm || 0);
    maxH = Math.max(maxH, p.heightMm || 0);
    if (!marks.includes(p.mark)) marks.push(p.mark);
    if (!byMark.has(p.mark)) byMark.set(p.mark, { ...p, qty: 0 });
    byMark.get(p.mark).qty += 1;
    if (family === 'welded_assembly' && !parts && p.parts) parts = p.parts;
    if ((!pathPointsMm || pathPointsMm.length < 3) && p.pathPointsMm?.length >= 3) {
      pathPointsMm = p.pathPointsMm;
      pathDiamMm = p.pathDiamMm || 0;
    }
  });
  if (!isFinite(minL)) minL = maxL;

  const base = family === 'loose_small'
    ? 'LOOSE ITEMS'
    : family === 'welded_assembly'
      ? (marks[0] || first.mark)
      : (first.profileDesc || sk || 'Group');

  const bits = [base];
  if (family !== 'welded_assembly' && family !== 'loose_small') {
    if (surf && surf !== 'BARE') bits.push(surf.replace(/_/g, ' '));
    if (dest && dest !== 'DEFAULT') bits.push(dest);
  }
  bits.push(`${qty} pcs`);
  const lr = formatLenRange(minL, maxL);
  if (lr && family !== 'loose_small') bits.push(lr);
  if (special) bits.push('SPECIAL');

  return {
    id: '',
    mark: bits.join(' · '),
    name: first.assemblyName || '',
    profileDesc: first.profileDesc || '',
    remarks: first.remarks || '',
    shapeKey: sk,
    profileShape: sk,
    sectH: sec.sectH, sectW: sec.sectW, sectT: sec.sectT,
    sectD: sec.sectD, sectTf: sec.sectTf, sectTw: sec.sectTw,
    category: categoryForFamily(family, first),
    qty,
    weightKg,
    strategy: strategyForFamily(family),
    state: 'unplaced',
    containerId: null,
    marks,
    virtualLmm: maxL,
    virtualWmm: maxW,
    virtualHmm: maxH,
    lengthMinMm: minL,
    lengthMaxMm: maxL,
    surfaceTreatment: surf,
    destination: dest,
    specialHandling: special,
    pathPointsMm,
    pathDiamMm,
    groupKind: family,
    groupKey: key,
    memberItems: Array.from(byMark.values()),
    memberPieces: pieces,
    isAssembly: family === 'welded_assembly',
    parts: family === 'welded_assembly' ? parts : null,
    checked: false,
    checkOrder: 0,
  };
}

/**
 * Step 2 — stage groups for sidebar after Group.
 */
function groupItemsRealWorld(items) {
  const map = new Map();
  expandToPieces(items).forEach(piece => {
    const family = classifyFamily(piece);
    const key = stageMergeKey(piece);
    if (!map.has(key)) map.set(key, { family, pieces: [] });
    map.get(key).pieces.push(piece);
  });

  const list = [];
  map.forEach(({ family, pieces }, key) => {
    list.push(buildStageCard(pieces, family, key));
  });

  const rank = (g) => {
    switch (g.groupKind) {
      case 'welded_assembly': return 0;
      case 'bundle_beam': return 1;
      case 'bundle_rhs': return 2;
      case 'stack_plate': return 3;
      case 'nest_z': return 4;
      case 'nest_c': return 5;
      case 'nest_l': return 6;
      case 'bundle_rod': return 7;
      case 'bundle_bent': return 8;
      case 'loose_small': return 9;
      default: return 10;
    }
  };
  // PURE weight high → low (heaviest first); ties by family rank / length
  list.sort((a, b) => {
    const dW = (b.weightKg || 0) - (a.weightKg || 0);
    if (Math.abs(dW) > 1e-6) return dW;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (b.lengthMaxMm || 0) - (a.lengthMaxMm || 0);
  });
  list.forEach((g, i) => { g.id = `G${i + 1}`; g.weightRank = i + 1; });
  return list;
}

function itemsForStagingGroup(g, allItems) {
  if (g.memberItems && g.memberItems.length) return g.memberItems;
  const marks = new Set(g.marks && g.marks.length ? g.marks : [g.mark]);
  return (allItems || []).filter(it => marks.has(it.mark));
}

// ── STEP 3: Pack units from a stage group ───────────────────────────────────

function maxBundleKg(family) {
  if (family === 'bundle_rod' || family === 'bundle_bent') return GROUP_MAX_ROD_KG;
  return GROUP_MAX_BUNDLE_KG;
}

function setSizeForPieces(pieces, family) {
  const maxKg = maxBundleKg(family);
  let sumW = 0, n = 0;
  pieces.forEach(p => {
    const w = p.unitWeightKg || 0;
    if (w > 0) { sumW += w; n++; }
  });
  const avg = n > 0 ? sumW / n : 50;
  const byWeight = Math.max(1, Math.floor(maxKg / Math.max(avg, 1e-6)));
  // Special handling → never nest tightly (sets of 1–2)
  if (pieces.some(p => resolveSpecialHandling(p)))
    return Math.min(2, byWeight, GROUP_MAX_SET);
  return Math.max(1, Math.min(GROUP_MAX_SET, byWeight));
}

function splitChunkByWeight(chunk, family) {
  const maxKg = maxBundleKg(family);
  const out = [];
  let cur = [];
  let w = 0;
  chunk.forEach(p => {
    const pw = Math.max(0, p.unitWeightKg || 0);
    if (cur.length && w + pw > maxKg) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(p);
    w += pw;
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Prefer same-length sets, then mixed leftovers. Longest → shortest.
 * @returns {object[][]} arrays of pieces
 */
function chunkNestPackUnits(pieces, family) {
  const setSize = setSizeForPieces(pieces, family);
  const byLen = new Map();
  pieces.forEach(p => {
    const L = lenBin(p.lengthMm, GROUP_LEN_BIN_MM);
    if (!byLen.has(L)) byLen.set(L, []);
    byLen.get(L).push(p);
  });
  const lens = Array.from(byLen.keys()).sort((a, b) => b - a);
  const units = [];
  const leftovers = [];

  lens.forEach(L => {
    const bucket = byLen.get(L);
    while (bucket.length >= setSize) {
      units.push(bucket.splice(0, setSize));
    }
    while (bucket.length) leftovers.push(bucket.pop());
  });

  leftovers.sort((a, b) => (b.lengthMm || 0) - (a.lengthMm || 0));
  while (leftovers.length) {
    units.push(leftovers.splice(0, setSize));
  }

  // Weight safety split
  const final = [];
  units.forEach(u => {
    splitChunkByWeight(u, family).forEach(c => final.push(c));
  });
  return final;
}

function packUnitFromPieces(pieces, stageGroup, idx) {
  const family = stageGroup.groupKind;
  const first = pieces[0];
  const sec = resolveItemSection(first);
  let maxL = 0, weight = 0;
  const marks = [];
  pieces.forEach(p => {
    maxL = Math.max(maxL, p.lengthMm || 0);
    weight += Math.max(0, p.unitWeightKg || 0);
    if (!marks.includes(p.mark)) marks.push(p.mark);
  });
  const byMark = new Map();
  pieces.forEach(p => {
    if (!byMark.has(p.mark)) byMark.set(p.mark, { ...p, qty: 0 });
    byMark.get(p.mark).qty += 1;
  });

  return {
    stagingGroupId: stageGroup.id,
    packUnitIndex: idx,
    groupKind: family,
    mark: `${stageGroup.profileDesc || stageGroup.mark} · set ${idx}`,
    marks,
    profileDesc: stageGroup.profileDesc,
    profileShape: stageGroup.profileShape || stageGroup.shapeKey,
    shapeKey: stageGroup.shapeKey,
    sectH: stageGroup.sectH, sectW: stageGroup.sectW, sectT: stageGroup.sectT,
    sectD: stageGroup.sectD, sectTf: stageGroup.sectTf, sectTw: stageGroup.sectTw,
    category: stageGroup.category,
    surfaceTreatment: stageGroup.surfaceTreatment,
    destination: stageGroup.destination,
    specialHandling: stageGroup.specialHandling || pieces.some(resolveSpecialHandling),
    qty: pieces.length,
    weightKg: weight,
    lengthMm: maxL,
    widthMm: stageGroup.virtualWmm,
    heightMm: stageGroup.virtualHmm,
    memberItems: Array.from(byMark.values()),
    nestPieces: pieces.map(p => {
      const s = resolveItemSection(p);
      return {
        mark: p.mark,
        qty: 1,
        sectH: s.sectH || p.heightMm,
        sectW: s.sectW || 0,
        sectT: s.sectT || 0,
        sectD: s.sectD || 0,
        profileDesc: p.profileDesc || '',
        lengthMm: p.lengthMm || 0,
        unitWeightKg: p.unitWeightKg || 0,
      };
    }),
    isAssembly: family === 'welded_assembly',
    parts: family === 'welded_assembly' ? (stageGroup.parts || first.parts || null) : null,
    pathPointsMm: stageGroup.pathPointsMm,
    pathDiamMm: stageGroup.pathDiamMm,
  };
}

/**
 * Create pack units the container packer / inspection layout should place.
 * Prefers STEP 7 (17-cs-pack-units.js) — metadata only, never morphs shapes.
 * @param {object} stageGroup from groupItemsRealWorld / Step4
 * @returns {object[]}
 */
function createPackUnits(stageGroup) {
  if (typeof buildPackUnitsStep7 === 'function')
    return buildPackUnitsStep7(stageGroup);

  // Fallback if Step7 script missing
  const family = stageGroup.groupKind || 'loose_small';
  const pieces = stageGroup.memberPieces
    || expandToPieces(stageGroup.memberItems || itemsForStagingGroup(stageGroup, []));

  if (!pieces.length) return [];

  if (family === 'welded_assembly') {
    const chunks = splitChunkByWeight(pieces, family);
    return chunks.map((c, i) => packUnitFromPieces(c, stageGroup, i + 1));
  }

  if (family.startsWith('nest_') || family === 'stack_plate'
      || family.startsWith('bundle_') || family === 'loose_small') {
    const chunks = chunkNestPackUnits(pieces, family);
    return chunks.map((c, i) => packUnitFromPieces(c, stageGroup, i + 1));
  }

  return [packUnitFromPieces(pieces, stageGroup, 1)];
}

/**
 * Convert a pack unit into a pseudo-raw item list for expandUnits.
 */
function packUnitToExpandItems(pu) {
  return (pu.memberItems || []).map(it => ({
    ...it,
    surfaceTreatment: pu.surfaceTreatment,
    destination: pu.destination,
    specialHandling: pu.specialHandling,
  }));
}
