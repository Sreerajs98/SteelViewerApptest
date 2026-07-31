namespace SteelPackingApp.Models;

/// <summary>
/// Exact cross-section dimensions of a structural steel profile.
/// All dimensions in mm. Zero means "not available / estimated from bounding box".
///
/// For a Z-purlin "200Z18":
///   H = 200mm (web height), t = 1.8mm (thickness), W ≈ 65mm (flange width estimated),
///   D ≈ 17mm (lip height estimated from gauge).
///
/// For a C-channel "120C20":
///   H = 120mm (height), t = 2.0mm (thickness), W ≈ 50mm (flange width).
///
/// For an I-beam "IPE300":
///   H = 300mm, W = 150mm, tf = 10.7mm (flange t), tw = 7.1mm (web t).
/// </summary>
public class ProfileSection
{
    /// <summary>Canonical shape key matching the JS renderer's FILL_FACTORS / makeShape routing.</summary>
    public string ShapeKey { get; set; } = "unknown";   // z_channel | c_channel | i_beam | l_angle | rhs | plate | rod

    /// <summary>Original string from Tekla part Description (e.g. "200Z18", "IPE300").</summary>
    public string Raw { get; set; } = "";

    // ── Shared ──────────────────────────────────────────────────────────────
    /// <summary>Overall height / web height (mm). Always the largest cross-section dimension.</summary>
    public double H { get; set; }

    /// <summary>Overall width / flange width (mm).</summary>
    public double W { get; set; }

    // ── Thin-walled cold-formed (Z, C, Sigma, Hat) ───────────────────────────
    /// <summary>Wall / flange / web thickness (mm). Same value for all walls in cold-formed profiles.</summary>
    public double T { get; set; }

    /// <summary>Lip height (mm) — Z/C/Sigma stiffening lip at flange tip.</summary>
    public double D { get; set; }

    // ── Hot-rolled (I, H, L, RHS) ────────────────────────────────────────────
    /// <summary>Flange thickness (mm) for I/H profiles.</summary>
    public double Tf { get; set; }

    /// <summary>Web thickness (mm) for I/H profiles.</summary>
    public double Tw { get; set; }

    // ── Plate / rod ─────────────────────────────────────────────────────────
    /// <summary>Plate thickness (mm) — same as H for a flat plate.</summary>
    public double Thickness => H;

    /// <summary>Rod / pipe diameter (mm).</summary>
    public double Diameter => H;

    // ── Availability flags ───────────────────────────────────────────────────
    /// <summary>True if exact dimensions came from a property set (reliable).
    /// False if estimated from the description string heuristics.</summary>
    public bool FromPropertySet { get; set; }

    /// <summary>Human-readable label for the info panel.</summary>
    public string Label => ShapeKey switch
    {
        "z_channel" => $"Z-purlin {Raw}  H={H:0}×t={T:0.0}mm",
        "c_channel" => $"C-channel {Raw}  H={H:0}×t={T:0.0}mm",
        "l_angle"   => $"L-angle {Raw}  {H:0}×{W:0}×{T:0.0}mm",
        "i_beam"    => $"I-beam {Raw}  H={H:0}×B={W:0}mm",
        "rhs"       => $"RHS {Raw}  {H:0}×{W:0}×{T:0.0}mm",
        "plate"     => $"Plate {Raw}  t={H:0}mm",
        "rod"       => $"Rod/bar ∅{Diameter:0}mm",
        "bent_sag_rod" => $"Bent sag rod ∅{Diameter:0}mm",
        _           => Raw
    };
}
