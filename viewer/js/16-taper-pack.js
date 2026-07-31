/* 16-taper-pack.js — Non-uniform / tapered assembly packing (rigid only)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SHAPE SAFETY — HARD RULES                                           ║
 * ║  • NEVER morph IFC parts / meshes / taper geometry                   ║
 * ║  • NEVER space tapered pieces with a single nesting_offset alone     ║
 * ║  • Anti-align yaw + station clearance, then group rest-pose          ║
 * ║  • Uniform Z/C/L nests are NOT handled here                          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const TAPER_STATION_STEP_MM = 250;
const TAPER_CLEARANCE_MM = 3.0;

function isTaperedOrNonUniformItem(it) {
  if (!it) return false;
  if (it.crossSection?.is_tapered) return true;
  if (it.taperProfile?.non_uniform) return true;
  if (it.nestMethod?.reason === 'welded_or_tapered' && it.crossSection?.is_tapered)
    return true;
  // Multi-part welded with strongly varying part sizes along length
  if (it.isAssembly && it.parts && it.parts.length >= 2) {
    const prof = it.taperProfile || sampleTaperWidthProfile(it);
    return !!(prof && prof.non_uniform);
  }
  return false;
}

/**
 * Sample local cross-section width along member length (mm).
 * Metadata only — does not change geometry.
 */
function sampleTaperWidthProfile(it, stepMm) {
  if (!it) return null;
  if (it.taperProfile && it.taperProfile.stations?.length)
    return it.taperProfile;

  const step = Math.max(50, stepMm || TAPER_STATION_STEP_MM);
  const clear = TAPER_CLEARANCE_MM;
  let stations = [];
  let maxWidthMm = 0;
  let minWidthMm = Infinity;
  let maxHeightMm = 0;
  let minHeightMm = Infinity;
  let source = 'bbox';

  const mesh = (typeof csCollectMesh === 'function') ? csCollectMesh(it) : null;
  if (mesh && mesh.positions?.length >= 9 && mesh.indices?.length >= 3
      && typeof csSliceMeshAt === 'function' && typeof csMeshBounds === 'function') {
    const b = csMeshBounds(mesh.positions);
    const axisInfo = (typeof csLengthAxisFromBounds === 'function')
      ? csLengthAxisFromBounds(b)
      : { length_axis: 'X', member_length: it.lengthMm || b.extentX };
    const length_axis = axisInfo.length_axis || 'X';
    const minA = length_axis === 'X' ? b.minX : length_axis === 'Y' ? b.minY : b.minZ;
    const extent = length_axis === 'X' ? b.extentX : length_axis === 'Y' ? b.extentY : b.extentZ;
    const L = Math.max(extent, Number(it.lengthMm) || 0, 1);
    const n = Math.max(3, Math.ceil(L / step) + 1);

    for (let i = 0; i < n; i++) {
      const t = i / Math.max(n - 1, 1);
      const pos = minA + extent * t;
      const segs = csSliceMeshAt(mesh.positions, mesh.indices, length_axis, pos);
      let w = 0, h = 0;
      if (segs && segs.length) {
        let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
        segs.forEach(s => {
          [s.start, s.end].forEach(p => {
            if (!p) return;
            lo0 = Math.min(lo0, p[0]); hi0 = Math.max(hi0, p[0]);
            lo1 = Math.min(lo1, p[1]); hi1 = Math.max(hi1, p[1]);
          });
        });
        const e0 = Math.max(0, hi0 - lo0);
        const e1 = Math.max(0, hi1 - lo1);
        // Larger CS extent ≈ pack lateral width; other ≈ local section height
        w = Math.max(e0, e1, 0);
        h = (e0 >= e1 ? e1 : e0) || w;
      }
      if (!(w > 0)) {
        // empty slice — interpolate later
        stations.push({ s_mm: t * L, width_mm: 0, height_mm: 0 });
        continue;
      }
      stations.push({ s_mm: t * L, width_mm: w, height_mm: h });
      maxWidthMm = Math.max(maxWidthMm, w);
      minWidthMm = Math.min(minWidthMm, w);
      if (h > 0) {
        maxHeightMm = Math.max(maxHeightMm, h);
        minHeightMm = Math.min(minHeightMm, h);
      }
    }
    // Fill zero slices from neighbors
    for (let i = 0; i < stations.length; i++) {
      if (stations[i].width_mm > 0 && stations[i].height_mm > 0) continue;
      let left = i - 1, right = i + 1;
      while (left >= 0 && !(stations[left].width_mm > 0)) left--;
      while (right < stations.length && !(stations[right].width_mm > 0)) right++;
      const wl = left >= 0 ? stations[left].width_mm : 0;
      const wr = right < stations.length ? stations[right].width_mm : 0;
      const hl = left >= 0 ? stations[left].height_mm : 0;
      const hr = right < stations.length ? stations[right].height_mm : 0;
      if (!(stations[i].width_mm > 0)) {
        stations[i].width_mm = Math.max(wl, wr, Number(it.widthMm) || Number(it.w) || 1);
      }
      if (!(stations[i].height_mm > 0)) {
        stations[i].height_mm = Math.max(hl, hr,
          Number(it.heightMm) || Number(it.h) || stations[i].width_mm || 1);
      }
      maxWidthMm = Math.max(maxWidthMm, stations[i].width_mm);
      minWidthMm = Math.min(minWidthMm, stations[i].width_mm);
      maxHeightMm = Math.max(maxHeightMm, stations[i].height_mm);
      minHeightMm = Math.min(minHeightMm, stations[i].height_mm);
    }
    source = 'mesh_stations';
  }

  if (!stations.length) {
    // Parts / bbox fallback — constant max footprint (safe, not nested)
    const w = Math.max(Number(it.widthMm) || Number(it.w) || 0, 1);
    const h = Math.max(Number(it.heightMm) || Number(it.h) || 0, w);
    const L = Math.max(Number(it.lengthMm) || Number(it.l) || 0, 1);
    stations = [
      { s_mm: 0, width_mm: w, height_mm: h },
      { s_mm: L * 0.5, width_mm: w, height_mm: h },
      { s_mm: L, width_mm: w, height_mm: h },
    ];
    maxWidthMm = w;
    minWidthMm = w;
    maxHeightMm = h;
    minHeightMm = h;
    source = 'bbox_constant';
  }

  if (!isFinite(minWidthMm) || minWidthMm === Infinity) minWidthMm = maxWidthMm;
  if (!isFinite(minHeightMm) || minHeightMm === Infinity) minHeightMm = maxHeightMm || maxWidthMm;
  if (!(maxHeightMm > 0)) maxHeightMm = Math.max(Number(it.heightMm) || Number(it.h) || 0, maxWidthMm, 1);
  const non_uniform = maxWidthMm > 0 && minWidthMm > 0
    && ((maxWidthMm - minWidthMm) / maxWidthMm) > 0.10;
  const height_non_uniform = maxHeightMm > 0 && minHeightMm > 0
    && ((maxHeightMm - minHeightMm) / maxHeightMm) > 0.10;

  const profile = {
    stations,
    maxWidthMm,
    minWidthMm,
    maxHeightMm,
    minHeightMm,
    non_uniform,
    height_non_uniform,
    clearance_mm: clear,
    source,
    // Do not treat a single offset as spacing for non-uniform
    uses_static_offset: !non_uniform,
  };
  it.taperProfile = profile;
  return profile;
}

/**
 * Minimum center-to-center lateral gap (mm) so stations never dig in.
 * antiAlign: second piece yaw 180° → compare station i vs station (n-1-i).
 */
function computeTaperStationGapMm(profileA, profileB, antiAlign, clearanceMm) {
  const clear = clearanceMm != null ? clearanceMm : TAPER_CLEARANCE_MM;
  const a = profileA?.stations || [];
  const b = profileB?.stations || profileA?.stations || [];
  if (!a.length || !b.length) {
    const w = Math.max(profileA?.maxWidthMm || 0, profileB?.maxWidthMm || 0, 1);
    return w + clear;
  }
  const n = Math.max(a.length, b.length);
  let need = 0;
  for (let i = 0; i < n; i++) {
    const wa = a[Math.min(i, a.length - 1)].width_mm || 0;
    const j = antiAlign ? (b.length - 1 - Math.min(i, b.length - 1)) : Math.min(i, b.length - 1);
    const wb = b[j].width_mm || 0;
    need = Math.max(need, wa * 0.5 + wb * 0.5 + clear);
  }
  // Ceiling: never less than max-width packing (safe)
  const ceiling = Math.max(profileA?.maxWidthMm || 0, profileB?.maxWidthMm || 0, 1) + clear;
  return Math.min(Math.max(need, clear + 1), ceiling);
}

/**
 * Side-by-side tapered / welded assemblies: anti-align + station gap.
 * Call before ensureStableShape (makeShape wrapper). Rigid only.
 */
function makeTaperedAssemblyBundle(it, color, opacity) {
  const group = new THREE.Group();
  const qty = Math.max(1, Math.min(it.qty || 1, 24));
  if (qty <= 1 || typeof makeIfcAssembly !== 'function') {
    return typeof makeIfcAssembly === 'function'
      ? makeIfcAssembly(it, color, opacity)
      : group;
  }

  const profile = sampleTaperWidthProfile(it);
  const clear = profile?.clearance_mm != null ? profile.clearance_mm : TAPER_CLEARANCE_MM;
  const gapMm = computeTaperStationGapMm(profile, profile, true, clear);
  const S = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;

  const childBase = {
    ...it,
    qty: 1,
    _assemblyChild: false,
    _skipStability: true, // stabilize outer group only
    taperProfile: profile,
  };

  for (let k = 0; k < qty; k++) {
    const piece = makeIfcAssembly(childBase, color, opacity);
    // Anti-align: odd pieces yaw 180° about vertical so fat↔thin
    if (k % 2 === 1) piece.rotation.y += Math.PI;
    piece.position.z = (k - (qty - 1) / 2) * gapMm * S;
    piece.userData.taperAntiAlign = (k % 2 === 1);
    piece.userData.taperGapMm = gapMm;
    group.add(piece);
  }

  if (typeof recenterGroupAabb === 'function') recenterGroupAabb(group);

  it.taperPackInfo = {
    qty,
    gap_mm: gapMm,
    anti_align: true,
    fit_mode: 'station_clearance',
    maxWidthMm: profile?.maxWidthMm || 0,
    non_uniform: !!profile?.non_uniform,
    mutates_geometry: false,
  };
  try {
    console.info(
      `[taper-pack] ${it.mark || '?'} qty=${qty} gap=${gapMm.toFixed(1)}mm`
      + ` antiAlign=1 stations=${profile?.stations?.length || 0} (no static offset)`
    );
  } catch (_) { /* */ }
  return group;
}

/** Packing helper: true AABB-ish footprint width for one tapered unit (mm). */
function taperPackFootprintMm(it) {
  const profile = sampleTaperWidthProfile(it);
  const qty = Math.max(1, it.qty || 1);
  if (qty <= 1) {
    return {
      w: Math.max(profile?.maxWidthMm || it.widthMm || it.w || 1, 1),
      h: Math.max(it.heightMm || it.h || profile?.maxWidthMm || 1, 1),
      gap_mm: 0,
    };
  }
  const gap = computeTaperStationGapMm(profile, profile, true, TAPER_CLEARANCE_MM);
  // Row of qty pieces along width
  const w = gap * (qty - 1) + Math.max(profile?.maxWidthMm || 0, 1);
  const h = Math.max(it.heightMm || it.h || profile?.minWidthMm || 1, 1);
  return { w, h, gap_mm: gap };
}
