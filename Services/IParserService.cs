namespace SteelPackingApp.Services;

using SteelPackingApp.Models;

/// <summary>
/// Schema-agnostic interface for parsing any BIM/IFC file into
/// normalized SteelItem objects. Implementations can target IFC2x3,
/// IFC4, Excel shipping lists, or any future format — the packing
/// engine only ever sees SteelItem and never touches raw IFC data.
/// </summary>
public interface IParserService
{
    /// <summary>Parse file and return all assemblies found.</summary>
    Task<ParseResult> ParseAsync(string filePath, ParseOptions options, CancellationToken ct = default);

    /// <summary>Return distinct phase/lot/zone values found in file (for filtering UI).</summary>
    Task<IReadOnlyList<string>> GetPhasesAsync(string filePath, CancellationToken ct = default);
}

public record ParseOptions(
    string?  PhaseFilter   = null,   // null = all phases
    bool     IncludeWarnings = true,
    double   AssemblyVolumeFactor = 2.0  // flag if total vol > primary vol × this
);

public class ParseResult
{
    public IReadOnlyList<SteelItem> Items     { get; init; } = Array.Empty<SteelItem>();
    public IReadOnlyList<ParseWarning> Warnings { get; init; } = Array.Empty<ParseWarning>();
    public int  SkippedCount  { get; init; }
    public string SourceFile  { get; init; } = "";
}

public class ParseWarning
{
    public string Mark     { get; init; } = "";
    public string Message  { get; init; } = "";
    public WarningSeverity Severity { get; init; }
}

public enum WarningSeverity { Info, Caution, Error }
