/* 01-staging-ui.js — staging, containers, grouping, refreshScene */


// ═══════════════════════════════════════════════════════════════════════
// PILLAR 5 — STAGING + CONTAINER MANAGER UI
// ═══════════════════════════════════════════════════════════════════════

// State
let assemblyGroups   = [];   // all groups from grouping engine
let activeContainerId = null;
let containers        = [];   // [{ id, label, spec, items:[], weightKg, volPct }]
let draggedGroup      = null;
let selectedGroup     = null;
let stagingFilter     = '';
/** 'set' = whole bundle, 'piece' = single child mesh */
let selectMode        = 'set';
/** When true: drag always clamps into active container (never outside walls). */
let moveMode          = false;
/** @deprecated kept for old callers — use freeDragOutside */
let outsideMoveMode   = false;
/** After Group: drag sets in 3D directly (no Move button). Default ON. */
let freeDragOutside   = true;
/** User-applied mesh rotations by mark — preserved on Optimise & Place */
let userRotations     = {};  // mark -> { x, y, z }

// ── Staging area ───────────────────────────────────────────────────────

function buildStagingArea(groups) {
  assemblyGroups = groups || [];
  renderStagingList();
  updateStagingFooter();
  updateWorkflowUI();
}

function filterStaging(q) {
  stagingFilter = (q || '').toLowerCase().trim();
  renderStagingList();
}

function groupSearchText(g) {
  const parts = [
    g.mark, g.name, g.profileDesc, g.shapeKey, g.profileShape,
    g.strategy, g.category, g.containerId,
    g.flag, g.grid, g.remarks,
    ...(g.marks || []),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function getFilteredGroups() {
  if (!stagingFilter) return assemblyGroups.slice();
  return assemblyGroups.filter(g => groupSearchText(g).includes(stagingFilter));
}

/** Best available kg for a staging group (card + members + pack units). */
function groupSortWeightKg(g) {
  if (!g) return 0;
  let kg = Math.max(0, Number(g.weightKg) || 0);
  const mem = g.memberItems || g.memberPieces || [];
  if (mem.length) {
    const sum = mem.reduce((s, p) =>
      s + Math.max(0, Number(p.unitWeightKg) || 0) * Math.max(1, Number(p.qty) || 1), 0);
    if (sum > kg) kg = sum;
  }
  const pus = g.packUnits || [];
  if (pus.length) {
    const puSum = pus.reduce((s, pu) =>
      s + Math.max(0, Number(pu.total_weight) || Number(pu.weightKg) || 0), 0);
    if (puSum > kg) kg = puSum;
  }
  g.sortWeightKg = kg;
  return kg;
}

/**
 * Group / staging list: PURE weight high → low (no assembly-first).
 * Ties: welded assemblies first, then longer.
 */
function sortStagingGroupsByWeight(groups) {
  const list = groups || [];
  const isAsm = (g) =>
    g.groupKind === 'welded_assembly'
    || !!(g.isAssembly && g.parts && g.parts.length >= 2);
  list.sort((a, b) => {
    const dw = groupSortWeightKg(b) - groupSortWeightKg(a);
    if (Math.abs(dw) > 1e-6) return dw;
    const aA = isAsm(a) ? 0 : 1;
    const bA = isAsm(b) ? 0 : 1;
    if (aA !== bA) return aA - bA;
    return (b.lengthMaxMm || 0) - (a.lengthMaxMm || 0);
  });
  list.forEach((g, i) => {
    g.id = g.id || `G${i + 1}`;
    g.weightRank = i + 1; // 1 = heaviest
  });
  return list;
}

/** Heaviest welded assemblies (base candidates) — for toast / debug. */
function heaviestAssemblyGroups(groups, n) {
  const lim = n != null ? n : 3;
  return (groups || [])
    .filter(g => g.groupKind === 'welded_assembly'
      || !!(g.isAssembly && g.parts && g.parts.length >= 2))
    .slice()
    .sort((a, b) => (b.weightKg || 0) - (a.weightKg || 0))
    .slice(0, lim);
}

function nextCheckOrder() {
  let max = 0;
  assemblyGroups.forEach(g => {
    if (g.checked && (g.checkOrder || 0) > max) max = g.checkOrder;
  });
  return max + 1;
}

/** Keep pack-order numbers contiguous after uncheck (1,2,3…). */
function renumberCheckOrder() {
  const ordered = assemblyGroups
    .filter(g => g.checked)
    .sort((a, b) => (a.checkOrder || 0) - (b.checkOrder || 0));
  ordered.forEach((g, i) => { g.checkOrder = i + 1; });
  assemblyGroups.forEach(g => { if (!g.checked) g.checkOrder = 0; });
}

function toggleSelectAll(checked) {
  if (!requireGrouped('pick items')) {
    const box = document.getElementById('selectAllBox');
    if (box) box.checked = false;
    return;
  }
  const filtered = getFilteredGroups().filter(g => g.state !== 'oversized');
  if (!checked) {
    // Untick → clear all checks; if Group by Shape is active, restore pre-group list
    filtered.forEach(g => { g.checked = false; g.checkOrder = 0; });
    assemblyGroups.forEach(g => { g.checked = false; g.checkOrder = 0; });
    if (_ungroupedGroups && _ungroupedGroups.length) {
      ungroupAll();
      showToast('Select all cleared — restored items before Group by Shape', 2800);
    }
  } else {
    // Visible list order becomes pack order 1, 2, 3…
    let n = 0;
    filtered.forEach(g => {
      g.checked = true;
      g.checkOrder = ++n;
    });
  }
  renderStagingList();
  updateStagingFooter();
}

function setSelectMode(mode) {
  selectMode = mode === 'piece' ? 'piece' : 'set';
  const setBtn = document.getElementById('selModeSet');
  const pieceBtn = document.getElementById('selModePiece');
  if (setBtn && pieceBtn) {
    const on = 'flex:1;padding:5px 0;border-radius:5px;border:1px solid var(--blue);background:rgba(59,130,246,0.15);color:var(--text);font-size:11px;cursor:pointer';
    const off = 'flex:1;padding:5px 0;border-radius:5px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);font-size:11px;cursor:pointer';
    setBtn.style.cssText = selectMode === 'set' ? on : off;
    pieceBtn.style.cssText = selectMode === 'piece' ? on : off;
  }
  showToast(selectMode === 'set'
    ? 'Select mode: full set (move/rotate together)'
    : 'Select mode: single piece', 2200);
}

function canFreeDragOutside() {
  return isGroupedReady() && freeDragOutside && !moveMode;
}

function updateMoveButtonsUI() {
  const label = document.getElementById('freeDragLabel');
  const box = document.getElementById('freeDragBox');
  const btnIn = document.getElementById('btnMoveMode');
  const grouped = isGroupedReady();

  if (box) {
    box.disabled = !grouped;
    box.checked = !!freeDragOutside;
  }
  if (label) {
    label.style.opacity = grouped ? '1' : '0.45';
    label.style.cursor = grouped ? 'pointer' : 'not-allowed';
    label.style.pointerEvents = grouped ? 'auto' : 'none';
    if (grouped && freeDragOutside && !moveMode) {
      label.style.border = '1px solid var(--blue)';
      label.style.background = 'rgba(59,130,246,0.18)';
      label.style.color = 'var(--text)';
    } else {
      label.style.border = '1px solid var(--border2)';
      label.style.background = grouped ? 'rgba(59,130,246,0.08)' : 'var(--bg3)';
      label.style.color = grouped ? 'var(--text)' : 'var(--text2)';
    }
  }
  if (btnIn) {
    btnIn.disabled = !grouped;
    btnIn.style.opacity = grouped ? '1' : '0.45';
    btnIn.style.cursor = grouped ? 'pointer' : 'not-allowed';
    if (moveMode && grouped) {
      btnIn.style.border = '1px solid var(--blue)';
      btnIn.style.background = 'rgba(59,130,246,0.2)';
      btnIn.style.color = 'var(--text)';
      btnIn.textContent = '→ Into container ON';
    } else {
      btnIn.style.border = '1px solid var(--border2)';
      btnIn.style.background = 'var(--bg3)';
      btnIn.style.color = 'var(--text2)';
      btnIn.textContent = '→ Into container';
    }
  }
  // While dragging a piece: freeze camera. Into-container mode: orbit rotate off.
  if (controls) {
    if (isDragging) {
      controls.enabled = false;
    } else {
      controls.enableRotate = !moveMode;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.enabled = true;
    }
  }
  if (renderer?.domElement) {
    renderer.domElement.style.cursor = isDragging
      ? 'grabbing'
      : (canFreeDragOutside() || moveMode) ? 'grab' : '';
  }
}

/** User option: drag sets in 3D after Group (default ON). */
function setFreeDragOutside(on) {
  if (!isGroupedReady()) {
    freeDragOutside = true;
    if (document.getElementById('freeDragBox')) document.getElementById('freeDragBox').checked = true;
    requireGrouped('drag to rearrange');
    return;
  }
  freeDragOutside = !!on;
  outsideMoveMode = freeDragOutside; // keep legacy flag in sync
  if (freeDragOutside) moveMode = false;
  updateMoveButtonsUI();
  showToast(freeDragOutside
    ? 'Drag ON — click a set and drag to place (no extra button)'
    : 'Drag OFF — orbit freely; turn on to rearrange sets', 2800);
}

/** @deprecated — use setFreeDragOutside / free drag checkbox */
function toggleOutsideMoveMode() {
  setFreeDragOutside(!freeDragOutside);
}

function enableOutsideMoveFromInfo() {
  if (!requireGrouped('drag')) return;
  setFreeDragOutside(true);
  showToast('Drag the set in the 3D view', 2200);
}

function startOutsideMoveForGroup(id) {
  if (!requireGrouped('drag')) return;
  setFreeDragOutside(true);
  selectGroupInScene(id, { frame: false });
  showToast('Drag this set in the 3D view to rearrange', 2600);
}

function toggleMoveMode() {
  if (!requireGrouped('move into container')) return;
  moveMode = !moveMode;
  if (moveMode) {
    freeDragOutside = false;
    outsideMoveMode = false;
    const box = document.getElementById('freeDragBox');
    if (box) box.checked = false;
  } else {
    freeDragOutside = true;
    const box = document.getElementById('freeDragBox');
    if (box) box.checked = true;
  }
  updateMoveButtonsUI();
  showToast(moveMode
    ? 'Into container ON — drag stays in safe-zone (wall clearance, no wall touch)'
    : 'Into container off — free drag restored', 3000);
}

function updateSelectAllBox() {
  const box = document.getElementById('selectAllBox');
  const hint = document.getElementById('selectedCountHint');
  if (!box) return;
  const filtered = getFilteredGroups().filter(g => g.state !== 'oversized');
  const nChecked = filtered.filter(g => g.checked).length;
  box.checked = filtered.length > 0 && nChecked === filtered.length;
  box.indeterminate = nChecked > 0 && nChecked < filtered.length;
  if (hint) {
    if (!isGroupedReady()) {
      hint.textContent = 'Group by Shape first';
    } else {
      hint.textContent = nChecked
        ? `${nChecked} selected · pack order 1→${nChecked}`
        : 'Click items to set pack order 1, 2, 3…';
    }
  }
}

function renderStagingList() {
  const list = document.getElementById('stagingList');
  const empty = document.getElementById('stagingEmpty');
  const count = document.getElementById('stagingCount');

  // Always keep staging in weight high→low after Group by Shape
  if (assemblyGroups.length && typeof isGroupedReady === 'function' && isGroupedReady())
    sortStagingGroupsByWeight(assemblyGroups);

  const filtered = getFilteredGroups();

  if (!assemblyGroups.length) {
    empty.style.display = ''; list.querySelectorAll('.ag-card').forEach(c=>c.remove());
    updateSelectAllBox();
    return;
  }
  empty.style.display = 'none';
  count.textContent = `(${assemblyGroups.length})` + (stagingFilter ? ` · ${filtered.length} shown` : '');

  // Remove old cards
  list.querySelectorAll('.ag-card').forEach(c => c.remove());

  filtered.forEach(g => {
    const card = document.createElement('div');
    card.className = 'ag-card'
      + (g.state === 'placed'   ? ' placed'   : '')
      + (g.state === 'oversized'? ' oversized' : '')
      + (selectedGroup === g   ? ' selected'  : '')
      + (g.checked            ? ' checked-card' : '');
    card.draggable = g.state !== 'placed';
    card.dataset.id = g.id;
    // Keep amber highlight if this card is the current 3D selection
    if (selected?.item) {
      const marks = new Set([selected.item.mark, ...(selected.item.marks || [])].filter(Boolean));
      if (marks.has(g.mark) || (g.marks || []).some(m => marks.has(m)))
        card.classList.add('scene-selected');
    }

    const stratClass = 'strategy-' + (g.strategy || 'single').toLowerCase();
    const orderNum = g.checked ? (g.checkOrder || 0) : 0;
    const orderLabel = orderNum > 0 ? String(orderNum) : '';
    const canPick = isGroupedReady();

    const iconHtml = g.shapeIconSvg
      || '<span class="ag-cs-icon ag-cs-icon-fallback" aria-hidden="true">▣</span>';
    const lenRange = (g.lengthMinMm > 0 && g.lengthMaxMm > 0
      && Math.abs(g.lengthMaxMm - g.lengthMinMm) >= 1)
      ? `${(g.lengthMinMm / 1000).toFixed(1)}–${(g.lengthMaxMm / 1000).toFixed(1)} m`
      : (g.lengthMaxMm > 0 ? `${(g.lengthMaxMm / 1000).toFixed(1)} m` : '');
    const labelOnly = g.profileLabel || g.profileDesc || '';

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span class="ag-order ${g.checked ? 'on' : ''}"
              style="opacity:${canPick ? '1' : '0.4'}"
              title="${canPick
                ? (g.checked ? 'Pack order #' + orderNum + ' — click to deselect' : 'Click to select (next pack order)')
                : 'Step 4 first: Group by Shape (signature)'}"
              onclick="event.stopPropagation();toggleCheck('${g.id}')">${canPick ? (orderLabel || '☐') : '—'}</span>
        <div class="ag-cs-thumb">${iconHtml}</div>
        <div style="flex:1;min-width:0">
          <div class="ag-mark">${g.mark}${g.checked && orderNum ? ` <span style="color:var(--blue);font-weight:600;font-size:11px">#${orderNum}</span>` : ''}</div>
          <div class="ag-name">${g.name || ''}${labelOnly ? ` · <span class="ag-profile-label" title="IFC label only">${labelOnly}</span>` : ''}</div>
          <div class="ag-meta">
            <span class="ag-pill">${g.qty || 1} pcs</span>
            <span class="ag-pill">${Math.round(g.sortWeightKg || g.weightKg || 0)} kg</span>
            ${lenRange ? `<span class="ag-pill">${lenRange}</span>` : ''}
            <span class="ag-pill ${stratClass}">${g.nestMethodLabel || g.strategy || 'Single'}</span>
            ${g.nestingOffsetMm > 0 ? `<span class="ag-pill" title="Step6 nest offset">Δ ${Number(g.nestingOffsetMm).toFixed(1)} mm</span>` : ''}
            ${g.stabilityInfo
              ? `<span class="ag-pill" style="${g.stabilityInfo.stable ? 'border-color:#1D9E7560;color:var(--green)' : 'border-color:var(--red);color:var(--red)'}" title="Auto CoG / rest-pose check">${g.stabilityInfo.stable ? 'Stable' : 'Unstable'}</span>`
              : (g.orientation_info?.vert_key
                ? `<span class="ag-pill" title="Step3 preferred vertical">base ${g.orientation_info.vert_key}</span>`
                : '')}
            ${g.surfaceTreatment ? `<span class="ag-pill">${String(g.surfaceTreatment).replace(/_/g, ' ')}</span>` : ''}
            ${g.destination && g.destination !== 'DEFAULT' ? `<span class="ag-pill">${g.destination}</span>` : ''}
            ${g.checked && orderNum ? `<span class="ag-pill" style="border-color:var(--blue);color:var(--blue)">Order ${orderNum}</span>` : ''}
            ${g.state === 'placed'    ? `<span class="ag-pill state-placed">✓ ${g.containerId}</span>` : ''}
            ${g.state === 'oversized' ? `<span class="ag-pill state-oversized">Oversized</span>` : ''}
            ${g.needsRotate && g.fitReason
              ? `<span class="ag-pill state-oversized" title="${String(g.fitReasonMsg || g.fitReason).replace(/"/g, '&quot;')}">⛔ ${g.fitReason}</span>`
              : (g.needsRotate ? `<span class="ag-pill state-oversized">Outside — no fit</span>` : '')}
          </div>
          ${g.needsRotate && g.fitReasonMsg
            ? `<div style="margin-top:4px;font-size:10.5px;color:var(--red);line-height:1.35" title="Constraint Override Log">Reason: ${g.fitReasonMsg}</div>`
            : ''}
          <div class="ag-actions">
            ${g.state !== 'placed'
              ? `<button class="place-btn" ${canPick ? '' : 'disabled style="opacity:0.4;cursor:not-allowed"'} onclick="event.stopPropagation();placeGroup('${g.id}')">Place in ${activeContainerId||'C1'}</button>`
              : `<button class="unplace-btn" onclick="event.stopPropagation();unplaceGroup('${g.id}')">Remove</button>`}
            <button onclick="event.stopPropagation();selectGroupInScene('${g.id}')">View</button>
            <button onclick="event.stopPropagation();rotateGroupFromStaging('${g.id}')">Rotate</button>
            ${canPick ? `<button onclick="event.stopPropagation();startOutsideMoveForGroup('${g.id}')" style="border-color:var(--blue);color:var(--blue)">Select &amp; drag</button>` : ''}
          </div>
        </div>
      </div>`;

    // Click card body to toggle check (only after Group by Shape)
    card.addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SPAN' || e.target.tagName === 'INPUT') return;
      if (!isGroupedReady()) {
        requireGrouped('pick items');
        return;
      }
      toggleCheck(g.id);
    });
    card.addEventListener('dragstart', e => {
      draggedGroup = g;
      try { e.dataTransfer.setData('text/plain', g.id); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => { draggedGroup = null; });

    list.appendChild(card);
  });

  updateSelectAllBox();
  updateWorkflowUI();
}

function updateStagingFooter() {
  const total   = assemblyGroups.length;
  const placed  = assemblyGroups.filter(g => g.state === 'placed').length;
  const unplaced = total - placed;
  document.getElementById('stagingStats').textContent =
    `${placed}/${total} placed · ${unplaced} remaining`;
}

// ── Drag onto viewport ─────────────────────────────────────────────────

function onViewportDragOver(e) {
  if (!draggedGroup || draggedGroup.state === 'placed') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.getElementById('dropTarget').classList.add('active');
}

function onViewportDragLeave(e) {
  document.getElementById('dropTarget').classList.remove('active');
}

function onViewportDrop(e) {
  e.preventDefault();
  document.getElementById('dropTarget').classList.remove('active');
  if (!draggedGroup || draggedGroup.state === 'placed') return;
  placeGroup(draggedGroup.id);
}

// ── Place / Unplace ────────────────────────────────────────────────────

function placeGroup(id) {
  if (!requireGrouped('Optimise')) return;
  const g = assemblyGroups.find(x => x.id === id);
  if (!g || g.state === 'placed') return;
  if (!rawScene) return;

  // Check this group alone (pack order #1) and run Optimise into current container
  assemblyGroups.forEach(x => {
    x.checked = (x.id === id);
    x.checkOrder = (x.id === id) ? 1 : 0;
  });
  layoutPlaceSelected();
}

function unplaceGroup(id) {
  const g = assemblyGroups.find(x => x.id === id);
  if (!g || g.state !== 'placed') return;

  const cont = containers.find(c => c.id === g.containerId);
  if (cont) {
    cont.items = cont.items.filter(x => x.id !== id);
    cont.weightKg -= (g.weightKg || 0);
  }
  g.state       = 'unplaced';
  g.containerId = null;

  renderStagingList();
  updateStagingFooter();
  renderContainerList();
  updateCog();
  refreshScene();
}

function selectGroupInScene(id, opts) {
  const frame = !opts || opts.frame !== false; // View reframes; Move must not
  const g = assemblyGroups.find(x => x.id === id);
  if (!g) return;

  function findEntry() {
    const marks = new Set();
    if (g.mark) marks.add(g.mark);
    (g.marks || []).forEach(m => { if (m) marks.add(m); });

    return clickable.find(c => {
      if (!c?.item) return false;
      const im = c.item.mark || '';
      if (marks.has(im)) return true;
      if (c.item.marks && c.item.marks.some(m => marks.has(m))) return true;
      for (const m of marks) {
        if (m && (im === m || im.startsWith(m + '-') || im.startsWith(m + '_'))) return true;
      }
      if (g.profileDesc && c.item.profileDesc &&
          String(c.item.profileDesc).toUpperCase() === String(g.profileDesc).toUpperCase() &&
          Math.round(c.item.lengthMm || c.item.l || 0) === Math.round(g.virtualLmm || 0))
        return true;
      return false;
    }) || null;
  }

  const entry = findEntry();
  if (entry) {
    selectItem(entry);
    if (frame) {
      frameCameraOnMesh(entry.mesh);
      showToast(`Viewing ${g.mark}`, 1500);
    }
    return;
  }

  // Move: never rebuild / reframe the scene — keep user's current view
  if (!frame) {
    showToast(`⚠ ${g.mark} not visible in 3D — use View first`, 2800);
    return;
  }

  // View: show current staging layout then frame
  if (rawScene) {
    if (_ungroupedGroups) layoutInspection();
    else layoutOutside();
    const again = findEntry();
    if (again) {
      selectItem(again);
      frameCameraOnMesh(again.mesh);
      showToast(`Viewing ${g.mark}`, 1500);
      return;
    }
  }
  showToast(`⚠ ${g.mark} not in 3D yet — use Rotate, then Optimise & Place`, 2800);
}

/** Explicit rotate — opens the rotate box (not on normal select). */
function rotateGroupFromStaging(id) {
  const g = assemblyGroups.find(x => x.id === id);
  if (!g) return;
  const marks = new Set();
  if (g.mark) marks.add(g.mark);
  (g.marks || []).forEach(m => { if (m) marks.add(m); });
  const entry = clickable.find(c => {
    if (!c?.item) return false;
    if (marks.has(c.item.mark)) return true;
    return (c.item.marks || []).some(m => marks.has(m));
  });
  if (entry) {
    selectItem(entry);
    openRotateForSelection(entry);
    frameCameraOnMesh(entry.mesh);
  } else {
    openRotateForSelection({ item: stagingGroupToItem(g), mesh: null, fromStaging: true, stagingGroup: g });
  }
  showToast(`Rotate ${g.mark} — Apply when done`, 2200);
}

/** Build a makeShape-compatible item from a staging assembly group. */
function stagingGroupToItem(g) {
  const p = g.shapeKey || g.profileShape || g.profileDesc || null;
  let profileShape = g.profileShape;
  if (!profileShape && typeof p === 'string') {
    const u = p.toUpperCase();
    if (u.includes('Z') && !u.includes('RHS')) profileShape = 'z_channel';
    else if (/\bC\b|CHANNEL/.test(u) || /C\d/.test(u)) profileShape = 'c_channel';
    else if (/L_?ANGLE|ANGLE/.test(u)) profileShape = 'l_angle';
    else if (/BENT\s*SAG|SAG\s*BENT|BEND\s*SAG|SAG\s*BEND|BENT_?SAG|SAG_?BENT|SAG[_\s-]*ROD|SAGROD/.test(u))
      profileShape = 'bent_sag_rod';
    else if (/ROD|BAR/.test(u)) profileShape = 'rod';
    else if (/PLT|PLATE/.test(u)) profileShape = 'plate';
    else if (/I_?BEAM|UB|UC|HEA|HEB|IPE/.test(u)) profileShape = 'i_beam';
  }
  // Prefer IFC bent path from group so pre-group rotate matches post-group shape
  let pathPointsMm = g.pathPointsMm || null;
  let pathDiamMm = g.pathDiamMm || 0;
  if ((!pathPointsMm || pathPointsMm.length < 3) && rawScene?.items?.length) {
    const marks = new Set(g.marks && g.marks.length ? g.marks : [g.mark]);
    const src = rawScene.items.find(it =>
      marks.has(it.mark) && it.pathPointsMm && it.pathPointsMm.length >= 3);
    if (src) {
      pathPointsMm = src.pathPointsMm;
      pathDiamMm = src.pathDiamMm || pathDiamMm;
      if (!profileShape && (src.shapeKey === 'bent_sag_rod' || src.profileShape === 'bent_sag_rod'))
        profileShape = 'bent_sag_rod';
      if (!g.shapeKey && src.shapeKey) g.shapeKey = src.shapeKey;
    }
  }
  if (pathPointsMm && pathPointsMm.length >= 3) {
    profileShape = 'bent_sag_rod';
  }
  const welded = g.groupKind === 'welded_assembly' || (g.isAssembly && g.parts && g.parts.length >= 2);
  return {
    mark: g.mark,
    marks: g.marks && g.marks.length ? [...g.marks] : [g.mark],
    assemblyName: g.name,
    category: g.category || (pathPointsMm ? 'rod' : 'other'),
    profileShape: profileShape || g.profileShape,
    profileDesc: g.profileDesc,
    remarks: g.remarks || (rawScene?.items?.find(it => it.mark === g.mark)?.remarks) || '',
    shapeKey: g.shapeKey || (pathPointsMm ? 'bent_sag_rod' : null),
    sectH: g.sectH, sectW: g.sectW, sectT: g.sectT,
    sectD: g.sectD, sectTf: g.sectTf, sectTw: g.sectTw,
    lengthMm: g.virtualLmm || g.l || 1000,
    widthMm:  g.virtualWmm || g.w || 100,
    heightMm: g.virtualHmm || g.h || 100,
    unitHeight: (g.sectH > 0 ? g.sectH : null) || Math.min(g.virtualHmm || 200, 420),
    unitWidth:  (g.sectW > 0 ? g.sectW : null) || Math.min(g.virtualWmm || 80, 200),
    // No hard 12-cap — that hid pieces vs Step7 SET_SIZE (up to 16/18)
    qty: Math.max(1, g.qty || 1),
    unitWeightKg: g.weightKg || 0,
    pathPointsMm,
    pathDiamMm: pathDiamMm || null,
    isAssembly: !!welded,
    parts: welded ? (g.parts || null) : null,
  };
}

/** Smoothly frame the camera on a mesh so View always finds the piece. */
function frameCameraOnMesh(mesh) {
  if (!mesh || !camera || !controls) return;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  const dist = maxDim * 2.4;
  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.45, center.z + dist * 0.55);
  controls.target.copy(center);
  controls.update();
}

// ── Container Manager ──────────────────────────────────────────────────

let _contIdCounter = 1;

function addContainer(spec) {
  const id = `C${_contIdCounter++}`;
  const cont = {
    id,
    label: `Container ${_contIdCounter - 1}`,
    spec: spec || rawScene?.containerSpec || { lengthMm:12000, widthMm:2350, heightMm:2690, maxWeightKg:26000 },
    items: [],
    weightKg: 0,
  };
  containers.push(cont);
  if (!activeContainerId) activeContainerId = id;
  renderContainerList();
  document.getElementById('contEmpty').style.display = 'none';
  return cont;
}

function removeContainer(id) {
  if (containers.length <= 1) { showToast('Cannot remove the last container'); return; }
  const cont = containers.find(c => c.id === id);
  if (cont) {
    // Return placed items to staging
    cont.items.forEach(g => { g.state = 'unplaced'; g.containerId = null; });
  }
  containers = containers.filter(c => c.id !== id);
  if (activeContainerId === id) activeContainerId = containers[0]?.id || null;
  renderContainerList();
  renderStagingList();
  updateStagingFooter();
  refreshScene();
}

function setActiveContainer(id) {
  activeContainerId = id;
  renderContainerList();
  refreshScene();
}

function renderContainerList() {
  const list = document.getElementById('contList');
  list.querySelectorAll('.cont-card').forEach(c => c.remove());

  containers.forEach(cont => {
    const maxW  = cont.spec?.maxWeightKg || 26000;
    const wPct  = Math.min((cont.weightKg / maxW) * 100, 100);
    const wCls  = wPct > 95 ? 'crit' : wPct > 75 ? 'warn' : '';
    const isActive = cont.id === activeContainerId;

    const card = document.createElement('div');
    card.className = 'cont-card' + (isActive ? ' active' : '');
    card.onclick = () => setActiveContainer(cont.id);
    card.innerHTML = `
      <span class="cont-remove" onclick="event.stopPropagation();removeContainer('${cont.id}')" title="Remove container">✕</span>
      <div class="cont-id">${cont.id} ${isActive ? '<span style="color:var(--blue);font-size:10px">● ACTIVE</span>' : ''}</div>
      <div class="cont-stats">
        <div>${cont.items.length} groups · ${Math.round(cont.weightKg)} kg</div>
        <div style="color:var(--text3)">${cont.spec?.lengthMm||12000}×${cont.spec?.widthMm||2350}×${cont.spec?.heightMm||2690} mm</div>
      </div>
      <div class="cont-bar"><div class="cont-bar-fill ${wCls}" style="width:${wPct.toFixed(1)}%"></div></div>
      <div style="font-size:10.5px;color:var(--text3);margin-top:4px">${wPct.toFixed(1)}% weight</div>`;
    list.appendChild(card);
  });
}

function updateCog() {
  const cont = containers.find(c => c.id === activeContainerId);
  if (!cont || !cont.items.length) {
    document.getElementById('cogDisplay2').innerHTML = 'No items placed';
    return;
  }
  let totalM=0, sumX=0, sumZ=0;
  cont.items.forEach(g => {
    const m = g.weightKg || 0;
    totalM += m; sumX += m * (g.virtualLmm||0)/2; sumZ += m * (g.virtualWmm||0)/2;
  });
  if (!totalM) return;
  const cogX = sumX/totalM, cogZ = sumZ/totalM;
  const cx = (cont.spec?.lengthMm||12000)/2;
  const cz = (cont.spec?.widthMm||2350)/2;
  const tolX = cx * 0.10, tolZ = cz * 0.10;
  const okX = Math.abs(cogX-cx) <= tolX;
  const okZ = Math.abs(cogZ-cz) <= tolZ;
  document.getElementById('cogDisplay2').innerHTML =
    `<b style="color:var(--text)">Centre of Gravity</b><br>
    <span class="${okX?'cog-ok':'cog-warn'}">Long: ${Math.round(cogX)} mm ${okX?'✓':'⚠ off-centre'}</span><br>
    <span class="${okZ?'cog-ok':'cog-warn'}">Lat: ${Math.round(cogZ-cz)} mm ${okZ?'✓':'⚠ off-centre'}</span>`;
}

/** Keep the right-panel C1 card in sync with Optimise / Place results. */
function syncSidebarContainersFromLayout() {
  if (!containers.length) addContainer(rawScene?.containerSpec);
  const cont = containers.find(c => c.id === activeContainerId) || containers[0];
  if (!cont) return;

  const placed = assemblyGroups.filter(g =>
    g.state === 'placed' && (!g.containerId || g.containerId === cont.id)
  );
  cont.items = placed;
  cont.weightKg = placed.reduce((s, g) => s + (g.weightKg || 0), 0);

  // Prefer packer-reported weight when available
  const packed = currentLayout?.containers?.[currentContainerIdx];
  if (packed && packed.usedWeightKg > 0 && cont.weightKg <= 0) {
    cont.weightKg = packed.usedWeightKg;
  }

  const emptyEl = document.getElementById('contEmpty');
  if (emptyEl) emptyEl.style.display = containers.length ? 'none' : '';
  renderContainerList();
  updateCog();
}

function toggleCheck(id) {
  if (!requireGrouped('pick items (1, 2, 3…)')) return;
  const g = assemblyGroups.find(x => x.id === id);
  if (!g || g.state === 'oversized') return;
  if (g.checked) {
    g.checked = false;
    g.checkOrder = 0;
    renumberCheckOrder();
  } else {
    g.checked = true;
    g.checkOrder = nextCheckOrder();
  }
  renderStagingList();
  updateStagingFooter();
  const n = assemblyGroups.filter(x => x.checked).length;
  document.getElementById('stagingCount').textContent =
    `(${assemblyGroups.length}) · ${n} selected`;
  updateSelectAllBox();
}

// ── Group / Ungroup ────────────────────────────────────────────────────

let _ungroupedGroups = null;  // backup for undo — also means "Step 2 Group done"

/** True after user has run Group by Shape (required before pick / Optimise). */
function isGroupedReady() {
  return !!( _ungroupedGroups && _ungroupedGroups.length );
}

function requireGrouped(actionLabel) {
  if (isGroupedReady()) return true;
  showToast(`Step 2 first: Group by Shape — then ${actionLabel || 'continue'}`, 3200);
  updateWorkflowUI();
  return false;
}

/** Lock pick / Optimise until Group by Shape; guide the correct workflow. */
function updateWorkflowUI() {
  const grouped = isGroupedReady();
  const hasItems = assemblyGroups.length > 0;
  const hint = document.getElementById('workflowHint');
  const btnGroup = document.getElementById('btnGroupByShape');
  const btnOpt = document.getElementById('btnOptimisePlace');
  const selAll = document.getElementById('selectAllBox');
  const selLabel = document.getElementById('selectAllLabel');

  if (hint) {
    if (!hasItems) {
      hint.innerHTML = 'Upload an IFC / Excel to begin';
      hint.style.borderColor = 'var(--border2)';
    } else if (!grouped) {
      hint.innerHTML = 'Step 1 done — items shown. <b style="color:var(--text)">Step 2: Group by Shape</b> (required next)';
      hint.style.borderColor = 'var(--blue)';
    } else {
      hint.innerHTML = 'Grouped ✓ — <b style="color:var(--text)">drag any set</b> to rearrange · pick <b style="color:var(--text)">1,2,3…</b> · Optimise';
      hint.style.borderColor = 'var(--green)';
    }
  }

  if (btnGroup) {
    if (!grouped && hasItems) {
      btnGroup.style.border = '1px solid var(--blue)';
      btnGroup.style.background = 'rgba(59,130,246,0.18)';
      btnGroup.style.color = 'var(--text)';
      btnGroup.style.fontWeight = '600';
      btnGroup.disabled = false;
      btnGroup.style.opacity = '1';
      btnGroup.style.cursor = 'pointer';
    } else if (grouped) {
      btnGroup.style.border = '1px solid var(--green)';
      btnGroup.style.background = 'rgba(29,158,117,0.15)';
      btnGroup.style.color = 'var(--green)';
      btnGroup.style.fontWeight = '600';
      btnGroup.disabled = false;
      btnGroup.style.opacity = '1';
      btnGroup.style.cursor = 'pointer';
      btnGroup.title = 'Already grouped — pick 1,2,3… then Optimise (or Ungroup to restart)';
    } else {
      btnGroup.style.opacity = '0.5';
    }
  }

  if (btnOpt) {
    btnOpt.disabled = !grouped;
    btnOpt.style.opacity = grouped ? '1' : '0.45';
    btnOpt.style.cursor = grouped ? 'pointer' : 'not-allowed';
  }
  if (!grouped) {
    outsideMoveMode = false;
    moveMode = false;
    freeDragOutside = true; // default ON again after next Group
  } else {
    outsideMoveMode = freeDragOutside;
  }
  updateMoveButtonsUI();
  if (selAll) {
    selAll.disabled = !grouped;
    selAll.style.cursor = grouped ? 'pointer' : 'not-allowed';
  }
  if (selLabel) {
    selLabel.style.opacity = grouped ? '1' : '0.5';
    selLabel.style.cursor = grouped ? 'pointer' : 'not-allowed';
  }
  updateSelectAllBox();
}

/** @deprecated — real-world keys live in 08-grouping.js */
function shapeGroupKey(g) {
  if (typeof realWorldGroupKey === 'function' && g.memberItems?.[0])
    return realWorldGroupKey(g.memberItems[0]);
  const shape = g.shapeKey || g.profileShape || '';
  const desc  = (g.profileDesc || '').trim().toUpperCase();
  const H = g.sectH > 0 ? Math.round(g.sectH)
          : Math.round(Math.max(g.virtualHmm || 0, g.virtualWmm || 0));
  const T = g.sectT > 0 ? Number(g.sectT).toFixed(1) : '';
  const L = Math.round(g.virtualLmm || 0);
  if (shape || desc) return `${shape}|${desc}|H${H}|T${T}|L${L}`;
  return `bbox|L${L}|W${Math.round(g.virtualWmm||0)}|H${Math.round(g.virtualHmm||0)}`;
}

/**
 * STEP 4 — Group by cross-section signature (+ dim bin + surface + destination).
 * Never changes item shapes / meshes. Profile name = label only.
 * Pack units still via createPackUnits at Optimise.
 */
function groupByShape() {
  if (!assemblyGroups.length) return;
  if (isGroupedReady()) {
    showToast('Already grouped — rotate if needed, pick 1,2,3… then Optimise', 3000);
    updateWorkflowUI();
    return;
  }
  if (!rawScene?.items?.length) {
    showToast('Grouping unavailable — reload the IFC', 3000);
    return;
  }
  const groupFn = typeof groupItemsByCsSignature === 'function'
    ? groupItemsByCsSignature
    : (typeof groupItemsRealWorld === 'function' ? groupItemsRealWorld : null);
  if (!groupFn) {
    showToast('Grouping unavailable — reload the IFC', 3000);
    return;
  }

  _ungroupedGroups = assemblyGroups.map(g => ({
    ...g,
    marks: g.marks ? [...g.marks] : [g.mark],
    memberItems: g.memberItems ? [...g.memberItems] : undefined,
    memberPieces: g.memberPieces ? [...g.memberPieces] : undefined,
  }));

  // Fill missing sectT/H/W from profile (so 2.5 / 2.0 / 1.5 Z split correctly)
  if (typeof resolveItemProfile === 'function') {
    (rawScene.items || []).forEach(it => {
      const r = resolveItemProfile(it);
      if (!r) return;
      if (!it.shapeKey && r.shapeKey) it.shapeKey = r.shapeKey;
      if (!it.profileShape && (r.profileShape || r.shapeKey))
        it.profileShape = r.profileShape || r.shapeKey;
      if (!(it.sectH > 0) && r.sectH > 0) it.sectH = r.sectH;
      if (!(it.sectW > 0) && r.sectW > 0) it.sectW = r.sectW;
      if (!(it.sectT > 0) && r.sectT > 0) it.sectT = r.sectT;
      if (!(it.sectD > 0) && r.sectD > 0) it.sectD = r.sectD;
    });
  }

  // Ensure signatures + nest method + nest offset (read-only — no shape change)
  if (typeof attachCsSignaturesToItems === 'function')
    attachCsSignaturesToItems(rawScene.items);
  if (typeof attachNestMethodsToItems === 'function')
    attachNestMethodsToItems(rawScene.items);
  if (typeof attachNestingOffsetsToItems === 'function')
    attachNestingOffsetsToItems(rawScene.items);

  assemblyGroups = groupFn(rawScene.items);
  assemblyGroups.forEach(g => {
    if (!g.profileShape && g.shapeKey) g.profileShape = g.shapeKey;
    g.checked = false;
    g.checkOrder = 0;
  });

  // STEP 7 — pack units (sort / SET_SIZE / metadata only — never morphs shapes)
  let packs = 0;
  if (typeof attachPackUnitsToGroups === 'function') {
    packs = attachPackUnitsToGroups(assemblyGroups);
  } else if (typeof createPackUnits === 'function') {
    assemblyGroups.forEach(g => {
      g.packUnits = createPackUnits(g);
      packs += (g.packUnits || []).length;
    });
  }

  // Sync pack-unit weights from group; then HEAVIEST → lightest in staging list
  assemblyGroups.forEach(g => {
    const gw = Math.max(0, Number(g.weightKg) || 0);
    (g.packUnits || []).forEach(pu => {
      if (!(pu.total_weight > 0) && !(pu.weightKg > 0)) {
        pu.total_weight = gw;
        pu.weightKg = gw;
      }
      // Prefer real pack-unit weight; keep group total as floor for single-unit assy
      if (g.groupKind === 'welded_assembly' && (g.packUnits || []).length === 1) {
        pu.total_weight = Math.max(pu.total_weight || 0, pu.weightKg || 0, gw);
        pu.weightKg = pu.total_weight;
      }
    });
  });
  sortStagingGroupsByWeight(assemblyGroups);

  // Coverage audit — catch any missed marks/pieces after Group
  const audit = (typeof auditGroupingCoverage === 'function')
    ? auditGroupingCoverage(rawScene.items, assemblyGroups)
    : null;

  renderStagingList();
  updateStagingFooter();
  layoutInspection();
  updateWorkflowUI();
  const n = assemblyGroups.length;
  const welded = assemblyGroups.filter(g => g.groupKind === 'welded_assembly').length;
  const top3 = assemblyGroups.slice(0, 3);
  const topHint = top3.length
    ? ` · #1–3: ${top3.map(g => `${(g.marks && g.marks[0]) || g.mark} ${Math.round(g.sortWeightKg || g.weightKg || 0)}kg`).join(', ')}`
    : '';
  if (audit && !audit.ok) {
    showToast(
      `⚠ Group: ${audit.inPcs} in → ${audit.outPcs} in groups`
      + (audit.missingMarks.length ? ` · missing ${audit.missingMarks.slice(0, 4).join(', ')}` : '')
      + ` — check console`,
      6000
    );
  } else {
    showToast(
      `✓ Grouped ${n} by weight high→low (${welded} assy)${topHint}`,
      5200
    );
  }
  try {
    console.info('[Group weight order]', assemblyGroups.slice(0, 10).map(g => ({
      mark: (g.marks && g.marks[0]) || g.mark,
      kind: g.groupKind,
      kg: Math.round(g.sortWeightKg || g.weightKg || 0),
    })));
  } catch (_) { /* */ }
}

function ungroupAll() {
  if (_ungroupedGroups) {
    assemblyGroups = _ungroupedGroups;
    _ungroupedGroups = null;
    assemblyGroups.forEach(g => { g.checked = false; g.checkOrder = 0; });
    renderStagingList();
    updateStagingFooter();
    layoutOutside(); // back to individual (non-grouped) layout
    updateWorkflowUI();
    showToast('Ungrouped — Step 2 again: Group by Shape', 2800);
  } else {
    showToast('Nothing to ungroup');
  }
}

function showToast(msg, ms=2500) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '_toast';
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(30,33,46,.97);color:#e2dfd8;border:1px solid #3b3f52;border-radius:8px;padding:9px 18px;font-size:12.5px;z-index:9999;transition:opacity .3s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.style.opacity='0', ms);
}

// ── refreshScene: re-render 3D based on placed items ──────────────────

function refreshScene() {
  if (!rawScene) return;
  // Build a virtual "placed items" scene for the active container
  const cont = containers.find(c => c.id === activeContainerId);
  if (!cont) return;

  // Map placed AssemblyGroups back to raw items for the existing renderer
  const placedItems = cont.items.flatMap(g => {
    const marks = new Set(g.marks && g.marks.length ? g.marks : [g.mark]);
    return (rawScene.items || []).filter(it => marks.has(it.mark));
  });

  const virtualLayout = {
    containers: [{
      ...rawScene.containerSpec,
      lengthMm: rawScene.containerSpec?.lengthMm || 12000,
      widthMm:  rawScene.containerSpec?.widthMm  || 2350,
      heightMm: rawScene.containerSpec?.heightMm || 2690,
      maxWeightKg: rawScene.containerSpec?.maxWeightKg || 26000,
      items: placedItems,
    }],
    oversized: assemblyGroups.filter(g => g.state === 'oversized').map(g => ({
      mark: g.mark, assemblyName: g.name, l: g.virtualLmm, w: g.virtualWmm, h: g.virtualHmm,
      weight: g.weightKg,
    })),
  };
  currentLayout = virtualLayout;
  renderContainer(0);
}

