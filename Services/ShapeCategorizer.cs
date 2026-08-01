namespace SteelPackingApp.Services;

/// <summary>
/// Detects a rough "shape family" from the assembly name text alone, so this
/// works on ANY job's Shipping List without hardcoding mark numbers or profiles
/// specific to one job. Extend the keyword lists as you see new assembly names
/// across different jobs/revisions.
/// </summary>
public static class ShapeCategorizer
{
    public static string Categorize(string assemblyName)
    {
        string n = (assemblyName ?? "").ToUpperInvariant();

        if (n.Contains("COLUMN") || n.Contains("RAFTER") || n.Contains("BEAM"))
            return "beam";          // solid I/W-section members -> drawn as a box, laid end to end

        // Hot-rolled L / flange brace / angle brace — not round rod, not plate stack
        if (n.Contains("FLANGE BRACE") || n.Contains("FLANGE_BRACE")
            || n.Contains("ANGLE BRACE") || n.Contains("ANGLE_BRACE")
            || n.Contains("L_BRACE") || n.Contains("L-BRACE")
            || n.Contains("L_ANGLE") || n.Contains("EQUAL ANGLE") || n.Contains("UNEQUAL ANGLE"))
            return "purlin";        // nestable open section family (L stack in JS)

        if (n.Contains("ROD") || n.Contains("PIPE")
            || (n.Contains("BRACE") && !n.Contains("ANGLE") && !n.Contains("FLANGE") && !n.Contains("L_")))
            return "rod";           // thin round members -> drawn as a slim box, laid end to end

        if (n.Contains("PANEL") || n.Contains("PLT") || n.Contains("PLATE") || n.Contains("SHIM") || n.Contains("SHEET"))
            return "plate";         // panels / flat items -> flat-stacked (height = qty x thickness)

        if (n.Contains("PURLIN") || n.Contains("CHANNEL") || n.Contains("GIRT"))
            return "purlin";        // Z/C sections -> nested lane, laid end to end

        return "other";
    }
}
