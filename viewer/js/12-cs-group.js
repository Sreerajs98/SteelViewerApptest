/* 12-cs-group.js — STEP 5: Shape Matching (Grouping)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / meshPositionsMm / meshIndices / pathPoints   ║
 * ║  • NEVER modify sectH/sectW/sectT / shapeKey / lengthMm / dims        ║
 * ║  • NEVER rotate or rebuild any THREE mesh here                       ║
 * ║  • Profile name from IFC = LABEL only (not merge logic)              ║
 * ║  • ONLY write: item.csSignature + stage group cards (metadata)       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Guide:
 *   Same Step2 cross-section signature (±5%) → same shape family
 *   Sub-group: H/W ±2mm, T ±0.15mm
 *   Split: surface (GALV≠PAINT≠BARE), destination (BLDG-A≠BLDG-B)
 *   Welded: assembly mark only (+ surf/dest so coatings never mix)
 *
 * merge_key = signature + dimensions + surface + destination
 */

const CSG_SIG_TOL = 0.05;          // ±5% signature bins (guide)
const CSG_SYM_TOL = 0.1;           // symmetry noisier (Step2 match guide)
const CSG_H_TOL_MM = 2;
const CSG_T_TOL_MM = 0.15;

function csgSigTol() {
  return (typeof cfgTol === 'function') ? cfgTol('signature_pct', CSG_SIG_TOL) : CSG_SIG_TOL;
}
function csgHTol() {
  return (typeof cfgTol === 'function') ? cfgTol('dim_h_w_mm', CSG_H_TOL_MM) : CSG_H_TOL_MM;
}
function csgTTol() {
  return (typeof cfgTol === 'function') ? cfgTol('dim_t_mm', CSG_T_TOL_MM) : CSG_T_TOL_MM;
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Step5 signature for grouping — PREFER Step2 analysis.signature (canonical).
 * Falls back to polygon recompute only if Step2 missing.
 * @returns {object|null}
 */
function computeCsSignature(it) {
  if (!it) return null;

  if (!it.crossSection && typeof extractCrossSection === 'function')
    extractCrossSection(it);
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function')
    analyzeCrossSection(it);

  const cs = it.crossSection;
  const an = it.csAnalysis;
  if (!cs?.outer_points || cs.outer_points.length < 3) {
    it.csSignature = null;
    return null;
  }

  // ── Prefer Step2 signature (guide INPUT) ────────────────────────────────
  const s2 = an?.signature;
  if (s2 && (s2.vertex_count > 0 || an.signature_hash)) {
    const aspect = s2.aspect_ratio > 0
      ? +s2.aspect_ratio
      : csgAspectFromItem(it, cs);
    const signature = {
      vertex_count: (s2.vertex_count | 0) || (cs.vertex_count | 0) || 0,
      area_ratio: +s2.area_ratio || 0,
      perimeter_ratio: +s2.perimeter_ratio || 0,
      concavity_ratio: +s2.concavity_ratio || 0,
      symmetry_score: Math.max(0, Math.min(1, +s2.symmetry_score || 0)),
      aspect_ratio: aspect,
      step2_hash: an.signature_hash || null,
      source: 'step2',
    };
    // Grouping hash = ±5% bins (merge matching), not raw Step2 round
    signature.hash = csgSignatureHash(signature);
    it.csSignature = signature;
    return signature;
  }

  // ── Fallback: derive from polygon (tests / incomplete Step2) ────────────
  const outer = csgCopyPoly(cs.outer_points);
  const norm = csgNormalizePoly(outer);
  const bb = csgBBox(norm.pts);
  const area = Math.max(csgPolygonArea(norm.pts), 1e-9);
  const peri = csgPerimeter(norm.pts);
  const bboxArea = Math.max(bb.w * bb.h, 1e-9);
  const bboxPeri = Math.max(2 * (bb.w + bb.h), 1e-9);

  const hull = csgConvexHull(norm.pts);
  const hullArea = Math.max(csgPolygonArea(hull), 1e-9);
  const concavity_ratio = Math.max(0, (hullArea - area) / hullArea);

  const vertex_count = cs.vertex_count || outer.length;
  const area_ratio = an?.area_ratio != null ? an.area_ratio : (area / bboxArea);
  const perimeter_ratio = an?.perimeter_ratio != null
    ? an.perimeter_ratio
    : (peri / bboxPeri);
  const symmetry_score = an?.symmetry_score != null
    ? an.symmetry_score
    : (an?.symmetry_180 != null ? an.symmetry_180 : csgSymmetryProxy(norm.pts));

  const signature = {
    vertex_count: vertex_count | 0,
    area_ratio: +area_ratio || 0,
    perimeter_ratio: +perimeter_ratio || 0,
    concavity_ratio: an?.concavity_ratio != null ? +an.concavity_ratio : +concavity_ratio,
    symmetry_score: Math.max(0, Math.min(1, +symmetry_score || 0)),
    aspect_ratio: csgAspectFromItem(it, cs),
    source: 'fallback',
  };

  signature.hash = csgSignatureHash(signature);
  it.csSignature = signature;
  return signature;
}

function csgAspectFromItem(it, cs) {
  const H = csgSectH(it) || cs?.cs_height || 0;
  const W = csgSectW(it) || cs?.cs_width || 0;
  if (!(H > 0) || !(W > 0)) return 1;
  const r = H / W;
  return r >= 1 ? r : (1 / Math.max(r, 1e-9));
}

/** Stamp csSignature on every item (after Steps 1–2; before Group by Shape). */
function attachCsSignaturesToItems(items) {
  let ok = 0, fail = 0;
  (items || []).forEach(it => {
    if (computeCsSignature(it)) ok++;
    else fail++;
  });
  try {
    console.info(`[Step5 signature] ${ok} ok, ${fail} failed of ${(items || []).length}`);
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length };
}

/**
 * STEP 5 — group by merge_key (signature + dims + surface + destination).
 * Returns cards compatible with staging UI / createPackUnits.
 * Does NOT mutate item geometry.
 */
function groupItemsByCsSignature(items) {
  const pieces = typeof expandToPieces === 'function'
    ? expandToPieces(items)
    : (items || []).flatMap(it => {
        const n = Math.max(1, it.qty || 1);
        const out = [];
        for (let i = 0; i < n; i++) out.push({ ...it, qty: 1, _pieceIdx: i });
        return out;
      });

  const map = new Map();
  pieces.forEach(piece => {
    const key = csgMergeKey(piece);
    if (!map.has(key)) map.set(key, { pieces: [], key });
    map.get(key).pieces.push(piece);
  });

  const list = [];
  map.forEach(({ pieces: pcs, key }) => {
    list.push(csgBuildStageCard(pcs, key));
  });

  // Pack-unit weight — never raw group total for multi-qty
  const packW = (g) => {
    if (typeof groupPackSortWeightKg === 'function') return groupPackSortWeightKg(g);
    const total = Math.max(0, Number(g.weightKg) || 0);
    const qty = Math.max(1, Number(g.qty) || 1);
    if (qty <= 1) return total;
    if (g.groupKind === 'welded_assembly' || g.isAssembly) return total / qty;
    if (/^nest_[zcl]$/.test(g.groupKind || '')) {
      const setSize = Math.min(12, qty);
      return total / Math.max(1, Math.ceil(qty / setSize));
    }
    return total / qty;
  };
  list.sort((a, b) => {
    const dW = packW(b) - packW(a);
    if (Math.abs(dW) > 1e-6) return dW;
    const aw = a.groupKind === 'welded_assembly' ? 0 : 1;
    const bw = b.groupKind === 'welded_assembly' ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return (b.lengthMaxMm || 0) - (a.lengthMaxMm || 0)
      || String(a.dimLabel || '').localeCompare(String(b.dimLabel || ''));
  });
  list.forEach((g, i) => { g.id = `G${i + 1}`; g.weightRank = i + 1; });

  try {
    const welded = list.filter(g => g.groupKind === 'welded_assembly').length;
    console.info(
      `[Step5 group] ${list.length} groups from ${pieces.length} pcs`
      + ` (${welded} welded-by-mark, no shape change)`
    );
  } catch (_) { /* */ }

  return list;
}

/**
 * Guide: two items same shape if signatures match within tolerance
 * (dims / surface / dest checked separately via merge_key).
 */
function csSignaturesMatchForGroup(a, b) {
  if (typeof signaturesMatch === 'function') return signaturesMatch(a, b);
  if (!a || !b) return false;
  if ((a.vertex_count | 0) !== (b.vertex_count | 0)) return false;
  const tol = csgSigTol();
  if (Math.abs((a.area_ratio || 0) - (b.area_ratio || 0)) > tol) return false;
  if (Math.abs((a.perimeter_ratio || 0) - (b.perimeter_ratio || 0)) > tol) return false;
  if (Math.abs((a.concavity_ratio || 0) - (b.concavity_ratio || 0)) > tol) return false;
  if (Math.abs((a.symmetry_score || 0) - (b.symmetry_score || 0)) > CSG_SYM_TOL) return false;
  if (Math.abs((a.aspect_ratio || 0) - (b.aspect_ratio || 0)) > 0.1) return false;
  return true;
}

/**
 * After Group: verify every expanded piece / mark is still in staging groups
 * and (if present) pack-unit nestPieces. Does not change geometry.
 * @returns {{ ok, inPcs, outPcs, packPcs, missingMarks, shortMarks }}
 */
function auditGroupingCoverage(sourceItems, groups) {
  const expand = (typeof expandToPieces === 'function')
    ? expandToPieces
    : (items) => {
        const out = [];
        (items || []).forEach(it => {
          const n = Math.max(1, it.qty || 1);
          for (let i = 0; i < n; i++) out.push({ ...it, qty: 1 });
        });
        return out;
      };

  const inPieces = expand(sourceItems || []);
  const inByMark = new Map();
  inPieces.forEach(p => {
    const m = String(p.mark || '').trim();
    if (!m) return;
    inByMark.set(m, (inByMark.get(m) || 0) + 1);
  });

  let outPcs = 0;
  const outByMark = new Map();
  (groups || []).forEach(g => {
    const pcs = (g.memberPieces && g.memberPieces.length)
      ? g.memberPieces
      : expand(g.memberItems || []);
    outPcs += pcs.length;
    pcs.forEach(p => {
      const m = String(p.mark || '').trim();
      if (!m) return;
      outByMark.set(m, (outByMark.get(m) || 0) + 1);
    });
    // Also count unique marks listed on the card
    (g.marks || []).forEach(m => {
      const key = String(m || '').trim();
      if (key && !outByMark.has(key)) outByMark.set(key, 0);
    });
  });

  let packPcs = 0;
  (groups || []).forEach(g => {
    (g.packUnits || []).forEach(pu => {
      if (pu.nestPieces && pu.nestPieces.length) {
        pu.nestPieces.forEach(np => { packPcs += Math.max(1, np.qty || 1); });
      } else {
        packPcs += Math.max(1, pu.qty || 0);
      }
    });
  });

  const missingMarks = [];
  const shortMarks = [];
  inByMark.forEach((n, m) => {
    const o = outByMark.get(m) || 0;
    if (o <= 0) missingMarks.push(m);
    else if (o < n) shortMarks.push(`${m}(${o}/${n})`);
  });

  const hasPacks = (groups || []).some(g => g.packUnits && g.packUnits.length);
  const packGap = hasPacks && packPcs !== inPieces.length;
  const ok = missingMarks.length === 0 && shortMarks.length === 0
    && outPcs === inPieces.length
    && (!hasPacks || packPcs === inPieces.length);

  const result = {
    ok,
    inPcs: inPieces.length,
    outPcs,
    packPcs,
    missingMarks,
    shortMarks,
    packGap,
  };

  try {
    if (ok) {
      console.info(
        `[Group audit] OK — ${result.inPcs} pcs → ${result.outPcs} in groups`
        + (hasPacks ? ` → ${packPcs} in pack units` : '')
      );
    } else {
      console.warn(
        `[Group audit] MISS — in=${result.inPcs} groups=${result.outPcs}`
        + ` packs=${packPcs}`
        + (missingMarks.length ? ` missing=[${missingMarks.slice(0, 12).join(', ')}]` : '')
        + (shortMarks.length ? ` short=[${shortMarks.slice(0, 12).join(', ')}]` : '')
        + (packGap ? ' (pack-unit piece count ≠ input)' : '')
      );
    }
  } catch (_) { /* */ }

  return result;
}

// ── merge key ───────────────────────────────────────────────────────────────

function csgIsWeldedOrTapered(it) {
  if (!it) return false;
  // Single-part standard profiles are NEVER welded (even if isAssembly flag set)
  const sk = it.shapeKey || it.profileShape || '';
  const nParts = (it.parts && it.parts.length) ? it.parts.length : 0;
  if (nParts <= 1 && (sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle'
      || sk === 'plate' || sk === 'rod' || sk === 'rhs' || sk === 'chs'
      || sk === 'bent_sag_rod'))
    return false;

  if (nParts >= 2) return true;
  if (it.csAnalysis?.profile_type === 'WELDED' || it.csAnalysis?.open_closed === 'welded')
    return true;
  if (it.crossSection?.is_tapered || it.crossSection?.welded_like
      || it.crossSection?.welded_assembly)
    return true;
  if (typeof classifyFamily === 'function' && classifyFamily(it) === 'welded_assembly')
    return true;
  const prof = `${it.profileDesc || ''}`.toUpperCase();
  if (/BUILT[\s-]?UP/.test(prof)) return true;
  return false;
}

/**
 * Nest / pack strategy token for merge key — INTERLOCK Z never mixes with PARALLEL.
 */
function csgNestStrategyKey(it) {
  if (!it) return 'NESTNONE';
  let nm = it.nestMethod || null;
  if (!nm && typeof decideNestMethod === 'function') {
    nm = decideNestMethod(it);
    if (nm && !it.nestMethod) it.nestMethod = nm; // stamp on piece copy
  }
  const m = (nm && nm.method) ? String(nm.method) : 'NESTNONE';
  const flip = !!(nm && nm.alternate_flip);
  return flip ? `${m}+FLIP` : m;
}

/** Short UI token: INTERLOCK_NEST → INTERLOCK */
function csgNestStrategyShort(nmOrKey) {
  const raw = typeof nmOrKey === 'string'
    ? nmOrKey
    : (nmOrKey?.method || '');
  if (!raw || raw === 'NESTNONE') return '';
  return String(raw)
    .replace(/\+FLIP$/i, '')
    .replace(/_NEST$/i, '')
    .replace(/_BUNDLE$/i, '')
    .replace(/_STACK$/i, '')
    .replace(/^PER_MARK$/i, 'PER-MARK')
    .replace(/_/g, '-');
}

/**
 * merge_key = signature + dimensions + nestStrategy + surface + destination
 * (+ special / bent flags — prevent unsafe merges without changing guide meaning)
 */
function csgMergeKey(it) {
  const surf = csgSurface(it);
  const dest = csgDestination(it);
  const special = (typeof resolveSpecialHandling === 'function'
    ? resolveSpecialHandling(it) : !!it.specialHandling) ? 'SPEC' : 'NORM';

  // Welded: group by assembly MARK only (guide) — still split surf/dest
  if (csgIsWeldedOrTapered(it)) {
    const mark = String(it.mark || 'UNKNOWN').trim().toUpperCase();
    return `welded|${mark}|${surf}|${dest}|${special}`;
  }

  // Bent vs straight rods: same CS otherwise would wrongly merge
  const bent = !!(it.pathPointsMm && it.pathPointsMm.length >= 3)
    || it.shapeKey === 'bent_sag_rod'
    || it.profileShape === 'bent_sag_rod'
    || /BENT|BEND/.test(`${it.profileDesc || ''}`);
  const rodKind = bent ? 'BENT' : 'STRAIGHT';

  const sig = it.csSignature || computeCsSignature(it);
  const sigHash = sig?.hash || 'sig:none';
  const dimBin = csgDimensionBin(it);
  const nestKey = csgNestStrategyKey(it);
  // Guide order: signature | dimensions | nestStrategy | surface | destination
  return `${sigHash}|${dimBin}|${nestKey}|${surf}|${dest}|${special}|${rodKind}`;
}

function csgSignatureHash(sig) {
  // Quantize into ±5% bins → identical hash ⇒ signaturesMatch within guide tol
  const q = (v, step) => {
    const x = Number(v) || 0;
    if (!isFinite(x)) return '0';
    const s = step != null ? step : csgSigTol();
    return (Math.round(x / s) * s).toFixed(3);
  };
  return [
    'v' + (sig.vertex_count | 0),
    'ar' + q(sig.area_ratio),
    'pr' + q(sig.perimeter_ratio),
    'cr' + q(sig.concavity_ratio),
    'sy' + q(sig.symmetry_score, CSG_SYM_TOL),
    'asp' + q(sig.aspect_ratio != null ? sig.aspect_ratio : 1, 0.1),
  ].join('_');
}

function csgDimensionBin(it) {
  const H = csgSectH(it);
  const W = csgSectW(it);
  const T = csgSectT(it);
  const hTol = csgHTol(), tTol = csgTTol();
  // Bin width = 2×tolerance so values within ±tol of a nominal share a bin
  // (plain round-to-tol creates cliff edges: 74.8→74 vs 75.2→76).
  const hStep = Math.max(hTol * 2, 1e-6);
  const tStep = Math.max(tTol * 2, 1e-6);
  const hB = Math.round(H / hStep) * hStep;
  const wB = Math.round(W / hStep) * hStep;
  let tB = T > 0
    ? (Math.floor(T / tStep + 1e-9) * tStep).toFixed(2)
    : '-';
  // Nest Z/C/L: unknown T must NOT collapse different gauges into one set —
  // fall back to normalised profile text so 2.5 / 2.0 / 1.5 stay separate.
  if (tB === '-' && csgIsNestColdForm(it)) {
    const pd = String(it.profileDesc || it.profileLabel || '')
      .trim().toUpperCase().replace(/\s+/g, '');
    tB = pd ? `P${pd.slice(0, 24)}` : 'Tunk';
  }
  return `H${hB}|W${wB}|T${tB}`;
}

function csgIsNestColdForm(it) {
  const sk = String(it?.shapeKey || it?.profileShape || '').toLowerCase();
  if (sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle') return true;
  if (typeof classifyFamily === 'function') {
    const f = classifyFamily(it);
    return f === 'nest_z' || f === 'nest_c' || f === 'nest_l';
  }
  return /PURLIN|GIRT|\bZ\d|\dZ\d/i.test(`${it?.profileDesc || ''} ${it?.assemblyName || ''}`);
}

function csgSectH(it) {
  if (it.sectH > 0) return it.sectH;
  if (it.crossSection?.cs_height > 0) return it.crossSection.cs_height;
  if (typeof resolveItemSection === 'function') {
    const s = resolveItemSection(it);
    if (s.sectH > 0) return s.sectH;
  }
  return Math.max(it.heightMm || 0, 0);
}

function csgSectW(it) {
  if (it.sectW > 0) return it.sectW;
  if (it.crossSection?.cs_width > 0) return it.crossSection.cs_width;
  if (typeof resolveItemSection === 'function') {
    const s = resolveItemSection(it);
    if (s.sectW > 0) return s.sectW;
  }
  return Math.max(it.widthMm || 0, 0);
}

function csgSectT(it) {
  if (it.sectT > 0) return it.sectT;
  if (typeof resolveItemSection === 'function') {
    const s = resolveItemSection(it);
    if (s.sectT > 0) return s.sectT;
  }
  if (typeof resolveItemProfile === 'function') {
    const r = resolveItemProfile(it);
    if (r && r.sectT > 0) return r.sectT;
  }
  return 0;
}

function csgSurface(it) {
  if (typeof resolveSurface === 'function') return resolveSurface(it);
  const s = String(it.surfaceTreatment || 'BARE').toUpperCase();
  return s || 'BARE';
}

function csgDestination(it) {
  if (typeof resolveDestination === 'function') return resolveDestination(it);
  return String(it.destination || 'DEFAULT').trim().toUpperCase() || 'DEFAULT';
}

function csgSurfaceShort(surf) {
  const s = String(surf || 'BARE').toUpperCase();
  if (/POWDER/.test(s)) return 'POWDER';
  if (/SPECIAL|EPOXY|FIRE/.test(s)) return 'SPECIAL';
  if (/GALV|HDG|HOT/.test(s)) return 'GALV';
  if (/PAINT|PRIMER|COAT/.test(s) && !/POWDER|SPECIAL/.test(s)) return 'PAINT';
  if (/BARE|MILL|NONE|UNCOAT|DEFAULT/.test(s) || !s) return 'BARE';
  return s.length > 10 ? s.slice(0, 10) : s;
}

// ── stage card ──────────────────────────────────────────────────────────────

function csgBuildStageCard(pieces, mergeKey) {
  const first = pieces[0];
  const welded = mergeKey.startsWith('welded|') || csgIsWeldedOrTapered(first);

  // Packing family hint only — not used for merge (signature already did that)
  const family = welded
    ? 'welded_assembly'
    : (typeof classifyFamily === 'function' ? classifyFamily(first) : 'loose_small');

  const sec = typeof resolveItemSection === 'function'
    ? resolveItemSection(first)
    : {
        shapeKey: first.shapeKey || first.profileShape,
        sectH: first.sectH || 0, sectW: first.sectW || 0, sectT: first.sectT || 0,
        sectD: first.sectD || 0, sectTf: first.sectTf || 0, sectTw: first.sectTw || 0,
      };

  const sk = (typeof shapeKeyForFamily === 'function'
    ? shapeKeyForFamily(family, sec)
    : null) || sec.shapeKey || first.profileShape || null;

  const surf = csgSurface(first);
  const dest = csgDestination(first);
  const special = typeof resolveSpecialHandling === 'function'
    ? resolveSpecialHandling(first) : !!first.specialHandling;

  let qty = 0, weightKg = 0, maxL = 0, minL = Infinity, maxW = 0, maxH = 0;
  const marks = [];
  const byMark = new Map();
  let parts = null;
  let pathPointsMm = null;
  let pathDiamMm = 0;
  let flangeClearGapMm = 0;

  // Stamp resolved H/W/T onto piece copies so pack units / nests never lose gauge
  pieces.forEach(p => {
    const s = typeof resolveItemSection === 'function' ? resolveItemSection(p) : null;
    if (s) {
      if (!(p.sectH > 0) && s.sectH > 0) p.sectH = s.sectH;
      if (!(p.sectW > 0) && s.sectW > 0) p.sectW = s.sectW;
      if (!(p.sectT > 0) && s.sectT > 0) p.sectT = s.sectT;
      if (!(p.sectD > 0) && s.sectD > 0) p.sectD = s.sectD;
      if (!p.shapeKey && s.shapeKey) p.shapeKey = s.shapeKey;
      if (!p.profileShape && (s.shapeKey || p.shapeKey))
        p.profileShape = s.shapeKey || p.shapeKey;
    }
  });

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
    if (welded && !parts && p.parts) parts = p.parts;
    if ((!pathPointsMm || pathPointsMm.length < 3) && p.pathPointsMm?.length >= 3) {
      pathPointsMm = p.pathPointsMm;
      pathDiamMm = p.pathDiamMm || 0;
    }
    if (!(flangeClearGapMm > 0) && p.flangeClearGapMm > 0)
      flangeClearGapMm = p.flangeClearGapMm;
  });
  if (!isFinite(minL)) minL = maxL;

  // Prefer resolved dims (T from profile when missing)
  const H = csgSectH(first) || (sec.sectH > 0 ? sec.sectH : 0);
  const W = csgSectW(first) || (sec.sectW > 0 ? sec.sectW : 0);
  const T = csgSectT(first) || (sec.sectT > 0 ? sec.sectT : 0);
  if (T > 0 && !(sec.sectT > 0)) sec.sectT = T;
  if (H > 0 && !(sec.sectH > 0)) sec.sectH = H;
  if (W > 0 && !(sec.sectW > 0)) sec.sectW = W;
  const dimLabel = csgDimLabel(H, W, T);
  const surfShort = csgSurfaceShort(surf);
  const destLabel = dest && dest !== 'DEFAULT' ? dest : null;
  const lenRange = typeof formatLenRange === 'function'
    ? formatLenRange(minL, maxL)
    : csgFormatLenRange(minL, maxL);

  // Step 5 nest method + Step 6 offset (metadata) — never mutates geometry
  let nestMethod = first.nestMethod || null;
  if (!nestMethod && typeof decideNestMethod === 'function')
    nestMethod = decideNestMethod(first);
  let nestingInfo = first.nestingInfo || null;
  if (!nestingInfo && typeof calculateNestingOffset === 'function')
    nestingInfo = calculateNestingOffset(first);
  const nestLabel = typeof nestMethodLabel === 'function'
    ? nestMethodLabel(nestMethod)
    : (nestMethod?.method || '');
  const nestShort = csgNestStrategyShort(nestMethod) || csgNestStrategyShort(csgNestStrategyKey(first));
  const strategy = nestMethod && typeof nestMethodToStrategy === 'function'
    ? nestMethodToStrategy(nestMethod)
    : (typeof strategyForFamily === 'function'
      ? strategyForFamily(family)
      : (welded ? 'SingleUnit' : 'Bundle'));
  const offMm = nestingInfo?.nesting_offset > 0
    ? nestingInfo.nesting_offset
    : (first.nestingOffsetMm || 0);
  const orient = first.orientation_info || null;

  // Card title: dims · nest · surface · dest · pcs · length RANGE
  const titleBits = [];
  if (welded) titleBits.push(marks[0] || first.mark || 'WELDED');
  else if (dimLabel) titleBits.push(dimLabel);
  else titleBits.push('GROUP');
  if (!welded && nestShort) titleBits.push(nestShort);
  titleBits.push(surfShort);
  if (destLabel) titleBits.push(destLabel);
  titleBits.push(`${qty} pcs`);
  if (lenRange) titleBits.push(lenRange);
  if (special) titleBits.push('SPECIAL');

  const sig = first.csSignature || null;
  const shapeIconSvg = csgThumbnailSvg(first.crossSection);

  return {
    id: '',
    mark: titleBits.join(' · '),
    name: first.assemblyName || '',
    // IFC profile — LABEL only (not used for merge)
    profileDesc: first.profileDesc || '',
    profileLabel: first.profileDesc || '',
    remarks: first.remarks || '',
    shapeKey: sk,
    profileShape: sk,
    sectH: H || sec.sectH, sectW: W || sec.sectW, sectT: T || sec.sectT,
    sectD: sec.sectD, sectTf: sec.sectTf, sectTw: sec.sectTw,
    category: typeof categoryForFamily === 'function'
      ? categoryForFamily(family, first)
      : (first.category || 'other'),
    qty,
    weightKg,
    strategy,
    nestMethod,
    nestMethodLabel: nestLabel,
    nestingInfo,
    nestingOffsetMm: offMm,
    orientation_info: orient,
    // Filled after 3D nest build (stabilizeNestBundle); hint from Step3 until then
    stabilityInfo: first.stabilityInfo || null,
    stabilityHint: orient?.vert_key
      ? `orient:${orient.vert_key}`
      : null,
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
    flangeClearGapMm,
    groupKind: family,
    groupKey: mergeKey,
    mergeKey,
    signatureHash: sig?.hash || (welded ? 'welded' : ''),
    csSignature: sig,
    dimLabel,
    shapeIconSvg,
    memberItems: Array.from(byMark.values()),
    memberPieces: pieces,
    isAssembly: welded,
    parts: welded ? parts : null,
    checked: false,
    checkOrder: 0,
  };
}

function csgDimLabel(H, W, T) {
  const h = H > 0 ? (Math.abs(H - Math.round(H)) < 0.05 ? String(Math.round(H)) : H.toFixed(1)) : '?';
  const w = W > 0 ? (Math.abs(W - Math.round(W)) < 0.05 ? String(Math.round(W)) : W.toFixed(1)) : '?';
  if (T > 0) {
    const t = Math.abs(T - Math.round(T)) < 0.05 ? String(Math.round(T)) : Number(T).toFixed(1);
    return `${h}×${w}×${t}`;
  }
  return `${h}×${w}`;
}

function csgFormatLenRange(minL, maxL) {
  if (!(maxL > 0)) return '';
  if (!(minL > 0) || Math.abs(maxL - minL) < 1)
    return `${(maxL / 1000).toFixed(1)} m`;
  return `${(minL / 1000).toFixed(1)}–${(maxL / 1000).toFixed(1)} m`;
}

/** Tiny SVG thumbnail from outer polygon — decorative only. */
function csgThumbnailSvg(cs) {
  if (!cs?.outer_points || cs.outer_points.length < 3) {
    return '<svg class="ag-cs-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">'
      + '<rect x="4" y="8" width="16" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cs.outer_points.forEach(p => {
    const x = +p[0], y = +p[1];
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  });
  const bw = Math.max(maxX - minX, 1e-3);
  const bh = Math.max(maxY - minY, 1e-3);
  const pad = 2;
  const S = 24;
  const sc = (S - pad * 2) / Math.max(bw, bh);
  const ox = pad + (S - pad * 2 - bw * sc) / 2;
  const oy = pad + (S - pad * 2 - bh * sc) / 2;
  let d = '';
  cs.outer_points.forEach((p, i) => {
    const x = ox + (+p[0] - minX) * sc;
    const y = oy + (maxY - +p[1]) * sc; // flip Y for SVG
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
  });
  d += 'Z';
  return `<svg class="ag-cs-icon" viewBox="0 0 ${S} ${S}" width="28" height="28" aria-hidden="true">`
    + `<path d="${d}" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
}

// ── geometry helpers (local — do not touch item meshes) ─────────────────────

function csgCopyPoly(pts) {
  return pts.map(p => [+p[0] || 0, +p[1] || 0]);
}

function csgBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(p => {
    if (p[0] < minX) minX = p[0]; if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0]; if (p[1] > maxY) maxY = p[1];
  });
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function csgPolygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) * 0.5;
}

function csgPerimeter(pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return p;
}

function csgCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    const c = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    a += c;
    cx += (pts[i][0] + pts[j][0]) * c;
    cy += (pts[i][1] + pts[j][1]) * c;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    const bb = csgBBox(pts);
    return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Translate to centroid, scale so max extent = 1 (shape-only). */
function csgNormalizePoly(pts) {
  const c = csgCentroid(pts);
  let shifted = pts.map(p => [p[0] - c.x, p[1] - c.y]);
  let maxR = 0;
  shifted.forEach(p => {
    const r = Math.max(Math.abs(p[0]), Math.abs(p[1]));
    if (r > maxR) maxR = r;
  });
  if (maxR < 1e-9) maxR = 1;
  shifted = shifted.map(p => [p[0] / maxR, p[1] / maxR]);
  return { pts: shifted, scale: maxR, cx: c.x, cy: c.y };
}

/** Second moments about origin (centroid after normalize). */
function csgSecondMoments(pts) {
  let ix = 0, iy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i][0], y0 = pts[i][1];
    const x1 = pts[j][0], y1 = pts[j][1];
    const cross = x0 * y1 - x1 * y0;
    iy += cross * (x0 * x0 + x0 * x1 + x1 * x1); // ∬ x²
    ix += cross * (y0 * y0 + y0 * y1 + y1 * y1); // ∬ y²
  }
  return { ix: Math.abs(ix) / 12, iy: Math.abs(iy) / 12 };
}

function csgConvexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 2) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0)
      lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0)
      upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function csgSymmetryProxy(pts) {
  // Cheap 180° check on normalized poly: point set vs rotated
  const n = pts.length;
  if (n < 3) return 0;
  let hits = 0;
  const tol = 0.08;
  for (let i = 0; i < n; i++) {
    const rx = -pts[i][0], ry = -pts[i][1];
    let ok = false;
    for (let j = 0; j < n; j++) {
      if (Math.hypot(pts[j][0] - rx, pts[j][1] - ry) < tol) { ok = true; break; }
    }
    if (ok) hits++;
  }
  return hits / n;
}
