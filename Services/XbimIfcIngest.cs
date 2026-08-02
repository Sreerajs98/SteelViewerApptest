using System.IO;
using System.Globalization;
using SteelPackingApp.Models;
using Xbim.Common.Geometry;
using Xbim.Common.XbimExtensions;
using Xbim.Ifc;
using Xbim.Ifc4.Interfaces;
using Xbim.ModelGeometry.Scene;

namespace SteelPackingApp.Services;

/// <summary>
/// Option 1 — xBIM-first IFC ingest for ANY IFC.
/// Extracts structural products/assemblies with exact solid meshes and
/// available property data. No Tekla FL/WB/RAFTER name clustering required.
/// </summary>
public static class XbimIfcIngest
{
    public static List<double> ListPhases(string ifcPath)
    {
        // Prefer deriving from a full load when caller already needs items;
        // this light scan is only for callers that list phases alone.
        var phases = new HashSet<double>();
        try
        {
            using var model = IfcStore.Open(ifcPath);
            foreach (var obj in model.Instances.OfType<IIfcObject>())
            {
                var psets = ReadPsetValues(obj);
                CollectPhaseTags(psets, phases, out _);
            }
        }
        catch { /* empty → caller treats as All */ }
        return phases.OrderBy(x => x).ToList();
    }

    /// <summary>
    /// Fast phase/item counts — opens IFC property sets only (no tessellation).
    /// Use this before the phase picker so the UI appears quickly on large files.
    /// </summary>
    public static IfcPhaseScan ScanForPicker(string ifcPath)
    {
        if (string.IsNullOrWhiteSpace(ifcPath) || !File.Exists(ifcPath))
            throw new FileNotFoundException("IFC file not found", ifcPath);

        using var model = IfcStore.Open(ifcPath);
        string jobNo = Path.GetFileNameWithoutExtension(ifcPath) ?? "IFC";
        try
        {
            var project = model.Instances.OfType<IIfcProject>().FirstOrDefault();
            if (project != null && !string.IsNullOrWhiteSpace(project.Name))
                jobNo = project.Name!.ToString() ?? jobNo;
        }
        catch { /* keep filename */ }

        var psetCache = new Dictionary<int, List<(string Key, object? Val)>>();
        List<(string Key, object? Val)> PsetsOf(IIfcObject obj)
        {
            if (!psetCache.TryGetValue(obj.EntityLabel, out var list))
            {
                list = ReadPsetValues(obj);
                psetCache[obj.EntityLabel] = list;
            }
            return list;
        }

        var assemblyChildren = new Dictionary<int, List<int>>();
        var childToAssembly = new Dictionary<int, int>();
        foreach (var rel in model.Instances.OfType<IIfcRelAggregates>())
        {
            if (rel.RelatingObject is not IIfcElementAssembly asm) continue;
            int aid = asm.EntityLabel;
            if (!assemblyChildren.TryGetValue(aid, out var kids))
            {
                kids = new List<int>();
                assemblyChildren[aid] = kids;
            }
            foreach (var ro in rel.RelatedObjects)
            {
                if (ro is not IIfcProduct p || IsFastener(p)) continue;
                kids.Add(p.EntityLabel);
                childToAssembly[p.EntityLabel] = aid;
            }
        }

        var phaseTagsAll = new HashSet<double>();
        var candidates = new List<(HashSet<double> Tags, bool IncludeAll)>();

        foreach (var asm in model.Instances.OfType<IIfcElementAssembly>())
        {
            assemblyChildren.TryGetValue(asm.EntityLabel, out var kids);
            kids ??= new List<int>();
            var tags = new HashSet<double>();
            CollectPhaseTags(PsetsOf(asm), tags, out bool untagged);
            bool includeAll = untagged;
            foreach (var kid in kids.Distinct())
            {
                if (model.Instances[kid] is not IIfcProduct prod || IsFastener(prod)) continue;
                CollectPhaseTags(PsetsOf(prod), tags, out bool ku);
                if (ku) includeAll = true;
            }
            foreach (var t in tags) phaseTagsAll.Add(t);
            candidates.Add((tags, includeAll));
        }

        foreach (var prod in model.Instances.OfType<IIfcProduct>().Where(IsStructuralProduct))
        {
            if (prod is IIfcElementAssembly) continue;
            if (IsFastener(prod)) continue;
            if (childToAssembly.ContainsKey(prod.EntityLabel)) continue;
            var tags = new HashSet<double>();
            CollectPhaseTags(PsetsOf(prod), tags, out bool untagged);
            foreach (var t in tags) phaseTagsAll.Add(t);
            candidates.Add((tags, untagged));
        }

        var counts = phaseTagsAll
            .OrderBy(p => p)
            .Select(p => (
                Phase: p,
                Count: candidates.Count(c =>
                    c.IncludeAll || c.Tags.Any(t => Math.Abs(t - p) < 0.01))
            ))
            .ToList();

        return new IfcPhaseScan
        {
            JobNo = jobNo,
            PhaseCounts = counts,
            TotalCandidates = candidates.Count
        };
    }

    public static IfcPhaseScan ScanForPickerWithFallback(string ifcPath)
    {
        try { return ScanForPicker(ifcPath); }
        catch
        {
            var phases = IfcAssemblyReader.ListPhases(ifcPath);
            if (phases.Count == 0)
                return new IfcPhaseScan { JobNo = Path.GetFileNameWithoutExtension(ifcPath) ?? "IFC" };
            // Counts unknown until geometry load — show phase list only
            return new IfcPhaseScan
            {
                JobNo = Path.GetFileNameWithoutExtension(ifcPath) ?? "IFC",
                PhaseCounts = phases.Select(p => (Phase: p, Count: 0)).ToList(),
                TotalCandidates = 0
            };
        }
    }

    /// <summary>
    /// Tessellate and build items. When <paramref name="phaseFilter"/> is set,
    /// only extracts meshes / builds items for that phase (still one CreateContext).
    /// </summary>
    public static IfcLoadResult LoadAll(string ifcPath) => LoadGeometry(ifcPath, null);

    public static (JobInfo job, List<SteelItem> items, int skipped) Convert(string ifcPath, double? phaseFilter)
    {
        var loaded = LoadGeometry(ifcPath, phaseFilter);
        return ApplyPhaseFilter(loaded, phaseFilter);
    }

    private static IfcLoadResult LoadGeometry(string ifcPath, double? phaseFilter)
    {
        if (string.IsNullOrWhiteSpace(ifcPath) || !File.Exists(ifcPath))
            throw new FileNotFoundException("IFC file not found", ifcPath);

        using var model = IfcStore.Open(ifcPath);
        double toMm = ResolveToMm(model);

        string jobNo = Path.GetFileNameWithoutExtension(ifcPath) ?? "IFC";
        try
        {
            var project = model.Instances.OfType<IIfcProject>().FirstOrDefault();
            if (project != null && !string.IsNullOrWhiteSpace(project.Name))
                jobNo = project.Name!.ToString() ?? jobNo;
        }
        catch { /* keep filename */ }

        var psetCache = new Dictionary<int, List<(string Key, object? Val)>>();
        List<(string Key, object? Val)> PsetsOf(IIfcObject obj)
        {
            if (!psetCache.TryGetValue(obj.EntityLabel, out var list))
            {
                list = ReadPsetValues(obj);
                psetCache[obj.EntityLabel] = list;
            }
            return list;
        }

        var assemblyChildren = new Dictionary<int, List<int>>();
        var childToAssembly = new Dictionary<int, int>();
        foreach (var rel in model.Instances.OfType<IIfcRelAggregates>())
        {
            if (rel.RelatingObject is not IIfcElementAssembly asm) continue;
            int aid = asm.EntityLabel;
            if (!assemblyChildren.TryGetValue(aid, out var kids))
            {
                kids = new List<int>();
                assemblyChildren[aid] = kids;
            }
            foreach (var ro in rel.RelatedObjects)
            {
                if (ro is not IIfcProduct p) continue;
                if (IsFastener(p)) continue;
                kids.Add(p.EntityLabel);
                childToAssembly[p.EntityLabel] = aid;
            }
        }

        var structural = model.Instances.OfType<IIfcProduct>()
            .Where(IsStructuralProduct)
            .Where(p => !IsFastener(p))
            .ToList();

        // Decide which products need mesh extract (phase-scoped when filtered)
        var neededLabels = new HashSet<int>();
        var asmInclude = new HashSet<int>();
        var looseInclude = new HashSet<int>();

        foreach (var asm in model.Instances.OfType<IIfcElementAssembly>())
        {
            assemblyChildren.TryGetValue(asm.EntityLabel, out var kids);
            kids ??= new List<int>();
            var tags = new HashSet<double>();
            CollectPhaseTags(PsetsOf(asm), tags, out bool untagged);
            bool includeAll = untagged;
            foreach (var kid in kids.Distinct())
            {
                if (model.Instances[kid] is not IIfcProduct prod || IsFastener(prod)) continue;
                CollectPhaseTags(PsetsOf(prod), tags, out bool ku);
                if (ku) includeAll = true;
            }
            if (!PhaseSelectionMatches(tags, includeAll, phaseFilter)) continue;
            asmInclude.Add(asm.EntityLabel);
            if (kids.Count == 0) neededLabels.Add(asm.EntityLabel);
            else foreach (var kid in kids) neededLabels.Add(kid);
        }

        var usedAsChild = new HashSet<int>(childToAssembly.Keys);
        foreach (var prod in structural)
        {
            if (prod is IIfcElementAssembly) continue;
            if (usedAsChild.Contains(prod.EntityLabel)) continue;
            var tags = new HashSet<double>();
            CollectPhaseTags(PsetsOf(prod), tags, out bool untagged);
            if (!PhaseSelectionMatches(tags, untagged, phaseFilter)) continue;
            looseInclude.Add(prod.EntityLabel);
            neededLabels.Add(prod.EntityLabel);
        }

        var context = new Xbim3DModelContext(model);
        context.CreateContext(null, false);

        var worldMeshes = BuildWorldMeshes(context, toMm, neededLabels);

        var items = new List<SteelItem>();
        int skipped = 0;
        var allPhaseTags = new HashSet<double>();

        foreach (var asm in model.Instances.OfType<IIfcElementAssembly>())
        {
            if (!asmInclude.Contains(asm.EntityLabel)) continue;

            if (!assemblyChildren.TryGetValue(asm.EntityLabel, out var kids) || kids.Count == 0)
            {
                if (worldMeshes.ContainsKey(asm.EntityLabel))
                {
                    var single = BuildSingleItem(asm, worldMeshes, PsetsOf);
                    if (single != null)
                    {
                        TryConvertSagRodAssy(single);
                        foreach (var t in single.PhaseTags) allPhaseTags.Add(t);
                        items.Add(single);
                    }
                    else skipped++;
                }
                else skipped++;
                continue;
            }

            var partMeshes = new List<(IIfcProduct Prod, List<double> Pos, List<int> Idx)>();
            foreach (var kid in kids.Distinct())
            {
                if (model.Instances[kid] is not IIfcProduct prod) continue;
                if (IsFastener(prod)) continue;
                if (!worldMeshes.TryGetValue(kid, out var mesh)) continue;
                partMeshes.Add((prod, mesh.Pos, mesh.Idx));
            }

            if (partMeshes.Count == 0)
            {
                skipped++;
                continue;
            }

            var item = BuildAssemblyItem(asm, partMeshes, PsetsOf);
            TryConvertSagRodAssy(item);
            foreach (var t in item.PhaseTags) allPhaseTags.Add(t);
            items.Add(item);
        }

        foreach (var prod in structural)
        {
            if (!looseInclude.Contains(prod.EntityLabel)) continue;
            if (!worldMeshes.TryGetValue(prod.EntityLabel, out _))
            {
                skipped++;
                continue;
            }

            var single = BuildSingleItem(prod, worldMeshes, PsetsOf);
            if (single != null)
            {
                TryConvertSagRodAssy(single);
                foreach (var t in single.PhaseTags) allPhaseTags.Add(t);
                items.Add(single);
            }
            else skipped++;
        }

        var phaseCounts = allPhaseTags
            .OrderBy(p => p)
            .Select(p => (Phase: p, Count: items.Count(i => ItemMatchesPhase(i, p))))
            .ToList();

        return new IfcLoadResult
        {
            Job = new JobInfo
            {
                JobNo = jobNo,
                BldgNo = "",
                PhaseNo = phaseFilter.HasValue
                    ? phaseFilter.Value.ToString("0", CultureInfo.InvariantCulture)
                    : "ALL",
                Customer = ""
            },
            AllItems = items,
            Skipped = skipped,
            PhaseCounts = phaseCounts
        };
    }

    private static bool PhaseSelectionMatches(HashSet<double> tags, bool includeAll, double? phaseFilter)
    {
        if (!phaseFilter.HasValue) return true;
        if (includeAll) return true;
        foreach (var t in tags)
            if (Math.Abs(t - phaseFilter.Value) < 0.01) return true;
        return false;
    }

    public static (JobInfo job, List<SteelItem> items, int skipped) ApplyPhaseFilter(
        IfcLoadResult loaded, double? phaseFilter)
    {
        var job = new JobInfo
        {
            JobNo = loaded.Job.JobNo,
            BldgNo = loaded.Job.BldgNo,
            Customer = loaded.Job.Customer,
            PhaseNo = phaseFilter.HasValue
                ? phaseFilter.Value.ToString("0", CultureInfo.InvariantCulture)
                : "ALL"
        };

        if (!phaseFilter.HasValue)
            return (job, loaded.AllItems, loaded.Skipped);

        // When LoadGeometry already scoped to phase, items are already filtered.
        var filtered = loaded.AllItems.Where(i => ItemMatchesPhase(i, phaseFilter.Value)).ToList();
        return (job, filtered, loaded.Skipped);
    }

    public static bool ItemMatchesPhase(SteelItem item, double phase)
    {
        if (item.IncludeInAllPhases) return true;
        for (int i = 0; i < item.PhaseTags.Count; i++)
        {
            if (Math.Abs(item.PhaseTags[i] - phase) < 0.01) return true;
        }
        return false;
    }

    // ── Builders ──────────────────────────────────────────────────────────

    private static SteelItem BuildAssemblyItem(
        IIfcElementAssembly asm,
        List<(IIfcProduct Prod, List<double> Pos, List<int> Idx)> partMeshes,
        Func<IIfcObject, List<(string Key, object? Val)>> psetsOf)
    {
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

        var psets = psetsOf(asm);
        string mark = PickMark(asm, psets);
        string name = asm.Name?.ToString() ?? "ASSEMBLY";
        string profile = PickProfile(asm, psets);
        double estimateKg = EstimateSteelWeightKg(union);
        double weight = PickWeight(asm, psets, estimateKg);

        var phaseTags = new HashSet<double>();
        CollectPhaseTags(psets, phaseTags, out bool asmUntagged);
        bool includeAll = asmUntagged;
        foreach (var (prod, _, _) in partMeshes)
        {
            CollectPhaseTags(psetsOf(prod), phaseTags, out bool kidUntagged);
            if (kidUntagged) includeAll = true;
        }

        var parts = new List<AssemblyPart>();
        foreach (var (prod, ifcPos, idx) in partMeshes)
        {
            parts.Add(MakePartFromMesh(prod, ifcPos, idx, asmCx, asmCy, asmCz, psetsOf));
        }

        bool weightEst = !(weight > 0);
        if (weightEst)
            weight = estimateKg;

        double envL = Math.Max(1, union.MaxX - union.MinX);
        double envH = Math.Max(1, union.MaxZ - union.MinZ);
        double envW = Math.Max(1, union.MaxY - union.MinY);
        string remarks = $"[xBIM assembly ×{parts.Count} parts; L={envL:0} H={envH:0} W={envW:0}]";
        var item = new SteelItem
        {
            AssmMark = string.IsNullOrWhiteSpace(mark) ? $"{name}-{asm.EntityLabel}" : mark,
            Qty = 1,
            AssemblyName = name,
            LengthMm = envL,
            HeightMm = envH,
            WidthMm = envW,
            UnitWeightKg = weight,
            TotalWeightKg = weight,
            ProfileDesc = profile,
            Section = ProfileDescParser.Parse(profile),
            WeightEstimated = weightEst,
            IsAssembly = true,
            Parts = parts,
            PhaseTags = phaseTags.OrderBy(x => x).ToList(),
            IncludeInAllPhases = includeAll,
            SurfaceTreatment = PickSurface(psets, profile, remarks),
            Destination = PickDestination(psets, phaseTags),
            SpecialHandling = PickSpecialHandling(psets, remarks, profile),
            Remarks = remarks
        };
        IfcAssemblyReader.ApplyShippingDimsFromParts(item, parts, envL, envW, envH, 0);
        return item;
    }

    private static SteelItem? BuildSingleItem(
        IIfcProduct prod,
        Dictionary<int, (List<double> Pos, List<int> Idx)> worldMeshes,
        Func<IIfcObject, List<(string Key, object? Val)>> psetsOf)
    {
        if (!worldMeshes.TryGetValue(prod.EntityLabel, out var mesh)) return null;
        var b = BoundsOf(mesh.Pos);
        double cx = 0.5 * (b.MinX + b.MaxX);
        double cy = 0.5 * (b.MinY + b.MaxY);
        double cz = 0.5 * (b.MinZ + b.MaxZ);

        var psets = psetsOf(prod);
        var part = MakePartFromMesh(prod, mesh.Pos, mesh.Idx, cx, cy, cz, psetsOf);
        string mark = PickMark(prod, psets);
        string name = prod.Name?.ToString() ?? prod.GetType().Name;
        string profile = PickProfile(prod, psets);
        double estimateKg = EstimateSteelWeightKg(b);
        double weight = PickWeight(prod, psets, estimateKg);
        bool weightEst = !(weight > 0);
        if (weightEst) weight = estimateKg;

        var phaseTags = new HashSet<double>();
        CollectPhaseTags(psets, phaseTags, out bool untagged);

        double len = Math.Max(1, b.MaxX - b.MinX);
        double hei = Math.Max(1, b.MaxZ - b.MinZ);
        double wid = Math.Max(1, b.MaxY - b.MinY);

        string remarks = $"[xBIM product mesh; L={len:0} H={hei:0} W={wid:0}]";
        return new SteelItem
        {
            AssmMark = string.IsNullOrWhiteSpace(mark) ? $"{name}-{prod.EntityLabel}" : mark,
            Qty = 1,
            AssemblyName = name,
            LengthMm = len,
            HeightMm = hei,
            WidthMm = wid,
            UnitWeightKg = weight,
            TotalWeightKg = weight,
            ProfileDesc = profile,
            Section = ProfileDescParser.Parse(profile),
            WeightEstimated = weightEst,
            IsAssembly = true,
            Parts = new List<AssemblyPart> { part },
            PhaseTags = phaseTags.OrderBy(x => x).ToList(),
            IncludeInAllPhases = untagged,
            SurfaceTreatment = PickSurface(psets, profile, remarks),
            Destination = PickDestination(psets, phaseTags),
            SpecialHandling = PickSpecialHandling(psets, remarks, profile),
            Remarks = remarks
        };
    }

    private static AssemblyPart MakePartFromMesh(
        IIfcProduct prod,
        List<double> ifcPos,
        List<int> idx,
        double asmCx, double asmCy, double asmCz,
        Func<IIfcObject, List<(string Key, object? Val)>>? psetsOf = null)
    {
        var partB = BoundsOf(ifcPos);
        var threePos = new List<double>(ifcPos.Count);
        for (int i = 0; i + 2 < ifcPos.Count; i += 3)
        {
            double ix = ifcPos[i] - asmCx;
            double iy = ifcPos[i + 1] - asmCy;
            double iz = ifcPos[i + 2] - asmCz;
            threePos.Add(ix);
            threePos.Add(iz);
            threePos.Add(iy);
        }

        double pMinX = partB.MinX - asmCx, pMaxX = partB.MaxX - asmCx;
        double pMinY = partB.MinZ - asmCz, pMaxY = partB.MaxZ - asmCz;
        double pMinZ = partB.MinY - asmCy, pMaxZ = partB.MaxY - asmCy;

        var ext = new[] {
            Math.Max(1, pMaxX - pMinX),
            Math.Max(1, pMaxY - pMinY),
            Math.Max(1, pMaxZ - pMinZ)
        }.OrderByDescending(v => v).ToArray();

        var psets = psetsOf != null ? psetsOf(prod) : ReadPsetValues(prod);
        string profile = PickProfile(prod, psets);
        string name = prod.Name?.ToString() ?? "";
        string partKind = GuessPartKind(name, profile, prod);

        return new AssemblyPart
        {
            Name = name,
            IfcType = prod.GetType().Name,
            ProfileDesc = profile,
            Section = ProfileDescParser.Parse(profile),
            LengthMm = ext[0],
            HeightMm = ext[1],
            WidthMm = ext[2],
            OffsetXMm = 0.5 * (pMinX + pMaxX),
            OffsetYMm = 0.5 * (pMinY + pMaxY),
            OffsetZMm = 0.5 * (pMinZ + pMaxZ),
            BoxXMm = Math.Max(1, pMaxX - pMinX),
            BoxYMm = Math.Max(1, pMaxY - pMinY),
            BoxZMm = Math.Max(1, pMaxZ - pMinZ),
            HasIfcTransform = false,
            Transform = Array.Empty<double>(),
            PartKind = partKind,
            ThicknessMm = ext[2] <= 80 ? ext[2] : 0,
            IfcEntityId = prod.EntityLabel,
            MeshPositionsMm = threePos,
            MeshIndices = new List<int>(idx),
            ProfilePointsMm = new List<double[]>(),
        };
    }

    // ── Geometry ──────────────────────────────────────────────────────────

    private static Dictionary<int, (List<double> Pos, List<int> Idx)> BuildWorldMeshes(
        Xbim3DModelContext context, double toMm, HashSet<int>? onlyLabels = null)
    {
        var byProduct = new Dictionary<int, List<(XbimShapeInstance Inst, byte Prefer)>>();
        foreach (var instance in context.ShapeInstances())
        {
            int label = instance.IfcProductLabel;
            if (onlyLabels != null && !onlyLabels.Contains(label)) continue;
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

        var world = new Dictionary<int, (List<double> Pos, List<int> Idx)>();
        foreach (var kvp in byProduct)
        {
            int best = kvp.Value.Max(x => x.Prefer);
            var accPos = new List<double>();
            var accIdx = new List<int>();
            foreach (var inst in kvp.Value.Where(x => x.Prefer == best).Select(x => x.Inst))
                AppendInstanceMesh(context, inst, accPos, accIdx, toMm);
            if (accPos.Count >= 9 && accIdx.Count >= 3)
                world[kvp.Key] = (accPos, accIdx);
        }
        return world;
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
            // 0.1 mm quantize — smaller JSON, no visible steel difference
            accPos.Add(Math.Round(p.X * toMm, 1));
            accPos.Add(Math.Round(p.Y * toMm, 1));
            accPos.Add(Math.Round(p.Z * toMm, 1));
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

    // ── Classification / properties ───────────────────────────────────────

    private static bool IsStructuralProduct(IIfcProduct p) =>
        p is IIfcElementAssembly
        or IIfcBeam or IIfcColumn or IIfcMember or IIfcPlate
        or IIfcBuildingElementProxy
        or IIfcFooting or IIfcRailing
        or IIfcDiscreteAccessory;

    private static bool IsFastener(IIfcProduct p)
    {
        if (p is IIfcMechanicalFastener) return true;
        string n = $"{p.Name} {p.GetType().Name}".ToUpperInvariant();
        return n.Contains("BOLT") || n.Contains("NUT") || n.Contains("WASHER") || n.Contains("SCREW");
    }

    private static string GuessPartKind(string name, string profile, IIfcProduct prod)
    {
        string s = $"{name} {profile}".ToUpperInvariant();
        // Flange brace / angle brace = L member, not a built-up plate flange
        if (System.Text.RegularExpressions.Regex.IsMatch(s,
                @"FLANGE[_\s-]*BRACE|ANGLE[_\s-]*BRACE|L[_\s-]*BRACE|L_?ANGLE|EQUAL\s*ANGLE"))
            return "other";
        if (s.Contains("WEB") || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bWB\d")) return "web";
        if (System.Text.RegularExpressions.Regex.IsMatch(s, @"\bFL\d")
            || (s.Contains("FLANGE") && !s.Contains("BRACE")))
            return "flange";
        if (s.Contains("STIFF") || s.Contains("END_PLT") || System.Text.RegularExpressions.Regex.IsMatch(s, @"\b(EP|BP|ST|PL)\d"))
            return "stiff";
        if (prod is IIfcPlate) return "plate";
        return "other";
    }

    private static void CollectPhaseTags(
        List<(string Key, object? Val)> psets,
        HashSet<double> tags,
        out bool untagged)
    {
        bool sawPhaseKey = false;
        foreach (var (key, val) in psets)
        {
            if (!key.Equals("PHASE", StringComparison.OrdinalIgnoreCase)
                && !key.Equals("Phase", StringComparison.OrdinalIgnoreCase))
                continue;
            sawPhaseKey = true;
            if (TryToDouble(val, out var d)) tags.Add(d);
        }
        untagged = !sawPhaseKey;
    }

    private static List<(string Key, object? Val)> ReadPsetValues(IIfcObject obj)
    {
        var list = new List<(string, object?)>();
        try
        {
            foreach (var rel in obj.IsDefinedBy.OfType<IIfcRelDefinesByProperties>())
            {
                if (rel.RelatingPropertyDefinition is not IIfcPropertySet pset) continue;
                foreach (var prop in pset.HasProperties.OfType<IIfcPropertySingleValue>())
                {
                    string key = prop.Name.ToString() ?? "";
                    object? val = prop.NominalValue?.Value;
                    list.Add((key, val));
                }
            }
        }
        catch { /* some IFCs have broken pset links */ }
        return list;
    }

    private static string PickMark(IIfcObject obj, List<(string Key, object? Val)> psets)
    {
        foreach (var key in new[] { "ASSEMBLY_MARK", "AssemblyMark", "MARK", "Mark", "REFERENCE", "TAG" })
        {
            var hit = psets.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (hit.Val != null && !string.IsNullOrWhiteSpace(hit.Val.ToString()))
                return hit.Val.ToString()!.Trim();
        }
        return obj.Name?.ToString()?.Trim() ?? "";
    }

    private static string PickProfile(IIfcProduct prod, List<(string Key, object? Val)> psets)
    {
        foreach (var key in new[] { "PROFILE", "Profile", "SECTION_NAME", "Section", "Description" })
        {
            var hit = psets.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (hit.Val != null && !string.IsNullOrWhiteSpace(hit.Val.ToString()))
                return hit.Val.ToString()!.Trim();
        }
        // Tekla often puts section in Description / ObjectType
        string? desc = prod.Description?.ToString();
        if (!string.IsNullOrWhiteSpace(desc)) return desc.Trim();
        try
        {
            if (prod is IIfcElement el && !string.IsNullOrWhiteSpace(el.ObjectType?.ToString()))
                return el.ObjectType!.ToString()!.Trim();
        }
        catch { }
        return "";
    }

    /// <summary>
    /// Read IFC mass and normalize to kilograms.
    /// Tekla exports often store grams (e.g. 47356 g → 47.356 kg) with no unit label.
    /// Uses explicit unit when present; otherwise picks among raw /÷1000 /×1000
    /// whichever best matches the bbox steel estimate.
    /// </summary>
    private static double PickWeight(
        IIfcObject? obj,
        List<(string Key, object? Val)> psets,
        double estimateKg = 0)
    {
        // 1) Prefer typed property + Unit from the object
        if (obj != null)
        {
            try
            {
                foreach (var rel in obj.IsDefinedBy.OfType<IIfcRelDefinesByProperties>())
                {
                    if (rel.RelatingPropertyDefinition is not IIfcPropertySet pset) continue;
                    foreach (var prop in pset.HasProperties.OfType<IIfcPropertySingleValue>())
                    {
                        string key = prop.Name.ToString() ?? "";
                        if (!IsWeightPropertyKey(key)) continue;
                        object? nom = prop.NominalValue?.Value;
                        if (nom == null) continue;
                        if (!TryToDouble(nom, out var w) || w <= 0) continue;
                        string? unit = FormatIfcUnit(prop.Unit);
                        return NormalizeMassToKg(w, unit, estimateKg);
                    }
                }
            }
            catch { /* broken pset links */ }
        }

        // 2) Fallback: flat pset list (+ optional WEIGHT_UNIT hint)
        string? unitHint = null;
        foreach (var (key, val) in psets)
        {
            if (val == null) continue;
            if (key.Contains("WEIGHT_UNIT", StringComparison.OrdinalIgnoreCase)
                || key.Equals("MassUnit", StringComparison.OrdinalIgnoreCase)
                || key.Equals("UNIT", StringComparison.OrdinalIgnoreCase))
            {
                unitHint = val.ToString();
                break;
            }
        }

        foreach (var (key, val) in psets)
        {
            if (val == null || !IsWeightPropertyKey(key)) continue;
            if (!TryToDouble(val, out var w) || w <= 0) continue;
            return NormalizeMassToKg(w, unitHint, estimateKg);
        }
        return 0;
    }

    private static bool IsWeightPropertyKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return false;
        if (key.Contains("WEIGHT_UNIT", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var k in new[] {
            "Weight", "WEIGHT", "NetWeight", "GrossWeight",
            "Assembly/Cast unit weight", "Assembly Weight", "Mass" })
        {
            if (key.Equals(k, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return key.Contains("weight", StringComparison.OrdinalIgnoreCase)
            && !key.Contains("unit", StringComparison.OrdinalIgnoreCase);
    }

    private static string? FormatIfcUnit(IIfcUnit? unit)
    {
        if (unit == null) return null;
        try
        {
            if (unit is IIfcSIUnit si)
            {
                // KILOGRAM → "kg"; bare GRAM → "g"; etc.
                string name = si.Name.ToString();
                if (name.Equals("GRAM", StringComparison.OrdinalIgnoreCase))
                {
                    if (si.Prefix.HasValue
                        && si.Prefix.Value.ToString().Equals("KILO", StringComparison.OrdinalIgnoreCase))
                        return "kg";
                    return "g";
                }
                string prefix = si.Prefix.HasValue ? si.Prefix.Value.ToString() : "";
                return string.IsNullOrEmpty(prefix) ? name : $"{prefix}_{name}";
            }
            return unit.ToString();
        }
        catch { return null; }
    }

    /// <summary>
    /// Convert raw IFC mass number → kg. Explicit unit wins; else estimate-guided.
    /// Example: Tekla 47356 (g) + rod estimate ~40 kg → 47.356 kg.
    /// </summary>
    internal static double NormalizeMassToKg(double raw, string? unitHint, double estimateKg = 0)
    {
        if (!(raw > 0) || double.IsNaN(raw) || double.IsInfinity(raw)) return 0;

        string u = (unitHint ?? "").Trim().ToLowerInvariant();
        if (u.Length > 0)
        {
            if (u == "kg" || u.Contains("kilogram") || u == "kilo_gram" || u.Contains("kilo_gram"))
                return raw;
            if (u == "g" || u == "gram" || u.Contains("gramme")
                || (u.Contains("gram") && !u.Contains("kilo") && !u.Contains("kg")))
                return raw / 1000.0;
            if (u.Contains("tonne") || u == "t" || u.Contains("metric ton")
                || (u.Contains("ton") && !u.Contains("newton")))
                return raw * 1000.0;
        }

        const double maxUnitKg = 26000; // container payload — one placeable unit cannot exceed
        double asG = raw / 1000.0;
        double asT = raw * 1000.0;

        // Hard: raw already heavier than a full container → grams
        if (raw > maxUnitKg && asG >= 0.05 && asG <= maxUnitKg)
            return asG;

        // Estimate-guided (cap estimate — fat assembly AABB must not “prove” tonnes)
        if (estimateKg >= 1.0)
        {
            double estUse = Math.Min(estimateKg, 5000);
            double best = raw;
            double bestScore = double.PositiveInfinity;
            foreach (double c in new[] { raw, asG, asT })
            {
                if (c < 0.05 || c > maxUnitKg) continue;
                double ratio = c / estUse;
                if (ratio < 0.05 || ratio > 25) continue;
                double score = Math.Abs(Math.Log(ratio));
                if (score < bestScore)
                {
                    bestScore = score;
                    best = c;
                }
            }
            if (!double.IsPositiveInfinity(bestScore))
                return best;

            // Light section estimate + huge raw → grams (rod/plate)
            if (estUse < 500 && raw >= 5000 && asG >= 0.5 && asG <= 5000)
                return asG;
        }

        if (raw > 100_000) return asG;
        if (raw < 0.05) return asT;
        return raw;
    }

    private static string PickSurface(List<(string Key, object? Val)> psets, string profile, string remarks)
    {
        foreach (var key in new[] {
            "SURFACE", "Surface", "FINISH", "Finish", "COATING", "Coating",
            "SURFACE_TREATMENT", "SurfaceTreatment", "FINISH_TYPE" })
        {
            var hit = psets.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (hit.Val != null && !string.IsNullOrWhiteSpace(hit.Val.ToString()))
                return ProfileDescParser.DetectSurface(hit.Val.ToString(), null);
        }
        return ProfileDescParser.DetectSurface(profile, remarks);
    }

    private static string PickDestination(List<(string Key, object? Val)> psets, HashSet<double> phaseTags)
    {
        foreach (var key in new[] {
            "BUILDING", "Building", "BLDG", "SHIP_TO", "ShipTo", "DESTINATION",
            "Destination", "SITE", "USER_FIELD_1", "UserField1", "UDA_BUILDING" })
        {
            var hit = psets.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (hit.Val != null && !string.IsNullOrWhiteSpace(hit.Val.ToString()))
                return hit.Val.ToString()!.Trim().ToUpperInvariant();
        }
        if (phaseTags.Count > 0)
            return "PHASE-" + string.Join("+", phaseTags.OrderBy(x => x).Select(p => p.ToString("0.##")));
        return "";
    }

    private static bool PickSpecialHandling(List<(string Key, object? Val)> psets, string remarks, string profile)
    {
        foreach (var key in new[] {
            "SPECIAL_HANDLING", "SpecialHandling", "FRAGILE", "Fragile",
            "USER_FIELD_2", "UserField2", "COMMENT", "Comment" })
        {
            var hit = psets.FirstOrDefault(p => p.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (hit.Val == null) continue;
            string v = hit.Val.ToString() ?? "";
            if (hit.Key.Contains("FRAGILE", StringComparison.OrdinalIgnoreCase)
                && (v.Equals("true", StringComparison.OrdinalIgnoreCase) || v == "1" || v.Equals("yes", StringComparison.OrdinalIgnoreCase)))
                return true;
            if (ProfileDescParser.DetectSpecialHandling(v, null)) return true;
        }
        return ProfileDescParser.DetectSpecialHandling(remarks, profile);
    }

    private static double EstimateSteelWeightKg(Bounds3 b)
    {
        double volM3 = Math.Max(0, (b.MaxX - b.MinX) * (b.MaxY - b.MinY) * (b.MaxZ - b.MinZ)) / 1e9;
        // Thin-walled fill factor ~8% of bbox for cold-formed / plates mixed
        return volM3 * 7850.0 * 0.08;
    }

    private static double ResolveToMm(IfcStore model)
    {
        try
        {
            double oneMeter = model.ModelFactors.OneMeter;
            if (oneMeter > 1e-9) return 1000.0 / oneMeter;
        }
        catch { }
        return 1.0;
    }

    private static bool TryToDouble(object? val, out double d)
    {
        d = 0;
        if (val == null) return false;
        if (val is double dd) { d = dd; return true; }
        if (val is float f) { d = f; return true; }
        if (val is int i) { d = i; return true; }
        if (val is long l) { d = l; return true; }
        return double.TryParse(val.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d);
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

    /// <summary>
    /// SAG_ROD_ASSY only: replace faceted IFC mesh with exact bent-rod tube path.
    /// Other items untouched.
    /// </summary>
    private static void TryConvertSagRodAssy(SteelItem item)
    {
        if (item == null) return;
        if (!IfcAssemblyReader.IsBentSagRodName(item.AssemblyName, item.ProfileDesc)
            && !IfcAssemblyReader.IsBentSagRodName(item.AssmMark, item.AssemblyName)
            && !IfcAssemblyReader.IsBentSagRodName(item.AssmMark, item.ProfileDesc))
            return;

        double diam = item.PathDiamMm;
        if (!(diam > 0) && item.Section != null
            && item.Section.ShapeKey is "rod" or "bent_sag_rod"
            && item.Section.H > 0 && item.Section.H <= 40)
            diam = item.Section.H;

        var rodM = System.Text.RegularExpressions.Regex.Match(
            $"{item.ProfileDesc} {item.AssemblyName} {item.AssmMark}",
            @"ROD\s*(\d+(?:\.\d+)?)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!(diam > 0) && rodM.Success)
            diam = double.Parse(rodM.Groups[1].Value, CultureInfo.InvariantCulture);

        List<(double X, double Y, double Z)> path;
        if (item.PathPointsMm.Count >= 3)
        {
            path = item.PathPointsMm
                .Where(p => p != null && p.Length >= 3)
                .Select(p => (p[0], p[1], p[2]))
                .ToList();
        }
        else
        {
            var verts = new List<(double X, double Y, double Z)>();
            foreach (var part in item.Parts)
            {
                var pos = part.MeshPositionsMm;
                if (pos == null || pos.Count < 9) continue;
                for (int i = 0; i + 2 < pos.Count; i += 3)
                    verts.Add((pos[i], pos[i + 1], pos[i + 2]));
            }
            path = CenterlineFromMeshVerts(verts, out double meshDiam);
            if (meshDiam > 0 && !(diam > 0)) diam = meshDiam;
        }

        if (path.Count < 3)
        {
            if (!(diam > 0))
            {
                var dims = new[] { item.LengthMm, item.WidthMm, item.HeightMm }
                    .Where(v => v > 0).OrderBy(v => v).ToArray();
                diam = dims.Length > 0 && dims[0] <= 40 ? dims[0] : 12;
            }
            diam = Math.Max(6, Math.Min(diam, 40));
            path = DoglegSagRodPath(item.LengthMm, item.WidthMm, item.HeightMm, diam);
        }
        else
        {
            if (!(diam > 0))
            {
                var dims = new[] { item.LengthMm, item.WidthMm, item.HeightMm }
                    .Where(v => v > 0).OrderBy(v => v).ToArray();
                diam = dims.Length > 0 && dims[0] <= 40 ? dims[0] : 12;
            }
            diam = Math.Max(6, Math.Min(diam, 40));
            path = OrientSagRodPathVerticalEnd(path);
        }

        if (path.Count < 3) return;

        double minX = path.Min(p => p.X), maxX = path.Max(p => p.X);
        double minY = path.Min(p => p.Y), maxY = path.Max(p => p.Y);
        double minZ = path.Min(p => p.Z), maxZ = path.Max(p => p.Z);
        double cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;

        item.PathPointsMm = path
            .Select(p => new[] { p.X - cx, p.Y - cy, p.Z - cz })
            .ToList();
        item.PathDiamMm = diam;
        item.LengthMm = Math.Max(1, maxX - minX + diam);
        item.HeightMm = Math.Max(1, maxY - minY + diam);
        item.WidthMm = Math.Max(diam, maxZ - minZ + diam);
        item.IsAssembly = false;
        item.Parts.Clear();
        item.Section = new ProfileSection
        {
            ShapeKey = "bent_sag_rod",
            Raw = string.IsNullOrWhiteSpace(item.ProfileDesc) ? $"ROD{diam:0}" : item.ProfileDesc,
            H = diam,
            W = diam,
            T = diam,
        };
        item.Remarks += $" [SAG_ROD_ASSY exact bent ∅{diam:0} ×{item.PathPointsMm.Count}pts]";
    }

    /// <summary>Slice mesh along longest axis → centroids = rod centerline.</summary>
    private static List<(double X, double Y, double Z)> CenterlineFromMeshVerts(
        List<(double X, double Y, double Z)> verts, out double diamGuess)
    {
        diamGuess = 0;
        if (verts.Count < 24) return new List<(double, double, double)>();

        double minX = verts.Min(v => v.X), maxX = verts.Max(v => v.X);
        double minY = verts.Min(v => v.Y), maxY = verts.Max(v => v.Y);
        double minZ = verts.Min(v => v.Z), maxZ = verts.Max(v => v.Z);
        double sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
        // Thin cross-section ≈ diameter
        var sides = new[] { sx, sy, sz }.OrderBy(v => v).ToArray();
        if (sides[0] > 0.5 && sides[0] <= 45) diamGuess = sides[0];

        // Principal = longest bbox axis
        int axis = 0;
        double span = sx;
        if (sy >= span) { axis = 1; span = sy; }
        if (sz >= span) { axis = 2; span = sz; }
        if (span < 50) return new List<(double, double, double)>();

        const int nSlice = 28;
        var cents = new List<(double X, double Y, double Z)>();
        for (int i = 0; i < nSlice; i++)
        {
            double t0 = i / (double)nSlice;
            double t1 = (i + 1) / (double)nSlice;
            double a0 = (axis == 0 ? minX : axis == 1 ? minY : minZ) + span * t0;
            double a1 = (axis == 0 ? minX : axis == 1 ? minY : minZ) + span * t1;
            double sxSum = 0, sySum = 0, szSum = 0;
            int n = 0;
            foreach (var v in verts)
            {
                double a = axis == 0 ? v.X : axis == 1 ? v.Y : v.Z;
                if (a < a0 || a > a1) continue;
                sxSum += v.X; sySum += v.Y; szSum += v.Z;
                n++;
            }
            if (n < 3) continue;
            cents.Add((sxSum / n, sySum / n, szSum / n));
        }
        if (cents.Count < 3) return new List<(double, double, double)>();

        // Drop near-duplicate samples
        var simplified = new List<(double X, double Y, double Z)> { cents[0] };
        for (int i = 1; i < cents.Count; i++)
        {
            var a = simplified[^1];
            var b = cents[i];
            double d = Math.Sqrt(
                (a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y) + (a.Z - b.Z) * (a.Z - b.Z));
            if (d >= 8) simplified.Add(b);
        }
        if (simplified.Count >= 2)
        {
            var last = cents[^1];
            var prev = simplified[^1];
            double dEnd = Math.Sqrt(
                (prev.X - last.X) * (prev.X - last.X)
                + (prev.Y - last.Y) * (prev.Y - last.Y)
                + (prev.Z - last.Z) * (prev.Z - last.Z));
            if (dEnd >= 4) simplified.Add(last);
        }
        return simplified.Count >= 3 ? simplified : cents;
    }

    private static List<(double X, double Y, double Z)> OrientSagRodPathVerticalEnd(
        List<(double X, double Y, double Z)> raw)
    {
        if (raw.Count < 3) return raw;
        var corners = raw.ToList();
        double firstLen = Dist3(corners[0], corners[1]);
        double lastLen = Dist3(corners[^2], corners[^1]);
        if (firstLen < lastLen * 0.75) corners.Reverse();

        var p0 = corners[0];
        var pA = corners[^2];
        var pB = corners[^1];
        double ex = pB.X - pA.X, ey = pB.Y - pA.Y, ez = pB.Z - pA.Z;
        double eLen = Math.Sqrt(ex * ex + ey * ey + ez * ez);
        if (eLen < 1e-6) return corners;
        ex /= eLen; ey /= eLen; ez /= eLen;

        double bx = pA.X - p0.X, by = pA.Y - p0.Y, bz = pA.Z - p0.Z;
        double bLen = Math.Sqrt(bx * bx + by * by + bz * bz);
        if (bLen < 1e-6) return corners;
        bx /= bLen; by /= bLen; bz /= bLen;

        double yx = -ex, yy = -ey, yz = -ez;
        double dot = bx * yx + by * yy + bz * yz;
        double xx = bx - dot * yx, xy = by - dot * yy, xz = bz - dot * yz;
        double xLen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
        if (xLen < 1e-6)
        {
            if (Math.Abs(yy) < 0.9) { xx = 1; xy = 0; xz = 0; }
            else { xx = 0; xy = 0; xz = 1; }
            dot = xx * yx + xy * yy + xz * yz;
            xx -= dot * yx; xy -= dot * yy; xz -= dot * yz;
            xLen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
        }
        if (xLen < 1e-9) return corners;
        xx /= xLen; xy /= xLen; xz /= xLen;
        double zx = xy * yz - xz * yy;
        double zy = xz * yx - xx * yz;
        double zz = xx * yy - xy * yx;

        var mapped = corners.Select(p => (
            p.X * xx + p.Y * xy + p.Z * xz,
            p.X * yx + p.Y * yy + p.Z * yz,
            p.X * zx + p.Y * zy + p.Z * zz
        )).ToList();

        if (mapped[0].Item1 > mapped[^1].Item1)
            mapped = mapped.Select(p => (-p.Item1, p.Item2, p.Item3)).ToList();
        if (mapped[^1].Item2 > mapped[0].Item2)
            mapped = mapped.Select(p => (p.Item1, -p.Item2, p.Item3)).ToList();
        return mapped;
    }

    private static List<(double X, double Y, double Z)> DoglegSagRodPath(
        double lengthMm, double widthMm, double heightMm, double diam)
    {
        var dims = new[] { lengthMm, widthMm, heightMm }.Where(v => v > diam * 2).OrderByDescending(v => v).ToArray();
        double span = dims.Length > 0 ? dims[0] : Math.Max(lengthMm, diam * 20);
        double drop = dims.Length > 1 ? dims[1] : Math.Max(span * 0.7, diam * 18);
        if (drop <= diam * 2.5) drop = Math.Max(span * 0.7, diam * 18);
        double L1 = Math.Min(Math.Max(span * 0.14, diam * 8), span * 0.2);
        double L3 = Math.Min(Math.Max(drop * 0.28, diam * 8), drop * 0.4);
        double run = Math.Max(span - L1, span * 0.55);
        double rise = Math.Max(drop - L3, drop * 0.5);
        double a1 = 10 * Math.PI / 180.0;
        double y0 = L1 * Math.Sin(a1) + rise + L3;
        double x1 = L1 * Math.Cos(a1);
        double y1 = y0 - L1 * Math.Sin(a1);
        double x2 = x1 + run;
        return new List<(double, double, double)>
        {
            (0, y0, 0),
            (x1, y1, 0),
            (x2, L3, 0),
            (x2, 0, 0),
        };
    }

    private static double Dist3((double X, double Y, double Z) a, (double X, double Y, double Z) b)
    {
        double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
        return Math.Sqrt(dx * dx + dy * dy + dz * dz);
    }

    public static (JobInfo job, List<SteelItem> items, int skipped) ConvertWithFallback(
        string ifcPath, double? phaseFilter)
    {
        try
        {
            var loaded = LoadGeometry(ifcPath, phaseFilter);
            return (loaded.Job, loaded.AllItems, loaded.Skipped);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[XbimIfcIngest] failed, STEP fallback: {ex.Message}");
            return IfcAssemblyReader.Convert(ifcPath, phaseFilter);
        }
    }

    public static IfcLoadResult LoadAllWithFallback(string ifcPath)
    {
        try
        {
            return LoadGeometry(ifcPath, null);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[XbimIfcIngest] failed, STEP fallback: {ex.Message}");
            var (job, items, skipped) = IfcAssemblyReader.Convert(ifcPath, null);
            var tags = new HashSet<double>();
            foreach (var it in items)
            {
                foreach (var t in it.PhaseTags) tags.Add(t);
            }
            return new IfcLoadResult
            {
                Job = job,
                AllItems = items,
                Skipped = skipped,
                PhaseCounts = tags
                    .OrderBy(p => p)
                    .Select(p => (Phase: p, Count: items.Count(i => ItemMatchesPhase(i, p))))
                    .ToList()
            };
        }
    }

    public static List<double> ListPhasesWithFallback(string ifcPath)
    {
        try
        {
            var phases = ListPhases(ifcPath);
            if (phases.Count > 0) return phases;
        }
        catch { /* fall through */ }
        return IfcAssemblyReader.ListPhases(ifcPath);
    }
}

/// <summary>Fast phase scan (no tessellation).</summary>
public sealed class IfcPhaseScan
{
    public string JobNo { get; init; } = "";
    public List<(double Phase, int Count)> PhaseCounts { get; init; } = new();
    public int TotalCandidates { get; init; }
    public bool HasPhaseTags => PhaseCounts.Count > 0;
}

/// <summary>Result of a geometry ingest pass.</summary>
public sealed class IfcLoadResult
{
    public JobInfo Job { get; init; } = new();
    public List<SteelItem> AllItems { get; init; } = new();
    public int Skipped { get; init; }
    public List<(double Phase, int Count)> PhaseCounts { get; init; } = new();
    public bool HasPhaseTags => PhaseCounts.Count > 0;
}
