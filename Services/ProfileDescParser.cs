using System.Text.RegularExpressions;
using SteelPackingApp.Models;

namespace SteelPackingApp.Services;

/// <summary>
/// Parses Tekla's section description strings (stored in the IFC part's
/// Description attribute) into exact cross-section dimensions.
///
/// Tekla writes the section in several standard formats:
///   Z-purlin   : "200Z18"          → H=200, t=1.8
///   Z-purlin   : "Z200/1.8"        → H=200, t=1.8
///   C-channel  : "120C20"          → H=120, t=2.0
///   C-channel  : "C120/2.0"        → H=120, t=2.0
///   L-angle    : "L40*2.5"         → H=W=40, t=2.5
///   L-angle    : "L75X75X6"        → H=75, W=75, t=6
///   I-beam IPE : "IPE300"          → H=300, W=150, tf=10.7, tw=7.1 (from lookup table)
///   I-beam HEA : "HEA200"          → lookup table
///   I-beam HEB : "HEB200"          → lookup table
///   I-beam UB  : "UB254X102X22"   → H=254, W=102
///   RHS        : "RHS200X100X6"   → H=200, W=100, t=6
///   SHS        : "SHS100X100X5"   → H=W=100, t=5
///   Flat plate : "PL6X500"         → thickness=6, width=500
///   Flat plate : "PL10*200"        → thickness=10, width=200
///   Round bar  : "ROD20"           → diameter=20
///   Round pipe : "CHS114.3X6"      → diameter=114.3, t=6
/// </summary>
public static class ProfileDescParser
{
    // Standard Z/C gauge tables — these profiles' flange width and lip are
    // not always present in Tekla property sets but are standardised for
    // cold-formed steel. Values from AS/NZS 4600 / EN 1993-1-3 tables.
    // Key = nominal height H (mm). Value = (W_flange, D_lip) in mm.
    private static readonly Dictionary<int, (double W, double D)> ZFlangeTable = new()
    {
        [100] = (55, 12), [115] = (55, 12), [120] = (55, 14),
        [150] = (60, 15), [175] = (60, 16), [200] = (65, 17),
        [230] = (65, 18), [250] = (70, 20), [300] = (75, 22),
    };
    private static readonly Dictionary<int, (double W, double D)> CFlangeTable = new()
    {
        [75]  = (40, 10), [100] = (50, 12), [120] = (55, 14),
        [150] = (55, 16), [175] = (60, 16), [200] = (65, 18),
        [230] = (65, 18), [250] = (70, 20), [300] = (75, 22),
    };

    // IPE / HEA / HEB section lookup (H, B, tf, tw) from steel tables.
    private static readonly Dictionary<string, (double H, double B, double Tf, double Tw)> IpeTable = new(StringComparer.OrdinalIgnoreCase)
    {
        ["80"]  = (80,  46,  5.2, 3.8), ["100"] = (100, 55,  5.7, 4.1),
        ["120"] = (120, 64,  6.3, 4.4), ["140"] = (140, 73,  6.9, 4.7),
        ["160"] = (160, 82,  7.4, 5.0), ["180"] = (180, 91,  8.0, 5.3),
        ["200"] = (200,100,  8.5, 5.6), ["220"] = (220,110,  9.2, 5.9),
        ["240"] = (240,120,  9.8, 6.2), ["270"] = (270,135, 10.2, 6.6),
        ["300"] = (300,150, 10.7, 7.1), ["330"] = (330,160, 11.5, 7.5),
        ["360"] = (360,170, 12.7, 8.0), ["400"] = (400,180, 13.5, 8.6),
        ["450"] = (450,190, 14.6, 9.4), ["500"] = (500,200, 16.0,10.2),
        ["550"] = (550,210, 17.2,11.1), ["600"] = (600,220, 19.0,12.0),
    };
    private static readonly Dictionary<string, (double H, double B, double Tf, double Tw)> HeaTable = new(StringComparer.OrdinalIgnoreCase)
    {
        ["100"] = (96,  100, 8.0, 5.0), ["120"] = (114, 120, 8.0, 5.0),
        ["140"] = (133, 140, 8.5, 5.5), ["160"] = (152, 160, 9.0, 6.0),
        ["180"] = (171, 180, 9.5, 6.0), ["200"] = (190, 200,10.0, 6.5),
        ["220"] = (210, 220,11.0, 7.0), ["240"] = (230, 240,12.0, 7.5),
        ["260"] = (250, 260,12.5, 7.5), ["280"] = (270, 280,13.0, 8.0),
        ["300"] = (290, 300,14.0, 8.5), ["320"] = (310, 300,15.5, 9.0),
        ["340"] = (330, 300,16.5,10.0), ["360"] = (350, 300,17.5,10.0),
        ["400"] = (390, 300,19.0,11.0), ["450"] = (440, 300,21.0,11.5),
        ["500"] = (490, 300,23.0,12.0), ["550"] = (540, 300,24.0,12.5),
        ["600"] = (590, 300,25.0,13.0), ["650"] = (640, 300,26.0,13.5),
        ["700"] = (690, 300,27.0,14.5), ["800"] = (790, 300,28.0,15.0),
        ["900"] = (890, 300,30.0,16.0),["1000"] = (990, 300,31.0,16.5),
    };

    public static ProfileSection? Parse(string? desc)
    {
        if (string.IsNullOrWhiteSpace(desc)) return null;

        // Normalise: remove internal spaces, upper-case.
        // Strip known suffixes BEFORE matching so "IPE300-A" → "IPE300",
        // "200Z18-GALV" → "200Z18", "C120/2.0 (custom)" → "C120/2.0".
        // We preserve the raw original for display but parse from stripped.
        string raw = desc.Trim();
        string stripped = StripSuffix(raw).Trim();

        var result =
            TryParseZ(stripped, raw)    ??
            TryParseC(stripped, raw)    ??
            TryParseLAngle(stripped, raw) ??
            TryParseIPE(stripped, raw)  ??
            TryParseHEA(stripped, raw)  ??
            TryParseHEB(stripped, raw)  ??
            TryParseUB(stripped, raw)   ??
            TryParseRHS(stripped, raw)  ??
            TryParseCHS(stripped, raw)  ??
            TryParsePlate(stripped, raw) ??
            TryParseRod(stripped, raw)  ??
            TryParseGenericH(stripped, raw);

        return result;
    }

    /// <summary>
    /// Detect surface treatment from profile / remarks text (Tekla suffixes & pset echoes).
    /// </summary>
    public static string DetectSurface(string? profileDesc, string? remarks = null)
    {
        string s = $"{profileDesc} {remarks}".ToUpperInvariant();
        if (string.IsNullOrWhiteSpace(s)) return "BARE";
        if (Regex.IsMatch(s, @"POWDER|P\.?\s*COAT|POWDERCOAT")) return "POWDER_COATED";
        if (Regex.IsMatch(s, @"SPECIAL[_\s-]?COAT|EPOXY|FIRE.?PROOF")) return "SPECIAL_COATING";
        if (Regex.IsMatch(s, @"\bGALV|GALVANI|HDG\b|HOT.?DIP")) return "GALVANIZED";
        if (Regex.IsMatch(s, @"\bPAINT|PRIMER|TOP.?COAT|COATED\b")) return "PAINTED";
        return "BARE";
    }

    /// <summary>Fragile / no-stack / special handling from comments.</summary>
    public static bool DetectSpecialHandling(string? remarks, string? profileDesc = null)
    {
        string s = $"{remarks} {profileDesc}".ToUpperInvariant();
        return Regex.IsMatch(s, @"FRAGILE|NO[\s_-]?STACK|SPECIAL|PRE[\s_-]?ATTACH|INSULATION|SHEETING");
    }

    /// <summary>
    /// Strip known non-structural suffixes so the core regex can match.
    /// Examples: "IPE300-A" → "IPE300"
    ///           "200Z18 GALVANISED" → "200Z18"
    ///           "C120/2.0(custom)" → "C120/2.0"
    ///           "HEA200 S355" → "HEA200"
    /// </summary>
    private static string StripSuffix(string s)
    {
        // Remove trailing parenthesised annotation: "IPE300 (Special)" → "IPE300"
        s = Regex.Replace(s, @"\s*\(.*\)\s*$", "");
        // Remove trailing grade/material codes: "S235", "S355", "S275", "A572", "A36"
        s = Regex.Replace(s, @"\s+[SA]\d{2,4}[A-Z]?\s*$", "", RegexOptions.IgnoreCase);
        // Remove trailing surface treatment words
        s = Regex.Replace(s, @"\s*[-_]?(GALV|GALVANISED|GALVANIZED|HDG|PAINT|PRIMER|CUSTOM|SPECIAL|STD|STANDARd)\s*$",
                           "", RegexOptions.IgnoreCase);
        // Remove trailing single letter grade suffix: "IPE300-A" → "IPE300"
        s = Regex.Replace(s, @"[-_][A-Z]\s*$", "", RegexOptions.IgnoreCase);
        return s.Trim();
    }

    // ── Z-purlin ──────────────────────────────────────────────────────────────
    // Formats: "200Z18" "Z200/1.8" "Z200-18" "200Z1.8" "Z200X75X2.5" "200X75X2.5Z"
    private static ProfileSection? TryParseZ(string d, string raw)
    {
        // "Z200X75X2.5" / "Z200*75*2.5"
        var m = Regex.Match(d,
            @"^Z\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)$",
            RegexOptions.IgnoreCase);
        if (m.Success)
        {
            double H3 = double.Parse(m.Groups[1].Value);
            double W3 = double.Parse(m.Groups[2].Value);
            double t3 = double.Parse(m.Groups[3].Value);
            if (t3 > 10) t3 /= 10.0;
            var (_, D3) = EstimateZFlange((int)H3, t3);
            return new ProfileSection { ShapeKey = "z_channel", Raw = raw, H = H3, W = W3, T = t3, D = D3 };
        }

        // "200X75X2.5Z"
        m = Regex.Match(d,
            @"^(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*[X*×]\s*(\d+(?:\.\d+)?)\s*Z$",
            RegexOptions.IgnoreCase);
        if (m.Success)
        {
            double H3 = double.Parse(m.Groups[1].Value);
            double W3 = double.Parse(m.Groups[2].Value);
            double t3 = double.Parse(m.Groups[3].Value);
            if (t3 > 10) t3 /= 10.0;
            var (_, D3) = EstimateZFlange((int)H3, t3);
            return new ProfileSection { ShapeKey = "z_channel", Raw = raw, H = H3, W = W3, T = t3, D = D3 };
        }

        // "200Z18" or "200Z1.8"
        m = Regex.Match(d, @"^(\d+)\s*Z\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success)
            // "Z200/1.8" or "Z200-18"
            m = Regex.Match(d, @"^Z\s*(\d+)\s*[/\-]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success)
            // "Z200X2.5" (H × thickness only)
            m = Regex.Match(d, @"^Z\s*(\d+)\s*[X*×]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;

        double H = double.Parse(m.Groups[1].Value);
        double t = double.Parse(m.Groups[2].Value);
        if (t > 10) t /= 10.0;   // "18" → 1.8 mm (Tekla writes gauge without decimal)

        // Flange and lip from table, or estimate
        var (W, D) = EstimateZFlange((int)H, t);

        return new ProfileSection { ShapeKey="z_channel", Raw=raw, H=H, W=W, T=t, D=D };
    }

    // ── C-channel ─────────────────────────────────────────────────────────────
    // Formats: "120C20" "C120/2.0" "C120-20"
    private static ProfileSection? TryParseC(string d, string raw)
    {
        var m = Regex.Match(d, @"^(\d+)\s*C\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success)
            m = Regex.Match(d, @"^C\s*(\d+)\s*[/\-]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;

        double H = double.Parse(m.Groups[1].Value);
        double t = double.Parse(m.Groups[2].Value);
        if (t > 10) t /= 10.0;

        var (W, D) = EstimateCFlange((int)H, t);
        return new ProfileSection { ShapeKey="c_channel", Raw=raw, H=H, W=W, T=t, D=D };
    }

    // ── L-angle ───────────────────────────────────────────────────────────────
    // Formats: "L40*2.5" "L75X75X6" "L50X50X5" "L75*75*6"
    private static ProfileSection? TryParseLAngle(string d, string raw)
    {
        // Equal leg + thickness: "L40*2.5" or "L40X2.5"
        var m = Regex.Match(d, @"^L\s*(\d+(?:\.\d+)?)\s*[*Xx]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (m.Success)
        {
            double leg = double.Parse(m.Groups[1].Value);
            double t   = double.Parse(m.Groups[2].Value);
            return new ProfileSection { ShapeKey="l_angle", Raw=raw, H=leg, W=leg, T=t };
        }

        // Unequal or three-value: "L75X50X6"
        m = Regex.Match(d, @"^L\s*(\d+(?:\.\d+)?)\s*[*Xx]\s*(\d+(?:\.\d+)?)\s*[*Xx]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (m.Success)
        {
            double H = double.Parse(m.Groups[1].Value);
            double W = double.Parse(m.Groups[2].Value);
            double t = double.Parse(m.Groups[3].Value);
            return new ProfileSection { ShapeKey="l_angle", Raw=raw, H=Math.Max(H,W), W=Math.Min(H,W), T=t };
        }
        return null;
    }

    // ── IPE ───────────────────────────────────────────────────────────────────
    private static ProfileSection? TryParseIPE(string d, string raw)
    {
        var m = Regex.Match(d, @"^IPE\s*(\d+)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        string key = m.Groups[1].Value;
        if (!IpeTable.TryGetValue(key, out var s)) { s = EstimateHSection(double.Parse(key)); }
        return new ProfileSection { ShapeKey="i_beam", Raw=raw, H=s.H, W=s.B, Tf=s.Tf, Tw=s.Tw, FromPropertySet=true };
    }

    // ── HEA ───────────────────────────────────────────────────────────────────
    private static ProfileSection? TryParseHEA(string d, string raw)
    {
        var m = Regex.Match(d, @"^HEA\s*(\d+)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        string key = m.Groups[1].Value;
        if (!HeaTable.TryGetValue(key, out var s)) { s = EstimateHSection(double.Parse(key)); }
        return new ProfileSection { ShapeKey="i_beam", Raw=raw, H=s.H, W=s.B, Tf=s.Tf, Tw=s.Tw, FromPropertySet=true };
    }

    // ── HEB ───────────────────────────────────────────────────────────────────
    private static ProfileSection? TryParseHEB(string d, string raw)
    {
        var m = Regex.Match(d, @"^HEB\s*(\d+)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double H = double.Parse(m.Groups[1].Value);
        double B = H <= 200 ? H : 300;   // HEB ≤200 → square, HEB >200 → 300mm flange
        double tf = H * 0.05 + 5;        // rough estimate
        double tw = H * 0.025 + 4;
        return new ProfileSection { ShapeKey="i_beam", Raw=raw, H=H, W=B, Tf=tf, Tw=tw };
    }

    // ── UB / UC (British standard) ─────────────────────────────────────────
    // Format: "UB254X102X22" or "UC203X203X46"
    private static ProfileSection? TryParseUB(string d, string raw)
    {
        var m = Regex.Match(d, @"^(UB|UC)\s*(\d+)\s*[Xx]\s*(\d+)\s*[Xx]\s*(\d+)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double H  = double.Parse(m.Groups[2].Value);
        double W  = double.Parse(m.Groups[3].Value);
        double kg = double.Parse(m.Groups[4].Value);  // mass/metre - not a geometry dim but helps estimate
        double tf = H * 0.055 + 2;
        double tw = H * 0.030 + 1.5;
        return new ProfileSection { ShapeKey="i_beam", Raw=raw, H=H, W=W, Tf=tf, Tw=tw };
    }

    // ── RHS / SHS ─────────────────────────────────────────────────────────────
    private static ProfileSection? TryParseRHS(string d, string raw)
    {
        var m = Regex.Match(d, @"^(?:RHS|SHS)\s*(\d+(?:\.\d+)?)\s*[Xx]\s*(\d+(?:\.\d+)?)\s*[Xx]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double H = double.Parse(m.Groups[1].Value);
        double W = double.Parse(m.Groups[2].Value);
        double t = double.Parse(m.Groups[3].Value);
        return new ProfileSection { ShapeKey="rhs", Raw=raw, H=Math.Max(H,W), W=Math.Min(H,W), T=t, FromPropertySet=true };
    }

    // ── CHS (circular hollow section / pipe) ─────────────────────────────────
    private static ProfileSection? TryParseCHS(string d, string raw)
    {
        var m = Regex.Match(d, @"^(?:CHS|PIPE|HSS)\s*(\d+(?:\.\d+)?)\s*[Xx]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double dia = double.Parse(m.Groups[1].Value);
        double t   = double.Parse(m.Groups[2].Value);
        return new ProfileSection { ShapeKey="rod", Raw=raw, H=dia, W=dia, T=t };
    }

    // ── Flat plate ────────────────────────────────────────────────────────────
    // Formats: "PL6X500" "PL10*200" "PL5.0X250"
    private static ProfileSection? TryParsePlate(string d, string raw)
    {
        var m = Regex.Match(d, @"^PL\s*(\d+(?:\.\d+)?)\s*[X*x]\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success)
            // bare "PL8" (thickness only)
            m = Regex.Match(d, @"^PL\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double thickness = double.Parse(m.Groups[1].Value);
        double width     = m.Groups.Count > 2 && m.Groups[2].Success ? double.Parse(m.Groups[2].Value) : 0;
        return new ProfileSection { ShapeKey="plate", Raw=raw, H=thickness, W=width > 0 ? width : thickness };
    }

    // ── Round bar / rod ───────────────────────────────────────────────────────
    // Formats: "ROD20" "D20" "BAR20" "R20"
    private static ProfileSection? TryParseRod(string d, string raw)
    {
        var m = Regex.Match(d, @"^(?:ROD|D|BAR|R)\s*(\d+(?:\.\d+)?)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double dia = double.Parse(m.Groups[1].Value);
        return new ProfileSection { ShapeKey="rod", Raw=raw, H=dia, W=dia };
    }

    // ── Generic "H200" or "W200" or bare number ───────────────────────────────
    private static ProfileSection? TryParseGenericH(string d, string raw)
    {
        var m = Regex.Match(d, @"^[A-Z]*\s*(\d{2,4})$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        double H = double.Parse(m.Groups[1].Value);
        if (H < 50 || H > 2000) return null;
        var s = EstimateHSection(H);
        return new ProfileSection { ShapeKey="i_beam", Raw=raw, H=s.H, W=s.B, Tf=s.Tf, Tw=s.Tw };
    }

    // ── Estimation helpers ────────────────────────────────────────────────────

    /// <summary>
    /// Nearest-H lookup in the Z flange table, then linear interpolation.
    /// </summary>
    private static (double W, double D) EstimateZFlange(int H, double t)
    {
        if (ZFlangeTable.TryGetValue(H, out var exact)) return exact;
        // Find bracketing entries and interpolate
        var keys = ZFlangeTable.Keys.OrderBy(k => k).ToList();
        var lo = keys.LastOrDefault(k => k <= H);
        var hi = keys.FirstOrDefault(k => k >= H);
        if (lo == 0) lo = keys[0];
        if (hi == 0) hi = keys[^1];
        if (lo == hi) return ZFlangeTable[lo];
        double frac = (H - lo) / (double)(hi - lo);
        var (Wlo,Dlo) = ZFlangeTable[lo];
        var (Whi,Dhi) = ZFlangeTable[hi];
        return (Wlo + frac*(Whi-Wlo), Dlo + frac*(Dhi-Dlo));
    }

    private static (double W, double D) EstimateCFlange(int H, double t)
    {
        if (CFlangeTable.TryGetValue(H, out var exact)) return exact;
        var keys = CFlangeTable.Keys.OrderBy(k => k).ToList();
        var lo = keys.LastOrDefault(k => k <= H);
        var hi = keys.FirstOrDefault(k => k >= H);
        if (lo == 0) lo = keys[0];
        if (hi == 0) hi = keys[^1];
        if (lo == hi) return CFlangeTable[lo];
        double frac = (H - lo) / (double)(hi - lo);
        var (Wlo,Dlo) = CFlangeTable[lo];
        var (Whi,Dhi) = CFlangeTable[hi];
        return (Wlo + frac*(Whi-Wlo), Dlo + frac*(Dhi-Dlo));
    }

    private static (double H, double B, double Tf, double Tw) EstimateHSection(double H)
    {
        // Rough proportions for a generic I/H beam
        double B  = H <= 200 ? H * 0.55 : Math.Min(H * 0.5, 300);
        double tf = H * 0.045 + 4;
        double tw = H * 0.025 + 3;
        return (H, B, tf, tw);
    }
}
