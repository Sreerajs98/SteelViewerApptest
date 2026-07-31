namespace SteelPackingApp.Services;

using SteelPackingApp.Models;

/// <summary>
/// Validation Layer — runs after parsing, before the packing engine.
/// Implements Gemini's Phase 3 recommendations:
///   1. Flags items whose shape relies on assembly-volume bounding box
///   2. Dimensional sanity checks (impossible aspect ratios)
///   3. Weight sanity checks (clearly wrong densities)
///   4. Marks items as Valid/Invalid so the UI can surface issues
///
/// This layer is PURE — it never modifies items, only annotates them
/// with validation results. The packing engine may choose to skip
/// Invalid items or include them with a visual warning.
/// </summary>
public class ValidationService
{
    private const double SteelDensity  = 7850.0;   // kg/m³
    private const double MinDensityRatio = 0.05;    // item weight / theoretical steel weight
    private const double MaxDensityRatio = 1.50;    // allow up to 50% over (welded assemblies)
    private const double MaxFlangeFraction = 1.20;  // I-beam width rarely > 1.2 × height
    private const double MinLengthToSection = 1.5;  // piece length should be > 1.5× max cross-section dim

    public ValidationResult Validate(IReadOnlyList<SteelItem> items)
    {
        var results = new List<ItemValidation>();

        foreach (var item in items)
        {
            var errors   = new List<string>();
            var warnings = new List<string>();

            // ── 1. Geometry-estimated shape ───────────────────────────────
            if (item.WeightEstimated)
                warnings.Add("Shape dimensions derived from geometry bounding box — may include secondary plates/cleats.");

            if (item.Remarks.Contains("secondary parts", StringComparison.OrdinalIgnoreCase))
                warnings.Add("Assembly bounding box volume significantly larger than primary member — shape may be inflated.");

            // ── 2. Dimensional sanity checks ─────────────────────────────
            if (item.LengthMm <= 0)
                errors.Add($"Length is zero or negative ({item.LengthMm:F0} mm).");

            if (item.WidthMm <= 0 || item.HeightMm <= 0)
                errors.Add($"Cross-section dimension zero or negative (W={item.WidthMm:F0}, H={item.HeightMm:F0} mm).");

            double maxSection = Math.Max(item.WidthMm, item.HeightMm);
            if (maxSection > 0 && item.LengthMm > 0 && item.LengthMm < maxSection * MinLengthToSection)
                warnings.Add($"Length ({item.LengthMm:F0} mm) is very short relative to section ({maxSection:F0} mm) — may be a cleat or bracket.");

            // Check for suspicious aspect ratios per shape family
            if (item.Section != null)
            {
                var s = item.Section;
                if (s.ShapeKey is "i_beam" or "h_beam" && s.W > s.H * MaxFlangeFraction)
                    warnings.Add($"I-beam flange width ({s.W:F0} mm) unusually wide vs height ({s.H:F0} mm) — verify section.");

                if (s.ShapeKey is "z_channel" or "c_channel" && s.T > s.H * 0.15)
                    warnings.Add($"Cold-formed wall thickness ({s.T:F1} mm) unusually thick for H={s.H:F0} mm — section may be misidentified.");

                if (s.H > 2000)
                    errors.Add($"Section height {s.H:F0} mm exceeds 2 m — likely a parsing error.");

                if (s.W > 1000)
                    errors.Add($"Section width {s.W:F0} mm exceeds 1 m — likely a parsing error.");
            }

            // ── 3. Weight sanity check ────────────────────────────────────
            if (item.UnitWeightKg > 0 && item.LengthMm > 0 && item.WidthMm > 0 && item.HeightMm > 0)
            {
                double volumeM3 = (item.LengthMm * item.WidthMm * item.HeightMm) / 1e9;
                double maxTheoreticalKg = volumeM3 * SteelDensity * MaxDensityRatio;
                double minTheoreticalKg = volumeM3 * SteelDensity * MinDensityRatio;

                if (item.UnitWeightKg > maxTheoreticalKg)
                    warnings.Add($"Weight ({item.UnitWeightKg:F1} kg) exceeds theoretical solid-steel bounding box weight ({maxTheoreticalKg:F1} kg) — check units.");

                if (!item.WeightEstimated && item.UnitWeightKg < minTheoreticalKg)
                    warnings.Add($"Weight ({item.UnitWeightKg:F1} kg) appears very low for bounding box size — may be missing data.");
            }

            // Zero weight is a caution, not a hard block — dims still packable.
            if (item.UnitWeightKg <= 0)
                warnings.Add("Weight is zero — centre-of-gravity may be approximate.");

            // ── 4. Aggregate result ───────────────────────────────────────
            results.Add(new ItemValidation
            {
                Item     = item,
                IsValid  = errors.Count == 0,
                Errors   = errors,
                Warnings = warnings,
            });
        }

        return new ValidationResult
        {
            ItemResults  = results,
            ValidCount   = results.Count(r => r.IsValid),
            InvalidCount = results.Count(r => !r.IsValid),
            WarnCount    = results.Count(r => r.Warnings.Count > 0),
        };
    }
}

public class ItemValidation
{
    public SteelItem   Item     { get; init; } = null!;
    public bool        IsValid  { get; set; }
    public List<string> Errors  { get; init; } = new();
    public List<string> Warnings { get; init; } = new();
    public bool HasIssues => !IsValid || Warnings.Count > 0;
}

public class ValidationResult
{
    public IReadOnlyList<ItemValidation> ItemResults { get; init; } = Array.Empty<ItemValidation>();
    public int ValidCount   { get; init; }
    public int InvalidCount { get; init; }
    public int WarnCount    { get; init; }
    public bool AllValid => InvalidCount == 0;

    /// <summary>All items that passed validation (valid = no errors, may have warnings).</summary>
    public IEnumerable<SteelItem> ValidItems => ItemResults.Where(r => r.IsValid).Select(r => r.Item);
}
