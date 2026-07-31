using System.Text.Json;
using System.Text.Json.Serialization;
using SteelPackingApp.Models;
using SteelPackingApp.Services;

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: IfcExport <ifcPath> [outJson] [phase|all]");
    return 1;
}

string ifcPath = args[0];
string outJson = args.Length > 1 ? args[1]
    : Path.Combine(AppContext.BaseDirectory, "scene_export.json");
double? phase = null;
if (args.Length > 2 && !string.Equals(args[2], "all", StringComparison.OrdinalIgnoreCase))
{
    if (double.TryParse(args[2], out var p)) phase = p;
}

if (!File.Exists(ifcPath))
{
    Console.Error.WriteLine("IFC not found: " + ifcPath);
    return 2;
}

Console.WriteLine($"Loading IFC: {ifcPath}");
var (job, items, skipped) = XbimIfcIngest.ConvertWithFallback(ifcPath, phase);
Console.WriteLine($"Items={items.Count} skipped={skipped} job={job.JobNo}");

var container = new Container();
var scene = SceneBuilder.BuildRawScene(job, container, items);

var opts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false,
};
string json = JsonSerializer.Serialize(scene, opts);
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outJson))!);
await File.WriteAllTextAsync(outJson, json);
Console.WriteLine($"Wrote {outJson} ({new FileInfo(outJson).Length / 1024.0:0} KB)");
Console.WriteLine($"Container {container.LengthMm}x{container.WidthMm}x{container.HeightMm} maxKg={container.MaxWeightKg}");
return 0;
