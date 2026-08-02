using System.Linq;
using SteelPackingApp.Models;

namespace SteelPackingApp.Services;

/// <summary>
/// Exports the RAW item list (not pre-arranged) so the 3D viewer can run its
/// own packing algorithms client-side - both a quick preview layout and a
/// real space+weight optimizer, triggered by buttons in the browser. This
/// keeps all packing logic in one place (the viewer) and works for any job's
/// item list without any per-job code here.
/// </summary>
public static class SceneBuilder
{
    public static RawScene BuildRawScene(JobInfo job, Container spec, List<SteelItem> items)
    {
        var scene = new RawScene
        {
            JobNo = job.JobNo,
            BldgNo = job.BldgNo,
            PhaseNo = job.PhaseNo,
            Customer = job.Customer,
            ContainerSpec = new ContainerSpecDto
            {
                LengthMm = spec.LengthMm,
                WidthMm = spec.WidthMm,
                HeightMm = spec.HeightMm,
                MaxWeightKg = spec.MaxWeightKg
            }
        };

        foreach (var item in items)
        {
            // Exact section from IFC profile desc (e.g. 200Z18 → t=1.8 mm)
            var sect = item.Section ?? ProfileDescParser.Parse(item.ProfileDesc);

            var raw = new RawItem
            {
                Mark = item.AssmMark,
                AssemblyName = item.AssemblyName,
                Category = ShapeCategorizer.Categorize(item.AssemblyName),
                LengthMm = item.LengthMm,
                WidthMm = item.WidthMm,
                HeightMm = item.HeightMm,
                ShippingLengthMm = item.ShippingLengthMm,
                ShippingWidthMm = item.ShippingWidthMm,
                ShippingHeightMm = item.ShippingHeightMm,
                FlangeWidthMm = item.FlangeWidthMm,
                Qty = item.Qty,
                UnitWeightKg = item.UnitWeightKg,
                ProfileDesc = item.ProfileDesc,
                WeightEstimated = item.WeightEstimated,
                Remarks = item.Remarks ?? "",
                FlangeClearGapMm = item.FlangeClearGapMm,
                ShapeKey = sect?.ShapeKey ?? "",
                SectH = sect?.H ?? 0,
                SectW = sect?.W ?? 0,
                SectT = sect?.T ?? 0,
                SectD = sect?.D ?? 0,
                SectTf = sect?.Tf ?? 0,
                SectTw = sect?.Tw ?? 0,
                SectFromPset = sect?.FromPropertySet ?? false,
                IsAssembly = item.IsAssembly && item.Parts.Count >= 1
                    && (item.Parts.Count >= 2
                        || item.Parts.Any(p => p.MeshPositionsMm != null && p.MeshPositionsMm.Count >= 9)),
                PathDiamMm = item.PathDiamMm,
                SurfaceTreatment = string.IsNullOrWhiteSpace(item.SurfaceTreatment)
                    ? ProfileDescParser.DetectSurface(item.ProfileDesc, item.Remarks)
                    : item.SurfaceTreatment,
                Destination = !string.IsNullOrWhiteSpace(item.Destination)
                    ? item.Destination
                    : (item.PhaseTags.Count > 0
                        ? "PHASE-" + string.Join("+", item.PhaseTags.Select(p => p.ToString("0.##")))
                        : (job.BldgNo ?? "")),
                SpecialHandling = item.SpecialHandling
                    || ProfileDescParser.DetectSpecialHandling(item.Remarks, item.ProfileDesc),
                PhaseTags = item.PhaseTags?.ToList() ?? new List<double>(),
            };

            // Bent sag rod only: exact IFC centerline for tube mesh
            if (item.PathPointsMm.Count >= 3)
            {
                raw.PathPointsMm = item.PathPointsMm
                    .Select(p => p.Length >= 3 ? new[] { p[0], p[1], p[2] } : p)
                    .ToList();
                if (string.IsNullOrEmpty(raw.ShapeKey) || raw.ShapeKey == "rod")
                    raw.ShapeKey = "bent_sag_rod";
            }

            // Assembly-only: export child parts for exact assembled shape in the viewer.
            // Single-member items never get Parts — nesting / packing unchanged.
            if (raw.IsAssembly)
            {
                foreach (var p in item.Parts)
                {
                    var ps = p.Section ?? ProfileDescParser.Parse(p.ProfileDesc);
                    raw.Parts.Add(new RawPart
                    {
                        Name = p.Name,
                        IfcType = p.IfcType,
                        ProfileDesc = p.ProfileDesc,
                        ShapeKey = ps?.ShapeKey ?? "",
                        SectH = ps?.H ?? 0,
                        SectW = ps?.W ?? 0,
                        SectT = ps?.T ?? 0,
                        SectD = ps?.D ?? 0,
                        SectTf = ps?.Tf ?? 0,
                        SectTw = ps?.Tw ?? 0,
                        LengthMm = p.LengthMm,
                        WidthMm = p.WidthMm,
                        HeightMm = p.HeightMm,
                        OffsetXMm = p.OffsetXMm,
                        OffsetYMm = p.OffsetYMm,
                        OffsetZMm = p.OffsetZMm,
                        BoxXMm = p.BoxXMm,
                        BoxYMm = p.BoxYMm,
                        BoxZMm = p.BoxZMm,
                        RotX = p.RotX,
                        RotY = p.RotY,
                        RotZ = p.RotZ,
                        HasIfcTransform = p.HasIfcTransform && p.Transform is { Length: 16 },
                        Transform = (p.HasIfcTransform && p.Transform is { Length: 16 })
                            ? p.Transform.ToArray()
                            : Array.Empty<double>(),
                        PartKind = p.PartKind ?? "other",
                        ThicknessMm = p.ThicknessMm,
                        SlopeDeg = p.SlopeDeg,
                        ProfilePointsMm = p.ProfilePointsMm != null && p.ProfilePointsMm.Count > 0
                            ? p.ProfilePointsMm.Select(pt => pt.ToArray()).ToList()
                            : new List<double[]>(),
                        ProfileExtrudeMm = p.ProfileExtrudeMm,
                        IfcEntityId = p.IfcEntityId,
                        MeshPositionsMm = p.MeshPositionsMm ?? new List<double>(),
                        MeshIndices = p.MeshIndices ?? new List<int>(),
                    });
                }
            }

            scene.Items.Add(raw);
        }

        return scene;
    }
}

public class RawScene
{
    public string JobNo { get; set; } = "";
    public string BldgNo { get; set; } = "";
    public string PhaseNo { get; set; } = "";
    public string Customer { get; set; } = "";
    public ContainerSpecDto ContainerSpec { get; set; } = new();
    public List<RawItem> Items { get; set; } = new();
    /// <summary>Validation warnings surfaced to JS info panel.</summary>
    public List<ValidationWarningDto> ValidationWarnings { get; set; } = new();
}

public class ValidationWarningDto
{
    public string Mark     { get; set; } = "";
    public string Message  { get; set; } = "";
    public string Severity { get; set; } = "Caution";
}


public class ContainerSpecDto
{
    public double LengthMm { get; set; }
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }
    public double MaxWeightKg { get; set; }
}

public class RawItem
{
    public string Mark { get; set; } = "";
    public string AssemblyName { get; set; } = "";
    public string Category { get; set; } = "other";
    public double LengthMm { get; set; }
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }

    /// <summary>Shipping-pose span mm (0 = unknown).</summary>
    public double ShippingLengthMm { get; set; }
    /// <summary>Shipping-pose seat width mm (0 = unknown).</summary>
    public double ShippingWidthMm { get; set; }
    /// <summary>Shipping-pose height mm (0 = unknown).</summary>
    public double ShippingHeightMm { get; set; }
    /// <summary>Flange plate width mm when known.</summary>
    public double FlangeWidthMm { get; set; }

    public int Qty { get; set; }
    public double UnitWeightKg { get; set; }
    public string ProfileDesc { get; set; } = "";
    public bool WeightEstimated { get; set; }
    public string Remarks { get; set; } = "";

    /// <summary>Clear gap between flange inner faces (mm); 0 if unknown.</summary>
    public double FlangeClearGapMm { get; set; }

    /// <summary>Exact section from IFC profile description (e.g. z_channel).</summary>
    public string ShapeKey { get; set; } = "";
    public double SectH { get; set; }
    public double SectW { get; set; }
    /// <summary>Wall / gauge thickness in mm — exact from IFC (e.g. 200Z18 → 1.8).</summary>
    public double SectT { get; set; }
    public double SectD { get; set; }
    public double SectTf { get; set; }
    public double SectTw { get; set; }
    public bool SectFromPset { get; set; }

    /// <summary>True only for multi-part IFC assemblies (exact shape path).</summary>
    public bool IsAssembly { get; set; }

    /// <summary>Child parts for assembled shape. Empty for normal C/Z/plate items.</summary>
    public List<RawPart> Parts { get; set; } = new();

    /// <summary>Bent sag rod IFC centerline (Three Y-up mm). Empty otherwise.</summary>
    public List<double[]> PathPointsMm { get; set; } = new();
    public double PathDiamMm { get; set; }

    /// <summary>GALVANIZED | PAINTED | BARE | POWDER_COATED | SPECIAL_COATING</summary>
    public string SurfaceTreatment { get; set; } = "BARE";

    /// <summary>Site / building / phase destination key for packing isolation.</summary>
    public string Destination { get; set; } = "";

    /// <summary>True → never tight-nest; pack with protection.</summary>
    public bool SpecialHandling { get; set; }

    /// <summary>PHASE property tags from IFC (may be empty).</summary>
    public List<double> PhaseTags { get; set; } = new();
}

/// <summary>One part inside a multi-body IFC assembly (viewer Y-up mm).</summary>
public class RawPart
{
    public string Name { get; set; } = "";
    public string IfcType { get; set; } = "";
    public string ProfileDesc { get; set; } = "";
    public string ShapeKey { get; set; } = "";
    public double SectH { get; set; }
    public double SectW { get; set; }
    public double SectT { get; set; }
    public double SectD { get; set; }
    public double SectTf { get; set; }
    public double SectTw { get; set; }
    public double LengthMm { get; set; }
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }
    public double OffsetXMm { get; set; }
    public double OffsetYMm { get; set; }
    public double OffsetZMm { get; set; }
    public double BoxXMm { get; set; }
    public double BoxYMm { get; set; }
    public double BoxZMm { get; set; }
    public double RotX { get; set; }
    public double RotY { get; set; }
    public double RotZ { get; set; }
    public bool HasIfcTransform { get; set; }
    public double[] Transform { get; set; } = Array.Empty<double>();
    public string PartKind { get; set; } = "other";
    public double ThicknessMm { get; set; }
    public double SlopeDeg { get; set; }
    public List<double[]> ProfilePointsMm { get; set; } = new();
    public double ProfileExtrudeMm { get; set; }
    public int IfcEntityId { get; set; }
    public List<double> MeshPositionsMm { get; set; } = new();
    public List<int> MeshIndices { get; set; } = new();
}
