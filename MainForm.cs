using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;
using SteelPackingApp.Models;
using SteelPackingApp.Services;

namespace SteelViewerApp;

/// <summary>
/// Native WinForms shell. Everything is driven from here:
///   - "Upload Shipping List Excel..." reads the file (ExcelReader), builds the
///     raw scene (SceneBuilder), and pushes it into the embedded 3D view.
///   - "Quick view" / "Optimize packing" just click the matching buttons
///     inside the embedded page - the packing algorithms themselves live in
///     Viewer3D.html's JavaScript (that is genuinely where 3D rendering has
///     to happen; WinForms has no built-in 3D surface), but the whole
///     workflow - pick file, load it, switch modes - is controlled from this
///     native C# window.
/// </summary>
public class MainForm : Form
{
    private readonly WebView2 webView = new();
    private readonly Button btnUpload = new();
    private readonly Button btnUploadIfc = new();
    private readonly Button btnLoadJson = new();
    private readonly Button btnQuick = new();
    private readonly Button btnOptimize = new();
    private readonly Label lblStatus = new();
    private readonly Container containerSpec = new(); // edit Models/Container.cs to change 40ft defaults

    private bool webViewReady = false;

    public MainForm()
    {
        Text = "Steel Container 3D Viewer";
        Width = 1280;
        Height = 820;
        StartPosition = FormStartPosition.CenterScreen;

        var topPanel = new Panel { Dock = DockStyle.Top, Height = 46, Padding = new Padding(8) };

        btnUploadIfc.Text = "Upload IFC...";
        btnUploadIfc.AutoSize = true;
        btnUploadIfc.Click += BtnUploadIfc_Click;

        btnLoadJson.Text = "Load scene JSON...";
        btnLoadJson.AutoSize = true;
        btnLoadJson.Click += BtnLoadJson_Click;

        lblStatus.AutoSize = true;
        lblStatus.Text = "No file loaded yet.";
        lblStatus.ForeColor = Color.DimGray;

        // Excel / Quick / Optimize buttons removed per UI request — IFC + JSON only
        topPanel.Controls.Add(btnUploadIfc);
        topPanel.Controls.Add(btnLoadJson);
        topPanel.Controls.Add(lblStatus);

        // simple horizontal layout without a designer file
        Load += (s, e) => LayoutTopPanel(topPanel);
        Resize += (s, e) => LayoutTopPanel(topPanel);

        webView.Dock = DockStyle.Fill;

        Controls.Add(webView);
        Controls.Add(topPanel);

        Load += MainForm_Load;
    }

    private void LayoutTopPanel(Panel panel)
    {
        int x = 8;
        foreach (Control c in panel.Controls)
        {
            c.Location = new Point(x, 11);
            x += c.Width + 14;
        }
    }

    private async void MainForm_Load(object? sender, EventArgs e)
    {
        try
        {
            await webView.EnsureCoreWebView2Async();
            string baseDir = AppContext.BaseDirectory;
            webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "steel.local",
                baseDir,
                Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
            string htmlPath = Path.Combine(baseDir, "Viewer3D.html");
            webView.CoreWebView2.NavigationCompleted += async (s2, e2) =>
            {
                webViewReady = true;
                if (!e2.IsSuccess) return;
                if (Program.RunWarehouseTests)
                    await RunJsTestSuiteAndExitAsync(
                        "runWarehouseGroundTestSuite",
                        "_warehouse_test_results.json",
                        "Warehouse ground");
                else if (Program.RunZGroundTests)
                    await RunJsTestSuiteAndExitAsync(
                        "runZGroundMeasureSuite",
                        "_z_ground_measure.json",
                        "Z ground MOVE measure");
                else if (Program.RunStep7Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep7TestSuite",
                        "_step7_test_results.json",
                        "Step7 nest-offset");
                else if (Program.RunGroundTests)
                    await RunJsTestSuiteAndExitAsync(
                        "runGroundStabilityTestSuite",
                        "_ground_test_results.json",
                        "Ground stability");
                else if (Program.RunStep6Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep6TestSuite",
                        "_step6_test_results.json",
                        "Step6 nest-method");
                else if (Program.RunStep5Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep5TestSuite",
                        "_step5_test_results.json",
                        "Step5 shape-matching");
                else if (Program.RunStep4Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep4TestSuite",
                        "_step4_test_results.json",
                        "Step4 apply-orientation");
                else if (Program.RunStep3Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep3TestSuite",
                        "_step3_test_results.json",
                        "Step3 orientation");
                else if (Program.RunStep2Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep2TestSuite",
                        "_step2_test_results.json",
                        "Step2 cs-analysis");
                else if (Program.RunStep1Tests)
                    await RunJsTestSuiteAndExitAsync(
                        "runStep1TestSuite",
                        "_step1_test_results.json",
                        "Step1 cross-section");
                else if (Program.RunGroupingTests)
                    await RunJsTestSuiteAndExitAsync(
                        "runGroupingTestSuite",
                        "_grouping_test_results.json",
                        "Grouping");
                else if (!string.IsNullOrWhiteSpace(Program.StartupIfcPath)
                    && File.Exists(Program.StartupIfcPath))
                {
                    await LoadIfcPathAsync(Program.StartupIfcPath, skipPhasePicker: true);
                    // CLI --ifc: exit after pack report is written (do not leave UI open)
                    Close();
                    return;
                }
            };
            webView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
        }
        catch (Exception ex)
        {
            if (Program.RunGroupingTests || Program.RunStep1Tests || Program.RunStep2Tests
                || Program.RunStep3Tests || Program.RunStep4Tests || Program.RunStep5Tests
                || Program.RunStep6Tests || Program.RunGroundTests || Program.RunStep7Tests
                || Program.RunWarehouseTests || Program.RunZGroundTests)
            {
                string failFile = Program.RunZGroundTests
                    ? "_z_ground_measure.json"
                    : Program.RunWarehouseTests
                    ? "_warehouse_test_results.json"
                    : Program.RunStep7Tests
                    ? "_step7_test_results.json"
                    : Program.RunGroundTests
                    ? "_ground_test_results.json"
                    : Program.RunStep6Tests
                    ? "_step6_test_results.json"
                    : Program.RunStep5Tests
                    ? "_step5_test_results.json"
                    : Program.RunStep4Tests
                    ? "_step4_test_results.json"
                    : Program.RunStep3Tests
                        ? "_step3_test_results.json"
                        : Program.RunStep2Tests
                            ? "_step2_test_results.json"
                            : Program.RunStep1Tests
                                ? "_step1_test_results.json"
                                : "_grouping_test_results.json";
                try
                {
                    await File.WriteAllTextAsync(
                        Path.Combine(AppContext.BaseDirectory, failFile),
                        $"{{\"ok\":false,\"error\":{JsonSerializer.Serialize(ex.Message)}}}");
                }
                catch { /* */ }
                Environment.ExitCode = 2;
                Close();
                return;
            }
            MessageBox.Show(
                "Could not start the embedded browser (WebView2). Make sure the " +
                "'WebView2 Runtime' is installed - it ships with Windows 10/11 and Edge " +
                "by default, but if this fails you can download it from Microsoft's site.\n\n" +
                ex.Message,
                "WebView2 error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// Headless: execute a JS test suite inside the real app WebView,
    /// write results JSON next to the EXE, then exit.
    /// </summary>
    private async Task RunJsTestSuiteAndExitAsync(string fnName, string outFileName, string label)
    {
        try
        {
            lblStatus.Text = $"Running {label} test suite…";
            await Task.Delay(800);

            string js = $@"
                (function(){{
                  if (typeof {fnName} !== 'function')
                    return JSON.stringify({{ ok:false, error:'{fnName} missing' }});
                  return JSON.stringify({fnName}());
                }})()";
            string raw = await webView.CoreWebView2!.ExecuteScriptAsync(js);
            string? json = JsonSerializer.Deserialize<string>(raw);
            if (string.IsNullOrWhiteSpace(json))
                json = "{\"ok\":false,\"error\":\"empty result\"}";

            string outPath = Path.Combine(AppContext.BaseDirectory, outFileName);
            await File.WriteAllTextAsync(outPath, json);

            using var doc = JsonDocument.Parse(json);
            bool ok = doc.RootElement.TryGetProperty("ok", out var okEl) && okEl.GetBoolean();
            int passed = doc.RootElement.TryGetProperty("passed", out var p) ? p.GetInt32() : 0;
            int total = doc.RootElement.TryGetProperty("total", out var t) ? t.GetInt32() : 0;
            int failed = doc.RootElement.TryGetProperty("failed", out var f) ? f.GetInt32() : -1;

            lblStatus.Text = ok
                ? $"{label} tests OK — {passed}/{total}"
                : $"{label} tests FAILED — {passed}/{total} ({failed} failed)";

            Environment.ExitCode = ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            try
            {
                await File.WriteAllTextAsync(
                    Path.Combine(AppContext.BaseDirectory, outFileName),
                    $"{{\"ok\":false,\"error\":{JsonSerializer.Serialize(ex.ToString())}}}");
            }
            catch { /* */ }
            Environment.ExitCode = 2;
        }
        finally
        {
            await Task.Delay(200);
            Close();
        }
    }

    private async void BtnUploadIfc_Click(object? sender, EventArgs e)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Select a Tekla IFC export",
            Filter = "IFC files (*.ifc)|*.ifc|All files (*.*)|*.*"
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        await LoadIfcPathAsync(dialog.FileName, skipPhasePicker: false);
    }

    /// <summary>Load IFC into the viewer. CLI uses skipPhasePicker=true (all phases).</summary>
    private async Task LoadIfcPathAsync(string ifcPath, bool skipPhasePicker)
    {
        btnUploadIfc.Enabled = false;
        btnLoadJson.Enabled = false;
        Cursor = Cursors.WaitCursor;
        try
        {
            lblStatus.Text = "Scanning IFC phases…";
            var scan = await Task.Run(() => XbimIfcIngest.ScanForPickerWithFallback(ifcPath));
            double? phaseFilter = null;

            if (!skipPhasePicker)
            {
                var counts = scan.HasPhaseTags
                    ? scan.PhaseCounts
                    : new List<(double Phase, int Count)> { (0, Math.Max(scan.TotalCandidates, 0)) };

                Cursor = Cursors.Default;
                using (var picker = new PhasePickerForm(counts, !scan.HasPhaseTags))
                {
                    if (picker.ShowDialog(this) != DialogResult.OK) return;
                    Cursor = Cursors.WaitCursor;
                    if (!picker.AllPhasesChosen) phaseFilter = picker.SelectedPhase;
                }
            }

            lblStatus.Text = phaseFilter.HasValue
                ? $"Loading phase {phaseFilter:0} geometry…"
                : "Loading IFC geometry (all phases)…";

            var (job, items, skipped) = await Task.Run(
                () => XbimIfcIngest.ConvertWithFallback(ifcPath, phaseFilter));

            if (items.Count == 0)
            {
                MessageBox.Show(
                    "No structural items could be read from this IFC.\n\n" +
                    "The app looks for IfcElementAssembly (Tekla) and also falls back to " +
                    "IfcBeam / IfcColumn / IfcMember / IfcPlate with property sets or geometry.\n\n" +
                    "If this file truly has no such elements, try another export or Excel shipping list.",
                    "No items found", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            lblStatus.Text = $"Building 3D scene ({items.Count} items)…";
            var validator = new ValidationService();
            var valResult = validator.Validate(items);

            var scene = SceneBuilder.BuildRawScene(job, containerSpec, items);
            scene.ValidationWarnings = valResult.ItemResults
                .Where(r => r.HasIssues)
                .SelectMany(r =>
                    r.Errors.Select(e => new ValidationWarningDto {
                        Mark = r.Item.AssmMark, Message = e, Severity = "Error" })
                    .Concat(r.Warnings.Select(w => new ValidationWarningDto {
                        Mark = r.Item.AssmMark, Message = w, Severity = "Caution" })))
                .ToList();

            await PushSceneToViewerAsync(scene);

            double totalWeight = items.Sum(i => i.TotalWeightKg);
            string phaseText = phaseFilter.HasValue ? $"Phase {phaseFilter:0}" : "All phases";
            int warnCount = valResult.InvalidCount;
            string warnText = warnCount > 0 ? $", {warnCount} unusable items" : "";
            lblStatus.Text = $"{job.JobNo}  |  {phaseText}  |  {items.Count} assemblies " +
                              $"({skipped} skipped - no usable part), {Math.Round(totalWeight, 1)} kg total{warnText}";

            // CLI --ifc: Group → select all → Optimise; write pack report for RF012 verify
            if (skipPhasePicker && webView.CoreWebView2 != null)
            {
                lblStatus.Text += "  |  Auto Optimise…";
                await Task.Delay(2800);
                // Fire async pack into window.__cliPackReport (ExecuteScript may not await Promise)
                await webView.CoreWebView2.ExecuteScriptAsync(
                    """
                    (function () {
                      window.__cliPackReport = null;
                      window.__cliPackBusy = true;
                      (async function () {
                        try {
                          if (typeof groupByShape === 'function') groupByShape();
                          await new Promise(r => setTimeout(r, 900));
                          if (typeof assemblyGroups !== 'undefined' && assemblyGroups.length) {
                            assemblyGroups.forEach(g => {
                              if (g.state !== 'oversized') g.checked = true;
                            });
                            if (typeof renumberCheckOrderByWeight === 'function')
                              renumberCheckOrderByWeight();
                            if (typeof renderStagingList === 'function') renderStagingList();
                            if (typeof updateSelectAllBox === 'function') updateSelectAllBox();
                          }
                          await new Promise(r => setTimeout(r, 500));
                          if (typeof layoutPlaceSelected === 'function')
                            await layoutPlaceSelected();
                          await new Promise(r => setTimeout(r, 2500));
                          const all = [];
                          const list = (typeof clickable !== 'undefined' && clickable) ? clickable : [];
                          for (const c of list) {
                            const it = c.item || {};
                            const mark = String(it.mark || c.mark || '');
                            const sb = it.stableBundleMm || it.packEnvelopeMm || null;
                            const marks = (it.marks && it.marks.length) ? it.marks : [mark];
                            all.push({
                              mark: mark,
                              marks: marks,
                              outside: !!(c.outsideContainer || it.outsideContainer),
                              fitReason: it.fitReason || c.fitReason || null,
                              fitReasonMsg: it.fitReasonMsg || null,
                              needsRotate: !!(it.needsRotate || c.needsRotate),
                              l: it.l || it.lengthMm || (sb && sb.l) || null,
                              w: it.w || it.widthMm || (sb && sb.w) || null,
                              h: it.h || it.heightMm || (sb && sb.h) || null,
                              sbSource: (sb && sb.source) || null,
                              pitchedFrom: (sb && sb.pitchedFrom) || null,
                              sb: sb ? { l: sb.l, w: sb.w, h: sb.h, source: sb.source || null } : null,
                            });
                          }
                          const isRf012 = (s) => /RF012/i.test(String(s || ''));
                          const groups = (typeof assemblyGroups !== 'undefined' && assemblyGroups)
                            ? assemblyGroups.filter(g =>
                                isRf012(g.mark) || (g.marks || []).some(isRf012))
                              .map(g => ({
                                mark: g.mark,
                                marks: g.marks || [],
                                state: g.state,
                                fitReason: g.fitReason || null,
                                fitReasonMsg: g.fitReasonMsg || null,
                                needsRotate: !!g.needsRotate,
                                qty: g.qty,
                                weightKg: g.weightKg,
                                isAssembly: !!g.isAssembly,
                                packUnit: g.packUnit ? {
                                  mark: g.packUnit.mark,
                                  l: g.packUnit.l || g.packUnit.lengthMm,
                                  w: g.packUnit.w || g.packUnit.widthMm,
                                  h: g.packUnit.h || g.packUnit.heightMm,
                                  sb: g.packUnit.stableBundleMm || null,
                                } : null,
                              }))
                            : [];
                          const sceneRf = ((typeof rawScene !== 'undefined' && rawScene && rawScene.items) || [])
                            .filter(it => isRf012(it.mark) || (it.marks || []).some(isRf012))
                            .map(it => ({
                              mark: it.mark,
                              lengthMm: it.lengthMm,
                              widthMm: it.widthMm,
                              heightMm: it.heightMm,
                              sectH: it.sectH, sectW: it.sectW,
                              isAssembly: !!it.isAssembly,
                              sb: it.stableBundleMm || null,
                            }));
                          const layout = (typeof currentLayout !== 'undefined' && currentLayout) ? currentLayout : null;
                          const placedRf = [];
                          ((layout && layout.containers) || []).forEach(c => {
                            (c.items || []).forEach(it => {
                              if (isRf012(it.mark) || (it.marks || []).some(isRf012)) {
                                placedRf.push({
                                  mark: it.mark, marks: it.marks || [],
                                  container: c.containerNumber,
                                  x: it.x, y: it.y, z: it.z,
                                  l: it.l, w: it.w, h: it.h,
                                  footL: it.packFootprintL || null,
                                  footW: it.packFootprintW || null,
                                  footH: it.packFootprintH || null,
                                  sb: it.stableBundleMm || null,
                                  tag: it.packOrientTag || null,
                                  weight: it.weight || it.unitWeightKg || null,
                                });
                              }
                            });
                          });
                          const overRf = ((layout && layout.oversized) || [])
                            .filter(it => isRf012(it.mark) || (it.marks || []).some(isRf012))
                            .map(it => ({
                              mark: it.mark, marks: it.marks || [],
                              fitReason: it.fitReason || null,
                              fitReasonMsg: it.fitReasonMsg || null,
                              l: it.l, w: it.w, h: it.h,
                              sb: it.stableBundleMm || null,
                            }));
                          // Live pack-unit probe from RF012 staging group
                          let unitProbe = null;
                          try {
                            const g0 = (typeof assemblyGroups !== 'undefined' && assemblyGroups || [])
                              .find(g => isRf012(g.mark) || (g.marks || []).some(isRf012));
                            if (g0 && typeof createPackUnits === 'function') {
                              const pus = createPackUnits(g0);
                              const pu = pus && pus[0];
                              let u = null;
                              if (pu && typeof cs8UnitFromPackUnit === 'function')
                                u = cs8UnitFromPackUnit(pu);
                              let diag = null;
                              if (u && typeof cs8DiagnoseUnfit === 'function' && rawScene) {
                                const sp = rawScene.containerSpec || {};
                                diag = cs8DiagnoseUnfit(
                                  u,
                                  sp.lengthMm || 12000,
                                  sp.widthMm || 2350,
                                  (sp.heightMm || 2690) - 2.5,
                                  [],
                                  sp.maxWeightKg || 26000
                                );
                              }
                              unitProbe = {
                                puMark: pu && pu.mark || null,
                                puLWH: pu ? {
                                  l: pu.lengthMm, w: pu.widthMm, h: pu.heightMm,
                                } : null,
                                puSb: pu && pu.stableBundleMm || null,
                                puBb: pu && pu.bundle_bbox || null,
                                unit: u ? {
                                  mark: u.mark, l: u.l, w: u.w, h: u.h,
                                  lengthMm: u.lengthMm, widthMm: u.widthMm, heightMm: u.heightMm,
                                  isAssembly: !!u.isAssembly, weight: u.weight,
                                } : null,
                                diagnose: diag,
                              };
                            } else {
                              unitProbe = { error: 'RF012 group or createPackUnits missing' };
                            }
                          } catch (pe) {
                            unitProbe = { error: String(pe && pe.message || pe) };
                          }
                          // L / flange-brace nest pack-unit probe (why unplaced?)
                          let braceProbe = null;
                          try {
                            const gL = (typeof assemblyGroups !== 'undefined' && assemblyGroups || [])
                              .filter(g => g && (g.shapeKey === 'l_angle' || g.groupKind === 'nest_l'))
                              .sort((a, b) => (b.qty || 0) - (a.qty || 0))[0];
                            if (gL) {
                              const pus = (gL.packUnits && gL.packUnits.length)
                                ? gL.packUnits
                                : (typeof createPackUnits === 'function' ? createPackUnits(gL) : []);
                              const pu = pus && pus[0];
                              let u = null;
                              if (pu && typeof cs8UnitFromPackUnit === 'function')
                                u = cs8UnitFromPackUnit(pu);
                              let diag = null;
                              if (u && typeof cs8DiagnoseUnfit === 'function' && rawScene) {
                                const sp = rawScene.containerSpec || {};
                                diag = cs8DiagnoseUnfit(
                                  u,
                                  sp.lengthMm || 12000,
                                  sp.widthMm || 2350,
                                  (sp.heightMm || 2690) - 2.5,
                                  [],
                                  sp.maxWeightKg || 26000
                                );
                              }
                              const overL = ((layout && layout.oversized) || [])
                                .filter(it => {
                                  const blob = String(it.shapeKey || '') + ' '
                                    + String(it.groupKind || '') + ' ' + String(it.mark || '');
                                  return /l_angle|nest_l|STACK|40.|50./i.test(blob);
                                })
                                .slice(0, 8)
                                .map(it => ({
                                  mark: it.mark, fitReason: it.fitReason,
                                  l: it.l || it.lengthMm, w: it.w || it.widthMm, h: it.h || it.heightMm,
                                }));
                              const ni = gL.nestingInfo || null;
                              const placedL = ((layout && layout.containers) || [])
                                .reduce((n, c) => n + ((c.items || []).filter(it => {
                                  const blob = String(it.groupKind || '') + ' ' + String(it.shapeKey || '');
                                  return /nest_l|l_angle/i.test(blob);
                                }).length), 0);
                              braceProbe = {
                                groupMark: gL.mark, qty: gL.qty, setCount: (pus || []).length,
                                sect: { H: gL.sectH, W: gL.sectW, T: gL.sectT },
                                nestMethod: (gL.nestMethod && gL.nestMethod.method) || null,
                                nestOff: (ni && ni.nesting_offset) || gL.nestingOffsetMm || null,
                                puLWH: pu ? { l: pu.lengthMm, w: pu.widthMm, h: pu.heightMm } : null,
                                puBb: pu && pu.bundle_bbox || null,
                                unit: u ? { l: u.l, w: u.w, h: u.h, weight: u.weight } : null,
                                diagnose: diag,
                                placedNestL: placedL,
                                oversizedL: overL,
                              };
                            } else {
                              braceProbe = { error: 'no nest_l group' };
                            }
                          } catch (be) {
                            braceProbe = { error: String(be && be.message || be) };
                          }
                          const rf012 = all.filter(r =>
                            isRf012(r.mark) || (r.marks || []).some(isRf012));
                          const outside = all.filter(r => r.outside);
                          const widthExceeds = []
                            .concat(overRf, groups, rf012)
                            .filter(r => /WIDTH_EXCEEDS/i.test(
                              String(r.fitReason || '') + String(r.fitReasonMsg || '')));
                          // Pack quality: unsupported mid-air + mesh AABB dig-in
                          let floatCount = 0;
                          let overlapCount = 0;
                          let maxMeshMinY = 0, maxMeshCy = 0, tallNestTip = 0;
                          const meshBoxes = [];
                          for (const c of list) {
                            if (!c || c.outsideContainer || !c.mesh) continue;
                            try {
                              c.mesh.updateMatrixWorld(true);
                              const box = new THREE.Box3().setFromObject(c.mesh);
                              if (!isFinite(box.min.y)) continue;
                              const gk = String((c.item && c.item.groupKind) || '');
                              const sk = String((c.item && (c.item.shapeKey || c.item.profileShape)) || '');
                              meshBoxes.push({
                                box: box,
                                mark: (c.item && c.item.mark) || '',
                                nest: /^nest_/.test(gk) || sk === 'z_channel'
                                  || sk === 'c_channel' || sk === 'l_angle',
                                y0: (c.item && c.item.y) || 0,
                                fh: (c.item && c.item.packFootprintH) || 0,
                                lock: !!(c.item && (c.item.packPoseLock
                                  || c.item._orientLocked || c.item.floorAnchor)),
                                gk: gk || sk || null,
                              });
                            } catch (_) { /* */ }
                          }
                          const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
                          const eps = 1e-3;
                          const floorEps = 30 * sc;   // 30mm
                          const supportTol = 40 * sc; // 40mm
                          const xzTol = 10 * sc;      // 10mm
                          for (let i = 0; i < meshBoxes.length; i++) {
                            const a = meshBoxes[i].box;
                            const nestLike = !!meshBoxes[i].nest;
                            const h = a.max.y - a.min.y;
                            const cy = (a.min.y + a.max.y) * 0.5;
                            if (a.min.y > maxMeshMinY) maxMeshMinY = a.min.y;
                            if (cy > maxMeshCy) maxMeshCy = cy;
                            // Stacked on another mesh = OK; mid-air with no support = float
                            if (a.min.y > floorEps) {
                              let supported = false;
                              for (let j = 0; j < meshBoxes.length; j++) {
                                if (i === j) continue;
                                const b = meshBoxes[j].box;
                                const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
                                const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
                                if (ox <= xzTol || oz <= xzTol) continue;
                                if (Math.abs(b.max.y - a.min.y) <= supportTol) { supported = true; break; }
                              }
                              if (!supported) floatCount++;
                            } else if (nestLike) {
                              // Tip-sit: nest taller than ~550mm with centroid high vs footprint
                              const fh = Math.max(meshBoxes[i].fh || 0, 1) * sc;
                              if (h > Math.max(550 * sc, fh * 1.8) && cy > h * 0.4) {
                                floatCount++; tallNestTip++;
                              }
                            }
                          }
                          for (let i = 0; i < meshBoxes.length; i++) {
                            for (let j = i + 1; j < meshBoxes.length; j++) {
                              const a = meshBoxes[i].box, b = meshBoxes[j].box;
                              const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
                              const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
                              const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
                              // 80mm — ignore nest flush / hairline; count real dig-in only
                              if (ox > 0.08 && oy > 0.08 && oz > 0.08) {
                                const vol = ox * oy * oz;
                                const volA = Math.max((a.max.x-a.min.x)*(a.max.y-a.min.y)*(a.max.z-a.min.z), 1e-9);
                                const volB = Math.max((b.max.x-b.min.x)*(b.max.y-b.min.y)*(b.max.z-b.min.z), 1e-9);
                                if (vol / Math.min(volA, volB) >= 0.15) overlapCount++;
                              }
                            }
                          }
                          const placedOk = placedRf.length > 0;
                          const widthOk = widthExceeds.length === 0;
                          // Float must be zero; allow a few residual AABB dig-ins after settle
                          // (nest flush / plate faces still inflate AABB counts)
                          const foremanPack = (typeof currentLayout !== 'undefined'
                              && currentLayout && (currentLayout.packStrategy === 'foreman_space_first'
                                || (currentLayout.packPasses && currentLayout.packPasses.foreman)))
                            || (window.__lastPackStrategy === 'foreman_space_first')
                            || (window.__foremanLast && window.__foremanLast.placed > 0);
                          // Foreman quality: zero float + packer-resolved overlaps (mesh AABB digs
                          // are expected when lane-packing assemblies to construct width).
                          const packerOv = (window.__foremanLast && window.__foremanLast.report
                            && window.__foremanLast.report.overlapCount != null)
                            ? window.__foremanLast.report.overlapCount
                            : overlapCount;
                          const qualityOk = floatCount === 0
                            && (foremanPack ? packerOv <= 8 : overlapCount <= 12);
                          const braceLike = all.filter(r =>
                            /FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE|L_?ANGLE/i
                              .test(String(r.mark || '') + ' ' + (r.marks || []).join(' ')));
                          const braceGroups = (typeof assemblyGroups !== 'undefined' && assemblyGroups || [])
                            .filter(g => {
                              const sk = String(g.shapeKey || g.profileShape || '');
                              const blob = String(g.mark || '') + ' ' + sk + ' ' + (g.groupKind || '');
                              return sk === 'l_angle' || g.groupKind === 'nest_l'
                                || /FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE|L_?ANGLE/i.test(blob);
                            })
                            .map(g => ({
                              mark: g.mark,
                              shapeKey: g.shapeKey || g.profileShape || null,
                              state: g.state,
                              qty: g.qty,
                              groupKind: g.groupKind || null,
                            }));
                          window.__cliPackReport = {
                            ok: placedOk && widthOk && qualityOk && !groups.some(g =>
                              /WIDTH_EXCEEDS/i.test(String(g.fitReason || ''))),
                            totalClickable: all.length,
                            inside: all.filter(r => !r.outside).length,
                            outsideCount: outside.length,
                            floatCount: floatCount,
                            overlapCount: overlapCount,
                            meshY: {
                              maxMinY: maxMeshMinY,
                              maxCy: maxMeshCy,
                              tallNestTip: tallNestTip,
                              n: meshBoxes.length,
                              high: meshBoxes
                                .map(m => ({
                                  mark: m.mark,
                                  nest: m.nest,
                                  lock: m.lock,
                                  gk: m.gk,
                                  minY: +m.box.min.y.toFixed(3),
                                  cy: +((m.box.min.y + m.box.max.y) * 0.5).toFixed(3),
                                  h: +(m.box.max.y - m.box.min.y).toFixed(3),
                                  itemY: m.y0,
                                  fh: m.fh,
                                }))
                                .sort((a, b) => b.minY - a.minY)
                                .slice(0, 8),
                            },
                            packStrategy: (typeof currentLayout !== 'undefined'
                              && currentLayout && currentLayout.packStrategy)
                              || (window.__lastPackStrategy || null),
                            foremanReport: (typeof currentLayout !== 'undefined'
                              && currentLayout && currentLayout.foremanReport)
                              || (window.__foremanLast && window.__foremanLast.report)
                              || null,
                            packPasses: (typeof currentLayout !== 'undefined'
                              && currentLayout && currentLayout.packPasses)
                              || null,
                            foremanLast: window.__foremanLast || null,
                            braceClickable: braceLike.slice(0, 20),
                            braceGroups: braceGroups.slice(0, 20),
                            rf012Clickable: rf012,
                            rf012Groups: groups,
                            rf012Scene: sceneRf,
                            rf012Placed: placedRf,
                            rf012Oversized: overRf,
                            unitProbe: unitProbe,
                            braceProbe: braceProbe,
                            widthExceedsCount: widthExceeds.length,
                            outsideSample: outside.slice(0, 15),
                          };
                        } catch (e) {
                          window.__cliPackReport = {
                            ok: false,
                            error: String(e && e.message || e),
                          };
                        } finally {
                          window.__cliPackBusy = false;
                        }
                      })();
                      return 'started';
                    })()
                    """);
                string packJson = "{\"ok\":false,\"error\":\"pack report timeout\"}";
                for (int i = 0; i < 150; i++) // up to ~5 min for large IFC best-of pack
                {
                    await Task.Delay(2000);
                    string probe = await webView.CoreWebView2.ExecuteScriptAsync(
                        "window.__cliPackReport ? JSON.stringify(window.__cliPackReport) : (window.__cliPackBusy ? '\"BUSY\"' : 'null')");
                    string? probeVal = null;
                    try { probeVal = JsonSerializer.Deserialize<string>(probe); } catch { /* */ }
                    if (probeVal == "BUSY" || probeVal == null) continue;
                    if (!string.IsNullOrWhiteSpace(probeVal) && probeVal.StartsWith('{'))
                    {
                        packJson = probeVal;
                        break;
                    }
                }
                try
                {
                    string reportPath = Path.Combine(AppContext.BaseDirectory, "_ifc_pack_report.json");
                    await File.WriteAllTextAsync(reportPath, packJson);
                }
                catch (Exception rex)
                {
                    try
                    {
                        await File.WriteAllTextAsync(
                            Path.Combine(AppContext.BaseDirectory, "_ifc_pack_report.json"),
                            $"{{\"ok\":false,\"error\":{JsonSerializer.Serialize(rex.Message)}}}");
                    }
                    catch { /* */ }
                }
                lblStatus.Text = $"{job.JobNo}  |  {phaseText}  |  {items.Count} assemblies " +
                                  $"({skipped} skipped), {Math.Round(totalWeight, 1)} kg  |  Optimised";
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not read this IFC file:\n\n" + ex.Message,
                "Error reading file", MessageBoxButtons.OK, MessageBoxIcon.Error);
            lblStatus.Text = "IFC load failed.";
        }
        finally
        {
            Cursor = Cursors.Default;
            btnUploadIfc.Enabled = true;
            btnLoadJson.Enabled = true;
        }
    }

    private async void BtnLoadJson_Click(object? sender, EventArgs e)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Select a scene JSON file (e.g. produced by ifc_to_scene.py)",
            Filter = "JSON files (*.json)|*.json|All files (*.*)|*.*"
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        try
        {
            string json = File.ReadAllText(dialog.FileName);
            using var doc = JsonDocument.Parse(json); // validate it's actually JSON before pushing to the browser

            await PushSceneJsonAsync(json);

            string jobNo = doc.RootElement.TryGetProperty("jobNo", out var j) ? j.GetString() ?? "" : "";
            int itemCount = doc.RootElement.TryGetProperty("items", out var itemsEl) ? itemsEl.GetArrayLength() : 0;
            lblStatus.Text = $"Loaded from JSON: {jobNo}  |  {itemCount} assembly rows";
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not read this JSON file:\n\n" + ex.Message,
                "Error reading file", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async void BtnUpload_Click(object? sender, EventArgs e)
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Select a Shipping List Excel file",
            Filter = "Excel files (*.xlsx)|*.xlsx|All files (*.*)|*.*"
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        try
        {
            var (job, items) = ExcelReader.ReadShippingList(dialog.FileName);

            if (items.Count == 0)
            {
                MessageBox.Show(
                    "No assembly rows were found. This app expects the standard AEM " +
                    "Shipping List layout (job info in row 6, headers in row 8, data from " +
                    "row 10). If your export looks different, adjust Services/ExcelReader.cs.",
                    "No items found", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var scene = SceneBuilder.BuildRawScene(job, containerSpec, items);
            await PushSceneToViewerAsync(scene);

            int totalPieces = items.Sum(i => i.Qty);
            double totalWeight = items.Sum(i => i.TotalWeightKg);
            lblStatus.Text = $"{job.JobNo}  |  Bldg {job.BldgNo}  Phase {job.PhaseNo}  |  " +
                              $"{items.Count} assembly types, {totalPieces} pieces, " +
                              $"{Math.Round(totalWeight, 1)} kg total";
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not read this Excel file:\n\n" + ex.Message,
                "Error reading file", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// Large scenes: write JSON once and let the viewer fetch it via virtual host.
    /// Avoids double-escaping megabytes of mesh data through ExecuteScriptAsync.
    /// </summary>
    private async Task PushSceneToViewerAsync(RawScene scene)
    {
        string json = await Task.Run(() => JsonSerializer.Serialize(scene, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
        }));
        await PushSceneJsonAsync(json);
    }

    private async Task PushSceneJsonAsync(string json)
    {
        if (!webViewReady || webView.CoreWebView2 == null)
        {
            MessageBox.Show("3D viewer is not ready yet. Wait a moment and try again.",
                "Viewer not ready", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        string cachePath = Path.Combine(AppContext.BaseDirectory, "_scene_cache.json");
        await File.WriteAllTextAsync(cachePath, json);

        // Bust cache so a second load always re-fetches
        string url = "https://steel.local/_scene_cache.json?t=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string js = $"loadSceneFromUrl({JsonSerializer.Serialize(url)})";
        await webView.CoreWebView2.ExecuteScriptAsync(js);
    }

    private void RunJs(string script)
    {
        if (!webViewReady || webView.CoreWebView2 == null) return;
        _ = webView.CoreWebView2.ExecuteScriptAsync(script);
    }
}
