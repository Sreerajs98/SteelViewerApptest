/* 07-load-scene.js — loadScene, excel, DotNet bridge */

function _coreLoadScene(data) {
  const { valid, issues } = validateRawItems(data.items || []);
  rawScene = { ...data, items: valid };
  dataIssues = issues;

  // Promote part profile → item (parent often empty; part has 200C18 / L40*2.5 / …)
  (rawScene.items || []).forEach(it => {
    if (!it || typeof resolveItemProfile !== 'function') return;
    const r = resolveItemProfile(it);
    if (!r) return;
    if (!it.profileDesc && r.profileDesc) it.profileDesc = r.profileDesc;
    if (!it.shapeKey && r.shapeKey) it.shapeKey = r.shapeKey;
    if (!it.profileShape && (r.profileShape || r.shapeKey))
      it.profileShape = r.profileShape || r.shapeKey;
    if (!(it.sectH > 0) && r.sectH > 0) it.sectH = r.sectH;
    if (!(it.sectW > 0) && r.sectW > 0) it.sectW = r.sectW;
    if (!(it.sectT > 0) && r.sectT > 0) it.sectT = r.sectT;
    if (!(it.sectD > 0) && r.sectD > 0) it.sectD = r.sectD;
  });

  // FIRST PRIORITY — warehouse ground sit preference (applied on makeShape)
  if (typeof attachWarehouseGroundToItems === 'function') {
    window._warehouseGroundStats = attachWarehouseGroundToItems(rawScene.items);
  }
  // STEP 1 — extract 2D cross-section per item (no shape morph; data only)
  if (typeof attachCrossSectionsToItems === 'function') {
    window._crossSectionStats = attachCrossSectionsToItems(rawScene.items);
  }
  // STEP 2 — analyze open/closed/concavity/symmetry/nest direction
  if (typeof attachCsAnalysisToItems === 'function') {
    window._csAnalysisStats = attachCsAnalysisToItems(rawScene.items);
  }
  // STEP 3 — orientation scores only (never mutates mesh / section / display)
  if (typeof attachOrientationsToItems === 'function') {
    window._orientStats = attachOrientationsToItems(rawScene.items);
  }
  // STEP 4 — apply orientation (oriented copy + bbox; originals preserved)
  if (typeof attachAppliedOrientationsToItems === 'function') {
    window._applyOrientStats = attachAppliedOrientationsToItems(rawScene.items);
  }
  // STEP 5 — shape matching prep: stamp CS signatures (grouping; no shape change)
  if (typeof attachCsSignaturesToItems === 'function') {
    window._csSigStats = attachCsSignaturesToItems(rawScene.items);
  }
  // STEP 6 — nest method from Step2 geometry (metadata only — no mesh change)
  if (typeof attachNestMethodsToItems === 'function') {
    window._nestMethodStats = attachNestMethodsToItems(rawScene.items);
  }
  // STEP 7 — nesting offset from geometry (metadata only — shapes never change)
  if (typeof attachNestingOffsetsToItems === 'function') {
    window._nestOffsetStats = attachNestingOffsetsToItems(rawScene.items);
  }
  // Store backend validation warnings for per-item display in info panel
  window._valWarnings = (data.validationWarnings || []).map(w => ({
    mark:     w.mark,
    message:  w.message,
    severity: w.severity || 'Caution',
  }));

  document.getElementById('dropZone').classList.add('hidden');
  setElStyle('panel', 'display', 'block');
  document.getElementById('hint').style.display = 'block';
  setElStyle('loadAnother', 'display', 'block');
  // jobTitle update — handled by topbar label in new layout
  setEl('jobTitle',
    `${data.jobNo} \u00b7 Bldg ${data.bldgNo} \u00b7 Phase ${data.phaseNo}`);

  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = '';
  Object.entries(COLORS).forEach(([cat,color]) => {
    const hex = '#' + color.toString(16).padStart(6,'0');
    const row = document.createElement('div');
    row.innerHTML = `<span class="swatch" style="background:${hex}"></span><span>${cat}</span>`;
    legendEl.appendChild(row);
  });
  const ovRow = document.createElement('div');
  ovRow.innerHTML = `<span class="swatch" style="background:#E24B4A;opacity:0.5"></span><span>Oversized / doesn't fit</span>`;
  legendEl.appendChild(ovRow);

  renderDataIssues();
  // Scene layout runs after staging is built (loadScene → buildStagingArea → layoutOutside)
}

function renderDataIssues() {
  const el = document.getElementById('dataIssues'); if (!el) return;
  if (dataIssues.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }

  el.style.display = 'block';
  const shown = dataIssues.slice(0, 15);
  const rows = shown.map(i =>
    `<div style="margin-bottom:6px"><b>${i.mark}</b> (${i.assemblyName}) - ${i.problems.join('; ')}</div>`
  ).join('');
  const more = dataIssues.length > shown.length
    ? `<div style="color:#8a8776">+ ${dataIssues.length - shown.length} more</div>` : '';

  el.innerHTML = `
    <div style="color:#E24B4A;font-weight:600;margin-bottom:6px">
      ${dataIssues.length} item(s) excluded - invalid dimensions/weight
    </div>
    ${rows}${more}
  `;
}

// ------------------------------------------------------------------
// DIRECT EXCEL PARSING (no C# step needed) - mirrors the same layout
// ExcelReader.cs expects from an AEM Shipping List export:
//   Row 6  : Job No (D6), Bldg No (F6), Phase No (H6), Customer (L6)
//   Row 8  : column headers
//   Row 10+: ASSM MARK(C) QTY(D) ASSEMBLY NAME(E) OVERALL SIZE(H)
//            LENGTH(J) UNIT WT(K) TOT WT(L)
// Default container is the standard 40ft box - edit DEFAULT_CONTAINER below
// if your usual container/trailer is a different size.
// ------------------------------------------------------------------
const DEFAULT_CONTAINER = { lengthMm: 12000, widthMm: 2350, heightMm: 2690, maxWeightKg: 26000 };

function categorizeName(name) {
  const n = (name || '').toUpperCase();
  if (n.includes('COLUMN') || n.includes('RAFTER') || n.includes('BEAM')) return 'beam';
  if (n.includes('ROD') || n.includes('BRACE') || n.includes('PIPE')) return 'rod';
  if (n.includes('PLT') || n.includes('PLATE') || n.includes('SHIM') || n.includes('SHEET')) return 'plate';
  if (n.includes('PURLIN') || n.includes('CHANNEL') || n.includes('GIRT')) return 'purlin';
  return 'other';
}

function parseOverallSize(sizeStr, fallbackLength) {
  if (!sizeStr) return [fallbackLength || 0, 50, 50];
  const parts = String(sizeStr).toUpperCase().split('X').map(s => s.trim()).filter(Boolean);
  if (parts.length === 3) {
    const [l, w, h] = parts.map(Number);
    if (!isNaN(l) && !isNaN(w) && !isNaN(h)) return [l, w, h];
  }
  return [fallbackLength || 0, 50, 50];
}

function cell(rows, r, c) {
  return rows[r] ? rows[r][c] : undefined;
}

function parseShippingListExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const jobNo = cell(rows, 5, 3) ?? '';
  const bldgNo = cell(rows, 5, 5) ?? '';
  const phaseNo = cell(rows, 5, 7) ?? '';
  const customer = cell(rows, 5, 11) ?? '';

  const items = [];
  let r = 9; // row 10 (0-indexed)
  let blank = 0;
  while (blank < 3 && r < rows.length + 3) {
    const mark = cell(rows, r, 2);
    if (mark === null || mark === undefined || String(mark).trim() === '') {
      blank++; r++; continue;
    }
    blank = 0;
    const qty = Number(cell(rows, r, 3)) || 0;
    const name = String(cell(rows, r, 4) ?? '').trim();
    const size = String(cell(rows, r, 7) ?? '').trim();
    const length = Number(cell(rows, r, 9)) || 0;
    const unitWt = Number(cell(rows, r, 10)) || 0;
    const [l, w, h] = parseOverallSize(size, length);

    items.push({
      mark: String(mark).trim(), assemblyName: name, category: categorizeName(name),
      lengthMm: l, widthMm: w, heightMm: h, qty, unitWeightKg: Math.round(unitWt * 1000) / 1000
    });
    r++;
  }

  return {
    jobNo: String(jobNo), bldgNo: String(bldgNo), phaseNo: String(phaseNo), customer: String(customer),
    containerSpec: { ...DEFAULT_CONTAINER },
    items
  };
}

function handleFile(file) {
  const isExcel = /\.xlsx?$/i.test(file.name);
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      if (isExcel) {
        loadScene(parseShippingListExcel(e.target.result));
      } else {
        loadScene(JSON.parse(e.target.result));
      }
    } catch (err) {
      alert('Could not read this file: ' + err.message);
    }
  };

  if (isExcel) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
}

document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
document.getElementById('fileInput2').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
document.getElementById('btnQuick').addEventListener('click', () => setMode('quick'));
document.getElementById('btnOptimize').addEventListener('click', () => setMode('optimize'));

// ------------------------------------------------------------------
// Bridge for a native host (e.g. the SteelViewerApp WinForms app) to push
// data straight in, without going through the file picker at all.
// ------------------------------------------------------------------




// ═══════════════════════════════════════════════════════════════════════
// SCENE INTEGRATION — wire AssemblyGroups into existing loadScene
// ═══════════════════════════════════════════════════════════════════════

// Staging wrapper — calls the original core function directly (no recursion)
function loadScene(data) {
  _coreLoadScene(data);

  // Build AssemblyGroups from the scene data (using GroupingService output
  // if provided, otherwise derive from raw items).
  let groups = [];
  if (data.assemblyGroups && data.assemblyGroups.length) {
    // C# PackingOrchestrator sent pre-built groups
    groups = data.assemblyGroups.map((g, i) => ({
      id:           g.groupId || `G${i}`,
      mark:         g.label   || g.members?.[0]?.assmMark || '?',
      name:         g.members?.[0]?.assemblyName || '',
      qty:          g.totalQty || (g.members?.length || 1),
      weightKg:     g.totalWeightKg || 0,
      strategy:     g.suggestedStrategy || 'SingleUnit',
      state:        g.state?.toLowerCase() || 'unplaced',
      containerId:  g.containerId || null,
      virtualLmm:   g.virtualLengthMm || 0,
      virtualWmm:   g.virtualWidthMm  || 0,
      virtualHmm:   g.virtualHeightMm || 0,
    }));
  } else {
    // Derive from raw items — one group per unique mark
    const seen = new Map();
    (data.items || []).forEach(it => {
      // Attach exact IFC thickness (C# sectT, or parse profileDesc)
      let shapeKey = it.shapeKey || null;
      let sectH = it.sectH || 0, sectW = it.sectW || 0, sectT = it.sectT || 0;
      let sectD = it.sectD || 0;
      if (!(sectT > 0) || !(sectH > 0)) {
        const parsed = detectFromDescription(it.profileDesc);
        if (parsed) {
          if (!shapeKey && parsed.shape) shapeKey = parsed.shape;
          if (!(sectH > 0) && parsed.H) sectH = parsed.H;
          if (!(sectW > 0) && parsed.W) sectW = parsed.W;
          if (!(sectT > 0) && parsed.T) sectT = parsed.T;
          if (!(sectD > 0) && parsed.D) sectD = parsed.D;
        }
      }

      if (!seen.has(it.mark)) {
        const totalW = it.unitWeightKg * (it.qty || 1);
        const L = it.lengthMm, W = it.widthMm, H = it.heightMm;
        let strategy = 'SingleUnit';
        if (L / Math.max(W,H) > 10) strategy = 'Bundle';
        else if (Math.min(W,H) / Math.max(W,H) < 0.05) strategy = 'Stack';
        else if (it.qty >= 4) strategy = 'Bundle';

        seen.set(it.mark, {
          id:          `G${seen.size+1}`,
          mark:        it.mark,
          name:        it.assemblyName || '',
          profileDesc: it.profileDesc || '',
          remarks:     it.remarks || '',
          shapeKey, sectH, sectW, sectT, sectD,
          profileShape: shapeKey || null,
          category:    it.category || '',
          qty:         it.qty || 1,
          weightKg:    totalW,
          strategy,
          state:       'unplaced',
          containerId: null,
          marks:       [it.mark],
          // Original IFC dims — Group / Optimise must not rewrite these
          virtualLmm:  L, virtualWmm: W, virtualHmm: H,
          pathPointsMm: it.pathPointsMm || null,
          pathDiamMm: it.pathDiamMm || 0,
        });
      } else {
        const g = seen.get(it.mark);
        g.qty += it.qty || 1;
        g.weightKg += it.unitWeightKg * (it.qty || 1);
        if (sectT > 0 && !(g.sectT > 0)) {
          g.sectH = sectH; g.sectW = sectW; g.sectT = sectT; g.sectD = sectD;
          g.shapeKey = shapeKey || g.shapeKey;
          g.profileDesc = it.profileDesc || g.profileDesc;
        }
        if ((!g.pathPointsMm || g.pathPointsMm.length < 3) && it.pathPointsMm?.length >= 3) {
          g.pathPointsMm = it.pathPointsMm;
          g.pathDiamMm = it.pathDiamMm || g.pathDiamMm;
        }
      }
    });
    groups = Array.from(seen.values());
  }

  // Reset containers — create exactly ONE on load, not multiple
  containers = [];
  _contIdCounter = 1;
  activeContainerId = null;
  addContainer();

  // If layout contains auto-packed containers, mark groups as placed
  if (currentLayout && currentLayout.containers) {
    currentLayout.containers.forEach((c, idx) => {
      const contId = containers[idx]?.id || `C${idx+1}`;
      (c.items || []).forEach(it => {
        const g = groups.find(x => x.mark === it.mark);
        if (g && g.state !== 'placed') {
          g.state = 'placed';
          g.containerId = contId;
          const cont = containers.find(x => x.id === contId);
          if (cont && !cont.items.find(x=>x.id===g.id)) {
            cont.items.push(g);
            cont.weightKg += g.weightKg;
          }
        }
      });
    });
  }

  // Phase 1: individual items — Group by Shape is Step 2 (required before pick / Optimise)
  _ungroupedGroups = null;
  buildStagingArea(groups);
  renderContainerList();
  updateCog();
  layoutOutside();
  updateWorkflowUI();

  // Show UI chrome
  document.getElementById('modeBar').classList.add('visible');
  document.getElementById('hint').style.display = '';
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('viewportInfo').style.display = '';

  // DON'T call refreshScene() here — layoutOutside already rendered the scene.
}

window.loadSceneFromDotNet = function (jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    document.getElementById('dropZone').classList.add('hidden');

    // Update top bar label
    const label = [data.jobNo, data.bldgNo && `Bldg ${data.bldgNo}`, data.phaseNo && `Phase ${data.phaseNo}`]
      .filter(Boolean).join(' · ');
    if (label) document.getElementById('jobLabel').textContent = label;

    loadScene(data);
  } catch (e) {
    alert('Error loading data from the app: ' + e.message);
  }
};

window.loadSceneFromUrl = async function (url) {
  try {
    document.getElementById('statusMsg').textContent = 'Loading 3D scene…';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    document.getElementById('dropZone').classList.add('hidden');
    const label = [data.jobNo, data.bldgNo && `Bldg ${data.bldgNo}`, data.phaseNo && `Phase ${data.phaseNo}`]
      .filter(Boolean).join(' · ');
    if (label) document.getElementById('jobLabel').textContent = label;
    loadScene(data);
  } catch (e) {
    alert('Error loading scene: ' + e.message);
  }
};

// File input handlers
document.getElementById('fileInput').addEventListener('change', function() {
  if (!this.files[0]) return;
  handleFileUpload(this.files[0]);
});
document.getElementById('fileInput2').addEventListener('change', function() {
  if (!this.files[0]) return;
  handleFileUpload(this.files[0]);
});

function handleFileUpload(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'json') {
    const fr = new FileReader();
    fr.onload = e => { try { loadScene(JSON.parse(e.target.result)); } catch(err) { alert('Invalid JSON: ' + err.message); } };
    fr.readAsText(file);
  } else if (ext === 'xlsx') {
    const fr = new FileReader();
    fr.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
        document.getElementById('statusMsg').textContent = 'Excel loaded (' + rows.length + ' rows). Use C# app for full processing.';
      } catch(err) { alert('Excel error: ' + err.message); }
    };
    fr.readAsArrayBuffer(file);
  }
}

// Initialise Three.js
initThree();
applyTheme(currentTheme());

