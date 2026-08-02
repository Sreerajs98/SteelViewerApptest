namespace SteelPackingApp.Models;

/// <summary>
/// One row from the AEM Shipping List = one assembly type (e.g. "CL001 - COLUMN").
/// Qty tells us how many physical pieces of this exact assembly need to be shipped.
/// </summary>
public class SteelItem
{
    public string AssmMark { get; set; } = "";
    public int Qty { get; set; }
    public string AssemblyName { get; set; } = "";

    public double LengthMm { get; set; }
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }

    /// <summary>
    /// Shipping-pose length (member span mm). 0 when unknown — viewer falls back to world AABB + JS sanitize.
    /// </summary>
    public double ShippingLengthMm { get; set; }

    /// <summary>Shipping-pose floor seat width (flange / steel width mm).</summary>
    public double ShippingWidthMm { get; set; }

    /// <summary>Shipping-pose height (web depth / clear gap mm).</summary>
    public double ShippingHeightMm { get; set; }

    /// <summary>True flange plate width mm when resolved from FL parts.</summary>
    public double FlangeWidthMm { get; set; }

    public double UnitWeightKg { get; set; }
    public double TotalWeightKg { get; set; }

    public string Remarks { get; set; } = "";

    /// <summary>
    /// Section profile description read from the IFC part's Description
    /// attribute (Tekla exports the section name here - e.g. "200Z18",
    /// "120C20", "L40*2.5", "PL6X500", "ROD12"). Empty when unavailable.
    /// Parsed on the JS side to decide the exact rendered cross-section.
    /// </summary>
    public string ProfileDesc { get; set; } = "";

    /// <summary>
    /// True when the weight came from a geometry-based estimate
    /// (bounding-box volume × steel density) rather than a real Tekla
    /// property set. The JS side reduces this by a shape-specific fill
    /// factor for thin-walled profiles like Z-purlins and C-channels,
    /// where the true steel volume is only ~2–15 % of the bounding box.
    /// </summary>
    public bool WeightEstimated { get; set; }

    /// <summary>
    /// Exact cross-section dimensions parsed from ProfileDesc.
    /// Null when the description string could not be parsed (e.g. non-standard naming).
    /// When present, the JS renderer uses these for physically-correct geometry
    /// instead of approximating from the bounding-box W/H dimensions.
    /// </summary>
    public ProfileSection? Section { get; set; }

    /// <summary>
    /// True when this IFC IfcElementAssembly has multiple structural parts
    /// that should render as one assembled shape (beam + plates/cleats…).
    /// Single-member assemblies stay false — existing C/Z path unchanged.
    /// </summary>
    public bool IsAssembly { get; set; }

    /// <summary>
    /// Child parts of a multi-body IFC assembly, offsets in Three.js Y-up mm
    /// relative to the assembly AABB centre. Empty for single-member items.
    /// </summary>
    public List<AssemblyPart> Parts { get; set; } = new();

    /// <summary>
    /// Bent sag rod only: IFC centerline points in Three.js Y-up mm, centred on AABB.
    /// Empty for all other items.
    /// </summary>
    public List<double[]> PathPointsMm { get; set; } = new();

    /// <summary>Bent sag rod bar diameter from IFC (mm).</summary>
    public double PathDiamMm { get; set; }

    /// <summary>
    /// Clear height between top/bottom flange inner faces (mm).
    /// Used by the viewer so rafter/column webs fill exactly between flanges.
    /// 0 when flanges cannot be resolved.
    /// </summary>
    public double FlangeClearGapMm { get; set; }

    /// <summary>
    /// PHASE values from this product/assembly (and aggregated children).
    /// Empty when untagged — see IncludeInAllPhases.
    /// </summary>
    public List<double> PhaseTags { get; set; } = new();

    /// <summary>
    /// True when any related object lacks a PHASE property — included under every phase filter
    /// (xBIM ingest). STEP fallback sets false so untagged items stay out of a phase pick.
    /// </summary>
    public bool IncludeInAllPhases { get; set; } = true;

    /// <summary>
    /// Surface treatment for packing isolation: GALVANIZED, PAINTED, BARE, POWDER_COATED, SPECIAL_COATING.
    /// </summary>
    public string SurfaceTreatment { get; set; } = "BARE";

    /// <summary>
    /// Destination / building / ship-to key. Empty → viewer treats as DEFAULT (same site).
    /// </summary>
    public string Destination { get; set; } = "";

    /// <summary>
    /// Fragile / special coating / no-stack — pack with protection, never tight-nest.
    /// </summary>
    public bool SpecialHandling { get; set; }

    public double LengthM => LengthMm / 1000.0;
}

/// <summary>
/// One structural part inside an IFC IfcElementAssembly (non-fastener).
/// Offsets / box sizes are millimetres, Three.js Y-up, relative to assembly centre.
/// </summary>
public class AssemblyPart
{
    public string Name { get; set; } = "";
    public string IfcType { get; set; } = "";
    public string ProfileDesc { get; set; } = "";
    public ProfileSection? Section { get; set; }

    /// <summary>Extrusion length for makeShape (mm).</summary>
    public double LengthMm { get; set; }
    public double WidthMm { get; set; }
    public double HeightMm { get; set; }

    public double OffsetXMm { get; set; }
    public double OffsetYMm { get; set; }
    public double OffsetZMm { get; set; }

    /// <summary>IFC AABB size remapped to Three.js axes (for centre-snap).</summary>
    public double BoxXMm { get; set; }
    public double BoxYMm { get; set; }
    public double BoxZMm { get; set; }

    public double RotX { get; set; }
    public double RotY { get; set; }
    public double RotZ { get; set; }

    /// <summary>
    /// True when Transform holds an IFC-derived 4×4 (column-major, Three.js Y-up)
    /// mapping mesh-local (X=length, Y=height, Z=width) → assembly-relative space.
    /// </summary>
    public bool HasIfcTransform { get; set; }

    /// <summary>16 doubles, column-major Three.js Matrix4. Empty when unused.</summary>
    public double[] Transform { get; set; } = Array.Empty<double>();

    /// <summary>web | flange | stiff | other — web is built first in the viewer.</summary>
    public string PartKind { get; set; } = "other";

    /// <summary>Plate thickness from IFC (mm).</summary>
    public double ThicknessMm { get; set; }

    /// <summary>Long-axis pitch vs horizontal (degrees), from IFC placement.</summary>
    public double SlopeDeg { get; set; }

    /// <summary>
    /// IFC extruded face profile in solid local XY (mm), centred — for tapered web etc.
    /// Each entry is [x,y]. Empty → use box extents.
    /// </summary>
    public List<double[]> ProfilePointsMm { get; set; } = new();

    /// <summary>Extrusion depth of ProfilePointsMm (usually thickness), mm.</summary>
    public double ProfileExtrudeMm { get; set; }

    /// <summary>IFC entity label (#123) for xBIM mesh lookup.</summary>
    public int IfcEntityId { get; set; }

    /// <summary>
    /// xBIM tessellated mesh positions in Three.js Y-up mm, assembly-relative
    /// (xyz interleaved). Used for rafter/column exact solids only.
    /// </summary>
    public List<double> MeshPositionsMm { get; set; } = new();

    /// <summary>Triangle indices into MeshPositionsMm (3 per triangle).</summary>
    public List<int> MeshIndices { get; set; } = new();
}

/// <summary>
/// A single physical piece to load, expanded out from a SteelItem's Qty.
/// E.g. if CL001 has Qty=1 it produces one ShippableUnit; BR001 with Qty=2
/// produces two identical ShippableUnits (unit 1 of 2, unit 2 of 2).
/// </summary>
public class ShippableUnit
{
    public SteelItem Source { get; set; } = null!;
    public int UnitIndex { get; set; }   // 1-based, e.g. 1 of 2
}

public class JobInfo
{
    public string JobNo { get; set; } = "";
    public string BldgNo { get; set; } = "";
    public string PhaseNo { get; set; } = "";
    public string Customer { get; set; } = "";
}
