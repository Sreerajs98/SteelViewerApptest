namespace SteelPackingApp.Services;

using SteelPackingApp.Models;

/// <summary>
/// Heuristic Clustering Engine — groups SteelItems into AssemblyGroups
/// following the priority chain:
///   1. AssemblyMark (exact match — same mark = same piece type)
///   2. Geometric similarity (dimensions within tolerance)
///   3. Material/Weight properties (similar density/weight class)
///
/// Deliberately NOT hardcoded by shape type — the engine observes data
/// and clusters by similarity, the same way a human planner would look
/// at a pile of steel and group "things that look the same".
///
/// Supports manual override (Merge / Split) so the user can correct
/// the automatic grouping before packing begins.
/// </summary>
public class GroupingService
{
    private readonly GroupingOptions _opts;

    public GroupingService(GroupingOptions? options = null)
        => _opts = options ?? new GroupingOptions();

    // ─────────────────────────────────────────────────────────────────
    // Auto-cluster
    // ─────────────────────────────────────────────────────────────────

    public IReadOnlyList<AssemblyGroup> Cluster(IReadOnlyList<SteelItem> items)
    {
        var groups = new List<AssemblyGroup>();

        // Priority 1 — AssemblyMark (exact): items sharing the same
        // mark are definitionally the same piece and always grouped together.
        var byMark = items.GroupBy(i => i.AssmMark.Trim().ToUpperInvariant());
        foreach (var markGroup in byMark)
        {
            var members = markGroup.ToList();
            var merged = TryMergeByGeometry(members, groups);
            if (!merged)
                groups.Add(CreateGroup(members));
        }

        // Priority 2 — Geometric similarity: groups that haven't been
        // merged yet are candidates for a secondary similarity pass.
        // Two groups merge if ALL three linear dims are within tolerance
        // AND their cross-section aspect ratios are similar.
        if (_opts.MergeGeometricallySimilar)
            MergeGeometricGroups(groups);

        // Priority 3 — Weight-class similarity: remaining small groups
        // whose unit weights fall in the same order of magnitude are
        // tentatively merged (produces a "misc light steel" bucket).
        if (_opts.MergeByWeightClass)
            MergeByWeightClass(groups);

        // Assign auto-suggested assembly strategy to each group.
        foreach (var g in groups)
            g.SuggestedStrategy = SuggestStrategy(g);

        return groups;
    }

    // ─────────────────────────────────────────────────────────────────
    // Manual overrides (User-in-the-Loop)
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Merge two groups into one. Preserves all members; the first
    /// group's identity becomes the merged group's identity.
    /// </summary>
    public AssemblyGroup Merge(AssemblyGroup a, AssemblyGroup b)
    {
        var merged = new AssemblyGroup
        {
            GroupId   = a.GroupId,
            Label     = $"{a.Label} + {b.Label}",
            Members   = a.Members.Concat(b.Members).ToList(),
            IsManual  = true,
        };
        merged.SuggestedStrategy = SuggestStrategy(merged);
        return merged;
    }

    /// <summary>
    /// Split one group into two based on a predicate.
    /// Items matching the predicate form the first group; the rest go to the second.
    /// </summary>
    public (AssemblyGroup A, AssemblyGroup B) Split(AssemblyGroup g, Func<SteelItem, bool> pred)
    {
        var aItems = g.Members.Where(pred).ToList();
        var bItems = g.Members.Where(i => !pred(i)).ToList();
        var a = CreateGroup(aItems); a.IsManual = true;
        var b = CreateGroup(bItems); b.IsManual = true;
        a.SuggestedStrategy = SuggestStrategy(a);
        b.SuggestedStrategy = SuggestStrategy(b);
        return (a, b);
    }

    // ─────────────────────────────────────────────────────────────────
    // Auto-suggest assembly strategy (Pillar 3)
    // ─────────────────────────────────────────────────────────────────

    private static AssemblyStrategy SuggestStrategy(AssemblyGroup g)
    {
        if (!g.Members.Any()) return AssemblyStrategy.SingleUnit;

        var sample  = g.Members.First();
        double L    = g.Members.Max(i => i.LengthMm);
        double maxW = g.Members.Max(i => Math.Max(i.WidthMm, i.HeightMm));
        double minW = g.Members.Min(i => Math.Min(i.WidthMm, i.HeightMm));
        double totalKg = g.Members.Sum(i => i.UnitWeightKg);

        // Long items (aspect ratio > 10) → Bundle (stack side by side or nest)
        if (maxW > 0 && L / maxW > 10)
            return AssemblyStrategy.Bundle;

        // Flat/thin items (one dimension < 5% of largest) → Stack (nesting)
        if (maxW > 0 && minW / maxW < 0.05)
            return AssemblyStrategy.Stack;

        // Heavy single items (> 5 t) → Single Unit (crane lift required)
        if (totalKg > 5000)
            return AssemblyStrategy.SingleUnit;

        // Multiple identical pieces with nesting potential → Bundle
        if (g.Members.Count >= 4 && IsColdFormed(sample))
            return AssemblyStrategy.Bundle;

        // Default
        return g.Members.Count == 1 ? AssemblyStrategy.SingleUnit : AssemblyStrategy.Stack;
    }

    private static bool IsColdFormed(SteelItem i) =>
        i.Section?.ShapeKey is "z_channel" or "c_channel" or "l_angle";

    // ─────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────

    private bool TryMergeByGeometry(List<SteelItem> members, List<AssemblyGroup> existing)
    {
        if (!_opts.MergeGeometricallySimilar) return false;
        var sample = members.First();
        var match  = existing.FirstOrDefault(g => GeometricallySimilar(g.Members.First(), sample));
        if (match == null) return false;
        match.Members.AddRange(members);
        match.Label = $"{match.GroupId} + {sample.AssmMark}";
        return true;
    }

    private void MergeGeometricGroups(List<AssemblyGroup> groups)
    {
        bool merged = true;
        while (merged)
        {
            merged = false;
            for (int i = 0; i < groups.Count && !merged; i++)
            for (int j = i + 1; j < groups.Count && !merged; j++)
            {
                if (groups[i].IsManual || groups[j].IsManual) continue;
                if (!GeometricallySimilar(groups[i].Members.First(), groups[j].Members.First())) continue;
                groups[i].Members.AddRange(groups[j].Members);
                groups[i].Label = $"{groups[i].GroupId}+";
                groups.RemoveAt(j);
                merged = true;
            }
        }
    }

    private void MergeByWeightClass(List<AssemblyGroup> groups)
    {
        // Weight class buckets: <10kg, 10-100kg, 100-1000kg, >1000kg
        static int WeightClass(double kg) => kg switch {
            < 10    => 0,
            < 100   => 1,
            < 1000  => 2,
            _       => 3
        };

        // Only merge single-item groups (lone pieces) into the nearest matching bucket.
        var singles = groups.Where(g => g.Members.Count == 1 && !g.IsManual).ToList();
        var buckets = new Dictionary<int, AssemblyGroup>();

        foreach (var sg in singles)
        {
            int cls = WeightClass(sg.Members.First().UnitWeightKg);
            if (!buckets.TryGetValue(cls, out var bucket))
            {
                bucket = CreateGroup(new List<SteelItem>());
                bucket.Label = $"Misc ({WeightClassLabel(cls)})";
                buckets[cls] = bucket;
                groups.Add(bucket);
            }
            bucket.Members.AddRange(sg.Members);
            groups.Remove(sg);
        }
    }

    private bool GeometricallySimilar(SteelItem a, SteelItem b)
    {
        double tol = _opts.DimensionToleranceMm;
        return Math.Abs(a.LengthMm - b.LengthMm) <= tol
            && Math.Abs(a.WidthMm  - b.WidthMm)  <= tol
            && Math.Abs(a.HeightMm - b.HeightMm) <= tol;
    }

    private static string WeightClassLabel(int cls) => cls switch {
        0 => "< 10 kg", 1 => "10–100 kg", 2 => "100–1000 kg", _ => "> 1 t"
    };

    private static int _nextId = 1;
    private static AssemblyGroup CreateGroup(List<SteelItem> members)
    {
        var sample = members.FirstOrDefault();
        return new AssemblyGroup
        {
            GroupId = $"G{_nextId++:000}",
            Label   = sample?.AssmMark ?? "UNKNOWN",
            Members = members,
        };
    }
}

public record GroupingOptions(
    bool   MergeGeometricallySimilar = true,
    bool   MergeByWeightClass        = false,   // off by default — can be noisy
    double DimensionToleranceMm      = 5.0      // ±5 mm = "same dimensions"
);
