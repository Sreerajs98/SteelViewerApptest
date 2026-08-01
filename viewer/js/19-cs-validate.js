/* 19-cs-validate.js — STEP 9 ONLY: Validation rules + configurable settings
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER morph meshes / ExtrudeGeometry / sect dims / parts          ║
 * ║  • NEVER rewrite lengthMm/widthMm/heightMm/sect* on restore          ║
 * ║  • Validation may REJECT / RESTORE poses only — never rewrite CS     ║
 * ║  • Unfit items → EXACT previous world pose (pre-optimise)            ║
 * ║  • Geometry is the rule book — zero profile-name hardcodes here      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Order: ORIENT → GROUP → NEST → PACK (always)
 */

// ── CONFIGURABLE SETTINGS (defaults match Step 9 spec) ──────────────────────

var PACK_CONFIG = {
  clearance: {
    nesting_mm: 3.0,
    parallel_bundle_mm: 2.5,
    // Safe-zone (see 00-loading-rules.js) — internal volume inset
    bundle_to_bundle_mm: 20,
    bundle_to_wall_mm: 2.5,         // legacy single-value → side
    bundle_to_wall_side_mm: 2.5,
    bundle_to_wall_end_mm: 2.5,
    bundle_to_wall_top_mm: 2.5,
    floor_clearance_mm: 0,
    skid_height_mm: 100,            // pack-unit bbox vertical enclosure
    dunnage_mm: 75,
  },
  cog: {
    max_offset_frac: 0.10,
  },
  limits: {
    max_bundle_kg: 3000,
    max_rod_bundle_kg: 2000,
    max_container_kg: 26000,
    max_set_interlock: 12,
    max_set_stack: 20,
    max_set_parallel: 15,
    max_set_flat: 10,
    max_set_hex: 18,
    max_set_per_mark: 2,
  },
  scoring: {
    stability_weight: 0.6,
    stackability_weight: 0.4,
  },
  container: {
    type: '40ft',
    lengthMm: 12192,
    widthMm: 2438,
    heightMm: 2591,
    maxWeightKg: 26000,
  },
  tolerances: {
    dim_h_w_mm: 2,
    dim_t_mm: 0.15,
    signature_pct: 0.05,
    length_bin_mm: 50,
  },
  support: {
    min_frac: 0.40,                 // upper / Pass2 loose fill
    floor_anchor_min_frac: 0.80,    // Rule #1 Floor Anchor bearing
    max_overhang_frac: 0.30,
  },
  floor_anchor: {
    enabled: true,
    support_min_frac: 0.80,
    yaw_longitudinal_only: true,    // 0° / 180° only
    require_floor_y: true,          // MinY == 0 or skid
  },
  rules: {
    yaw_only: true,
    weight_before_volume: true,
    nest_offset_never_zero: true,
    floor_anchor_first: true,
    pipeline_order: ['orient', 'group', 'nest', 'pack'],
  },
};

const PACK_CONTAINER_PRESETS = {
  '20ft':     { lengthMm: 5898,  widthMm: 2352, heightMm: 2393, maxWeightKg: 26000 },
  '40ft':     { lengthMm: 12032, widthMm: 2352, heightMm: 2393, maxWeightKg: 26000 },
  '40ft HC':  { lengthMm: 12032, widthMm: 2352, heightMm: 2698, maxWeightKg: 26000 },
  '45ft':     { lengthMm: 13556, widthMm: 2352, heightMm: 2698, maxWeightKg: 26000 },
  'Flat Rack':{ lengthMm: 12032, widthMm: 2352, heightMm: 2100, maxWeightKg: 40000 },
  'Open Top': { lengthMm: 12032, widthMm: 2352, heightMm: 2352, maxWeightKg: 26000 },
  '40ft ISO': { lengthMm: 12192, widthMm: 2438, heightMm: 2591, maxWeightKg: 26000 },
};

function getPackConfig() {
  return PACK_CONFIG;
}

function setPackConfig(partial) {
  if (!partial || typeof partial !== 'object') return PACK_CONFIG;
  PACK_CONFIG = cs9MergeDeep(PACK_CONFIG, partial);
  cs9ClampConfig(PACK_CONFIG);
  try { console.info('[Step9 config] updated', PACK_CONFIG); } catch (_) { /* */ }
  return PACK_CONFIG;
}

function applyContainerPreset(typeName) {
  const p = PACK_CONTAINER_PRESETS[typeName];
  if (!p) return null;
  PACK_CONFIG.container = { type: typeName, ...p };
  return PACK_CONFIG.container;
}

function cfgClearance(key, fallback) {
  const c = PACK_CONFIG.clearance || {};
  const v = c[key];
  return (v != null && isFinite(v)) ? v : fallback;
}

function cfgLimit(key, fallback) {
  const c = PACK_CONFIG.limits || {};
  const v = c[key];
  return (v != null && isFinite(v)) ? v : fallback;
}

function cfgTol(key, fallback) {
  const c = PACK_CONFIG.tolerances || {};
  const v = c[key];
  return (v != null && isFinite(v)) ? v : fallback;
}

function cfgSupport(key, fallback) {
  const c = PACK_CONFIG.support || {};
  const v = c[key];
  return (v != null && isFinite(v)) ? v : fallback;
}

function cfgScoring() {
  const s = PACK_CONFIG.scoring || {};
  let sw = s.stability_weight != null ? s.stability_weight : 0.6;
  let tw = s.stackability_weight != null ? s.stackability_weight : 0.4;
  const sum = sw + tw;
  if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
    sw /= sum; tw /= sum;
  }
  return { stability_weight: sw, stackability_weight: tw };
}

function cfgMaxSetForMethod(method) {
  switch (method) {
    case 'INTERLOCK_NEST': return cfgLimit('max_set_interlock', 12);
    case 'STACK_NEST': return cfgLimit('max_set_stack', 20);
    case 'PARALLEL_BUNDLE': return cfgLimit('max_set_parallel', 15);
    case 'FLAT_STACK': return cfgLimit('max_set_flat', 10);
    case 'HEX_BUNDLE': return cfgLimit('max_set_hex', 18);
    case 'PER_MARK_STACK': return cfgLimit('max_set_per_mark', 2);
    default: return cfgLimit('max_set_parallel', 15);
  }
}

function cfgNestClearanceMm(method) {
  if (method === 'PARALLEL_BUNDLE')
    return cfgClearance('parallel_bundle_mm', 2.5);
  return cfgClearance('nesting_mm', 3.0);
}

function cfgEnsureNestOffset(offsetMm, method) {
  const o = Number(offsetMm) || 0;
  if (PACK_CONFIG.rules && PACK_CONFIG.rules.nest_offset_never_zero === false)
    return Math.max(o, 0);
  // Guide: FLAT_STACK offset = thickness only — never force nest clearance
  if (method === 'FLAT_STACK') return Math.max(o, 0.5);
  const clear = cfgNestClearanceMm(method);
  return Math.max(o, clear, 0.5);
}

// ── VALIDATION ──────────────────────────────────────────────────────────────

function validatePackLayout(layout, opts) {
  const o = opts || {};
  const violations = [];
  const warnings = [];
  const cfg = getPackConfig();
  const containers = (layout && layout.containers) || [];
  const rules = (typeof getLoadingRules === 'function') ? getLoadingRules() : null;
  const wallSide = rules ? rules.WALL_CLEARANCE_SIDE_MM
    : cfgClearance('bundle_to_wall_side_mm', cfgClearance('bundle_to_wall_mm', 50));
  const wallEnd = rules ? rules.WALL_CLEARANCE_END_MM
    : cfgClearance('bundle_to_wall_end_mm', 100);
  const gap = rules ? rules.MIN_BUNDLE_GAP_MM : cfgClearance('bundle_to_bundle_mm', 20);
  const maxKg = cfgLimit('max_container_kg', 26000);
  const supportMin = cfgSupport('min_frac', 0.40);
  const floorAnchorMin = cfgSupport('floor_anchor_min_frac', 0.80);
  const overhangMax = cfgSupport('max_overhang_frac', 0.30);

  if (o.pipeline && Array.isArray(o.pipeline)) {
    const want = (cfg.rules && cfg.rules.pipeline_order) || ['orient', 'group', 'nest', 'pack'];
    for (let i = 0; i < want.length; i++) {
      if (o.pipeline[i] !== want[i]) {
        warnings.push({
          rule: 1, code: 'pipeline_order',
          msg: `Expected ${want.join('→')}, got ${(o.pipeline || []).join('→')}`,
        });
        break;
      }
    }
  }

  containers.forEach((c, ci) => {
    const L = c.lengthMm || cfg.container.lengthMm;
    const W = c.widthMm || cfg.container.widthMm;
    const items = c.items || [];

    let wSum = 0;
    items.forEach(it => { wSum += (it.unitWeightKg || it.weight || 0) * (it.qty || 1); });
    if (wSum > maxKg + 1e-3) {
      violations.push({
        rule: 12, code: 'container_weight',
        container: ci + 1, weight: wSum, max: maxKg,
        msg: `Container weight ${wSum.toFixed(1)}kg > ${maxKg}kg`,
      });
    }

    for (let i = 0; i < items.length; i++) {
      const a = cs9ItemBox(items[i], L, W);
      if (!a) continue;

      const ur = items[i].userRot;
      if (ur && (Math.abs(ur.x) > 1e-6 || Math.abs(ur.z) > 1e-6)) {
        violations.push({
          rule: 10, code: 'tilt_forbidden',
          mark: items[i].mark, container: ci + 1,
          msg: `Item ${items[i].mark} has X/Z rotation — only Y allowed`,
        });
      }

      if (items[i]._floatSuspect) {
        violations.push({
          rule: 8, code: 'floating',
          mark: items[i].mark, container: ci + 1,
          msg: `Item ${items[i].mark} base not on floor/solid`,
        });
      }

      {
        const need = (items[i].floorAnchor || items[i].baseLayerLock)
          ? floorAnchorMin : supportMin;
        if (items[i]._supportFrac != null && items[i]._supportFrac < need - 1e-9) {
          violations.push({
            rule: 9, code: 'support',
            mark: items[i].mark, container: ci + 1,
            msg: `Support ${(items[i]._supportFrac * 100).toFixed(0)}%`
              + ` < ${(need * 100).toFixed(0)}%`
              + ((items[i].floorAnchor || items[i].baseLayerLock)
                ? ' (Floor Anchor)' : ''),
          });
        }
      }
      // Rule #1: floor-anchor cargo must not tip / use 90° yaw
      if (items[i].floorAnchor || items[i].baseLayerLock) {
        const ur = items[i].userRot;
        const yaw = ur && ur.y != null ? Math.abs(ur.y) : 0;
        const yawOk = yaw < 0.15
          || Math.abs(yaw - Math.PI) < 0.15
          || Math.abs(yaw - Math.PI * 2) < 0.15;
        if (ur && !yawOk) {
          violations.push({
            rule: 1, code: 'floor_anchor_yaw',
            mark: items[i].mark, container: ci + 1,
            msg: `Floor Anchor ${items[i].mark}: yaw must be 0°/180°`,
          });
        }
      }
      if (items[i]._overhangFrac != null && items[i]._overhangFrac > overhangMax + 1e-9) {
        violations.push({
          rule: 9, code: 'overhang',
          mark: items[i].mark, container: ci + 1,
          msg: `Overhang ${(items[i]._overhangFrac * 100).toFixed(0)}% > 30%`,
        });
      }

      const bw = (items[i].unitWeightKg || items[i].weight || 0);
      const maxB = cfgLimit('max_bundle_kg', 3000);
      if (bw > maxB + 1e-3) {
        violations.push({
          rule: 12, code: 'bundle_weight',
          mark: items[i].mark, weight: bw, max: maxB,
          msg: `Bundle ${items[i].mark} ${bw.toFixed(1)}kg > ${maxB}kg`,
        });
      }

      if (a.minX < wallEnd - 1 || a.maxX > L - wallEnd + 1
          || a.minZ < wallSide - 1 || a.maxZ > W - wallSide + 1) {
        warnings.push({
          rule: 14, code: 'wall_clearance',
          mark: items[i].mark, container: ci + 1,
          msg: `Safe-zone clearance (end ${wallEnd}mm / side ${wallSide}mm) for ${items[i].mark}`,
        });
      }

      for (let j = i + 1; j < items.length; j++) {
        const b = cs9ItemBox(items[j], L, W);
        if (!b) continue;
        const ai = cs9Inflate(a, gap * 0.5);
        const bi = cs9Inflate(b, gap * 0.5);
        if (cs9AabbOverlap(ai, bi)) {
          if (cs9AabbOverlap(a, b)) {
            violations.push({
              rule: 13, code: 'collision',
              mark: items[i].mark, other: items[j].mark, container: ci + 1,
              msg: `AABB collision ${items[i].mark} ↔ ${items[j].mark}`,
            });
          } else {
            warnings.push({
              rule: 14, code: 'bundle_gap',
              mark: items[i].mark, other: items[j].mark, container: ci + 1,
              msg: `Bundle gap < ${gap}mm: ${items[i].mark} ↔ ${items[j].mark}`,
            });
          }
        }
      }
    }

    for (let i = 0; i < items.length; i++) {
      const a = cs9ItemBox(items[i], L, W);
      if (!a || a.minY < 2) continue;
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const b = cs9ItemBox(items[j], L, W);
        if (!b) continue;
        if (Math.abs(b.maxY - a.minY) > cfgClearance('dunnage_mm', 75) + 5) continue;
        if (!cs9FootprintOverlap(a, b)) continue;
        const fa = cs9Family(items[i]);
        const fb = cs9Family(items[j]);
        if (fa && fb && fa !== fb) {
          const gapY = a.minY - b.maxY;
          const need = cfgClearance('dunnage_mm', 75);
          if (gapY + 1 < need * 0.5) {
            warnings.push({
              rule: 15, code: 'dunnage',
              mark: items[i].mark, other: items[j].mark, container: ci + 1,
              msg: `Dunnage needed between ${fb} → ${fa} (got ${gapY.toFixed(0)}mm)`,
            });
          }
        }
      }
    }
  });

  if (o.stagingGroups) {
    cs9ValidateStagingGroups(o.stagingGroups, violations, warnings);
  }

  const ok = violations.length === 0;
  try {
    console.info(
      `[Step9 validate] ${ok ? 'OK' : 'FAIL'} — ${violations.length} violation(s),`
      + ` ${warnings.length} warning(s)`
    );
  } catch (_) { /* */ }

  return { ok, violations, warnings };
}

function cs9ValidateStagingGroups(groups, violations, warnings) {
  (groups || []).forEach(g => {
    const pcs = g.memberPieces || g.memberItems || [];
    const surfs = new Set();
    const dests = new Set();
    pcs.forEach(p => {
      surfs.add(String(p.surfaceTreatment || g.surfaceTreatment || 'BARE').toUpperCase());
      dests.add(String(p.destination || g.destination || 'DEFAULT').toUpperCase());
    });
    if (surfs.size > 1) {
      violations.push({
        rule: 4, code: 'surface_mix', group: g.id || g.mark,
        msg: `Mixed surface treatments in ${g.id || g.mark}: ${[...surfs].join(',')}`,
      });
    }
    if (dests.size > 1) {
      violations.push({
        rule: 5, code: 'destination_mix', group: g.id || g.mark,
        msg: `Mixed destinations in ${g.id || g.mark}: ${[...dests].join(',')}`,
      });
    }
    if (g.groupKind === 'welded_assembly' && (g.marks || []).length > 1) {
      violations.push({
        rule: 6, code: 'welded_merge', group: g.id || g.mark,
        msg: `Welded multi-part merged across marks in ${g.id}`,
      });
    }
    const method = g.nestMethod?.method || g.nest_method
      || (g.packUnits && g.packUnits[0] && g.packUnits[0].nest_method);
    const off = g.nestingOffsetMm || g.nestingInfo?.nesting_offset
      || (g.packUnits && g.packUnits[0] && g.packUnits[0].nesting_offset);
    if (method && method !== 'PER_MARK_STACK' && method !== 'FLAT_STACK') {
      if (!(Number(off) > 0)) {
        warnings.push({
          rule: 7, code: 'nest_offset_zero', group: g.id || g.mark,
          msg: `Nesting offset is zero for ${g.id || g.mark} (${method})`,
        });
      }
    }
  });
}

function enforceValidationOnLayout(layout, opts) {
  const report = validatePackLayout(layout, opts);
  if (!layout) return { layout, report, rejected: [] };
  const rejected = [];
  const badMarks = new Set();

  report.violations.forEach(v => {
    if (v.mark) badMarks.add(v.mark);
    if (v.other && (v.code === 'collision')) badMarks.add(v.other);
  });

  if (!badMarks.size) return { layout, report, rejected };

  (layout.containers || []).forEach(c => {
    const keep = [];
    (c.items || []).forEach(it => {
      const marks = [it.mark, ...(it.marks || [])].filter(Boolean);
      if (marks.some(m => badMarks.has(m))) rejected.push(it);
      else keep.push(it);
    });
    c.items = keep;
  });
  layout.oversized = (layout.oversized || []).concat(rejected);
  return { layout, report, rejected };
}

/**
 * Restore unfit units to EXACT pre-optimise world pose.
 * SHAPE SAFE: uses ONLY prevPose.item geometry — never packer envelope dims.
 * One mesh per previous visual unit (no mark-duplication).
 */
function restoreUnfitToPrevPose(unfitUnits, prevPose, placedMarks, spec) {
  const keepOutside = [];
  const seenMarks = new Set();
  const seenPoseKeys = new Set();
  const placed = placedMarks || new Set();
  const W = (spec && spec.widthMm) || PACK_CONFIG.container.widthMm || 2438;

  function poseKey(prev) {
    if (!prev) return null;
    const it = prev.item || {};
    if (it.stagingGroupId != null && it.packUnitIndex != null)
      return `pu:${it.stagingGroupId}#${it.packUnitIndex}`;
    if (it.stagingGroupId != null)
      return `g:${it.stagingGroupId}|${Math.round(prev.x)}|${Math.round(prev.z)}`;
    return `xyz:${Math.round(prev.x)}|${Math.round(prev.y)}|${Math.round(prev.z)}|${it.mark || ''}`;
  }

  /** Clone geometry fields from pre-optimise item ONLY — never from packer reject. */
  function cloneShapeSafe(prevItem, mark, allMarks) {
    const src = prevItem || {};
    return {
      mark: mark || src.mark,
      marks: allMarks && allMarks.length ? [...allMarks]
        : (src.marks && src.marks.length ? [...src.marks] : [mark || src.mark]),
      assemblyName: src.assemblyName,
      category: src.category,
      profileShape: src.profileShape,
      profileDesc: src.profileDesc,
      shapeKey: src.shapeKey,
      // Exact original dims — DO NOT take packer l/w/h
      lengthMm: src.lengthMm || src.l,
      widthMm: src.widthMm || src.w,
      heightMm: src.heightMm || src.h,
      l: src.lengthMm || src.l,
      w: src.widthMm || src.w,
      h: src.heightMm || src.h,
      sectH: src.sectH, sectW: src.sectW, sectT: src.sectT,
      sectD: src.sectD, sectTf: src.sectTf, sectTw: src.sectTw,
      unitHeight: src.unitHeight, unitWidth: src.unitWidth,
      unitDiam: src.unitDiam, unitThickness: src.unitThickness,
      qty: src.qty || 1,
      unitWeightKg: src.unitWeightKg || src.weight || 0,
      weight: src.unitWeightKg || src.weight || 0,
      nestPieces: src.nestPieces || null,
      nestingInfo: src.nestingInfo,
      nestingOffsetMm: src.nestingOffsetMm,
      nestMethod: src.nestMethod,
      nested: src.nested, stacked: src.stacked, bundled: src.bundled,
      gridCols: src.gridCols, gridRows: src.gridRows,
      isAssembly: !!src.isAssembly,
      parts: src.parts || null,
      pathPointsMm: src.pathPointsMm || null,
      pathDiamMm: src.pathDiamMm || 0,
      stagingGroupId: src.stagingGroupId,
      packUnitIndex: src.packUnitIndex,
      groupKind: src.groupKind,
      surfaceTreatment: src.surfaceTreatment,
      destination: src.destination,
      taperProfile: src.taperProfile || null,
      mutates_geometry: false,
    };
  }

  function pushRestored(prev, marks, needsRot, fitReason, fitReasonMsg) {
    if (!prev) return;
    const key = poseKey(prev);
    if (key && seenPoseKeys.has(key)) {
      marks.forEach(m => { if (m) seenMarks.add(m); });
      return;
    }
    if (key) seenPoseKeys.add(key);

    const primary = marks.find(m => m && !placed.has(m)) || marks[0] || prev.item?.mark;
    marks.forEach(m => { if (m) seenMarks.add(m); });

    const item = cloneShapeSafe(prev.item, primary, marks);
    // EXACT pose — mm world coords captured before optimise
    item.x = prev.x;
    item.y = prev.y;
    item.z = prev.z;
    item.userRot = prev.rot
      ? { x: prev.rot.x || 0, y: prev.rot.y || 0, z: prev.rot.z || 0 }
      : null;
    item.packYawOnly = false; // full euler restore — do not compose on rest-pose
    item.outsideContainer = true;
    item.needsRotate = !!needsRot;
    item.restoredFromOptimise = true;
    item.exactPoseLock = true; // render must not floor-snap / restack this
    item.fitReason = fitReason || null;
    item.fitReasonMsg = fitReasonMsg || null;
    keepOutside.push(item);
  }

  (unfitUnits || []).forEach(u => {
    const marks = [u.mark, ...(u.marks || [])].filter(Boolean);
    if (!marks.length) return;
    const fitReason = u.fitReason || 'no_fit';
    const fitReasonMsg = u.fitReasonMsg || fitReason;

    // Prefer a mark that still has a captured pre-optimise pose
    let prev = null;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (!m || placed.has(m)) continue;
      if (seenMarks.has(m)) { prev = null; break; }
      if (prevPose && prevPose[m]) { prev = prevPose[m]; break; }
    }
    if (seenMarks.has(marks[0]) && !prev) return;

    if (prev) {
      pushRestored(prev, marks, true, fitReason, fitReasonMsg);
      return;
    }

    // No prev pose for any mark — last-resort park (should be rare)
    const m0 = marks.find(m => m && !placed.has(m) && !seenMarks.has(m));
    if (!m0) return;
    marks.forEach(m => { if (m) seenMarks.add(m); });
    const idx = keepOutside.length;
    const raw = (typeof rawScene !== 'undefined' && rawScene?.items)
      ? rawScene.items.find(it => it.mark === m0) : null;
    const item = cloneShapeSafe(raw || u, m0, marks);
    // Still avoid packer envelope if raw IFC dims exist
    if (raw) {
      item.lengthMm = raw.lengthMm || item.lengthMm;
      item.widthMm = raw.widthMm || item.widthMm;
      item.heightMm = raw.heightMm || item.heightMm;
      item.l = item.lengthMm; item.w = item.widthMm; item.h = item.heightMm;
      item.sectH = raw.sectH; item.sectW = raw.sectW; item.sectT = raw.sectT;
      item.sectD = raw.sectD; item.parts = raw.parts; item.pathPointsMm = raw.pathPointsMm;
    }
    item.x = (item.lengthMm || 500) / 2;
    item.y = (item.heightMm || 200) / 2;
    item.z = W / 2 + 900 + idx * 400;
    item.userRot = null;
    item.packYawOnly = false;
    item.outsideContainer = true;
    item.needsRotate = true;
    item.restoredFromOptimise = true;
    item.exactPoseLock = false; // no prior pose — allow floor sit
    item.fitReason = fitReason;
    item.fitReasonMsg = fitReasonMsg;
    keepOutside.push(item);
  });

  try {
    console.info(
      `[Step9 restore] ${keepOutside.length} unit(s) → exact pre-optimise pose (shapes unchanged)`
    );
  } catch (_) { /* */ }

  return keepOutside;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function cs9ItemBox(it, L, W) {
  if (!it) return null;
  // Prefer pack footprint (post-yaw AABB); fall back to construct dims
  const l = it.packFootprintL || it.lengthMm || it.l || 0;
  const w = it.packFootprintW || it.widthMm || it.w || 0;
  const h = it.packFootprintH || it.heightMm || it.h || 0;
  if (!(l > 0 && w > 0 && h > 0)) return null;
  // Item x/y/z are CENTER coords (x along length, z relative to container centreline)
  const cx = it.x != null ? it.x : l / 2;
  const cy = it.y != null ? it.y : h / 2;
  const cz = it.z != null ? it.z : 0;
  return {
    minX: cx - l / 2, maxX: cx + l / 2,
    minY: cy - h / 2, maxY: cy + h / 2,
    minZ: cz - w / 2, maxZ: cz + w / 2,
  };
}

function cs9Inflate(b, m) {
  return {
    minX: b.minX - m, maxX: b.maxX + m,
    minY: b.minY, maxY: b.maxY,
    minZ: b.minZ - m, maxZ: b.maxZ + m,
  };
}

function cs9AabbOverlap(a, b) {
  return a.maxX > b.minX && a.minX < b.maxX
    && a.maxY > b.minY && a.minY < b.maxY
    && a.maxZ > b.minZ && a.minZ < b.maxZ;
}

function cs9FootprintOverlap(a, b) {
  return a.maxX > b.minX && a.minX < b.maxX
    && a.maxZ > b.minZ && a.minZ < b.maxZ;
}

function cs9Family(it) {
  return it.groupKind || it.category || it.profileShape || it.shapeKey || null;
}

function cs9MergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  Object.keys(patch || {}).forEach(k => {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv)
        && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = cs9MergeDeep(base[k], pv);
    } else {
      out[k] = pv;
    }
  });
  return out;
}

function cs9ClampConfig(cfg) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const c = cfg.clearance;
  if (c) {
    c.nesting_mm = clamp(c.nesting_mm, 0, 10);
    c.parallel_bundle_mm = clamp(c.parallel_bundle_mm, 0, 20);
    c.bundle_to_bundle_mm = clamp(c.bundle_to_bundle_mm, 10, 100);
    c.bundle_to_wall_mm = clamp(c.bundle_to_wall_mm, 0, 200);
    if (c.bundle_to_wall_side_mm != null)
      c.bundle_to_wall_side_mm = clamp(c.bundle_to_wall_side_mm, 0, 200);
    if (c.bundle_to_wall_end_mm != null)
      c.bundle_to_wall_end_mm = clamp(c.bundle_to_wall_end_mm, 0, 300);
    if (c.bundle_to_wall_top_mm != null)
      c.bundle_to_wall_top_mm = clamp(c.bundle_to_wall_top_mm, 0, 200);
    if (c.floor_clearance_mm != null)
      c.floor_clearance_mm = clamp(c.floor_clearance_mm, 0, 100);
    if (c.skid_height_mm != null)
      c.skid_height_mm = clamp(c.skid_height_mm, 0, 300);
    c.dunnage_mm = clamp(c.dunnage_mm, 25, 150);
  }
  if (cfg.cog && cfg.cog.max_offset_frac != null) {
    cfg.cog.max_offset_frac = clamp(cfg.cog.max_offset_frac, 0.05, 0.25);
  }
  const L = cfg.limits;
  if (L) {
    L.max_bundle_kg = clamp(L.max_bundle_kg, 1000, 5000);
    L.max_container_kg = clamp(L.max_container_kg, 5000, 50000);
    L.max_set_interlock = clamp(L.max_set_interlock | 0, 4, 20);
    L.max_set_stack = clamp(L.max_set_stack | 0, 5, 30);
    L.max_set_parallel = clamp(L.max_set_parallel | 0, 4, 25);
  }
  const s = cfg.scoring;
  if (s) {
    s.stability_weight = clamp(s.stability_weight, 0.3, 0.8);
    s.stackability_weight = clamp(s.stackability_weight, 0.2, 0.7);
  }
}

function collectUnfitFromLayout(layout, attemptedMarks) {
  const placed = new Set();
  (layout?.containers || []).forEach(c => {
    (c.items || []).forEach(it => {
      if (it.mark) placed.add(it.mark);
      (it.marks || []).forEach(m => { if (m) placed.add(m); });
    });
  });
  const unfit = [];
  const seen = new Set();
  (layout?.oversized || []).forEach(u => {
    const marks = [u.mark, ...(u.marks || [])].filter(Boolean);
    marks.forEach(m => {
      if (seen.has(m)) return;
      seen.add(m);
      unfit.push(u);
    });
  });
  (attemptedMarks || []).forEach(m => {
    if (!m || placed.has(m) || seen.has(m)) return;
    seen.add(m);
    unfit.push({ mark: m, marks: [m], fitReason: 'no_fit' });
  });
  return { placed, unfit };
}
