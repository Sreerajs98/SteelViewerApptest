namespace SteelPackingApp.Models;

/// <summary>
/// Physical container spec. Defaults below are standard 40ft high-cube internal
/// dimensions and a typical max payload weight - adjust to match your actual
/// container/trailer type if different.
/// </summary>
public class Container
{
    public string Name { get; set; } = "40 FT Container";
    public double LengthMm { get; set; } = 12000;
    public double WidthMm { get; set; } = 2350;
    public double HeightMm { get; set; } = 2690;
    public double MaxWeightKg { get; set; } = 26000;
}

public class ContainerLoadPlan
{
    public int ContainerNumber { get; set; }
    public Container Spec { get; set; } = new();
    public List<ShippableUnit> Units { get; set; } = new();

    public double UsedWeightKg => Units.Sum(u => u.Source.UnitWeightKg);
    public double WeightUtilizationPct =>
        Spec.MaxWeightKg == 0 ? 0 : UsedWeightKg / Spec.MaxWeightKg * 100.0;
}
