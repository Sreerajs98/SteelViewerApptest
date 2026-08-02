using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;
using SteelPackingApp.Models;
using SteelPackingApp.Services;

namespace SteelViewerApp;

/// <summary>
/// Native WinForms shell. IFC / JSON load + Group By in the embedded viewer.
/// Container Optimise / packing has been removed — Group By is unchanged.
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
                if (Program.RunZGroundTests)
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
                    Close();
                }
            };
            webView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
        }
        catch (Exception ex)
        {
            if (Program.RunGroupingTests || Program.RunStep1Tests || Program.RunStep2Tests
                || Program.RunStep3Tests || Program.RunStep4Tests || Program.RunStep5Tests
                || Program.RunStep6Tests || Program.RunGroundTests || Program.RunStep7Tests
                || Program.RunZGroundTests)
            {
                string failFile = Program.RunZGroundTests
                    ? "_z_ground_measure.json"
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

    /// <summary>
    /// Load IFC into the viewer. CLI (--ifc) skips the phase picker (all phases)
    /// then runs Group By + Pack V2 Optimise soak (steps 2–5) and writes a report.
    /// </summary>
    private async Task LoadIfcPathAsync(string ifcPath, bool skipPhasePicker)
    {
        btnUploadIfc.Enabled = false;
        btnLoadJson.Enabled = false;
        Cursor = Cursors.WaitCursor;
        try
        {
            double? phaseFilter = null;
            if (!skipPhasePicker)
            {
                lblStatus.Text = "Scanning IFC phases…";
                var scan = await Task.Run(() => XbimIfcIngest.ScanForPickerWithFallback(ifcPath));
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

            // CLI --ifc: Group By + yard quality probe (gravity / overlap / nest footprint)
            if (skipPhasePicker && webView.CoreWebView2 != null)
            {
                lblStatus.Text += "  |  Auto Group…";
                await Task.Delay(2500);
                // Fire async so a hung groupByShape cannot block ExecuteScript forever
                await webView.CoreWebView2.ExecuteScriptAsync(
                    """
                    (function () {
                      window.__cliGroupReport = null;
                      window.__cliGroupBusy = true;
                      (async function () {
                        try {
                          if (typeof groupByShape === 'function') groupByShape();
                          // Allow layoutInspection + mesh nail / deconflict to finish
                          await new Promise(r => setTimeout(r, 1800));
                          const groups = (typeof assemblyGroups !== 'undefined' && assemblyGroups)
                            ? assemblyGroups : [];
                          const selfTest = (typeof csPackNormalizeSelfTest === 'function')
                            ? csPackNormalizeSelfTest()
                            : { ok: false, error: 'selfTest missing' };
                          const nestUnits = [];
                          const fatNests = [];
                          const shortLen = [];
                          const Wcap = 2438;
                          groups.forEach(g => {
                            (g.packUnits || []).forEach(pu => {
                              const gk = String(pu.groupKind || g.groupKind || '').toLowerCase();
                              const sk = String(pu.shapeKey || pu.profileShape || '').toLowerCase();
                              const nest = /^nest_[zcl]$/.test(gk)
                                || sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle';
                              if (!nest) return;
                              const pw = Math.round(+pu.packWidthMm || +pu.widthMm
                                || (pu.stableBundleMm && +pu.stableBundleMm.w) || 0);
                              const pl = Math.round(+pu.packLengthMm || +pu.lengthMm || 0);
                              const ph = Math.round(+pu.packHeightMm || +pu.heightMm || 0);
                              const src = (pu.stableBundleMm && pu.stableBundleMm.source) || null;
                              const row = {
                                mark: pu.mark || g.mark || null,
                                groupKind: gk || null,
                                pl, pw, ph, src,
                                qty: pu.qty || 0,
                                normalized: !!pu._packFootprintNormalized,
                              };
                              nestUnits.push(row);
                              if (pw > Wcap * 0.42) fatNests.push(row);
                              if (pl > 0 && pl < 500) shortLen.push(row);
                            });
                          });

                          // Yard mesh metrics: float, tip gap, AABB overlaps
                          const sc = (typeof SCALE === 'number' && SCALE > 0) ? SCALE : 0.01;
                          const list = (typeof clickable !== 'undefined' && clickable) ? clickable : [];
                          const outs = list.filter(c => c && c.outsideContainer && c.mesh && c.item);
                          const floats = [];
                          // Tip-gap policy (does NOT remorph Group By poses):
                          // Tip sampling on IFC nests/tapers is noisy and often
                          // expected (taper depth, nest mesh bins). Report as WARN
                          // only. Hard yard fail = float + nest dig-in only.
                          const tipWarnNest = [];
                          const tipWarnAsm = [];
                          function isNestItem(it) {
                            if (!it) return false;
                            const gk = String(it.groupKind || '').toLowerCase();
                            const sk = String(it.shapeKey || it.profileShape || '').toLowerCase();
                            return /^nest_[zcl]$/.test(gk)
                              || sk === 'z_channel' || sk === 'c_channel' || sk === 'l_angle';
                          }
                          outs.forEach(c => {
                            try {
                              c.mesh.updateMatrixWorld(true);
                              const box = new THREE.Box3().setFromObject(c.mesh);
                              const minYmm = (box.min.y / sc);
                              if (minYmm > 3) {
                                floats.push({
                                  mark: String(c.item.mark || ''),
                                  gk: c.item.groupKind || null,
                                  minYmm: +minYmm.toFixed(1),
                                });
                              }
                              let tip = null;
                              if (typeof csShipPrepTipGapMm === 'function')
                                tip = csShipPrepTipGapMm(c.mesh);
                              if (tip == null || !(tip > 8)) return;
                              const nest = isNestItem(c.item);
                              const row = {
                                mark: String(c.item.mark || ''),
                                gk: c.item.groupKind || null,
                                tipGapMm: +Number(tip).toFixed(1),
                                nest: nest,
                              };
                              if (nest) tipWarnNest.push(row);
                              else tipWarnAsm.push(row);
                            } catch (_) { /* */ }
                          });
                          const overlaps = [];
                          for (let i = 0; i < outs.length; i++) {
                            for (let j = i + 1; j < outs.length; j++) {
                              try {
                                outs[i].mesh.updateMatrixWorld(true);
                                outs[j].mesh.updateMatrixWorld(true);
                                const a = new THREE.Box3().setFromObject(outs[i].mesh);
                                const b = new THREE.Box3().setFromObject(outs[j].mesh);
                                const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
                                const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
                                const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
                                if (ox > 0.02 && oy > 0.02 && oz > 0.02) {
                                  overlaps.push({
                                    a: String(outs[i].item.mark || ''),
                                    b: String(outs[j].item.mark || ''),
                                    oxMm: Math.round(ox / sc),
                                    oyMm: Math.round(oy / sc),
                                    ozMm: Math.round(oz / sc),
                                    nest: !!(outs[i].item.groupKind || '').toString().startsWith('nest_')
                                      || !!(outs[j].item.groupKind || '').toString().startsWith('nest_'),
                                  });
                                }
                              } catch (_) { /* */ }
                            }
                          }
                          const nestOverlaps = overlaps.filter(o => o.nest);
                          // Hard yard fail: float + nest dig-in only
                          const yardOk = floats.length === 0
                            && nestOverlaps.length === 0;

                          // Step 2a — packer unit list (no placement)
                          let step2a = { ok: false, error: 'csPackV2BuildUnits missing' };
                          if (typeof csPackV2BuildUnits === 'function') {
                            groups.forEach(g => {
                              if (g && g.state !== 'oversized') g.checked = true;
                            });
                            const built = csPackV2BuildUnits(groups, {
                              containerSpec: (typeof rawScene !== 'undefined' && rawScene)
                                ? rawScene.containerSpec : { widthMm: 2438 },
                            });
                            const uids = built.map(u => u._fmUid);
                            const uidUnique = uids.length === new Set(uids).size;
                            const dimsOk = built.every(u =>
                              +u.packLengthMm > 0 && +u.packWidthMm > 0 && +u.packHeightMm > 0);
                            const self2a = (typeof csPackV2Step2aSelfTest === 'function')
                              ? csPackV2Step2aSelfTest() : { ok: true, skipped: true };
                            step2a = {
                              ok: uidUnique && dimsOk && self2a.ok !== false,
                              unitCount: built.length,
                              uidUnique: uidUnique,
                              dimsOk: dimsOk,
                              selfTest: self2a,
                              sample: built.slice(0, 12).map(u => ({
                                mark: u.mark || null,
                                uid: u._fmUid || null,
                                order: u._checkOrder || 0,
                                pl: Math.round(+u.packLengthMm || 0),
                                pw: Math.round(+u.packWidthMm || 0),
                                ph: Math.round(+u.packHeightMm || 0),
                                kg: Math.round(+u.weightKg || 0),
                                gk: u.groupKind || null,
                              })),
                            };
                          }

                          // Step 2b — one safe floor free-rect (no placement)
                          let step2b = { ok: false, error: 'csPackV2InitialFreeRects missing' };
                          if (typeof csPackV2InitialFreeRects === 'function') {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const init = csPackV2InitialFreeRects(spec);
                            const rects = (init && init.freeRects) || [];
                            const env = (init && init.envelope) || {};
                            const r0 = rects[0] || null;
                            const oneFloor = rects.length === 1
                              && r0 && r0.y === 0 && r0.supportedBy === 'floor';
                            const inset = !!(r0 && r0.x > 0 && r0.z > 0
                              && r0.x + r0.length < (+spec.lengthMm || 12000)
                              && r0.z + r0.width < (+spec.widthMm || 2438));
                            const self2b = (typeof csPackV2Step2bSelfTest === 'function')
                              ? csPackV2Step2bSelfTest() : { ok: true, skipped: true };
                            step2b = {
                              ok: oneFloor && inset && self2b.ok !== false,
                              rectCount: rects.length,
                              oneFloor: oneFloor,
                              inset: inset,
                              selfTest: self2b,
                              rect: r0 ? {
                                x: +r0.x, z: +r0.z,
                                length: +r0.length, width: +r0.width,
                                y: +r0.y, heightAvailable: +r0.heightAvailable,
                              } : null,
                              envelope: {
                                outerL: env.outerLengthMm || null,
                                outerW: env.outerWidthMm || null,
                                outerH: env.outerHeightMm || null,
                                length: env.lengthMm || null,
                                width: env.widthMm || null,
                                height: env.heightMm || null,
                                sideGap: env.clearanceSideMm || null,
                                endGap: env.clearanceEndMm || null,
                                source: env.source || null,
                              },
                            };
                          }

                          // Step 2c — try one floor seat (AABB + overlap), no loop
                          let step2c = { ok: false, error: 'csPackV2TryFloorSeat missing' };
                          if (typeof csPackV2TryFloorSeat === 'function'
                              && step2b && step2b.ok && step2a && step2a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const init = (typeof csPackV2InitialFreeRects === 'function')
                              ? csPackV2InitialFreeRects(spec) : null;
                            const floor = init && init.freeRects && init.freeRects[0];
                            const env = init && init.envelope;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            // Prefer a floor-fitting unit that still leaves room for a
                            // second seat (Z or X). Fat almost-full-width nests skip
                            // the second-seat check — OVERLAP alone proves 2c.
                            const gap = 20;
                            const fitsFloor = (u) =>
                              +u.packLengthMm <= (floor && floor.length)
                              && +u.packWidthMm <= (floor && floor.width)
                              && +u.packHeightMm <= (floor && floor.heightAvailable);
                            const roomForSecond = (u) =>
                              (+u.packWidthMm * 2 + gap) <= (floor && floor.width)
                              || (+u.packLengthMm * 2 + gap) <= (floor && floor.length);
                            let probeU = built.find(u => fitsFloor(u) && roomForSecond(u));
                            if (!probeU) probeU = built.find(u => fitsFloor(u));
                            if (!probeU && built.length) probeU = built[0];
                            const self2c = (typeof csPackV2Step2cSelfTest === 'function')
                              ? csPackV2Step2cSelfTest() : { ok: true, skipped: true };
                            let corner = null;
                            let overlap = null;
                            let beside = null;
                            let secondAxis = null;
                            if (probeU && floor && env) {
                              corner = csPackV2TryFloorSeat(
                                probeU, floor.x, floor.z,
                                { envelope: env, rect: floor, placedBoxes: [] });
                              if (corner && corner.ok && corner.box) {
                                overlap = csPackV2TryFloorSeat(
                                  probeU, floor.x, floor.z,
                                  { envelope: env, rect: floor, placedBoxes: [corner.box] });
                                const alongZ = floor.z + corner.pw + gap;
                                const alongX = floor.x + corner.pl + gap;
                                if ((corner.pw * 2 + gap) <= floor.width) {
                                  secondAxis = 'z';
                                  beside = csPackV2TryFloorSeat(
                                    probeU, floor.x, alongZ,
                                    { envelope: env, rect: floor, placedBoxes: [corner.box] });
                                } else if ((corner.pl * 2 + gap) <= floor.length) {
                                  secondAxis = 'x';
                                  beside = csPackV2TryFloorSeat(
                                    probeU, alongX, floor.z,
                                    { envelope: env, rect: floor, placedBoxes: [corner.box] });
                                }
                              }
                            }
                            const coreOk = !!(corner && corner.ok
                              && overlap && !overlap.ok && overlap.reason === 'OVERLAP');
                            const secondNeeded = secondAxis != null;
                            const secondOk = !secondNeeded || !!(beside && beside.ok);
                            const logicOk = coreOk && secondOk;
                            step2c = {
                              ok: self2c.ok !== false && logicOk,
                              selfTest: self2c,
                              probeMark: probeU ? (probeU.mark || null) : null,
                              probeDims: probeU ? {
                                pl: Math.round(+probeU.packLengthMm || 0),
                                pw: Math.round(+probeU.packWidthMm || 0),
                                ph: Math.round(+probeU.packHeightMm || 0),
                              } : null,
                              cornerOk: !!(corner && corner.ok),
                              overlapRejected: !!(overlap && !overlap.ok
                                && overlap.reason === 'OVERLAP'),
                              besideOk: !!(beside && beside.ok),
                              secondAxis: secondAxis,
                              secondNeeded: secondNeeded,
                              cornerReason: corner ? corner.reason : null,
                              overlapReason: overlap ? overlap.reason : null,
                            };
                          }

                          // Step 2d — gravity commit: floor seat always y=0
                          let step2d = { ok: false, error: 'csPackV2CommitFloorSeat missing' };
                          if (typeof csPackV2CommitFloorSeat === 'function'
                              && step2c && step2c.ok && step2b && step2b.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const init = (typeof csPackV2InitialFreeRects === 'function')
                              ? csPackV2InitialFreeRects(spec) : null;
                            const floor = init && init.freeRects && init.freeRects[0];
                            const env = init && init.envelope;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const fitsFloor = (u) =>
                              +u.packLengthMm <= (floor && floor.length)
                              && +u.packWidthMm <= (floor && floor.width)
                              && +u.packHeightMm <= (floor && floor.heightAvailable);
                            let probeU = built.find(u => fitsFloor(u));
                            if (!probeU && built.length) probeU = built[0];
                            const self2d = (typeof csPackV2Step2dSelfTest === 'function')
                              ? csPackV2Step2dSelfTest() : { ok: true, skipped: true };
                            let seat = null;
                            let commit = null;
                            let tamper = null;
                            let rejectBad = null;
                            if (probeU && floor && env
                                && typeof csPackV2TryFloorSeat === 'function') {
                              seat = csPackV2TryFloorSeat(
                                probeU, floor.x, floor.z,
                                { envelope: env, rect: floor, placedBoxes: [] });
                              if (seat && seat.ok) {
                                commit = csPackV2CommitFloorSeat(probeU, seat, {
                                  envelope: env, rect: floor, placedBoxes: [],
                                });
                                const fakeY = Object.assign({}, seat, {
                                  y: 500,
                                  box: Object.assign({}, seat.box || {}, {
                                    minY: 500, maxY: 500 + (+probeU.packHeightMm || 0),
                                  }),
                                });
                                tamper = csPackV2CommitFloorSeat(probeU, fakeY, {
                                  envelope: env, rect: floor, placedBoxes: [],
                                  recheck: false,
                                });
                                rejectBad = csPackV2CommitFloorSeat(probeU, {
                                  ok: false, reason: 'OVERLAP', x: seat.x, z: seat.z,
                                }, { envelope: env, rect: floor });
                              }
                            }
                            const gravityOk = !!(commit && commit.ok
                              && commit.placement && commit.placement.y === 0
                              && commit.placement.box
                              && commit.placement.box.minY === 0
                              && commit.placement.layer === 'floor');
                            const tamperOk = !!(tamper && tamper.ok
                              && tamper.placement && tamper.placement.y === 0
                              && tamper.placement.box && tamper.placement.box.minY === 0);
                            const rejectOk = !!(rejectBad && !rejectBad.ok
                              && rejectBad.reason === 'SEAT_NOT_OK');
                            step2d = {
                              ok: self2d.ok !== false && gravityOk && tamperOk && rejectOk,
                              selfTest: self2d,
                              probeMark: probeU ? (probeU.mark || null) : null,
                              commitY: commit && commit.placement
                                ? commit.placement.y : null,
                              commitMinY: commit && commit.placement && commit.placement.box
                                ? commit.placement.box.minY : null,
                              tamperForcedY0: tamperOk,
                              rejectBadSeat: rejectOk,
                              gravity: commit && commit.placement
                                ? commit.placement.gravity : null,
                            };
                          }

                          // Step 2e — guillotine free-rect split after floor commit
                          let step2e = { ok: false, error: 'csPackV2ApplySplit missing' };
                          if (typeof csPackV2ApplySplit === 'function'
                              && step2d && step2d.ok && step2b && step2b.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const init = (typeof csPackV2InitialFreeRects === 'function')
                              ? csPackV2InitialFreeRects(spec) : null;
                            const floor = init && init.freeRects && init.freeRects[0];
                            const env = init && init.envelope;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            // Prefer a unit that leaves a usable side lane after split
                            const fitsCorner = (u) =>
                              +u.packLengthMm <= (floor && floor.length)
                              && +u.packWidthMm + 50 <= (floor && floor.width)
                              && +u.packHeightMm <= (floor && floor.heightAvailable);
                            let probeU = built.find(u => fitsCorner(u));
                            if (!probeU) probeU = built.find(u =>
                              +u.packLengthMm <= (floor && floor.length)
                              && +u.packWidthMm <= (floor && floor.width)
                              && +u.packHeightMm <= (floor && floor.heightAvailable));
                            if (!probeU && built.length) probeU = built[0];
                            const self2e = (typeof csPackV2Step2eSelfTest === 'function')
                              ? csPackV2Step2eSelfTest() : { ok: true, skipped: true };
                            let seat = null;
                            let commit = null;
                            let applied = null;
                            let sideLane = null;
                            let noOverlap = true;
                            let inputIntact = false;
                            if (probeU && floor && env
                                && typeof csPackV2TryFloorSeat === 'function'
                                && typeof csPackV2CommitFloorSeat === 'function') {
                              seat = csPackV2TryFloorSeat(
                                probeU, floor.x, floor.z,
                                { envelope: env, rect: floor, placedBoxes: [] });
                              if (seat && seat.ok) {
                                commit = csPackV2CommitFloorSeat(probeU, seat, {
                                  envelope: env, rect: floor, placedBoxes: [],
                                });
                              }
                              if (commit && commit.ok && commit.placement) {
                                const beforeN = init.freeRects.length;
                                applied = csPackV2ApplySplit(
                                  init.freeRects, floor, commit.placement, { gapMm: 0 });
                                inputIntact = init.freeRects.length === beforeN;
                                if (applied && applied.ok && applied.freeRects) {
                                  sideLane = applied.freeRects.find(r =>
                                    Math.abs(+r.length - +floor.length) <= 0.5);
                                  for (let i = 0; i < applied.freeRects.length; i++) {
                                    for (let j = i + 1; j < applied.freeRects.length; j++) {
                                      if (typeof csPackV2FreeRectsOverlap === 'function'
                                          && csPackV2FreeRectsOverlap(
                                            applied.freeRects[i], applied.freeRects[j]))
                                        noOverlap = false;
                                    }
                                    // leftover must not dig into placed box
                                    const fr = applied.freeRects[i];
                                    const frBox = (typeof csPackV2MakeBox === 'function')
                                      ? csPackV2MakeBox(fr.x, fr.z, fr.length, fr.width, 1, 0)
                                      : null;
                                    if (frBox && commit.placement.box
                                        && typeof csPackV2BoxesOverlap === 'function'
                                        && csPackV2BoxesOverlap(frBox, commit.placement.box))
                                      noOverlap = false;
                                  }
                                }
                              }
                            }
                            const splitOk = !!(applied && applied.ok
                              && applied.freeRects && applied.freeRects.length >= 1
                              && sideLane && noOverlap && inputIntact
                              && commit && commit.placement && commit.placement.y === 0);
                            step2e = {
                              ok: self2e.ok !== false && splitOk,
                              selfTest: self2e,
                              probeMark: probeU ? (probeU.mark || null) : null,
                              probeDims: probeU ? {
                                pl: Math.round(+probeU.packLengthMm || 0),
                                pw: Math.round(+probeU.packWidthMm || 0),
                                ph: Math.round(+probeU.packHeightMm || 0),
                              } : null,
                              leftoverCount: applied && applied.freeRects
                                ? applied.freeRects.length : 0,
                              hasSideLane: !!sideLane,
                              sideLaneWidth: sideLane
                                ? Math.round(+sideLane.width) : null,
                              noOverlap: noOverlap,
                              inputIntact: inputIntact,
                              policy: applied ? applied.policy : null,
                            };
                          }

                          // Step 2f — full floor loop + honest fitReason leftovers
                          let step2f = { ok: false, error: 'csPackV2PackFloor missing' };
                          if (typeof csPackV2PackFloor === 'function'
                              && step2e && step2e.ok && step2a && step2a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self2f = (typeof csPackV2Step2fSelfTest === 'function')
                              ? csPackV2Step2fSelfTest() : { ok: true, skipped: true };
                            const selfShip = (typeof cs8ShipAxesSelfTest === 'function')
                              ? cs8ShipAxesSelfTest() : { ok: true, skipped: true };
                            const pack = csPackV2PackFloor(built, { containerSpec: spec });
                            let placedY0 = true;
                            let placedNoOv = true;
                            let reasonsOk = true;
                            let frNoOv = true;
                            const reasonCounts = {};
                            let absurdWithHints = 0;
                            const absurdSample = [];
                            const Wcap = +(spec.widthMm || 2438);
                            for (let i = 0; i < built.length; i++) {
                              const u = built[i];
                              if (!u) continue;
                              const pw = +u.packWidthMm || 0;
                              const pl = +u.packLengthMm || 0;
                              const ph = +u.packHeightMm || 0;
                              const isAsm = !!(u.isAssembly
                                || u.groupKind === 'welded_assembly'
                                || u.groupKind === 'assembly_single');
                              const hasHint = (+u.sectW >= 40) || (+u.shippingWidthMm >= 40)
                                || (+u.flangeWidthMm >= 40) || (+u.sectH >= 40);
                              const absurd = (typeof cs8IsAbsurdAssemblyFootprint === 'function')
                                ? cs8IsAbsurdAssemblyFootprint(pl, pw, ph, u)
                                : (pw > Wcap + 1 && pl > Wcap * 0.5);
                              // Gate only assemblies — true-oversize plates stay FOOTPRINT_EXCEEDS
                              if (isAsm && hasHint && absurd) {
                                absurdWithHints++;
                                if (absurdSample.length < 12) {
                                  absurdSample.push({
                                    mark: u.mark || null,
                                    pl: Math.round(pl), pw: Math.round(pw), ph: Math.round(ph),
                                    sectW: +u.sectW || 0, sectH: +u.sectH || 0,
                                    shipW: +u.shippingWidthMm || +u.flangeWidthMm || 0,
                                    shipL: +u.shippingLengthMm || 0,
                                    shipH: +u.shippingHeightMm || 0,
                                    gk: u.groupKind || null,
                                    isAsm: true,
                                  });
                                }
                              }
                            }
                            if (pack && pack.placed) {
                              for (let i = 0; i < pack.placed.length; i++) {
                                const p = pack.placed[i];
                                if (!p || p.y !== 0 || !p.box || p.box.minY !== 0)
                                  placedY0 = false;
                                for (let j = i + 1; j < pack.placed.length; j++) {
                                  const q = pack.placed[j];
                                  if (p && q && p.box && q.box
                                      && typeof csPackV2BoxesOverlap === 'function'
                                      && csPackV2BoxesOverlap(p.box, q.box))
                                    placedNoOv = false;
                                }
                              }
                            }
                            if (pack && pack.unplaced) {
                              for (let i = 0; i < pack.unplaced.length; i++) {
                                const u = pack.unplaced[i];
                                if (!u || !u.fitReason) reasonsOk = false;
                                else {
                                  reasonCounts[u.fitReason] =
                                    (reasonCounts[u.fitReason] || 0) + 1;
                                }
                              }
                            }
                            if (pack && pack.freeRects
                                && typeof csPackV2FreeRectsOverlap === 'function') {
                              for (let i = 0; i < pack.freeRects.length; i++) {
                                for (let j = i + 1; j < pack.freeRects.length; j++) {
                                  if (csPackV2FreeRectsOverlap(
                                    pack.freeRects[i], pack.freeRects[j]))
                                    frNoOv = false;
                                }
                              }
                            }
                            const accounted = !!(pack
                              && (pack.placedCount + pack.unplacedCount) === built.length);
                            const feasRate = pack && pack.feasibleCount > 0
                              ? +pack.feasiblePlaceRate : 1;
                            // Feasible floor rate: after dim honesty + corner/yaw
                            const feasOk = feasRate >= 0.20 || !(pack && pack.feasibleCount > 0);
                            const logicOk = !!(pack && pack.ok !== false
                              && placedY0 && placedNoOv && reasonsOk && frNoOv
                              && accounted && absurdWithHints === 0 && feasOk);
                            step2f = {
                              ok: self2f.ok !== false && selfShip.ok !== false && logicOk,
                              selfTest: self2f,
                              shipAxesSelfTest: selfShip,
                              unitCount: built.length,
                              placedCount: pack ? pack.placedCount : 0,
                              unplacedCount: pack ? pack.unplacedCount : 0,
                              freeRectCount: pack && pack.freeRects
                                ? pack.freeRects.length : 0,
                              placedY0: placedY0,
                              placedNoOverlap: placedNoOv,
                              freeRectsNoOverlap: frNoOv,
                              allUnplacedHaveReason: reasonsOk,
                              accounted: accounted,
                              absurdFootprintCount: pack
                                ? (pack.absurdFootprintCount || 0) : 0,
                              absurdWithHints: absurdWithHints,
                              absurdSample: absurdSample,
                              feasibleCount: pack ? pack.feasibleCount : 0,
                              feasiblePlaced: pack ? pack.feasiblePlaced : 0,
                              feasiblePlaceRate: Math.round(feasRate * 1000) / 1000,
                              reasonCounts: reasonCounts,
                              unplacedSample: (pack && pack.unplaced)
                                ? pack.unplaced.slice(0, 15).map(u => ({
                                  mark: u.mark || null,
                                  fitReason: u.fitReason || null,
                                  pl: u.unit ? Math.round(+u.unit.packLengthMm || 0) : null,
                                  pw: u.unit ? Math.round(+u.unit.packWidthMm || 0) : null,
                                  ph: u.unit ? Math.round(+u.unit.packHeightMm || 0) : null,
                                }))
                                : [],
                            };
                          }

                          // Step 3a — twin pair detect only (no seat yet)
                          let step3a = { ok: false, error: 'csPackV2DetectTwinPairs missing' };
                          if (typeof csPackV2DetectTwinPairs === 'function'
                              && step2f && step2f.ok && step2a && step2a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const env = (typeof csPackV2FloorEnvelope === 'function')
                              ? csPackV2FloorEnvelope(spec) : null;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3a = (typeof csPackV2Step3aSelfTest === 'function')
                              ? csPackV2Step3aSelfTest() : { ok: true, skipped: true };
                            const pairs = csPackV2DetectTwinPairs(built, env);
                            let candCount = 0;
                            for (let i = 0; i < built.length; i++) {
                              if (typeof csPackV2IsTwinCandidate === 'function'
                                  && csPackV2IsTwinCandidate(built[i], env))
                                candCount++;
                            }
                            // Identity: every pair has two distinct uids
                            let idsOk = true;
                            const seen = new Set();
                            for (let i = 0; i < pairs.length; i++) {
                              const p = pairs[i];
                              const ua = p && p.a && p.a._fmUid;
                              const ub = p && p.b && p.b._fmUid;
                              if (!ua || !ub || ua === ub || seen.has(ua) || seen.has(ub))
                                idsOk = false;
                              else { seen.add(ua); seen.add(ub); }
                              if (p && Math.abs(+p.a.packLengthMm - +p.b.packLengthMm) > 50.5)
                                idsOk = false;
                            }
                            step3a = {
                              ok: self3a.ok !== false && idsOk,
                              selfTest: self3a,
                              candidateCount: candCount,
                              pairCount: pairs.length,
                              idsOk: idsOk,
                              pairs: pairs.slice(0, 10).map(p => ({
                                a: p.a ? (p.a.mark || p.a._fmUid) : null,
                                b: p.b ? (p.b.mark || p.b._fmUid) : null,
                                spanL: Math.round(+p.spanL || 0),
                                seatW: Math.round(+p.seatW || 0),
                                gapMm: p.gapMm,
                                uids: p._fmUids || null,
                              })),
                            };
                          }

                          // Step 3b — twin #1 wall-hug (inspect design on real IFC pairs)
                          let step3b = { ok: false, error: 'csPackV2SeatTwinWallHug missing' };
                          if (typeof csPackV2SeatTwinWallHug === 'function'
                              && step3a && step3a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const env = (typeof csPackV2FloorEnvelope === 'function')
                              ? csPackV2FloorEnvelope(spec) : null;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3b = (typeof csPackV2Step3bSelfTest === 'function')
                              ? csPackV2Step3bSelfTest() : { ok: true, skipped: true };
                            const pairs = (typeof csPackV2DetectTwinPairs === 'function')
                              ? csPackV2DetectTwinPairs(built, env) : [];
                            const views = [];
                            let allDesignOk = true;
                            let seated = 0;
                            // Probe up to 5 pairs — seat twin A only (3b scope)
                            for (let i = 0; i < pairs.length && i < 5; i++) {
                              const pr = pairs[i];
                              const hug = csPackV2SeatTwinWallHug(pr.a, env, {
                                placedBoxes: [],
                              });
                              if (hug && hug.ok) seated++;
                              else allDesignOk = false;
                              const d = hug && hug.inspect && hug.inspect.design
                                ? hug.inspect.design : null;
                              views.push({
                                mark: pr.a ? (pr.a.mark || null) : null,
                                ok: !!(hug && hug.ok),
                                reason: hug ? hug.reason : 'null',
                                designOk: !!(hug && hug.inspect && hug.inspect.ok),
                                pl: d ? d.pl : Math.round(+(pr.a && pr.a.packLengthMm) || 0),
                                pw: d ? d.pw : Math.round(+(pr.a && pr.a.packWidthMm) || 0),
                                ph: d ? d.ph : Math.round(+(pr.a && pr.a.packHeightMm) || 0),
                                x: d ? d.x : null,
                                z: d ? d.z : null,
                                y: d ? d.y : null,
                                steelWOk: d ? d.steelWOk : null,
                                atHomeWall: d ? d.atHomeWall : null,
                                atRear: d ? d.atRear : null,
                                onFloor: d ? d.onFloor : null,
                                padded: d ? (d.pw > 400) : null,
                              });
                              if (d && (d.pw > 400 || !d.steelWOk || !d.atHomeWall
                                  || !d.onFloor || !d.atRear))
                                allDesignOk = false;
                            }
                            // No pairs is OK for IFCs without twins — still need self-test
                            const probeOk = pairs.length === 0
                              || (seated === Math.min(5, pairs.length) && allDesignOk);
                            step3b = {
                              ok: self3b.ok !== false && probeOk,
                              selfTest: self3b,
                              pairCount: pairs.length,
                              seatedCount: seated,
                              allDesignOk: allDesignOk,
                              wallHugViews: views,
                            };
                          }

                          // Step 3c — twin #2 beside (+60 mm); design view A+B
                          let step3c = { ok: false, error: 'csPackV2PlaceTwinLane missing' };
                          if (typeof csPackV2PlaceTwinLane === 'function'
                              && step3a && step3a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const env = (typeof csPackV2FloorEnvelope === 'function')
                              ? csPackV2FloorEnvelope(spec) : null;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3c = (typeof csPackV2Step3cSelfTest === 'function')
                              ? csPackV2Step3cSelfTest() : { ok: true, skipped: true };
                            const pairs = (typeof csPackV2DetectTwinPairs === 'function')
                              ? csPackV2DetectTwinPairs(built, env) : [];
                            const views = [];
                            let allDesignOk = true;
                            let seated = 0;
                            for (let i = 0; i < pairs.length && i < 5; i++) {
                              const pr = pairs[i];
                              const lane = csPackV2PlaceTwinLane(pr, env, {
                                placedBoxes: [],
                              });
                              if (lane && lane.ok) seated++;
                              else allDesignOk = false;
                              const dA = lane && lane.hug && lane.hug.inspect
                                && lane.hug.inspect.design
                                ? lane.hug.inspect.design : null;
                              const dB = lane && lane.beside && lane.beside.inspect
                                && lane.beside.inspect.design
                                ? lane.beside.inspect.design : null;
                              views.push({
                                markA: pr.a ? (pr.a.mark || null) : null,
                                markB: pr.b ? (pr.b.mark || null) : null,
                                ok: !!(lane && lane.ok),
                                reason: lane ? lane.reason : 'null',
                                gapMm: lane ? lane.gapMm : null,
                                A: dA ? {
                                  pl: dA.pl, pw: dA.pw, ph: dA.ph,
                                  x: dA.x, z: dA.z, y: dA.y,
                                  steelWOk: dA.steelWOk, atHomeWall: dA.atHomeWall,
                                  atRear: dA.atRear, onFloor: dA.onFloor,
                                  padded: dA.pw > 400,
                                } : null,
                                B: dB ? {
                                  pl: dB.pl, pw: dB.pw, ph: dB.ph,
                                  x: dB.x, z: dB.z, y: dB.y,
                                  gapMm: dB.gapMm, gapOk: dB.gapOk,
                                  noOverlap: dB.noOverlap, steelWOk: dB.steelWOk,
                                  sameRearAsA: dB.sameRearAsA, onFloor: dB.onFloor,
                                  padded: dB.pw > 400,
                                } : null,
                              });
                              if (!dA || !dB || dA.pw > 400 || dB.pw > 400
                                  || !dA.steelWOk || !dB.steelWOk
                                  || !dA.onFloor || !dB.onFloor
                                  || !dB.gapOk || !dB.noOverlap
                                  || !dB.sameRearAsA)
                                allDesignOk = false;
                            }
                            const probeOk = pairs.length === 0
                              || (seated === Math.min(5, pairs.length) && allDesignOk);
                            step3c = {
                              ok: self3c.ok !== false && probeOk,
                              selfTest: self3c,
                              pairCount: pairs.length,
                              seatedCount: seated,
                              allDesignOk: allDesignOk,
                              twinLaneViews: views,
                            };
                          }

                          // Step 3d — clean full-length leftover strip after twin lane
                          let step3d = { ok: false, error: 'csPackV2RebuildTwinLeftoverRects missing' };
                          if (typeof csPackV2RebuildTwinLeftoverRects === 'function'
                              && typeof csPackV2PlaceTwinLane === 'function'
                              && step3a && step3a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const env = (typeof csPackV2FloorEnvelope === 'function')
                              ? csPackV2FloorEnvelope(spec) : null;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3d = (typeof csPackV2Step3dSelfTest === 'function')
                              ? csPackV2Step3dSelfTest() : { ok: true, skipped: true };
                            const pairs = (typeof csPackV2DetectTwinPairs === 'function')
                              ? csPackV2DetectTwinPairs(built, env) : [];
                            const views = [];
                            let allDesignOk = true;
                            let rebuilt = 0;
                            for (let i = 0; i < pairs.length && i < 5; i++) {
                              const pr = pairs[i];
                              const lane = csPackV2PlaceTwinLane(pr, env, {
                                placedBoxes: [],
                              });
                              const reb = (lane && lane.ok)
                                ? csPackV2RebuildTwinLeftoverRects(env, lane.placed, {})
                                : { ok: false, reason: 'LANE_FAIL', freeRects: [] };
                              if (reb && reb.ok) rebuilt++;
                              else allDesignOk = false;
                              const d = reb && reb.inspect && reb.inspect.design
                                ? reb.inspect.design : null;
                              const side = d && d.sideStrip ? d.sideStrip : null;
                              const front = d && d.frontRemnant ? d.frontRemnant : null;
                              views.push({
                                markA: pr.a ? (pr.a.mark || null) : null,
                                markB: pr.b ? (pr.b.mark || null) : null,
                                laneOk: !!(lane && lane.ok),
                                ok: !!(reb && reb.ok),
                                reason: reb ? reb.reason : 'null',
                                rectCount: reb && reb.freeRects
                                  ? reb.freeRects.length : 0,
                                occupied: d ? d.occupied : null,
                                sideStrip: side,
                                frontRemnant: front,
                                fullLengthOk: d ? d.fullLengthOk : null,
                                sideZOk: d ? d.sideZOk : null,
                                noRectOverlap: d ? d.noRectOverlap : null,
                                noTwinDigIn: d ? d.noTwinDigIn : null,
                                onFloor: d ? d.onFloor : null,
                                envLength: env ? Math.round(env.lengthMm) : null,
                              });
                              if (!d || !d.fullLengthOk || !d.sideZOk
                                  || !d.noRectOverlap || !d.noTwinDigIn
                                  || !d.onFloor || (reb.freeRects
                                    && reb.freeRects.length > 2))
                                allDesignOk = false;
                            }
                            const probeOk = pairs.length === 0
                              || (rebuilt === Math.min(5, pairs.length) && allDesignOk);
                            step3d = {
                              ok: self3d.ok !== false && probeOk,
                              selfTest: self3d,
                              pairCount: pairs.length,
                              rebuiltCount: rebuilt,
                              allDesignOk: allDesignOk,
                              stripViews: views,
                            };
                          }

                          // Step 3e — long nests into clean strip (design + no dig-in)
                          let step3e = { ok: false, error: 'csPackV2PlaceLongNestsIntoStrip missing' };
                          if (typeof csPackV2PlaceLongNestsIntoStrip === 'function'
                              && typeof csPackV2PlaceTwinLane === 'function'
                              && typeof csPackV2RebuildTwinLeftoverRects === 'function'
                              && step3a && step3a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const env = (typeof csPackV2FloorEnvelope === 'function')
                              ? csPackV2FloorEnvelope(spec) : null;
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3e = (typeof csPackV2Step3eSelfTest === 'function')
                              ? csPackV2Step3eSelfTest() : { ok: true, skipped: true };
                            const pairs = (typeof csPackV2DetectTwinPairs === 'function')
                              ? csPackV2DetectTwinPairs(built, env) : [];
                            const longCands = built.filter(u =>
                              typeof csPackV2IsLongNestUnit === 'function'
                              && csPackV2IsLongNestUnit(u, env));
                            const views = [];
                            let allDesignOk = true;
                            let probeRuns = 0;
                            let probeOkRuns = 0;
                            // Probe first twin pair lane → strip → long nests
                            if (pairs.length > 0) {
                              const pr = pairs[0];
                              const lane = csPackV2PlaceTwinLane(pr, env, {
                                placedBoxes: [],
                              });
                              const reb = (lane && lane.ok)
                                ? csPackV2RebuildTwinLeftoverRects(env, lane.placed, {})
                                : { ok: false, freeRects: [] };
                              const pass = (reb && reb.ok)
                                ? csPackV2PlaceLongNestsIntoStrip(
                                  built, reb.freeRects, lane.placed, { envelope: env })
                                : { ok: false, nestViews: [], placedLongCount: 0,
                                    longCandidateCount: longCands.length };
                              probeRuns = 1;
                              const nestViews = (pass && pass.nestViews) || [];
                              let designOk = !!(pass && pass.ok);
                              for (let vi = 0; vi < nestViews.length && vi < 8; vi++) {
                                const nv = nestViews[vi];
                                const d = nv && nv.design ? nv.design : null;
                                views.push({
                                  mark: nv ? nv.mark : null,
                                  ok: !!(nv && nv.ok),
                                  reason: nv ? nv.reason : null,
                                  pl: d ? d.pl : (nv && nv.pl),
                                  pw: d ? d.pw : (nv && nv.pw),
                                  ph: d ? d.ph : (nv && nv.ph),
                                  x: d ? d.x : (nv && nv.x),
                                  z: d ? d.z : (nv && nv.z),
                                  y: d ? d.y : (nv && nv.y),
                                  longEnough: d ? d.longEnough : null,
                                  inStrip: d ? d.inStrip : null,
                                  onFloor: d ? d.onFloor : null,
                                  noTwinDigIn: d ? d.noTwinDigIn : null,
                                  isNest: d ? d.isNest : null,
                                });
                                if (nv && nv.ok && d && (!d.longEnough || !d.inStrip
                                    || !d.onFloor || !d.noTwinDigIn || !d.isNest))
                                  designOk = false;
                              }
                              // No long nests is OK — pass still ok with 0 placed
                              if (designOk && pass && pass.ok) probeOkRuns = 1;
                              else allDesignOk = false;
                              step3e = {
                                ok: self3e.ok !== false && designOk && !!(pass && pass.ok),
                                selfTest: self3e,
                                pairCount: pairs.length,
                                longCandidateCount: pass
                                  ? pass.longCandidateCount : longCands.length,
                                placedLongCount: pass ? pass.placedLongCount : 0,
                                unplacedLongCount: pass && pass.unplacedLong
                                  ? pass.unplacedLong.length : 0,
                                allDesignOk: designOk,
                                sideStripZ: reb && reb.sideStrip ? reb.sideStrip.z : null,
                                nestViews: views,
                              };
                            } else {
                              // No twins — still require self-test; long-nest helper alone OK
                              step3e = {
                                ok: self3e.ok !== false,
                                selfTest: self3e,
                                pairCount: 0,
                                longCandidateCount: longCands.length,
                                placedLongCount: 0,
                                unplacedLongCount: 0,
                                allDesignOk: true,
                                nestViews: [],
                                note: 'no_twin_pairs',
                              };
                            }
                            if (probeRuns && !probeOkRuns) allDesignOk = false;
                            if (step3e && step3e.allDesignOk === false) allDesignOk = false;
                            step3e.allDesignOk = allDesignOk && (step3e.allDesignOk !== false);
                          }

                          // Step 3f — PackWithTwins full wire (twins→strip→long→floor)
                          let step3 = { ok: false, error: 'csPackV2PackWithTwins missing' };
                          if (typeof csPackV2PackWithTwins === 'function'
                              && step3a && step3a.ok) {
                            const spec = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec })
                              : [];
                            const self3 = (typeof csPackV2Step3SelfTest === 'function')
                              ? csPackV2Step3SelfTest() : { ok: true, skipped: true };
                            const pack = csPackV2PackWithTwins(built, {
                              containerSpec: spec,
                              enableStacks: true,
                            });
                            let accounted = false;
                            let feasOk = true;
                            let absurdWithHints = 0;
                            const absurdSample = [];
                            const Wcap = +(spec.widthMm || 2438);
                            if (pack) {
                              accounted = (pack.placedCount + pack.unplacedCount) === built.length;
                              const feasRate = pack.feasibleCount > 0
                                ? +pack.feasiblePlaceRate : 1;
                              feasOk = feasRate >= 0.20 || !(pack.feasibleCount > 0);
                            }
                            for (let i = 0; i < built.length; i++) {
                              const u = built[i];
                              if (!u) continue;
                              const pw = +u.packWidthMm || 0;
                              const pl = +u.packLengthMm || 0;
                              const ph = +u.packHeightMm || 0;
                              const isAsm = !!(u.isAssembly
                                || u.groupKind === 'welded_assembly'
                                || u.groupKind === 'assembly_single');
                              const hasHint = (+u.sectW >= 40) || (+u.shippingWidthMm >= 40)
                                || (+u.flangeWidthMm >= 40) || (+u.sectH >= 40);
                              const absurd = (typeof cs8IsAbsurdAssemblyFootprint === 'function')
                                ? cs8IsAbsurdAssemblyFootprint(pl, pw, ph, u)
                                : (pw > Wcap + 1 && pl > Wcap * 0.5);
                              if (isAsm && hasHint && absurd) {
                                absurdWithHints++;
                                if (absurdSample.length < 8) {
                                  absurdSample.push({
                                    mark: u.mark || null,
                                    pl: Math.round(pl), pw: Math.round(pw), ph: Math.round(ph),
                                  });
                                }
                              }
                            }
                            // Twin design sample (first 6 twin-role seats)
                            const twinViews = [];
                            if (pack && pack.placed) {
                              for (let i = 0; i < pack.placed.length && twinViews.length < 6; i++) {
                                const p = pack.placed[i];
                                if (!p || (p.role !== 'twin_wall_hug' && p.role !== 'twin_beside'))
                                  continue;
                                twinViews.push({
                                  mark: p.mark || null,
                                  role: p.role,
                                  pl: Math.round(+p.pl), pw: Math.round(+p.pw), ph: Math.round(+p.ph),
                                  x: +p.x, z: +p.z, y: +p.y,
                                  onFloor: p.y === 0 && p.box && p.box.minY === 0,
                                  steelWOk: +p.pw >= 120 && +p.pw <= 400,
                                  padded: +p.pw > 400,
                                });
                              }
                            }
                            const hasSideStrip = !!(pack && pack.hasSideStrip);
                            const stripAcceptable = !!(pack && (pack.stripAcceptable
                              || hasSideStrip || pack.stripOk));
                            const longFit = pack ? (+pack.longNestFitCount || 0) : 0;
                            const longPlaced = pack ? (+pack.longNestPlacedCount || 0) : 0;
                            const longRate = pack && pack.longNestPlaceRate != null
                              ? +pack.longNestPlaceRate
                              : (longFit > 0 ? longPlaced / longFit : 1);
                            const stripCap = pack ? (+pack.stripNestCapacity || 0) : 0;
                            const longTarget = pack && pack.longNestTarget != null
                              ? +pack.longNestTarget
                              : Math.min(stripCap, longFit);
                            // Real yard: fill min(strip capacity, fitters) — not every IFC nest
                            const longNestOk = longFit === 0 || stripCap === 0
                              || longPlaced >= longTarget;
                            const twinLaneOk = pack.twinPairCount === 0
                              || (pack.twinPairsPlaced >= 1 && pack.twinGapOk
                                && pack.twinNoDig && hasSideStrip && stripAcceptable);
                            const logicOk = !!(pack && pack.ok !== false
                              && pack.designOk !== false
                              && pack.allFloorY0 && pack.allNoOverlap
                              && pack.stackDesignOk !== false
                              && pack.stackNoTwinDig !== false
                              && accounted && absurdWithHints === 0 && feasOk
                              && twinLaneOk && longNestOk);
                            step3 = {
                              ok: self3.ok !== false && logicOk,
                              selfTest: self3,
                              unitCount: built.length,
                              placedCount: pack ? pack.placedCount : 0,
                              unplacedCount: pack ? pack.unplacedCount : 0,
                              feasibleCount: pack ? pack.feasibleCount : 0,
                              feasiblePlaced: pack ? pack.feasiblePlaced : 0,
                              feasiblePlaceRate: pack ? pack.feasiblePlaceRate : null,
                              absurdWithHints: absurdWithHints,
                              absurdSample: absurdSample,
                              twinPairCount: pack ? pack.twinPairCount : 0,
                              twinPairsPlaced: pack ? pack.twinPairsPlaced : 0,
                              twinPlacedCount: pack ? pack.twinPlacedCount : 0,
                              twinGapOk: pack ? pack.twinGapOk : null,
                              twinNoDig: pack ? pack.twinNoDig : null,
                              twinStoppedForStrip: pack ? !!pack.twinStoppedForStrip : null,
                              stripReserveMm: pack ? pack.stripReserveMm : null,
                              stripOk: pack ? pack.stripOk : null,
                              stripAcceptable: stripAcceptable,
                              hasSideStrip: hasSideStrip,
                              sideAbsentOk: pack && pack.stripInspect && pack.stripInspect.design
                                ? !!pack.stripInspect.design.sideAbsentOk : null,
                              sideStrip: pack && pack.sideStrip ? {
                                length: Math.round(+pack.sideStrip.length),
                                width: Math.round(+pack.sideStrip.width),
                                x: +pack.sideStrip.x,
                                z: +pack.sideStrip.z,
                              } : null,
                              longCandidateCount: pack ? pack.longCandidateCount : 0,
                              longNestFitCount: longFit,
                              longNestPlacedCount: longPlaced,
                              longNestPlaceRate: longRate,
                              stripNestCapacity: stripCap,
                              longNestTarget: longTarget,
                              allFloorY0: pack ? pack.allFloorY0 : null,
                              allNoOverlap: pack ? pack.allNoOverlap : null,
                              stackCount: pack ? (+pack.stackCount || 0) : 0,
                              stackDesignOk: pack ? pack.stackDesignOk !== false : null,
                              allStacksOnSupport: pack ? !!pack.allStacksOnSupport : null,
                              stackNoTwinDig: pack ? pack.stackNoTwinDig !== false : null,
                              accounted: accounted,
                              twinViews: twinViews,
                              laneResults: pack ? (pack.laneResults || []).slice(0, 8) : [],
                            };
                          }

                          // Step 4a — support map from placed nests (probe only; no stacking yet)
                          let step4a = { ok: false, error: 'csPackV2BuildSupportMap missing' };
                          if (typeof csPackV2BuildSupportMap === 'function'
                              && step3 && step3.ok !== false
                              && typeof csPackV2PackWithTwins === 'function') {
                            const spec4 = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4 = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4 })
                              : [];
                            const pack4 = csPackV2PackWithTwins(built4, {
                              containerSpec: spec4, enableStacks: false,
                            });
                            const self4a = (typeof csPackV2Step4aSelfTest === 'function')
                              ? csPackV2Step4aSelfTest() : { ok: true, skipped: true };
                            const map4 = csPackV2BuildSupportMap(
                              pack4.placed || [], pack4.envelope, {});
                            const nestOnFloor = (pack4.placed || []).filter(p =>
                              p && (p.role === 'long_nest_strip'
                                || (p.unit && typeof csPackIsNestUnit === 'function'
                                  && csPackIsNestUnit(p.unit))));
                            const twinOnFloor = (pack4.placed || []).filter(p =>
                              p && (p.role === 'twin_wall_hug' || p.role === 'twin_beside'));
                            const twinAsSupport = (map4.supports || []).filter(s =>
                              twinOnFloor.some(t => t._fmUid === s.sourceUid)).length;
                            const tallRejected = (map4.rejected || []).filter(r =>
                              String(r.reason || '').indexOf('TALL') >= 0).length;
                            const nestSupportMatch = map4.supportCount === nestOnFloor.length
                              || (nestOnFloor.length > 0 && map4.supportCount
                                === nestOnFloor.filter(p =>
                                  typeof csPackV2IsTallCarrier !== 'function'
                                  || !csPackV2IsTallCarrier(p, pack4.envelope)).length);
                            step4a = {
                              ok: self4a.ok !== false && map4.ok !== false
                                && twinAsSupport === 0 && nestSupportMatch,
                              selfTest: self4a,
                              supportCount: map4.supportCount || 0,
                              rejectedCount: map4.rejectedCount || 0,
                              nestPlacedCount: nestOnFloor.length,
                              twinPlacedCount: twinOnFloor.length,
                              twinAsSupport: twinAsSupport,
                              tallRejected: tallRejected,
                              nestSupportMatch: nestSupportMatch,
                              supports: (map4.supports || []).slice(0, 12).map(s => ({
                                mark: s.mark || null,
                                sourceUid: s.sourceUid,
                                pl: Math.round(+s.pl),
                                pw: Math.round(+s.pw),
                                ph: Math.round(+s.ph),
                                topY: Math.round(+s.topY),
                                x: +s.x,
                                z: +s.z,
                                kind: s.kind,
                                role: s.role || null,
                              })),
                              rejectedSample: (map4.rejected || []).slice(0, 12).map(r => ({
                                mark: r.mark || null,
                                reason: r.reason || null,
                                role: r.role || null,
                              })),
                            };
                          }

                          // Step 4b — stack candidate rules probe (no seat/commit yet)
                          let step4b = { ok: false, error: 'csPackV2IsStackCandidate missing' };
                          if (typeof csPackV2IsStackCandidate === 'function'
                              && typeof csPackV2BuildSupportMap === 'function'
                              && step4a && step4a.ok !== false
                              && typeof csPackV2PackWithTwins === 'function') {
                            const spec4b = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4b = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4b })
                              : [];
                            const pack4b = csPackV2PackWithTwins(built4b, {
                              containerSpec: spec4b, enableStacks: false,
                            });
                            const self4b = (typeof csPackV2Step4bSelfTest === 'function')
                              ? csPackV2Step4bSelfTest() : { ok: true, skipped: true };
                            const map4b = csPackV2BuildSupportMap(
                              pack4b.placed || [], pack4b.envelope, {});
                            const placedUids = {};
                            for (let i = 0; i < (pack4b.placed || []).length; i++) {
                              const p = pack4b.placed[i];
                              if (p && p._fmUid != null) placedUids[p._fmUid] = true;
                            }
                            const leftoverNests = built4b.filter(u =>
                              u && typeof csPackIsNestUnit === 'function'
                              && csPackIsNestUnit(u)
                              && (u._fmUid == null || !placedUids[u._fmUid]));
                            let candidatePairs = 0;
                            let unitsWithCandidate = 0;
                            const reasonCounts = {};
                            const samples = [];
                            for (let i = 0; i < leftoverNests.length; i++) {
                              const u = leftoverNests[i];
                              let unitOk = false;
                              for (let j = 0; j < (map4b.supports || []).length; j++) {
                                const c = csPackV2IsStackCandidate(
                                  u, map4b.supports[j], pack4b.envelope, {});
                                if (c && c.ok) {
                                  candidatePairs++;
                                  unitOk = true;
                                  if (samples.length < 8) {
                                    samples.push({
                                      mark: u.mark || null,
                                      supportMark: map4b.supports[j].mark || null,
                                      bearingFrac: c.design
                                        ? Math.round(+c.design.bearingFrac * 1000) / 1000
                                        : null,
                                      topY: map4b.supports[j].topY,
                                      ph: c.design ? c.design.ph : null,
                                    });
                                  }
                                } else if (c && c.reason) {
                                  reasonCounts[c.reason] = (reasonCounts[c.reason] || 0) + 1;
                                }
                              }
                              if (unitOk) unitsWithCandidate++;
                            }
                            // Assemblies must never be stack candidates
                            let asmCand = 0;
                            for (let i = 0; i < built4b.length; i++) {
                              const u = built4b[i];
                              if (!u || typeof csPackIsNestUnit !== 'function') continue;
                              if (csPackIsNestUnit(u)) continue;
                              if (!(u.isAssembly || u.groupKind === 'welded_assembly'
                                || u.groupKind === 'assembly_single')) continue;
                              for (let j = 0; j < (map4b.supports || []).length; j++) {
                                const c = csPackV2IsStackCandidate(
                                  u, map4b.supports[j], pack4b.envelope, {});
                                if (c && c.ok) asmCand++;
                              }
                            }
                            step4b = {
                              ok: self4b.ok !== false && asmCand === 0,
                              selfTest: self4b,
                              supportCount: map4b.supportCount || 0,
                              leftoverNestCount: leftoverNests.length,
                              candidatePairs: candidatePairs,
                              unitsWithCandidate: unitsWithCandidate,
                              assemblyCandidates: asmCand,
                              rejectReasons: reasonCounts,
                              samples: samples,
                            };
                          }

                          // Step 4c — try stack seat probe (preview only; no commit)
                          let step4c = { ok: false, error: 'csPackV2TryStackSeat missing' };
                          if (typeof csPackV2TryStackSeat === 'function'
                              && typeof csPackV2BuildSupportMap === 'function'
                              && step4b && step4b.ok !== false
                              && typeof csPackV2PackWithTwins === 'function') {
                            const spec4c = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4c = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4c })
                              : [];
                            const pack4c = csPackV2PackWithTwins(built4c, {
                              containerSpec: spec4c, enableStacks: false,
                            });
                            const self4c = (typeof csPackV2Step4cSelfTest === 'function')
                              ? csPackV2Step4cSelfTest() : { ok: true, skipped: true };
                            const map4c = csPackV2BuildSupportMap(
                              pack4c.placed || [], pack4c.envelope, {});
                            const boxes4c = (pack4c.placed || []).map(p => p && p.box)
                              .filter(Boolean);
                            const placedUids4c = {};
                            for (let i = 0; i < (pack4c.placed || []).length; i++) {
                              const p = pack4c.placed[i];
                              if (p && p._fmUid != null) placedUids4c[p._fmUid] = true;
                            }
                            const leftover4c = built4c.filter(u =>
                              u && typeof csPackIsNestUnit === 'function'
                              && csPackIsNestUnit(u)
                              && (u._fmUid == null || !placedUids4c[u._fmUid]));
                            let seatOkCount = 0;
                            let unitsSeatOk = 0;
                            let floatOrFloorY = 0;
                            let digOverlap = 0;
                            const seatReasons = {};
                            const seatSamples = [];
                            for (let i = 0; i < leftover4c.length; i++) {
                              const u = leftover4c[i];
                              let unitOk = false;
                              for (let j = 0; j < (map4c.supports || []).length; j++) {
                                const s = csPackV2TryStackSeat(u, map4c.supports[j], {
                                  envelope: pack4c.envelope,
                                  placedBoxes: boxes4c,
                                });
                                if (s && s.ok) {
                                  seatOkCount++;
                                  unitOk = true;
                                  if (!(+s.y > 0) || (s.box && +s.box.minY === 0
                                    && +map4c.supports[j].topY > 0))
                                    floatOrFloorY++;
                                  for (let k = 0; k < boxes4c.length; k++) {
                                    if (s.box && csPackV2BoxesOverlap(s.box, boxes4c[k]))
                                      digOverlap++;
                                  }
                                  if (seatSamples.length < 8) {
                                    seatSamples.push({
                                      mark: u.mark || null,
                                      supportMark: map4c.supports[j].mark || null,
                                      y: +s.y,
                                      topY: +map4c.supports[j].topY,
                                      pl: Math.round(+s.pl),
                                      pw: Math.round(+s.pw),
                                      ph: Math.round(+s.ph),
                                      bearingFrac: s.candidate && s.candidate.design
                                        ? Math.round(+s.candidate.design.bearingFrac * 1000) / 1000
                                        : null,
                                      onSupport: !!(s.inspect && s.inspect.design
                                        && s.inspect.design.onSupport),
                                    });
                                  }
                                } else if (s && s.reason) {
                                  seatReasons[s.reason] = (seatReasons[s.reason] || 0) + 1;
                                }
                              }
                              if (unitOk) unitsSeatOk++;
                            }
                            step4c = {
                              ok: self4c.ok !== false && floatOrFloorY === 0
                                && digOverlap === 0,
                              selfTest: self4c,
                              supportCount: map4c.supportCount || 0,
                              leftoverNestCount: leftover4c.length,
                              seatOkCount: seatOkCount,
                              unitsSeatOk: unitsSeatOk,
                              floatOrFloorY: floatOrFloorY,
                              digOverlap: digOverlap,
                              rejectReasons: seatReasons,
                              samples: seatSamples,
                            };
                          }

                          // Step 4d — commit stack seat probe (single commits; no pass loop yet)
                          let step4d = { ok: false, error: 'csPackV2CommitStackSeat missing' };
                          if (typeof csPackV2CommitStackSeat === 'function'
                              && typeof csPackV2TryStackSeat === 'function'
                              && typeof csPackV2BuildSupportMap === 'function'
                              && step4c && step4c.ok !== false
                              && typeof csPackV2PackWithTwins === 'function') {
                            const spec4d = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4d = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4d })
                              : [];
                            const pack4d = csPackV2PackWithTwins(built4d, {
                              containerSpec: spec4d, enableStacks: false,
                            });
                            const self4d = (typeof csPackV2Step4dSelfTest === 'function')
                              ? csPackV2Step4dSelfTest() : { ok: true, skipped: true };
                            const map4d = csPackV2BuildSupportMap(
                              pack4d.placed || [], pack4d.envelope, {});
                            const boxes4d = (pack4d.placed || []).map(p => p && p.box)
                              .filter(Boolean);
                            const placedUids4d = {};
                            for (let i = 0; i < (pack4d.placed || []).length; i++) {
                              const p = pack4d.placed[i];
                              if (p && p._fmUid != null) placedUids4d[p._fmUid] = true;
                            }
                            const leftover4d = built4d.filter(u =>
                              u && typeof csPackIsNestUnit === 'function'
                              && csPackIsNestUnit(u)
                              && (u._fmUid == null || !placedUids4d[u._fmUid]));
                            let commitOk = 0;
                            let commitFail = 0;
                            let badFloorY = 0;
                            let badRole = 0;
                            let digOverlap4d = 0;
                            const commitReasons = {};
                            const commitSamples = [];
                            // Probe: try commit first leftover nest on first viable support
                            // (not a full pass — that is 4e). Validate gravity lock.
                            for (let i = 0; i < leftover4d.length; i++) {
                              const u = leftover4d[i];
                              let did = false;
                              for (let j = 0; j < (map4d.supports || []).length; j++) {
                                const sup = map4d.supports[j];
                                const s = csPackV2TryStackSeat(u, sup, {
                                  envelope: pack4d.envelope,
                                  placedBoxes: boxes4d,
                                });
                                if (!s || !s.ok) {
                                  if (s && s.reason)
                                    commitReasons[s.reason] = (commitReasons[s.reason] || 0) + 1;
                                  continue;
                                }
                                const cm = csPackV2CommitStackSeat(u, s, sup, {
                                  envelope: pack4d.envelope,
                                  placedBoxes: boxes4d,
                                });
                                if (cm && cm.ok && cm.placement) {
                                  commitOk++;
                                  did = true;
                                  const pl = cm.placement;
                                  if (+sup.topY > 0 && +pl.y === 0) badFloorY++;
                                  if (pl.role !== 'nest_stack' || pl.layer !== 'stack')
                                    badRole++;
                                  for (let k = 0; k < boxes4d.length; k++) {
                                    if (csPackV2BoxesOverlap(pl.box, boxes4d[k]))
                                      digOverlap4d++;
                                  }
                                  if (commitSamples.length < 8) {
                                    commitSamples.push({
                                      mark: u.mark || null,
                                      supportMark: sup.mark || null,
                                      y: +pl.y,
                                      minY: pl.box ? +pl.box.minY : null,
                                      topY: +sup.topY,
                                      role: pl.role,
                                      layer: pl.layer,
                                      onSupport: !!(pl.inspect && pl.inspect.design
                                        && pl.inspect.design.onSupport),
                                    });
                                  }
                                  // Don't mutate boxes for probe of other units —
                                  // 4e will do sequential commits. One success per unit.
                                  break;
                                }
                                commitFail++;
                                if (cm && cm.reason)
                                  commitReasons[cm.reason] = (commitReasons[cm.reason] || 0) + 1;
                              }
                              if (!did) { /* leftover without commit — ok for probe */ }
                            }
                            step4d = {
                              ok: self4d.ok !== false && badFloorY === 0
                                && badRole === 0 && digOverlap4d === 0,
                              selfTest: self4d,
                              supportCount: map4d.supportCount || 0,
                              leftoverNestCount: leftover4d.length,
                              commitOk: commitOk,
                              commitFail: commitFail,
                              badFloorY: badFloorY,
                              badRole: badRole,
                              digOverlap: digOverlap4d,
                              rejectReasons: commitReasons,
                              samples: commitSamples,
                            };
                          }

                          // Step 4e — PlaceNestStacks pass (probe; wire into PackWithTwins = 4f)
                          let step4e = { ok: false, error: 'csPackV2PlaceNestStacks missing' };
                          if (typeof csPackV2PlaceNestStacks === 'function'
                              && step4d && step4d.ok !== false
                              && typeof csPackV2PackWithTwins === 'function') {
                            const spec4e = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4e = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4e })
                              : [];
                            const pack4e = csPackV2PackWithTwins(built4e, {
                              containerSpec: spec4e, enableStacks: false,
                            });
                            const self4e = (typeof csPackV2Step4eSelfTest === 'function')
                              ? csPackV2Step4eSelfTest() : { ok: true, skipped: true };
                            const pass4e = csPackV2PlaceNestStacks(built4e, pack4e.placed || [], {
                              envelope: pack4e.envelope,
                              containerSpec: spec4e,
                            });
                            let digTwin4e = 0;
                            let floatY4e = 0;
                            for (let i = 0; i < (pass4e.stacked || []).length; i++) {
                              const pl = pass4e.stacked[i];
                              if (!pl || !pl.box) continue;
                              if (+pl.supportTopY > 0 && +pl.y === 0) floatY4e++;
                              if (Math.abs(+pl.box.minY - +pl.y) > 0.5) floatY4e++;
                              for (let j = 0; j < (pack4e.placed || []).length; j++) {
                                const tw = pack4e.placed[j];
                                if (!tw || !tw.box) continue;
                                if ((tw.role === 'twin_wall_hug' || tw.role === 'twin_beside')
                                    && typeof csPackV2BoxesOverlap === 'function'
                                    && csPackV2BoxesOverlap(pl.box, tw.box))
                                  digTwin4e++;
                              }
                            }
                            const unplacedReasons = {};
                            for (let i = 0; i < (pass4e.stillUnplaced || []).length; i++) {
                              const r = pass4e.stillUnplaced[i].reason || 'UNKNOWN';
                              unplacedReasons[r] = (unplacedReasons[r] || 0) + 1;
                            }
                            step4e = {
                              ok: self4e.ok !== false && pass4e.designOk !== false
                                && floatY4e === 0 && digTwin4e === 0
                                && pass4e.accounted !== false,
                              selfTest: self4e,
                              stackCount: pass4e.stackCount || 0,
                              leftoverIn: pass4e.leftoverIn || 0,
                              stillUnplacedCount: pass4e.stillUnplacedCount || 0,
                              accounted: !!pass4e.accounted,
                              designOk: !!pass4e.designOk,
                              allOnSupport: !!pass4e.allOnSupport,
                              allNoDigIn: !!pass4e.allNoDigIn,
                              allNoFloorY0: !!pass4e.allNoFloorY0,
                              floatY: floatY4e,
                              digTwin: digTwin4e,
                              unplacedReasons: unplacedReasons,
                              samples: (pass4e.stacked || []).slice(0, 8).map(p => ({
                                mark: p.mark || null,
                                y: +p.y,
                                minY: p.box ? +p.box.minY : null,
                                supportTopY: +p.supportTopY,
                                role: p.role,
                                supportMark: null,
                              })),
                              attemptSample: (pass4e.attempts || []).slice(0, 10).map(a => ({
                                mark: a.mark || null,
                                ok: !!a.ok,
                                reason: a.reason || null,
                                supportMark: a.supportMark || null,
                                y: a.y != null ? +a.y : null,
                                sameFamily: a.sameFamily != null ? !!a.sameFamily : null,
                              })),
                            };
                          }

                          // Step 4f — wired PackWithTwins+stacks + full Step4 suite
                          let step4 = { ok: false, error: 'csPackV2PackWithTwins missing' };
                          if (typeof csPackV2PackWithTwins === 'function'
                              && step4e && step4e.ok !== false) {
                            const spec4f = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built4f = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec4f })
                              : [];
                            const self4 = (typeof csPackV2Step4SelfTest === 'function')
                              ? csPackV2Step4SelfTest() : { ok: true, skipped: true };
                            const packOff = csPackV2PackWithTwins(built4f, {
                              containerSpec: spec4f, enableStacks: false,
                            });
                            const packOn = csPackV2PackWithTwins(built4f, {
                              containerSpec: spec4f, enableStacks: true,
                            });
                            const stackItems = (packOn.placed || []).filter(p =>
                              p && (p.role === 'nest_stack' || p.layer === 'stack'));
                            const floorItems = (packOn.placed || []).filter(p =>
                              p && p.role !== 'nest_stack' && p.layer !== 'stack');
                            let floatY4f = 0;
                            let digPair = 0;
                            let digTwin4f = 0;
                            for (let i = 0; i < stackItems.length; i++) {
                              const pl = stackItems[i];
                              if (!pl.box) continue;
                              if (!(+pl.y > 0) && !(+pl.supportTopY === 0)) floatY4f++;
                              if (Math.abs(+pl.box.minY - +pl.y) > 0.5) floatY4f++;
                            }
                            for (let i = 0; i < (packOn.placed || []).length; i++) {
                              const a = packOn.placed[i];
                              if (!a || !a.box) continue;
                              for (let j = i + 1; j < packOn.placed.length; j++) {
                                const b = packOn.placed[j];
                                if (!b || !b.box) continue;
                                if (typeof csPackV2BoxesOverlap === 'function'
                                    && csPackV2BoxesOverlap(a.box, b.box))
                                  digPair++;
                              }
                              if (a.role === 'nest_stack' || a.layer === 'stack') {
                                for (let j = 0; j < packOn.placed.length; j++) {
                                  const tw = packOn.placed[j];
                                  if (!tw || !tw.box) continue;
                                  if ((tw.role === 'twin_wall_hug' || tw.role === 'twin_beside')
                                      && typeof csPackV2BoxesOverlap === 'function'
                                      && csPackV2BoxesOverlap(a.box, tw.box))
                                    digTwin4f++;
                                }
                              }
                            }
                            const accounted4f = packOn.placedCount + packOn.unplacedCount
                              === built4f.length;
                            const improved = packOn.placedCount >= packOff.placedCount
                              && (packOn.stackCount || 0)
                                === Math.max(0, packOn.placedCount - packOff.placedCount);
                            const twinAsStackSup = stackItems.filter(p =>
                              p.supportUid != null
                              && (packOn.placed || []).some(t =>
                                t && t._fmUid === p.supportUid
                                && (t.role === 'twin_wall_hug' || t.role === 'twin_beside'))).length;
                            step4 = {
                              ok: self4.ok !== false && packOn.ok !== false
                                && packOn.stackDesignOk !== false
                                && packOn.allFloorY0 && packOn.allNoOverlap
                                && floatY4f === 0 && digPair === 0 && digTwin4f === 0
                                && twinAsStackSup === 0 && accounted4f && improved,
                              selfTest: self4,
                              enableStacks: !!packOn.enableStacks,
                              unitCount: built4f.length,
                              placedFloorOnly: packOff.placedCount || 0,
                              placedWithStacks: packOn.placedCount || 0,
                              unplacedCount: packOn.unplacedCount || 0,
                              stackCount: packOn.stackCount || 0,
                              stackLeftoverIn: packOn.stackLeftoverIn || 0,
                              stackStillUnplaced: packOn.stackStillUnplacedCount || 0,
                              feasiblePlaceRate: packOn.feasiblePlaceRate,
                              allFloorY0: !!packOn.allFloorY0,
                              allStacksOnSupport: !!packOn.allStacksOnSupport,
                              allNoOverlap: !!packOn.allNoOverlap,
                              stackNoTwinDig: packOn.stackNoTwinDig !== false,
                              stackDesignOk: packOn.stackDesignOk !== false,
                              floatY: floatY4f,
                              digPair: digPair,
                              digTwin: digTwin4f,
                              twinAsStackSupport: twinAsStackSup,
                              accounted: accounted4f,
                              improved: improved,
                              floorItemCount: floorItems.length,
                              stackItemCount: stackItems.length,
                              samples: stackItems.slice(0, 10).map(p => ({
                                mark: p.mark || null,
                                y: +p.y,
                                minY: p.box ? +p.box.minY : null,
                                supportTopY: +p.supportTopY,
                                supportUid: p.supportUid != null ? p.supportUid : null,
                                role: p.role,
                                layer: p.layer,
                              })),
                            };
                          }

                          // Step 5 — Optimise report + soak gates (float/dig/twins/stacks)
                          let step5 = { ok: false, error: 'csPackV2BuildPackReport missing' };
                          if (typeof csPackV2BuildPackReport === 'function'
                              && step4 && step4.ok !== false) {
                            const spec5 = (typeof rawScene !== 'undefined' && rawScene
                              && rawScene.containerSpec)
                              ? rawScene.containerSpec
                              : { lengthMm: 12000, widthMm: 2438, heightMm: 2690 };
                            const built5 = (typeof csPackV2BuildUnits === 'function')
                              ? csPackV2BuildUnits(
                                (typeof assemblyGroups !== 'undefined' && assemblyGroups) || [],
                                { containerSpec: spec5, checkedOnly: false })
                              : [];
                            // Fast 5f on fixtures (skip nested 5e/4 — those already ran above)
                            const self5f = (typeof csPackV2Step5fSelfTest === 'function')
                              ? csPackV2Step5fSelfTest({ skipRegression: true })
                              : { ok: true, skipped: true };
                            const opt5 = (typeof csPackV2RunOptimise === 'function')
                              ? csPackV2RunOptimise({
                                  units: built5,
                                  containerSpec: spec5,
                                  enableStacks: true,
                                })
                              : null;
                            const opt5off = (typeof csPackV2RunOptimise === 'function')
                              ? csPackV2RunOptimise({
                                  units: built5,
                                  containerSpec: spec5,
                                  enableStacks: false,
                                })
                              : null;
                            const report5 = (opt5 && opt5.report)
                              ? opt5.report
                              : csPackV2BuildPackReport(opt5 || packOn || null);
                            const soak5 = (typeof csPackV2SoakInspect === 'function' && opt5)
                              ? csPackV2SoakInspect(opt5, {
                                  containerSpec: spec5,
                                  floorOnly: opt5off && opt5off.pack,
                                })
                              : { ok: false, error: 'soak_missing' };
                            // Live THREE soak: apply layout + render, then measure meshes
                            let live5 = { ok: true, skipped: true, reason: 'NO_RENDER' };
                            try {
                              if (opt5 && opt5.layout && typeof renderContainer === 'function') {
                                currentLayout = opt5.layout;
                                currentContainerIdx = 0;
                                renderContainer(0);
                                if (typeof csPackV2LiveMeshSoak === 'function'
                                    && typeof clickable !== 'undefined') {
                                  live5 = csPackV2LiveMeshSoak(
                                    clickable,
                                    opt5.layout.containers[0] || spec5);
                                }
                              }
                            } catch (liveErr) {
                              live5 = {
                                ok: false,
                                error: String(liveErr && liveErr.message || liveErr),
                              };
                            }
                            try {
                              if (typeof csPackV2PublishPackReport === 'function' && report5)
                                csPackV2PublishPackReport(report5, { updateDom: false });
                            } catch (_) { /* */ }
                            const matchStep4 = !!(report5
                              && step4.placedWithStacks === report5.placedCount
                              && step4.stackCount === report5.stackCount
                              && step4.unplacedCount === report5.unplacedCount);
                            const applyOk = !!(opt5 && opt5.apply
                              && opt5.apply.missed === 0
                              && opt5.placedItems
                              && opt5.placedItems.length === report5.placedCount);
                            const twinOk = !report5.twinPlacedCount
                              || (report5.twinHugCount >= 1 && soak5.twinHugOk);
                            const stackOk = !report5.stackCount
                              || (soak5.stacksElevated && soak5.stackCount === report5.stackCount);
                            const liveOk = live5.skipped || (live5.ok !== false
                              && (+live5.floatCount || 0) === 0
                              && (+live5.digCount || 0) === 0);
                            step5 = {
                              ok: self5f.ok !== false
                                && report5 && report5.ok !== false
                                && soak5 && soak5.ok !== false
                                && soak5.floatCount === 0
                                && soak5.digCount === 0
                                && soak5.digTwin === 0
                                && matchStep4 && applyOk
                                && twinOk && stackOk
                                && liveOk
                                && report5.gates
                                && report5.gates.allFloorY0
                                && report5.gates.allNoOverlap
                                && report5.gates.stackNoTwinDig,
                              selfTest: {
                                ok: self5f.ok !== false,
                                passed: self5f.passed,
                                total: self5f.total,
                                skipped: !!self5f.skipped,
                                mode: 'step5f_fast',
                              },
                              unitCount: built5.length,
                              soak: {
                                ok: soak5.ok,
                                summary: soak5.summary,
                                floatCount: soak5.floatCount,
                                digCount: soak5.digCount,
                                digTwin: soak5.digTwin,
                                twinHugOk: soak5.twinHugOk,
                                twinHugCount: soak5.twinHugCount,
                                twinBesideCount: soak5.twinBesideCount,
                                stackCount: soak5.stackCount,
                                stacksElevated: soak5.stacksElevated,
                                improved: soak5.improved,
                                accounted: soak5.accounted,
                                placedFloorOnly: opt5off ? opt5off.pack.placedCount : null,
                                placedWithStacks: opt5 ? opt5.pack.placedCount : null,
                              },
                              live: {
                                ok: live5.ok !== false,
                                skipped: !!live5.skipped,
                                summary: live5.summary || null,
                                floatCount: live5.floatCount != null ? live5.floatCount : null,
                                digCount: live5.digCount != null ? live5.digCount : null,
                                digTwin: live5.digTwin != null ? live5.digTwin : null,
                                meshDigCount: live5.meshDigCount != null ? live5.meshDigCount : null,
                                meshCount: live5.meshCount != null ? live5.meshCount : null,
                                stackCount: live5.stackCount != null ? live5.stackCount : null,
                                twinHugOk: live5.twinHugOk,
                                error: live5.error || null,
                              },
                              report: report5 ? {
                                ok: report5.ok,
                                summary: report5.summary,
                                placedCount: report5.placedCount,
                                unplacedCount: report5.unplacedCount,
                                twinPlacedCount: report5.twinPlacedCount,
                                twinHugCount: report5.twinHugCount,
                                twinBesideCount: report5.twinBesideCount,
                                stackCount: report5.stackCount,
                                floorCount: report5.floorCount,
                                longNestPlacedCount: report5.longNestPlacedCount,
                                hasSideStrip: report5.hasSideStrip,
                                stripReserveMm: report5.stripReserveMm,
                                enableStacks: report5.enableStacks,
                                leftoverByReason: report5.leftoverByReason,
                                leftovers: (report5.leftovers || []).slice(0, 25),
                                gates: report5.gates,
                                weightKg: report5.weightKg,
                                weightUtilizationPct: report5.weightUtilizationPct,
                              } : null,
                              matchStep4: matchStep4,
                              applyOk: applyOk,
                              twinOk: twinOk,
                              stackOk: stackOk,
                              liveOk: liveOk,
                              toast: (opt5 && opt5.toast) || (report5 && report5.toast) || null,
                            };
                          }

                          window.__cliGroupReport = {
                            ok: selfTest.ok !== false && fatNests.length === 0
                              && yardOk && step2a.ok !== false && step2b.ok !== false
                              && step2c.ok !== false && step2d.ok !== false
                              && step2e.ok !== false && step2f.ok !== false
                              && step3a.ok !== false && step3b.ok !== false
                              && step3c.ok !== false && step3d.ok !== false
                              && step3e.ok !== false && step3.ok !== false
                              && step4a.ok !== false && step4b.ok !== false
                              && step4c.ok !== false && step4d.ok !== false
                              && step4e.ok !== false && step4.ok !== false
                              && step5.ok !== false,
                            mode: 'group_yard_step2_plus_step3_plus_step4_plus_step5f',
                            groupCount: groups.length,
                            outsideCount: outs.length,
                            selfTest: selfTest,
                            nestUnitCount: nestUnits.length,
                            fatNestCount: fatNests.length,
                            fatNests: fatNests.slice(0, 20),
                            shortLenCount: shortLen.length,
                            shortLen: shortLen.slice(0, 15),
                            nestSample: nestUnits.slice(0, 25),
                            step2a: step2a,
                            step2b: step2b,
                            step2c: step2c,
                            step2d: step2d,
                            step2e: step2e,
                            step2f: step2f,
                            step3a: step3a,
                            step3b: step3b,
                            step3c: step3c,
                            step3d: step3d,
                            step3e: step3e,
                            step3: step3,
                            step4a: step4a,
                            step4b: step4b,
                            step4c: step4c,
                            step4d: step4d,
                            step4e: step4e,
                            step4: step4,
                            step5: step5,
                            yard: {
                              floatCount: floats.length,
                              floats: floats.slice(0, 25),
                              tipWarnNestCount: tipWarnNest.length,
                              tipWarnNests: tipWarnNest.slice(0, 25),
                              tipWarnAsmCount: tipWarnAsm.length,
                              tipWarnAsms: tipWarnAsm.slice(0, 25),
                              overlapCount: overlaps.length,
                              nestOverlapCount: nestOverlaps.length,
                              overlaps: overlaps.slice(0, 30),
                            },
                            groups: groups.slice(0, 80).map(g => ({
                              mark: g.mark || null,
                              groupKind: g.groupKind || null,
                              qty: g.qty || 0,
                              state: g.state || null,
                              weightKg: g.sortWeightKg || g.weightKg || 0,
                              packUnits: (g.packUnits || []).length,
                            })),
                          };
                        } catch (e) {
                          window.__cliGroupReport = {
                            ok: false,
                            error: String(e && e.message || e),
                          };
                        } finally {
                          window.__cliGroupBusy = false;
                        }
                      })();
                      return 'started';
                    })()
                    """);
                string groupJson = "{\"ok\":false,\"error\":\"group report timeout\"}";
                for (int i = 0; i < 180; i++) // up to ~3 min (large IFC Group By)
                {
                    await Task.Delay(1000);
                    string probe = await webView.CoreWebView2.ExecuteScriptAsync(
                        "window.__cliGroupReport ? JSON.stringify(window.__cliGroupReport) : (window.__cliGroupBusy ? '\"BUSY\"' : 'null')");
                    string? probeVal = null;
                    try { probeVal = JsonSerializer.Deserialize<string>(probe); } catch { /* */ }
                    if (probeVal == "BUSY" || probeVal == null) continue;
                    if (!string.IsNullOrWhiteSpace(probeVal) && probeVal.StartsWith('{'))
                    {
                        groupJson = probeVal;
                        break;
                    }
                }
                try
                {
                    string reportPath = Path.Combine(AppContext.BaseDirectory, "_ifc_group_report.json");
                    await File.WriteAllTextAsync(reportPath, groupJson);
                    if (!string.IsNullOrWhiteSpace(Program.CliReportOutPath))
                    {
                        try
                        {
                            string dest = Program.CliReportOutPath.Trim().Trim('"');
                            if (!Path.IsPathRooted(dest))
                            {
                                // Resolve relative to the caller's cwd, not the EXE folder
                                dest = Path.GetFullPath(dest, Directory.GetCurrentDirectory());
                            }
                            string? dir = Path.GetDirectoryName(dest);
                            if (!string.IsNullOrWhiteSpace(dir))
                                Directory.CreateDirectory(dir);
                            File.Copy(reportPath, dest, overwrite: true);
                        }
                        catch (Exception outEx)
                        {
                            try
                            {
                                await File.WriteAllTextAsync(
                                    Path.Combine(AppContext.BaseDirectory, "_ifc_group_report_out_error.txt"),
                                    outEx.ToString());
                            }
                            catch { /* */ }
                        }
                    }
                    try
                    {
                        using var doc = JsonDocument.Parse(groupJson);
                        bool ok = doc.RootElement.TryGetProperty("ok", out var okEl)
                            && okEl.ValueKind == JsonValueKind.True;
                        Environment.ExitCode = ok ? 0 : 1;
                    }
                    catch
                    {
                        Environment.ExitCode = 2;
                    }
                }
                catch { /* */ }
                lblStatus.Text = $"{job.JobNo}  |  {phaseText}  |  {items.Count} assemblies " +
                                  $"({skipped} skipped), {Math.Round(totalWeight, 1)} kg  |  Grouped";
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
            using var doc = JsonDocument.Parse(json);

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
