/* 13-cs-nest-method.js — STEP 6: Nest Method Assignment
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER modify parts / meshPositionsMm / meshIndices / pathPoints   ║
 * ║  • NEVER modify sectH/sectW/sectT / shapeKey / lengthMm / dims        ║
 * ║  • NEVER rotate, nest-offset, or rebuild any THREE mesh here         ║
 * ║  • NO profile-name rules — Step 2 geometry properties only           ║
 * ║  • ONLY write: item.nestMethod  (decision metadata for later steps)  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Guide (auto from Step2 — no hardcoded profile names):
 *   Open + deep concavity + symmetry     → INTERLOCK_NEST + flip
 *   Open + deep concavity + no symmetry  → INTERLOCK_NEST (no flip)
 *   Open + shallow concavity             → STACK_NEST
 *   Closed                               → PARALLEL_BUNDLE
 *   Solid + thin                         → FLAT_STACK
 *   Solid + round                        → HEX_BUNDLE
 *   Multi-part / tapered / welded        → PER_MARK_STACK (dunnage)
 *
 * Prefers Step2 nest_type / can_flip when present (single source of truth).
 */

const CSN_CONCAVITY_INTERLOCK = 0.15; // matches CSA_CONCAVITY_HIGH
const CSN_SYM_FLIP_MIN = 0.85;        // matches CSA_SYM_FLIP_MIN (Step2)
const CSN_THIN_RATIO = 0.10;
const CSN_ROUND_ASPECT = 0.18;        // |H−W|/max ≤ this
const CSN_ROUND_AREA_MIN = 0.65;      // circle-in-square ≈ 0.785; Step2 uses 0.65

// Step2 nest_type → Step6 method string used by packing / offset
const CSN_TYPE_TO_METHOD = {
  INTERLOCK: 'INTERLOCK_NEST',
  STACK: 'STACK_NEST',
  PARALLEL: 'PARALLEL_BUNDLE',
  FLAT_STACK: 'FLAT_STACK',
  BUNDLE: 'HEX_BUNDLE',
  PER_MARK: 'PER_MARK_STACK',
};

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Decide nest method for one item. Read-only w.r.t. geometry / display.
 * @returns {object|null} nestMethod record
 */
function decideNestMethod(it) {
  if (!it) return null;

  if (!it.crossSection && typeof extractCrossSection === 'function')
    extractCrossSection(it);
  if (!it.csAnalysis && typeof analyzeCrossSection === 'function')
    analyzeCrossSection(it);

  const cs = it.crossSection || null;
  const an = it.csAnalysis || null;

  const welded = csnIsWeldedOrTapered(it, cs, an);
  const open_closed = welded
    ? 'welded'
    : (an?.open_closed || (cs?.welded_like ? 'welded' : null) || 'solid');

  const concavity = Number(an?.concavity_ratio);
  const concavity_ratio = isFinite(concavity) ? concavity : 0;
  const symmetry = Number(
    an?.symmetry_score != null ? an.symmetry_score
      : (an?.symmetry_180 != null ? an.symmetry_180 : 0)
  );
  const symmetry_score = isFinite(symmetry) ? symmetry : 0;
  const has_180 = !!(an?.has_180_symmetry
    || an?.can_alternate_flip
    || an?.can_flip
    || symmetry_score >= CSN_SYM_FLIP_MIN);

  const dims = csnReadCrossDims(it, cs, an);
  const minD = Math.min(dims.a, dims.b);
  const maxD = Math.max(dims.a, dims.b, 1e-9);
  const thin_ratio = minD / maxD;
  const is_thin = thin_ratio < CSN_THIN_RATIO
    || (an?.aspect_ratio > 0 && an.aspect_ratio > 10);
  const is_round = csnIsRound(open_closed, dims, an, thin_ratio);

  let method = 'PARALLEL_BUNDLE';
  let alternate_flip = false;
  let density = 'moderate';
  let reason = 'solid_default';
  let from_step2 = false;

  // ── Prefer Step2 nest_type (canonical geometry decision) ─────────────────
  const step2Type = an?.nest_type ? String(an.nest_type).toUpperCase() : '';
  if (welded) {
    method = 'PER_MARK_STACK';
    density = 'dunnage';
    reason = 'welded_or_tapered';
  } else if (step2Type && CSN_TYPE_TO_METHOD[step2Type]) {
    method = CSN_TYPE_TO_METHOD[step2Type];
    from_step2 = true;
    ({ alternate_flip, density, reason } = csnAnnotateFromStep2(
      method, an, has_180, symmetry_score, is_thin, is_round
    ));
  } else {
    // ── Fallback decision tree (same guide, for incomplete Step2) ─────────
    const decided = csnDecideFromProperties({
      open_closed, concavity_ratio, has_180, symmetry_score,
      is_thin, is_round,
    });
    method = decided.method;
    alternate_flip = decided.alternate_flip;
    density = decided.density;
    reason = decided.reason;
  }

  // Guide invariant: INTERLOCK flip ONLY when 180° symmetry present
  if (method === 'INTERLOCK_NEST') {
    alternate_flip = !!(an?.can_flip != null
      ? an.can_flip
      : (an?.can_alternate_flip != null
        ? an.can_alternate_flip
        : has_180));
    if (!reason || reason === 'step2_INTERLOCK') {
      reason = alternate_flip
        ? 'open_deep_concavity_flip'
        : 'open_deep_concavity_no_flip';
    }
    density = 'dense';
  }

  const nestMethod = {
    method,                 // PER_MARK_STACK | INTERLOCK_NEST | STACK_NEST | …
    alternate_flip,         // true → later nest may flip every other piece
    density,                // dense | moderate | rows | vertical | hex | dunnage
    reason,
    from_step2,
    step2_nest_type: step2Type || null,
    // Echo inputs (informational — not mutations)
    open_closed,
    concavity_ratio,
    symmetry_score,
    is_thin,
    is_round,
    thin_ratio,
    dims_used: { a: dims.a, b: dims.b, t: dims.t },
    applies_to_display: false,
    mutates_geometry: false,
  };

  it.nestMethod = nestMethod;
  return nestMethod;
}

/** Stamp nestMethod on every item (after Step 2 / 5). Never changes shapes. */
function attachNestMethodsToItems(items) {
  const tallies = {};
  let ok = 0, fail = 0, flip = 0;
  (items || []).forEach(it => {
    const nm = decideNestMethod(it);
    if (nm && nm.method) {
      ok++;
      tallies[nm.method] = (tallies[nm.method] || 0) + 1;
      if (nm.alternate_flip) flip++;
    } else fail++;
  });
  try {
    const parts = Object.keys(tallies).map(k => `${k}=${tallies[k]}`).join(' ');
    console.info(
      `[Step6 nest-method] ${ok} ok, ${fail} failed | ${parts}`
      + ` | flip=${flip} (metadata only — shapes unchanged)`
    );
  } catch (_) { /* */ }
  return { ok, fail, total: (items || []).length, tallies, flip };
}

/** Short label for staging UI pills. */
function nestMethodLabel(nm) {
  if (!nm) return '';
  const m = typeof nm === 'string' ? nm : nm.method;
  switch (m) {
    case 'PER_MARK_STACK': return 'Per-mark stack';
    case 'INTERLOCK_NEST': return nm.alternate_flip ? 'Interlock+flip' : 'Interlock nest';
    case 'STACK_NEST': return 'Stack nest';
    case 'PARALLEL_BUNDLE': return 'Parallel bundle';
    case 'FLAT_STACK': return 'Flat stack';
    case 'HEX_BUNDLE': return 'Hex bundle';
    default: return m || '';
  }
}

/** Map Step6 method → coarse staging strategy string (UI / pack hint only). */
function nestMethodToStrategy(nm) {
  const m = nm?.method || nm;
  switch (m) {
    case 'PER_MARK_STACK': return 'SingleUnit';
    case 'INTERLOCK_NEST':
    case 'STACK_NEST': return 'Bundle';
    case 'FLAT_STACK': return 'Stack';
    case 'HEX_BUNDLE':
    case 'PARALLEL_BUNDLE': return 'Bundle';
    default: return 'Bundle';
  }
}

// ── decision helpers ────────────────────────────────────────────────────────

function csnAnnotateFromStep2(method, an, has_180, symmetry_score, is_thin, is_round) {
  switch (method) {
    case 'INTERLOCK_NEST':
      return {
        alternate_flip: !!(an?.can_flip || an?.can_alternate_flip || has_180),
        density: 'dense',
        reason: 'step2_INTERLOCK',
      };
    case 'STACK_NEST':
      return { alternate_flip: false, density: 'moderate', reason: 'step2_STACK' };
    case 'PARALLEL_BUNDLE':
      return { alternate_flip: false, density: 'rows', reason: 'step2_PARALLEL' };
    case 'FLAT_STACK':
      return {
        alternate_flip: false,
        density: 'vertical',
        reason: is_thin ? 'step2_FLAT_STACK_thin' : 'step2_FLAT_STACK',
      };
    case 'HEX_BUNDLE':
      return {
        alternate_flip: false,
        density: 'hex',
        reason: is_round ? 'step2_BUNDLE_round' : 'step2_BUNDLE',
      };
    case 'PER_MARK_STACK':
      return { alternate_flip: false, density: 'dunnage', reason: 'step2_PER_MARK' };
    default:
      return { alternate_flip: false, density: 'moderate', reason: 'step2_' + method };
  }
}

function csnDecideFromProperties(p) {
  const {
    open_closed, concavity_ratio, has_180, symmetry_score, is_thin, is_round,
  } = p;

  if (open_closed === 'welded') {
    return {
      method: 'PER_MARK_STACK',
      alternate_flip: false,
      density: 'dunnage',
      reason: 'welded_or_tapered',
    };
  }
  if (open_closed === 'open' && concavity_ratio > CSN_CONCAVITY_INTERLOCK) {
    return {
      method: 'INTERLOCK_NEST',
      alternate_flip: !!has_180 || symmetry_score >= CSN_SYM_FLIP_MIN,
      density: 'dense',
      reason: (has_180 || symmetry_score >= CSN_SYM_FLIP_MIN)
        ? 'open_deep_concavity_flip'
        : 'open_deep_concavity_no_flip',
    };
  }
  if (open_closed === 'open') {
    return {
      method: 'STACK_NEST',
      alternate_flip: false,
      density: 'moderate',
      reason: 'open_shallow_stack',
    };
  }
  if (open_closed === 'closed') {
    return {
      method: 'PARALLEL_BUNDLE',
      alternate_flip: false,
      density: 'rows',
      reason: 'closed_parallel',
    };
  }
  // solid
  if (is_thin) {
    return {
      method: 'FLAT_STACK',
      alternate_flip: false,
      density: 'vertical',
      reason: 'solid_thin_flat',
    };
  }
  if (is_round) {
    return {
      method: 'HEX_BUNDLE',
      alternate_flip: false,
      density: 'hex',
      reason: 'solid_round_hex',
    };
  }
  return {
    method: 'PARALLEL_BUNDLE',
    alternate_flip: false,
    density: 'side_by_side',
    reason: 'solid_parallel',
  };
}

function csnIsWeldedOrTapered(it, cs, an) {
  if (!it) return false;
  if (an?.open_closed === 'welded' || an?.nest_type === 'PER_MARK'
      || an?.profile_type === 'WELDED')
    return true;
  if (typeof csgIsWeldedOrTapered === 'function') return csgIsWeldedOrTapered(it);

  // Single-part known open/closed/solid profiles are never welded
  const sk = it.shapeKey || it.profileShape || '';
  const nParts = (it.parts && it.parts.length) ? it.parts.length : 0;
  if (nParts <= 1 && (sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle'
      || sk === 'plate' || sk === 'rod' || sk === 'rhs' || sk === 'chs'
      || sk === 'bent_sag_rod' || sk === 'i_beam'))
    return false;

  if (nParts >= 2) return true;
  if (cs?.is_tapered || cs?.welded_like || cs?.welded_assembly) return true;
  if (typeof classifyFamily === 'function' && classifyFamily(it) === 'welded_assembly')
    return true;
  if (/BUILT[\s-]?UP/i.test(String(it.profileDesc || ''))) return true;
  return false;
}

function csnReadCrossDims(it, cs, an) {
  let a = Number(cs?.cs_height || an?.cs_height || it.sectH || 0) || 0;
  let b = Number(cs?.cs_width || an?.cs_width || it.sectW || 0) || 0;
  let t = Number(it.sectT || 0) || 0;
  if (!(a > 0)) a = Number(it.heightMm || 0) || 0;
  if (!(b > 0)) b = Number(it.widthMm || 0) || 0;
  if (!(a > 0)) a = 1;
  if (!(b > 0)) b = 1;
  if (!(t > 0)) t = Math.min(a, b);
  return { a, b, t };
}

function csnIsRound(open_closed, dims, an, thin_ratio) {
  if (open_closed !== 'solid') return false;
  if (thin_ratio < CSN_THIN_RATIO) return false;
  const maxD = Math.max(dims.a, dims.b, 1e-9);
  const aspect = Math.abs(dims.a - dims.b) / maxD;
  if (aspect > CSN_ROUND_ASPECT) return false;
  const ar = Number(an?.area_ratio);
  if (isFinite(ar) && ar >= CSN_ROUND_AREA_MIN && ar < 0.92) return true;
  // Near-square solid with high symmetry → treat as round bar
  const sym = Number(an?.symmetry_180 != null ? an.symmetry_180 : an?.symmetry_score);
  if (isFinite(sym) && sym >= 0.9 && aspect <= CSN_ROUND_ASPECT) return true;
  // Many verts on solid circle outline
  const vc = an?.vertex_count || an?.signature?.vertex_count || 0;
  if (vc >= 16 && aspect <= CSN_ROUND_ASPECT) return true;
  return false;
}
