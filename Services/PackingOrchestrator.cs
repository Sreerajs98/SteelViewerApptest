namespace SteelPackingApp.Services;

using System.Linq;
using SteelPackingApp.Models;

/// <summary>
/// Top-level orchestrator — wires the four independent engines together
/// following the decoupled architecture:
///
///   IFC file
///      ↓  [IParserService]       schema-agnostic parse
///   SteelItem[]
///      ↓  [ValidationService]    sanity check + flag bad data
///   SteelItem[] (valid)
///      ↓  [GroupingService]      heuristic clustering
///   AssemblyGroup[]
///      ↓  [PackingEngine]        3-D bin packing
///   ContainerManager             multi-container result
///
/// Each engine is independently testable and replaceable. The UI talks
/// to this orchestrator and to ContainerManager only.
/// </summary>
public class PackingOrchestrator
{
    private readonly IParserService    _parser;
    private readonly ValidationService _validator;
    private readonly GroupingService   _grouper;
    private readonly PackingEngine     _packer;

    public PackingOrchestrator(
        IParserService?    parser    = null,
        ValidationService? validator = null,
        GroupingService?   grouper   = null,
        PackingEngine?     packer    = null)
    {
        _parser    = parser    ?? new IfcParserAdapter();
        _validator = validator ?? new ValidationService();
        _grouper   = grouper   ?? new GroupingService();
        _packer    = packer    ?? new PackingEngine();
    }

    /// <summary>
    /// Full auto-pack pipeline: parse → validate → group → pack.
    /// Returns a populated ContainerManager ready for the UI.
    /// </summary>
    public async Task<OrchestratorResult> RunAsync(
        string filePath, ParseOptions? parseOpts = null,
        GroupingOptions? groupOpts = null,
        ContainerSpec?   containerSpec = null,
        IProgress<string>? progress = null,
        CancellationToken ct = default)
    {
        // ── Step 1: Parse ─────────────────────────────────────────────
        progress?.Report("Parsing IFC file…");
        var parseResult = await _parser.ParseAsync(filePath, parseOpts ?? new ParseOptions(), ct);

        // ── Step 2: Validate ──────────────────────────────────────────
        progress?.Report("Validating items…");
        var valResult = _validator.Validate(parseResult.Items);

        // ── Step 3: Group ─────────────────────────────────────────────
        progress?.Report("Clustering into assembly groups…");
        var validItems = valResult.ValidItems.ToList();
        if (!validItems.Any())
            return OrchestratorResult.Fail("No valid items found after validation. Check IFC data.");

        var groups = _grouper.Cluster(validItems);

        // ── Step 4: Pack ──────────────────────────────────────────────
        progress?.Report($"Packing {groups.Count} groups into containers…");
        var manager = new ContainerManager(containerSpec);
        _packer.Pack(groups, manager);

        progress?.Report("Done.");

        return new OrchestratorResult
        {
            Ok             = true,
            ParseResult    = parseResult,
            ValidationResult = valResult,
            Groups         = groups,
            Manager        = manager,
        };
    }

    /// <summary>
    /// Re-group and re-pack with new options (e.g. after user changes phase filter).
    /// Parser is NOT re-run — uses cached parse result.
    /// </summary>
    public OrchestratorResult Regroup(
        IReadOnlyList<SteelItem> items,
        GroupingOptions?  groupOpts     = null,
        ContainerSpec?    containerSpec = null)
    {
        var valResult = _validator.Validate(items);
        var groups    = _grouper.Cluster(valResult.ValidItems.ToList());
        var manager   = new ContainerManager(containerSpec);
        _packer.Pack(groups, manager);

        return new OrchestratorResult
        {
            Ok               = true,
            ValidationResult = valResult,
            Groups           = groups,
            Manager          = manager,
        };
    }
}

public class OrchestratorResult
{
    public bool              Ok               { get; init; }
    public string?           Error            { get; init; }
    public ParseResult?      ParseResult      { get; init; }
    public ValidationResult? ValidationResult { get; init; }
    public IReadOnlyList<AssemblyGroup>? Groups { get; init; }
    public ContainerManager? Manager          { get; init; }

    public static OrchestratorResult Fail(string error) => new() { Ok = false, Error = error };
}

// ── Thin adapter: xBIM-first ingest, STEP fallback ─────────────────────────

internal class IfcParserAdapter : IParserService
{
    public async Task<ParseResult> ParseAsync(string filePath, ParseOptions opts, CancellationToken ct)
    {
        return await Task.Run(() =>
        {
            var warnings = new List<ParseWarning>();

            double? phaseDouble = null;
            if (opts.PhaseFilter != null && double.TryParse(opts.PhaseFilter, out double pd))
                phaseDouble = pd;

            var (_, items, skipped) = XbimIfcIngest.ConvertWithFallback(filePath, phaseDouble);

            foreach (var item in items)
            {
                if (item.WeightEstimated)
                    warnings.Add(new ParseWarning {
                        Mark     = item.AssmMark,
                        Message  = "Weight estimated from geometry bounding box",
                        Severity = WarningSeverity.Caution
                    });
                if (item.Remarks.Contains("secondary parts", StringComparison.OrdinalIgnoreCase))
                    warnings.Add(new ParseWarning {
                        Mark     = item.AssmMark,
                        Message  = "Bounding box may include secondary parts",
                        Severity = WarningSeverity.Caution
                    });
            }

            return new ParseResult {
                Items        = items,
                Warnings     = warnings,
                SkippedCount = skipped,
                SourceFile   = filePath
            };
        }, ct);
    }

    public async Task<IReadOnlyList<string>> GetPhasesAsync(string filePath, CancellationToken ct)
        => await Task.Run(() =>
            (IReadOnlyList<string>) XbimIfcIngest.ListPhasesWithFallback(filePath)
                .Select(p => p.ToString("G"))
                .ToList()
        , ct);
}
