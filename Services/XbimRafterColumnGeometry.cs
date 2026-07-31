using System.IO;
using SteelPackingApp.Models;
using Xbim.Common.Geometry;
using Xbim.Common.XbimExtensions;
using Xbim.Ifc;
using Xbim.ModelGeometry.Scene;

namespace SteelPackingApp.Services;

/// <summary>
/// xBIM exact solids for RAFTER / COLUMN assemblies only.
/// Keeps IFC relative positions, angles and sizes — one shared assembly
/// origin so every flange/web/stiffener lines up like Tekla.
/// </summary>
public static class XbimRafterColumnGeometry
{
    public static void Enrich(string ifcPath, List<SteelItem> items)
    {
        if (string.IsNullOrWhiteSpace(ifcPath) || !File.Exists(ifcPath) || items.Count == 0)
            return;

        var targets = items.Where(IsRafterOrColumnAssembly).ToList();
        if (targets.Count == 0) return;

        var neededIds = new HashSet<int>(
            targets.SelectMany(t => t.Parts)
                .Select(p => p.IfcEntityId)
                .Where(id => id > 0));
        if (neededIds.Count == 0) return;

        try
        {
            using var model = IfcStore.Open(ifcPath);
            // Convert model units → mm. Prefer OneMeter (units per metre); Tekla IFC is usually mm.
            double toMm = 1.0;
            try
            {
                // IModelFactors.OneMeter = how many model units in 1 metre
                double oneMeter = model.ModelFactors.OneMeter;
                if (oneMeter > 1e-9)
                    toMm = 1000.0 / oneMeter; // e.g. oneMeter=1000 → mm; oneMeter=1 → m
            }
            catch { toMm = 1.0; }
            if (!(toMm > 0) || double.IsNaN(toMm) || double.IsInfinity(toMm))
                toMm = 1.0;

            var context = new Xbim3DModelContext(model);
            context.CreateContext(null, false);

            // Prefer body-with-openings; fall back to excluded if none
            var byProduct = new Dictionary<int, List<(XbimShapeInstance Inst, byte Prefer)>>();
            foreach (var instance in context.ShapeInstances())
            {
                int label = instance.IfcProductLabel;
                if (!neededIds.Contains(label)) continue;

                byte prefer = instance.RepresentationType switch
                {
                    XbimGeometryRepresentationType.OpeningsAndAdditionsIncluded => 2,
                    XbimGeometryRepresentationType.OpeningsAndAdditionsExcluded => 1,
                    _ => 0
                };
                if (!byProduct.TryGetValue(label, out var list))
                {
                    list = new List<(XbimShapeInstance, byte)>();
                    byProduct[label] = list;
                }
                list.Add((instance, prefer));
            }

            // World IFC mm meshes per product
            var worldMeshes = new Dictionary<int, (List<double> Pos, List<int> Idx)>();
            foreach (var kvp in byProduct)
            {
                int best = kvp.Value.Max(x => x.Prefer);
                var chosen = kvp.Value.Where(x => x.Prefer == best).Select(x => x.Inst);
                var accPos = new List<double>();
                var accIdx = new List<int>();
                foreach (var inst in chosen)
                    AppendInstanceMesh(context, inst, accPos, accIdx, toMm);
                if (accPos.Count >= 9 && accIdx.Count >= 3)
                    worldMeshes[kvp.Key] = (accPos, accIdx);
            }

            if (worldMeshes.Count == 0) return;

            foreach (var item in targets)
            {
                // Parts of this assembly that have xBIM meshes
                var partMeshes = new List<(AssemblyPart Part, List<double> Pos, List<int> Idx)>();
                foreach (var part in item.Parts)
                {
                    if (part.IfcEntityId <= 0) continue;
                    if (!worldMeshes.TryGetValue(part.IfcEntityId, out var mesh)) continue;
                    partMeshes.Add((part, mesh.Pos, mesh.Idx));
                }
                if (partMeshes.Count == 0) continue;

                // ONE assembly origin = union AABB centre of all part meshes (IFC XYZ mm)
                Bounds3 union = default;
                bool first = true;
                foreach (var pm in partMeshes)
                {
                    var b = BoundsOf(pm.Pos);
                    if (first) { union = b; first = false; }
                    else union = Union(union, b);
                }
                double asmCx = 0.5 * (union.MinX + union.MaxX);
                double asmCy = 0.5 * (union.MinY + union.MaxY);
                double asmCz = 0.5 * (union.MinZ + union.MaxZ);

                // Exact packing envelope from union AABB (IFC Z-up → Three Y-up)
                // Length≈X, Height≈Z→Y, Width≈Y→Z
                item.LengthMm = Math.Max(1, union.MaxX - union.MinX);
                item.HeightMm = Math.Max(1, union.MaxZ - union.MinZ);
                item.WidthMm  = Math.Max(1, union.MaxY - union.MinY);

                int attached = 0;
                foreach (var (part, ifcPos, idx) in partMeshes)
                {
                    var partB = BoundsOf(ifcPos);
                    // Assembly-relative Three Y-up mesh (angles/size baked in verts)
                    var threePos = new List<double>(ifcPos.Count);
                    for (int i = 0; i + 2 < ifcPos.Count; i += 3)
                    {
                        double ix = ifcPos[i] - asmCx;
                        double iy = ifcPos[i + 1] - asmCy;
                        double iz = ifcPos[i + 2] - asmCz;
                        threePos.Add(ix);
                        threePos.Add(iz); // Three Y ← IFC Z
                        threePos.Add(iy); // Three Z ← IFC Y
                    }

                    part.MeshPositionsMm = threePos;
                    part.MeshIndices = new List<int>(idx);

                    // Exact part AABB in Three space
                    double pMinX = partB.MinX - asmCx, pMaxX = partB.MaxX - asmCx;
                    double pMinY = partB.MinZ - asmCz, pMaxY = partB.MaxZ - asmCz; // Three Y
                    double pMinZ = partB.MinY - asmCy, pMaxZ = partB.MaxY - asmCy; // Three Z
                    part.OffsetXMm = 0.5 * (pMinX + pMaxX);
                    part.OffsetYMm = 0.5 * (pMinY + pMaxY);
                    part.OffsetZMm = 0.5 * (pMinZ + pMaxZ);
                    part.BoxXMm = Math.Max(1, pMaxX - pMinX);
                    part.BoxYMm = Math.Max(1, pMaxY - pMinY);
                    part.BoxZMm = Math.Max(1, pMaxZ - pMinZ);

                    // Size = exact mesh extents (sorted: L ≥ mid ≥ thin)
                    var ext = new[] { part.BoxXMm, part.BoxYMm, part.BoxZMm }
                        .OrderByDescending(v => v).ToArray();
                    part.LengthMm = ext[0];
                    part.HeightMm = ext[1];
                    part.WidthMm = ext[2];
                    // Credible plate thickness = thinnest mesh axis
                    if (ext[2] > 0.5 && ext[2] <= 80)
                        part.ThicknessMm = ext[2];

                    // Mesh already in assembly space — no extra IFC matrix
                    part.HasIfcTransform = false;
                    part.Transform = Array.Empty<double>();
                    part.RotX = part.RotY = part.RotZ = 0;
                    attached++;
                }

                if (attached > 0)
                {
                    double gap = EstimateGapFromMeshes(partMeshes, asmCx, asmCy, asmCz);
                    if (gap > 20) item.FlangeClearGapMm = gap;
                    item.Remarks = (item.Remarks ?? "").TrimEnd()
                        + $" [xBIM exact ×{attached} parts; L={item.LengthMm:0} H={item.HeightMm:0} W={item.WidthMm:0}]";
                }
            }
        }
        catch (Exception ex)
        {
            foreach (var item in targets)
                item.Remarks = (item.Remarks ?? "").TrimEnd()
                    + $" [xBIM skipped: {ex.GetType().Name}]";
        }
    }

    private static bool IsRafterOrColumnAssembly(SteelItem item)
    {
        if (!item.IsAssembly || item.Parts.Count < 2) return false;
        string s = $"{item.AssemblyName} {item.AssmMark}";
        return System.Text.RegularExpressions.Regex.IsMatch(
            s, @"RAFTER|COLUMN", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    private static void AppendInstanceMesh(
        Xbim3DModelContext context,
        XbimShapeInstance instance,
        List<double> accPos,
        List<int> accIdx,
        double toMm)
    {
        var geometry = context.ShapeGeometry(instance);
        if (geometry is not IXbimShapeGeometryData geomData) return;
        byte[]? data = geomData.ShapeData;
        if (data == null || data.Length == 0) return;

        XbimShapeTriangulation tri;
        using (var ms = new MemoryStream(data))
        using (var br = new BinaryReader(ms))
            tri = br.ReadShapeTriangulation();
        if (tri?.Vertices == null || tri.Vertices.Count == 0) return;

        int vertexBase = accPos.Count / 3;
        var xf = instance.Transformation;
        foreach (var v in tri.Vertices)
        {
            var p = xf.Transform(v);
            accPos.Add(p.X * toMm);
            accPos.Add(p.Y * toMm);
            accPos.Add(p.Z * toMm);
        }

        if (tri.Faces == null) return;
        foreach (var face in tri.Faces)
        {
            var faceIdx = face.Indices;
            if (faceIdx == null || faceIdx.Count < 3) continue;
            if (faceIdx.Count % 3 == 0)
            {
                for (int i = 0; i + 2 < faceIdx.Count; i += 3)
                {
                    accIdx.Add(vertexBase + faceIdx[i]);
                    accIdx.Add(vertexBase + faceIdx[i + 1]);
                    accIdx.Add(vertexBase + faceIdx[i + 2]);
                }
            }
            else
            {
                for (int i = 1; i + 1 < faceIdx.Count; i++)
                {
                    accIdx.Add(vertexBase + faceIdx[0]);
                    accIdx.Add(vertexBase + faceIdx[i]);
                    accIdx.Add(vertexBase + faceIdx[i + 1]);
                }
            }
        }
    }

    private struct Bounds3
    {
        public double MinX, MinY, MinZ, MaxX, MaxY, MaxZ;
    }

    private static Bounds3 BoundsOf(List<double> pos)
    {
        var b = new Bounds3
        {
            MinX = double.PositiveInfinity, MinY = double.PositiveInfinity, MinZ = double.PositiveInfinity,
            MaxX = double.NegativeInfinity, MaxY = double.NegativeInfinity, MaxZ = double.NegativeInfinity
        };
        for (int i = 0; i + 2 < pos.Count; i += 3)
        {
            double x = pos[i], y = pos[i + 1], z = pos[i + 2];
            if (x < b.MinX) b.MinX = x; if (x > b.MaxX) b.MaxX = x;
            if (y < b.MinY) b.MinY = y; if (y > b.MaxY) b.MaxY = y;
            if (z < b.MinZ) b.MinZ = z; if (z > b.MaxZ) b.MaxZ = z;
        }
        return b;
    }

    private static Bounds3 Union(Bounds3 a, Bounds3 b) => new()
    {
        MinX = Math.Min(a.MinX, b.MinX), MinY = Math.Min(a.MinY, b.MinY), MinZ = Math.Min(a.MinZ, b.MinZ),
        MaxX = Math.Max(a.MaxX, b.MaxX), MaxY = Math.Max(a.MaxY, b.MaxY), MaxZ = Math.Max(a.MaxZ, b.MaxZ)
    };

    /// <summary>Rough flange clear gap from web/flange mesh AABBs along section depth.</summary>
    private static double EstimateGapFromMeshes(
        List<(AssemblyPart Part, List<double> Pos, List<int> Idx)> parts,
        double asmCx, double asmCy, double asmCz)
    {
        var flanges = parts.Where(p =>
            string.Equals(p.Part.PartKind, "flange", StringComparison.OrdinalIgnoreCase)
            || System.Text.RegularExpressions.Regex.IsMatch(
                $"{p.Part.Name} {p.Part.ProfileDesc}", @"FLANGE|\bFL\d",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)).ToList();
        if (flanges.Count < 2) return 0;

        // Depth ≈ farthest flange-centre pair in IFC
        var cents = flanges.Select(f =>
        {
            var b = BoundsOf(f.Pos);
            return (X: 0.5 * (b.MinX + b.MaxX), Y: 0.5 * (b.MinY + b.MaxY), Z: 0.5 * (b.MinZ + b.MaxZ), B: b);
        }).ToList();

        double best = -1;
        double dx = 0, dy = 1, dz = 0;
        for (int i = 0; i < cents.Count; i++)
        for (int j = i + 1; j < cents.Count; j++)
        {
            double ex = cents[j].X - cents[i].X, ey = cents[j].Y - cents[i].Y, ez = cents[j].Z - cents[i].Z;
            double d = Math.Sqrt(ex * ex + ey * ey + ez * ez);
            if (d > best) { best = d; if (d > 1e-6) { dx = ex / d; dy = ey / d; dz = ez / d; } }
        }
        if (best < 40) return 0;

        double Dot((double X, double Y, double Z, Bounds3 B) c) => c.X * dx + c.Y * dy + c.Z * dz;
        double Half((double X, double Y, double Z, Bounds3 B) c)
        {
            // half extent of AABB along D
            double hx = 0.5 * (c.B.MaxX - c.B.MinX) * Math.Abs(dx);
            double hy = 0.5 * (c.B.MaxY - c.B.MinY) * Math.Abs(dy);
            double hz = 0.5 * (c.B.MaxZ - c.B.MinZ) * Math.Abs(dz);
            return hx + hy + hz;
        }

        var projs = cents.Select(c => (P: Dot(c), H: Half(c))).ToList();
        double lo = projs.Min(x => x.P), hi = projs.Max(x => x.P);
        double mid = 0.5 * (lo + hi);
        var bot = projs.Where(x => x.P <= mid).ToList();
        var top = projs.Where(x => x.P > mid).ToList();
        if (bot.Count == 0 || top.Count == 0) return 0;
        double gap = top.Min(x => x.P - x.H) - bot.Max(x => x.P + x.H);
        return gap > 20 ? gap : 0;
    }
}
