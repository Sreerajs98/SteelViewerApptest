namespace SteelPackingApp.Services;

using SteelPackingApp.Models;

/// <summary>
/// Manages a fleet of shipping containers.
/// Pillar 4: the packing engine calls ContainerManager to open a new
/// container when no existing one has room; the UI also allows the
/// user to manually add containers ("Add New Container" button).
///
/// Each container tracks:
///   - Its own spec (L × W × H, max weight)
///   - Which AssemblyGroups are placed inside it
///   - Remaining volume and weight budget
///   - 3D extreme-point list for the packing algorithm
/// </summary>
public class ContainerManager
{
    private readonly ContainerSpec _defaultSpec;
    private readonly List<ManagedContainer> _containers = new();
    private int _nextNumber = 1;

    public ContainerManager(ContainerSpec? spec = null)
        => _defaultSpec = spec ?? ContainerSpec.Standard40Ft;

    // ── Container lifecycle ──────────────────────────────────────────

    public IReadOnlyList<ManagedContainer> All => _containers;
    public ManagedContainer? Active => _containers.FirstOrDefault(c => c.Id == _activeId);

    private string? _activeId;

    /// <summary>Create a new empty container and make it active.</summary>
    public ManagedContainer AddContainer(ContainerSpec? spec = null)
    {
        var c = new ManagedContainer
        {
            Id     = $"C{_nextNumber++}",
            Spec   = spec ?? _defaultSpec,
            Label  = $"Container {_nextNumber - 1}",
        };
        _containers.Add(c);
        _activeId ??= c.Id;
        ContainersChanged?.Invoke();
        return c;
    }

    /// <summary>Remove a container (returns its placed groups to Unplaced state).</summary>
    public void RemoveContainer(string id)
    {
        var c = _containers.FirstOrDefault(c => c.Id == id);
        if (c == null) return;
        foreach (var g in c.PlacedGroups)
        {
            g.State       = PlacementState.Unplaced;
            g.ContainerId = null;
            g.PlacedX = g.PlacedY = g.PlacedZ = null;
        }
        _containers.Remove(c);
        if (_activeId == id) _activeId = _containers.FirstOrDefault()?.Id;
        ContainersChanged?.Invoke();
    }

    public void SetActive(string id)
    {
        if (_containers.Any(c => c.Id == id)) _activeId = id;
    }

    // ── Placement ─────────────────────────────────────────────────────

    /// <summary>
    /// Place a group into the active container at the given position.
    /// Returns a PlacementResult indicating success or the reason for failure.
    /// </summary>
    public PlacementResult Place(AssemblyGroup group, double x, double y, double z)
    {
        var c = Active ?? AddContainer();
        return Place(group, c, x, y, z);
    }

    public PlacementResult Place(AssemblyGroup group, ManagedContainer c, double x, double y, double z)
    {
        // Validate: weight budget
        if (c.UsedWeightKg + group.TotalWeightKg > c.Spec.MaxWeightKg)
            return PlacementResult.Fail($"Exceeds container weight limit ({c.Spec.MaxWeightKg} kg).");

        // Validate: boundary
        if (x + group.VirtualLengthMm > c.Spec.LengthMm ||
            y + group.VirtualHeightMm > c.Spec.HeightMm ||
            z + group.VirtualWidthMm  > c.Spec.WidthMm)
            return PlacementResult.Fail("Group exceeds container boundary.");

        // Validate: floor support (Y=0 is floor)
        if (y < c.Spec.DunnageMm - 1e-6)
            return PlacementResult.Fail($"Y position below floor/dunnage level ({c.Spec.DunnageMm} mm).");

        // Validate: AABB collision with existing items
        var newBox = new AABB(x, y, z,
            x + group.VirtualLengthMm,
            y + group.VirtualHeightMm,
            z + group.VirtualWidthMm);

        foreach (var placed in c.PlacedGroups)
        {
            var existBox = new AABB(
                placed.PlacedX!.Value, placed.PlacedY!.Value, placed.PlacedZ!.Value,
                placed.PlacedX.Value + placed.VirtualLengthMm,
                placed.PlacedY.Value + placed.VirtualHeightMm,
                placed.PlacedZ.Value + placed.VirtualWidthMm);

            if (newBox.Intersects(existBox))
                return PlacementResult.Fail($"Overlaps with already-placed group '{placed.Label}'.");
        }

        // Commit placement
        group.PlacedX      = x;
        group.PlacedY      = y;
        group.PlacedZ      = z;
        group.ContainerId  = c.Id;
        group.State        = PlacementState.Placed;
        c.PlacedGroups.Add(group);
        c.UsedWeightKg    += group.TotalWeightKg;

        // Validate stability: every item must have ≥ 60% of its footprint
        // supported by the floor or another item directly below it.
        var stabWarn = CheckStability(group, c);

        PlacementsChanged?.Invoke();
        return PlacementResult.Success(stabWarn);
    }

    /// <summary>Remove a placed group from its container (returns it to Unplaced).</summary>
    public void Unplace(AssemblyGroup group)
    {
        var c = _containers.FirstOrDefault(c => c.Id == group.ContainerId);
        if (c != null)
        {
            c.PlacedGroups.Remove(group);
            c.UsedWeightKg -= group.TotalWeightKg;
        }
        group.State       = PlacementState.Unplaced;
        group.ContainerId = null;
        group.PlacedX = group.PlacedY = group.PlacedZ = null;
        PlacementsChanged?.Invoke();
    }

    // ── CoG ────────────────────────────────────────────────────────────

    public CoGResult ComputeCoG(ManagedContainer c)
    {
        double totalMass = 0, sumX = 0, sumZ = 0;
        foreach (var g in c.PlacedGroups)
        {
            double m = g.TotalWeightKg;
            double cx = g.PlacedX!.Value + g.VirtualLengthMm / 2;
            double cz = g.PlacedZ!.Value + g.VirtualWidthMm  / 2;
            totalMass += m; sumX += m * cx; sumZ += m * cz;
        }
        if (totalMass <= 0) return new CoGResult();
        double cogX = sumX / totalMass;
        double cogZ = sumZ / totalMass;
        double centreX = c.Spec.LengthMm / 2;
        double centreZ = c.Spec.WidthMm  / 2;
        double tolX = c.Spec.LengthMm * 0.10;
        double tolZ = c.Spec.WidthMm  * 0.10;
        return new CoGResult
        {
            LongitudinalMm = cogX,
            LateralMm      = cogZ - centreZ,
            LongitudinalOk = Math.Abs(cogX - centreX) <= tolX,
            LateralOk      = Math.Abs(cogZ - centreZ) <= tolZ,
        };
    }

    // ── Stability ──────────────────────────────────────────────────────

    private string? CheckStability(AssemblyGroup newGroup, ManagedContainer c)
    {
        if (newGroup.PlacedY!.Value <= c.Spec.DunnageMm + 1) return null; // on floor = always stable

        double footL = newGroup.VirtualLengthMm;
        double footW = newGroup.VirtualWidthMm;
        double footArea = footL * footW;
        if (footArea <= 0) return null;

        double supported = 0;
        foreach (var g in c.PlacedGroups)
        {
            if (g == newGroup) continue;
            double topY = g.PlacedY!.Value + g.VirtualHeightMm;
            if (Math.Abs(topY - newGroup.PlacedY.Value) > 5) continue; // not directly below

            // Overlap area in X-Z plane
            double ox1 = Math.Max(newGroup.PlacedX!.Value, g.PlacedX!.Value);
            double ox2 = Math.Min(newGroup.PlacedX.Value + footL, g.PlacedX.Value + g.VirtualLengthMm);
            double oz1 = Math.Max(newGroup.PlacedZ!.Value, g.PlacedZ!.Value);
            double oz2 = Math.Min(newGroup.PlacedZ.Value + footW, g.PlacedZ.Value + g.VirtualWidthMm);
            if (ox2 > ox1 && oz2 > oz1) supported += (ox2 - ox1) * (oz2 - oz1);
        }

        double ratio = supported / footArea;
        if (ratio < 0.60)
            return $"Stability warning: only {ratio:P0} of footprint is supported — item may be unstable.";
        return null;
    }

    public event Action? ContainersChanged;
    public event Action? PlacementsChanged;
}

// ── Supporting types ────────────────────────────────────────────────────────

public class ManagedContainer
{
    public string          Id            { get; init; } = "";
    public string          Label         { get; set;  } = "";
    public ContainerSpec   Spec          { get; init; } = ContainerSpec.Standard40Ft;
    public List<AssemblyGroup> PlacedGroups { get; } = new();
    public double          UsedWeightKg  { get; set; }
    public double          UsedVolumePct =>
        PlacedGroups.Sum(g => g.VirtualLengthMm * g.VirtualHeightMm * g.VirtualWidthMm)
        / (Spec.LengthMm * Spec.HeightMm * Spec.WidthMm) * 100;
}

public record ContainerSpec(
    double LengthMm    = 12000,
    double WidthMm     = 2350,
    double HeightMm    = 2690,
    double MaxWeightKg = 26000,
    double DunnageMm   = 75)
{
    public static readonly ContainerSpec Standard40Ft = new();
    public static readonly ContainerSpec Standard20Ft = new(6058, 2438, 2591, 21800, 75);
    public static readonly ContainerSpec HighCube40Ft = new(12192, 2352, 2895, 26000, 75);
}

public class PlacementResult
{
    public bool    Ok              { get; private init; }
    public string? FailReason      { get; private init; }
    public string? StabilityWarning { get; private init; }

    public static PlacementResult Success(string? warn = null)
        => new() { Ok = true, StabilityWarning = warn };
    public static PlacementResult Fail(string reason)
        => new() { Ok = false, FailReason = reason };
}

public class CoGResult
{
    public double LongitudinalMm { get; init; }
    public double LateralMm      { get; init; }
    public bool   LongitudinalOk { get; init; } = true;
    public bool   LateralOk      { get; init; } = true;
    public bool   AllOk          => LongitudinalOk && LateralOk;
}

public readonly record struct AABB(double X1, double Y1, double Z1, double X2, double Y2, double Z2)
{
    public bool Intersects(AABB o) =>
        X1 < o.X2 - 1e-6 && X2 > o.X1 + 1e-6 &&
        Y1 < o.Y2 - 1e-6 && Y2 > o.Y1 + 1e-6 &&
        Z1 < o.Z2 - 1e-6 && Z2 > o.Z1 + 1e-6;
}
