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

            // CLI --ifc: Group → select all → Optimise so upright floor anchors are visible
            if (skipPhasePicker && webView.CoreWebView2 != null)
            {
                lblStatus.Text += "  |  Auto Optimise…";
                await Task.Delay(2800);
                await webView.CoreWebView2.ExecuteScriptAsync(
                    """
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
                        console.info('[CLI] Group + Optimise done');
                      } catch (e) {
                        console.error('[CLI] auto pack failed', e);
                      }
                    })()
                    """);
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
