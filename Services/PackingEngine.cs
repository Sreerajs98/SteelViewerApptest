namespace SteelPackingApp.Services;

using SteelPackingApp.Models;

/// <summary>
/// Type-agnostic 3-D bin packing engine.
/// ONLY interacts with AssemblyGroup virtual bounding boxes — it has
/// zero knowledge of steel profile shapes, IFC, or property sets.
///
/// Algorithm: Extreme-Points First Fit Decreasing (EP-FFD)
///   - Sort groups by layer priority (heavy floor → cold-formed middle → light top)
///   - For each group, try all existing containers before opening a new one
///   - Within a container, use the Extreme-Points method to find tight placement
///   - Enforce: gravity support, boundary collision, weight budget
///
/// Outputs: mutates AssemblyGroup.State/ContainerId/PlacedX/Y/Z
///          and populates ContainerManager via Place().
/// </summary>
public class PackingEngine
{
    // Groups are sorted into 3 vertical layers — matches how a human
    // loader physically works: heavy structural first, then cold-formed,
    // then light plates/rods on top.
    private static readonly Dictionary<string, int> LayerPriority = new()
    {
        ["i_beam"]    = 0, ["h_beam"]  = 0,   // Floor layer
        ["c_channel"] = 1, ["z_channel"] = 1,  // Middle layer
        ["l_angle"]   = 1, ["rhs"]     = 1,
        ["plate"]     = 2, ["rod"]      = 2,   // Top layer
    };

    public void Pack(IReadOnlyList<AssemblyGroup> groups, ContainerManager manager)
    {
        // Separate oversized items up front
        var packable  = new List<AssemblyGroup>();
        var oversized = new List<AssemblyGroup>();

        foreach (var g in groups)
        {
            var spec = manager.All.FirstOrDefault()?.Spec ?? ContainerSpec.Standard40Ft;
            if (FitsInSpec(g, spec))
                packable.Add(g);
            else
            {
                g.State = PlacementState.Oversized;
                oversized.Add(g);
            }
        }

        // Sort by layer priority, then by descending volume within each layer
        packable.Sort((a, b) =>
        {
            int pa = GetLayerPriority(a), pb = GetLayerPriority(b);
            if (pa != pb) return pa.CompareTo(pb);
            return -(a.VirtualLengthMm * a.VirtualHeightMm * a.VirtualWidthMm)
                    .CompareTo(b.VirtualLengthMm * b.VirtualHeightMm * b.VirtualWidthMm);
        });

        // EP-FFD packing
        var epState = new Dictionary<string, EpContainerState>();

        foreach (var group in packable)
        {
            bool placed = false;

            foreach (var c in manager.All)
            {
                if (!epState.TryGetValue(c.Id, out var eps))
                {
                    eps = new EpContainerState(c.Spec);
                    epState[c.Id] = eps;
                }

                var pos = TryPlace(group, c, eps);
                if (pos != null)
                {
                    var result = manager.Place(group, c, pos.Value.x, pos.Value.y, pos.Value.z);
                    if (result.Ok)
                    {
                        eps.UpdateAfterPlace(
                            pos.Value.x, pos.Value.y, pos.Value.z,
                            group.VirtualLengthMm, group.VirtualHeightMm, group.VirtualWidthMm);
                        placed = true;
                        break;
                    }
                }
            }

            if (!placed)
            {
                // Open a new container
                var newC = manager.AddContainer();
                var eps  = new EpContainerState(newC.Spec);
                epState[newC.Id] = eps;

                double startY = GetLayerPriority(group) == 0 ? newC.Spec.DunnageMm : 0;
                var result = manager.Place(group, newC, 0, startY, 0);
                if (result.Ok)
                {
                    eps.UpdateAfterPlace(0, startY, 0,
                        group.VirtualLengthMm, group.VirtualHeightMm, group.VirtualWidthMm);
                }
                else
                {
                    group.State = PlacementState.Oversized;
                }
            }
        }
    }

    private (double x, double y, double z)? TryPlace(
        AssemblyGroup group, ManagedContainer c, EpContainerState eps)
    {
        if (c.UsedWeightKg + group.TotalWeightKg > c.Spec.MaxWeightKg)
            return null;

        double startY = GetLayerPriority(group) == 0 ? c.Spec.DunnageMm : 0;

        foreach (var ep in eps.Points.OrderBy(p => p.y).ThenBy(p => p.x).ThenBy(p => p.z))
        {
            if (ep.y < startY - 1e-6) continue;

            double x = ep.x, y = ep.y, z = ep.z;
            double ex = x + group.VirtualLengthMm;
            double ey = y + group.VirtualHeightMm;
            double ez = z + group.VirtualWidthMm;

            if (ex > c.Spec.LengthMm + 1e-6) continue;
            if (ey > c.Spec.HeightMm + 1e-6) continue;
            if (ez > c.Spec.WidthMm  + 1e-6) continue;

            if (!eps.HasClash(x, y, z, group.VirtualLengthMm, group.VirtualHeightMm, group.VirtualWidthMm))
                return (x, y, z);
        }
        return null;
    }

    private static bool FitsInSpec(AssemblyGroup g, ContainerSpec s)
        => g.VirtualLengthMm <= s.LengthMm + 1e-6
        && g.VirtualWidthMm  <= s.WidthMm  + 1e-6
        && g.VirtualHeightMm <= s.HeightMm + 1e-6;

    private static int GetLayerPriority(AssemblyGroup g)
    {
        var key = g.Members.FirstOrDefault()?.Section?.ShapeKey ?? "";
        return LayerPriority.TryGetValue(key, out int p) ? p : 1;
    }
}

// ── Extreme-Points container state ────────────────────────────────────────────

internal class EpContainerState
{
    public List<(double x, double y, double z)> Points { get; } = new() { (0, 0, 0) };
    private readonly List<(double x1,double y1,double z1,double x2,double y2,double z2)> _boxes = new();
    private readonly ContainerSpec _spec;

    public EpContainerState(ContainerSpec spec) => _spec = spec;

    public bool HasClash(double x, double y, double z, double l, double h, double w)
    {
        foreach (var (x1,y1,z1,x2,y2,z2) in _boxes)
        {
            if (x < x2-1e-6 && x+l > x1+1e-6 &&
                y < y2-1e-6 && y+h > y1+1e-6 &&
                z < z2-1e-6 && z+w > z1+1e-6)
                return true;
        }
        return false;
    }

    public void UpdateAfterPlace(double x, double y, double z, double l, double h, double w)
    {
        _boxes.Add((x, y, z, x+l, y+h, z+w));

        // Remove occupied extreme points and add three new ones
        Points.RemoveAll(p =>
            p.x >= x-1e-6 && p.x < x+l-1e-6 &&
            p.y >= y-1e-6 && p.y < y+h-1e-6 &&
            p.z >= z-1e-6 && p.z < z+w-1e-6);

        TryAdd(x+l, y,   z  );
        TryAdd(x,   y+h, z  );
        TryAdd(x,   y,   z+w);
    }

    private void TryAdd(double x, double y, double z)
    {
        if (x > _spec.LengthMm + 1e-6) return;
        if (y > _spec.HeightMm + 1e-6) return;
        if (z > _spec.WidthMm  + 1e-6) return;
        if (!Points.Any(p => Math.Abs(p.x-x)<1 && Math.Abs(p.y-y)<1 && Math.Abs(p.z-z)<1))
            Points.Add((x, y, z));
    }
}
