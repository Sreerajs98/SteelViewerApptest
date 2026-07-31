namespace SteelPackingApp.Models;

/// <summary>
/// A group of physically identical (or intentionally grouped) SteelItems
/// that will be packed together as a single unit. The packing engine
/// interacts ONLY with AssemblyGroup objects — it never sees raw SteelItems.
///
/// Virtual bounding box = the envelope of all members when assembled
/// using the SuggestedStrategy (bundled, stacked, or single).
/// </summary>
public class AssemblyGroup
{
    public string GroupId   { get; set; } = "";
    public string Label     { get; set; } = "";
    public bool   IsManual  { get; set; }   // true = user overrode auto-grouping

    public List<SteelItem> Members { get; set; } = new();

    /// <summary>Auto-suggested by GroupingService.SuggestStrategy().</summary>
    public AssemblyStrategy SuggestedStrategy { get; set; } = AssemblyStrategy.SingleUnit;

    /// <summary>User can override the suggested strategy.</summary>
    public AssemblyStrategy ActiveStrategy
    {
        get => _userStrategy ?? SuggestedStrategy;
        set => _userStrategy = value;
    }
    private AssemblyStrategy? _userStrategy;

    // ── Derived virtual bounding box ─────────────────────────────────

    /// <summary>
    /// Length of the assembled group (mm). For bundles = longest member length.
    /// </summary>
    public double VirtualLengthMm => Members.Any() ? Members.Max(m => m.LengthMm) : 0;

    /// <summary>
    /// Width of the assembled group (mm).
    /// Bundle: members laid side-by-side, so total width grows.
    /// Stack: same width as one member (flanges interlock).
    /// </summary>
    public double VirtualWidthMm
    {
        get
        {
            if (!Members.Any()) return 0;
            var s = Members.First();
            return ActiveStrategy switch
            {
                AssemblyStrategy.Bundle => EstimateBundleWidth(),
                AssemblyStrategy.Stack  => s.WidthMm,
                _                       => s.WidthMm
            };
        }
    }

    /// <summary>Virtual height of the assembled group (mm).</summary>
    public double VirtualHeightMm
    {
        get
        {
            if (!Members.Any()) return 0;
            var s = Members.First();
            return ActiveStrategy switch
            {
                AssemblyStrategy.Stack  => EstimateStackHeight(),
                _                       => s.HeightMm
            };
        }
    }

    public double TotalWeightKg => Members.Sum(m => m.UnitWeightKg);
    public int    TotalQty      => Members.Count;

    // ── Placement state ───────────────────────────────────────────────

    public PlacementState State { get; set; } = PlacementState.Unplaced;
    public string? ContainerId  { get; set; }   // e.g. "C1", "C2"
    public double? PlacedX      { get; set; }
    public double? PlacedY      { get; set; }
    public double? PlacedZ      { get; set; }

    // ── Helpers ───────────────────────────────────────────────────────

    private double EstimateBundleWidth()
    {
        // Cold-formed Z/C: contour nesting — each additional piece adds only
        // a small stagger offset (W-t ≈ 95% of W per additional piece).
        // Hot-rolled / general: side-by-side stacking, full width each.
        var s = Members.First();
        bool coldFormed = s.Section?.ShapeKey is "z_channel" or "c_channel";
        if (coldFormed)
        {
            double t  = s.Section!.T > 0 ? s.Section.T : s.WidthMm * 0.015;
            double dz = s.WidthMm - t;
            return s.WidthMm + (Members.Count - 1) * dz;
        }
        return s.WidthMm * Members.Count;
    }

    private double EstimateStackHeight()
    {
        var s = Members.First();
        bool coldFormed = s.Section?.ShapeKey is "z_channel" or "c_channel";
        if (coldFormed)
        {
            double t  = s.Section!.T > 0 ? s.Section.T : s.HeightMm * 0.015;
            double D  = s.Section.D > 0  ? s.Section.D : s.HeightMm * 0.085;
            double dy = D + t;
            return s.HeightMm + (Members.Count - 1) * dy;
        }
        // I-beams: box nesting pairs
        if (s.Section?.ShapeKey is "i_beam" or "h_beam")
        {
            int pairs = (int)Math.Ceiling(Members.Count / 2.0);
            return pairs * s.HeightMm;
        }
        // Generic stack
        return s.HeightMm * Members.Count;
    }
}

public enum AssemblyStrategy
{
    SingleUnit,   // One piece or a heavy/awkward item shipped as-is
    Bundle,       // Multiple pieces banded side by side (long profiles)
    Stack,        // Pieces nested / stacked flat (C/Z contour nesting, plate stacks)
}

public enum PlacementState
{
    Unplaced,
    Placed,
    Oversized,    // Does not fit in any container
}
