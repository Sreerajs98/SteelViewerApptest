using SteelPackingApp.Models;

namespace SteelPackingApp.Services;

/// <summary>
/// Reads a Tekla-exported IFC file directly (via StepParser - no xBIM, no
/// external IFC toolkit) and produces the same List&lt;SteelItem&gt; the
/// Excel-based flow produces, so it can go through the exact same
/// SceneBuilder/packing/3D-view pipeline afterwards.
///
/// What this looks for, per real shippable assembly (IfcElementAssembly):
///   - "ACERO_DATA" property set  -> ASSEMBLY_MARK, ASSEMBLY_NAME, PHASE
///   - "Tekla Assembly" property set -> "Assembly/Cast unit weight" (the
///     real total weight, already including welded-on plates/stiffeners)
///   - Its main structural part's "Tekla Quantity" property set -> real
///     Height/Width/Length in mm, computed by Tekla itself.
/// Bolts/washers (IfcMechanicalFastener) are skipped when picking the main
/// part - they ship attached to the assembly, not as separate pieces.
///
/// One IFC file can span an entire building across MULTIPLE phases (unlike
/// a Shipping List Excel, which is already scoped to one phase) - call
/// ListPhases first and let the person pick which phase they're shipping.
/// </summary>
public static class IfcAssemblyReader
{
    private class PropertySet
    {
        public string Name = "";
        public Dictionary<string, object?> Props = new();
    }

    public static List<double> ListPhases(string ifcPath)
    {
        var entities = StepParser.TokenizeEntities(File.ReadAllText(ifcPath));
        var (psets, entityToPsets, _) = BuildIndices(entities);

        var phases = new HashSet<double>();

        void TryAddPhase(Dictionary<string, object?> props)
        {
            foreach (var key in new[] { "PHASE", "Phase", "phase" })
            {
                if (!props.TryGetValue(key, out var ph)) continue;
                if (ph is double d) { phases.Add(d); return; }
                if (ph is int i) { phases.Add(i); return; }
                if (ph is string s && double.TryParse(s, out var parsed)) { phases.Add(parsed); return; }
            }
        }

        // Assemblies (Tekla) + any entity that carries a PHASE property
        foreach (var kvp in entities)
        {
            var type = kvp.Value.Type;
            bool isAsm = type == "IFCELEMENTASSEMBLY";
            bool isLoose = type is "IFCBEAM" or "IFCCOLUMN" or "IFCMEMBER" or "IFCPLATE"
                or "IFCBUILDINGELEMENTPROXY";
            if (!isAsm && !isLoose) continue;

            var acero = GetPsetByName(kvp.Key, "ACERO_DATA", entityToPsets, psets);
            TryAddPhase(acero);

            if (entityToPsets.TryGetValue(kvp.Key, out var pids))
            {
                foreach (var pid in pids)
                {
                    if (!psets.TryGetValue(pid, out var pset)) continue;
                    TryAddPhase(pset.Props);
                }
            }
        }
        return phases.OrderBy(x => x).ToList();
    }

    public static (JobInfo job, List<SteelItem> items, int skippedNoMainPart) Convert(string ifcPath, double? phaseFilter)
    {
        string text = File.ReadAllText(ifcPath);
        var entities = StepParser.TokenizeEntities(text);
        var (psets, entityToPsets, entityToParts) = BuildIndices(entities);

        string jobNo = "";
        foreach (var kvp in entities)
        {
            if (kvp.Value.Type != "IFCPROJECT") continue;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            if (args.Count > 2) jobNo = StepParser.Unwrap(args[2]) as string ?? "";
            break;
        }

        var items = new List<SteelItem>();
        int skipped = 0;

        // Different Tekla export configurations name property sets slightly
        // differently. Rather than assume one fixed set of names, each piece
        // of data is looked up through a short list of candidates, in order
        // of how reliable/specific they are - the first one that actually
        // has a value wins.
        string[] markCommonPsets = { "Pset_ColumnCommon", "Pset_BeamCommon", "Pset_MemberCommon", "Pset_PlateCommon" };

        foreach (var kvp in entities)
        {
            if (kvp.Value.Type != "IFCELEMENTASSEMBLY") continue;
            int eid = kvp.Key;

            var acero = GetPsetByName(eid, "ACERO_DATA", entityToPsets, psets);
            var teklaAsm = GetPsetByName(eid, "Tekla Assembly", entityToPsets, psets);

            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            string? nameAttr = args.Count > 2 ? StepParser.Unwrap(args[2]) as string : null;

            double? phase = (acero.TryGetValue("PHASE", out var phObj) && phObj is double phd) ? phd : null;
            if (phaseFilter.HasValue && phase != phaseFilter.Value) continue;

            var partIds = entityToParts.TryGetValue(eid, out var pl) ? pl : new List<int>();
            var nonFastenerParts = partIds
                .Where(pid => entities.TryGetValue(pid, out var p) && p.Type != "IFCMECHANICALFASTENER")
                .ToList();

            // --- Mark: ACERO_DATA -> Tekla Assembly mark -> a part's own
            // "Reference" property (Pset_*Common) -> the assembly's own Name
            // attribute -> entity id as a last resort so nothing is silently
            // dropped just because it lacks a mark.
            string? mark = (acero.TryGetValue("ASSEMBLY_MARK", out var m1) ? m1 as string : null)
                ?? (teklaAsm.TryGetValue("Assembly/Cast unit Mark", out var m2) ? m2 as string : null);

            if (string.IsNullOrWhiteSpace(mark))
            {
                foreach (var pid in nonFastenerParts)
                {
                    foreach (var psetName in markCommonPsets)
                    {
                        var pset = GetPsetByName(pid, psetName, entityToPsets, psets);
                        if (pset.TryGetValue("Reference", out var refVal) && refVal is string refStr && !string.IsNullOrWhiteSpace(refStr))
                        {
                            mark = refStr;
                            break;
                        }
                    }
                    if (mark != null) break;
                }
            }
            mark ??= nameAttr ?? $"ASM-{eid}";

            string name = (acero.TryGetValue("ASSEMBLY_NAME", out var n1) ? n1 as string : null)
                ?? nameAttr ?? "UNKNOWN";

            // --- Weight: assembly-level total -> sum of each part's own
            // weight (Tekla Quantity, then BaseQuantities) as a fallback so
            // a missing assembly-level rollup doesn't zero out the weight.
            double weight = (teklaAsm.TryGetValue("Assembly/Cast unit weight", out var w) && w is double wd) ? wd : 0;
            if (weight <= 0)
            {
                double summed = 0;
                foreach (var pid in nonFastenerParts)
                {
                    var tq = GetPsetByName(pid, "Tekla Quantity", entityToPsets, psets);
                    if (tq.TryGetValue("Weight", out var pw) && pw is double pwd) { summed += pwd; continue; }
                    var bq = GetPsetByName(pid, "BaseQuantities", entityToPsets, psets);
                    if (bq.TryGetValue("NetWeight", out var nw) && nw is double nwd) summed += nwd;
                }
                if (summed > 0) weight = summed;
            }

            // --- Dimensions: pick the longest non-fastener part by Length,
            // preferring "Tekla Quantity" but falling back to "BaseQuantities"
            // (which nearly every IFC export includes) if that pset is absent
            // or incomplete on this particular part.
            double bestLen = -1;
            int primaryPartId = -1;
            Dictionary<string, object?>? mainDims = null;
            string mainProfileDesc = "";
            double mainPartVolumeMm3 = 0;

            foreach (var pid in nonFastenerParts)
            {
                var tq = GetPsetByName(pid, "Tekla Quantity", entityToPsets, psets);
                var bq = GetPsetByName(pid, "BaseQuantities", entityToPsets, psets);

                double? len = (tq.TryGetValue("Length", out var l1) && l1 is double l1d) ? l1d
                            : (bq.TryGetValue("Length", out var l2) && l2 is double l2d) ? l2d
                            : null;
                if (len is null or <= 0) continue;

                if (len.Value > bestLen)
                {
                    bestLen = len.Value;
                    primaryPartId = pid;
                    mainDims = new Dictionary<string, object?>(bq);
                    foreach (var kv in tq) mainDims[kv.Key] = kv.Value;

                    // Tekla writes the section profile string into the IFC part's
                    // Description attribute. Try to collect from ALL parts — even
                    // secondary parts — since sometimes the main member's description
                    // is richer than the assembly's own attributes.
                    if (entities.TryGetValue(pid, out var part))
                    {
                        var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
                        if (partArgs.Count > 3 && StepParser.Unwrap(partArgs[3]) is string desc
                            && !string.IsNullOrWhiteSpace(desc))
                            mainProfileDesc = desc;
                    }

                    // Estimate main part volume for later sanity check.
                    // Width and Height may or may not be present, so we try both.
                    double GetD2(Dictionary<string, object?> d, string key) =>
                        d.TryGetValue(key, out var v) && v is double dv ? dv : 0;
                    double w0 = GetD2(mainDims, "Width");
                    double h0 = mainDims.ContainsKey("Height") ? GetD2(mainDims, "Height") : w0;
                    if (w0 > 0 && h0 > 0)
                        mainPartVolumeMm3 = len.Value * w0 * h0;
                }
            }

            // If we still have no description, scan ALL parts — sometimes the
            // profile desc lives on a secondary part (e.g. a gusset plate attached
            // to a Z-purlin carries the Z's description in Tekla).
            if (string.IsNullOrWhiteSpace(mainProfileDesc))
            {
                foreach (var pid in nonFastenerParts)
                {
                    if (!entities.TryGetValue(pid, out var part)) continue;
                    var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
                    if (partArgs.Count > 3 && StepParser.Unwrap(partArgs[3]) is string desc
                        && !string.IsNullOrWhiteSpace(desc))
                    {
                        mainProfileDesc = desc;
                        break;
                    }
                }
            }

            string dimensionSource = "property set";

            // --- Geometry fallback: used only when NO property-set dimensions
            // were found. Key improvement over the naive approach: instead of
            // computing one bounding box for the entire assembly (which would
            // inflate the box if the assembly has attached plates / cleats /
            // stiffeners), we compute a separate bounding box for EACH
            // non-fastener part and pick the PRIMARY MEMBER — defined as the
            // part whose bounding-box VOLUME is largest. The primary member is
            // almost always the structural profile; secondary plates are smaller.
            //
            // We also apply a volume-ratio sanity check: if the assembly bounding
            // box is more than 2× the primary member's bounding box, we flag the
            // result as potentially inflated by secondary parts so the caller can
            // handle it (e.g. show a warning in the UI).
            if (mainDims == null)
            {
                double bestVol = -1;
                double[]? bestExtents = null;
                double totalGeomVol = 0;
                double geometryWeightSum = 0;
                bool anyGeometryFound = false;

                foreach (var pid in nonFastenerParts)
                {
                    if (!entities.TryGetValue(pid, out var part)) continue;
                    var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
                    if (partArgs.Count < 7) continue;
                    if (StepParser.Unwrap(partArgs[6]) is not StepRef reprRef) continue;

                    var extents = GeometryBoundingBox(reprRef.Id, entities);
                    if (extents == null) continue;

                    anyGeometryFound = true;
                    double volM3 = (extents[0] * extents[1] * extents[2]) / 1e9;
                    double volMm3 = extents[0] * extents[1] * extents[2];
                    totalGeomVol += volMm3;
                    geometryWeightSum += volM3 * SteelDensityKgPerM3;

                    // Use VOLUME (not length) to identify the primary structural member.
                    // A long thin rod has less volume than a short wide I-beam.
                    if (volMm3 > bestVol)
                    {
                        bestVol = volMm3;
                        bestExtents = extents;
                        primaryPartId = pid;

                        // Collect profile desc from the part identified as primary
                        if (partArgs.Count > 3 && StepParser.Unwrap(partArgs[3]) is string desc
                            && !string.IsNullOrWhiteSpace(desc))
                            mainProfileDesc = desc;
                    }
                }

                if (bestExtents != null)
                {
                    mainDims = new Dictionary<string, object?>
                    {
                        ["Length"] = bestExtents[0],
                        ["Width"]  = bestExtents[1],
                        ["Height"] = bestExtents[2]
                    };
                    if (weight <= 0 && anyGeometryFound) weight = geometryWeightSum;

                    // Volume ratio check (Gemini Phase 1 recommendation):
                    // If the total assembly volume is > 2× the primary member volume,
                    // the assembly likely has significant secondary parts that inflate
                    // the bounding box — flag it so the UI can show a caution.
                    bool inflated = totalGeomVol > bestVol * 2.0;
                    dimensionSource = inflated
                        ? "geometry (estimated, may include secondary parts)"
                        : "geometry (estimated)";
                }
            }

            if (mainDims == null) { skipped++; continue; } // no usable data anywhere - property sets or geometry

            double GetD(Dictionary<string, object?> d, string key) =>
                d.TryGetValue(key, out var v) && v is double dv ? dv : 0;

            var section = ProfileDescParser.Parse(mainProfileDesc);

            var item = new SteelItem
            {
                AssmMark = mark,
                Qty = 1,
                AssemblyName = name,
                LengthMm = GetD(mainDims, "Length"),
                WidthMm = GetD(mainDims, "Width"),
                HeightMm = mainDims.ContainsKey("Height") ? GetD(mainDims, "Height") : GetD(mainDims, "Width"),
                UnitWeightKg = weight,
                TotalWeightKg = weight,
                ProfileDesc = mainProfileDesc,
                Section = section,
                WeightEstimated = dimensionSource == "geometry (estimated)",
                Remarks = (phase.HasValue ? $"Phase {phase} " : "") + $"[{dimensionSource}]",
                PhaseTags = phase.HasValue ? new List<double> { phase.Value } : new List<double>(),
                // STEP path: untagged items are excluded when a phase filter is applied
                IncludeInAllPhases = false
            };

            // Multi-part IFC assembly → exact Tekla-like structure (all assemblies)
            if (TryBuildAssemblyParts(nonFastenerParts, entities, psets, entityToPsets,
                    out var asmParts, out var envL, out var envW, out var envH)
                && asmParts.Count >= 2)
            {
                item.IsAssembly = true;
                item.Parts = asmParts;
                item.LengthMm = envL;
                item.WidthMm = envW;
                item.HeightMm = envH;

                bool plateBuiltUp = IsPlateBuiltUpAssembly(asmParts);
                bool teklaFlWb = asmParts.Any(p => IsTeklaFlangeMark(p.Name, p.ProfileDesc)
                    || IsTeklaWebMark(p.Name, p.ProfileDesc));
                bool hasL = asmParts.Any(p =>
                    p.Section?.ShapeKey == "l_angle"
                    || System.Text.RegularExpressions.Regex.IsMatch(
                        $"{p.Name} {p.ProfileDesc}", @"\bL\s*\d|L_?ANGLE|\bANGLE\b",
                        System.Text.RegularExpressions.RegexOptions.IgnoreCase));
                string kind = plateBuiltUp || teklaFlWb ? "plate-built"
                    : hasL ? "L/C+plates"
                    : "multi-part";
                item.Remarks += $" [IFC {kind} assembly ×{asmParts.Count} parts]";
                double gapMm = EstimateFlangeClearGapMm(asmParts);
                if (gapMm > 0) {
                    item.FlangeClearGapMm = gapMm;
                    item.Remarks += $" flangeClearGap={gapMm:0}mm; pack=assemblyAABB";
                }
                ApplyShippingDimsFromParts(item, asmParts, envL, envW, envH, gapMm);
            }

            // Bent sag rod only: IFC centerline + diameter → exact 3D path
            if (primaryPartId > 0)
                TryAttachBentSagRod(item, primaryPartId, entities, name, mainProfileDesc);
            else if (nonFastenerParts.Count > 0)
                TryAttachBentSagRod(item, nonFastenerParts[0], entities, name, mainProfileDesc);

            items.Add(item);
        }

        // ── Fallback: Tekla Assemblies:Off → cluster FLANGES+WEB into assemblies.
        // Packing uses overall assembly AABB (Option 3). Parts keep exact IFC geometry.
        if (items.Count == 0)
        {
            items.AddRange(ExtractBuiltUpAssembliesAndLoose(entities, psets, entityToPsets));
        }

        var job = new JobInfo
        {
            JobNo = jobNo,
            BldgNo = "",
            PhaseNo = phaseFilter.HasValue ? phaseFilter.Value.ToString("0") : "ALL",
            Customer = ""
        };

        return (job, items, skipped);
    }

    /// <summary>
    /// Tekla Assemblies:Off — group nearby FLANGES + WEB into one assembly.
    /// Packing envelope = union world AABB of all parts (Option 3).
    /// Each part keeps exact IFC size / placement / profile for 3D shape.
    /// </summary>
    private static List<SteelItem> ExtractBuiltUpAssembliesAndLoose(
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        Dictionary<int, PropertySet> psets,
        Dictionary<int, List<int>> entityToPsets)
    {
        var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "IFCBEAM", "IFCCOLUMN", "IFCMEMBER", "IFCPLATE", "IFCBUILDINGELEMENTPROXY"
        };

        var cands = new List<(
            int Id, string Name, string Desc, string Type,
            double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ,
            bool IsFl, bool IsWb, bool IsMember)>();

        foreach (var kvp in entities)
        {
            if (!types.Contains(kvp.Value.Type)) continue;
            int eid = kvp.Key;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            string name = args.Count > 2 ? StepParser.Unwrap(args[2]) as string ?? "" : "";
            string desc = args.Count > 3 ? StepParser.Unwrap(args[3]) as string ?? "" : "";
            bool isFl = IsTeklaFlangeMark(name, desc);
            bool isWb = IsTeklaWebMark(name, desc);
            bool isMember = System.Text.RegularExpressions.Regex.IsMatch(
                $"{name} {desc}", @"\b(RAFTER|COLUMN|BEAM)\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            bool isPl = System.Text.RegularExpressions.Regex.IsMatch(
                desc, @"^\s*PL\s*\d", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                || IsBuiltUpPlateName(name, desc);
            if (!(isFl || isWb || (isMember && isPl) || IsTeklaStiffOrEndMark(name, desc)))
                continue;

            var bounds = ProductWorldBounds(eid, entities);
            if (bounds == null) continue;
            cands.Add((
                eid, name, desc, kvp.Value.Type,
                bounds.Value.MinX, bounds.Value.MinY, bounds.Value.MinZ,
                bounds.Value.MaxX, bounds.Value.MaxY, bounds.Value.MaxZ,
                isFl, isWb, isMember));
        }

        int n = cands.Count;
        var parent = Enumerable.Range(0, n).ToArray();
        int Find(int i) { while (parent[i] != i) i = parent[i] = parent[parent[i]]; return i; }
        void Union(int a, int b) { a = Find(a); b = Find(b); if (a != b) parent[a] = b; }

        static double AabbGap(
            (double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ) a,
            (double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ) b)
        {
            double gx = Math.Max(0, Math.Max(a.MinX - b.MaxX, b.MinX - a.MaxX));
            double gy = Math.Max(0, Math.Max(a.MinY - b.MaxY, b.MinY - a.MaxY));
            double gz = Math.Max(0, Math.Max(a.MinZ - b.MaxZ, b.MinZ - a.MaxZ));
            return Math.Sqrt(gx * gx + gy * gy + gz * gz);
        }

        const double touchMm = 120;
        for (int i = 0; i < n; i++)
        {
            var a = cands[i];
            var ab = (a.MinX, a.MinY, a.MinZ, a.MaxX, a.MaxY, a.MaxZ);
            for (int j = i + 1; j < n; j++)
            {
                var b = cands[j];
                if (AabbGap(ab, (b.MinX, b.MinY, b.MinZ, b.MaxX, b.MaxY, b.MaxZ)) <= touchMm)
                    Union(i, j);
            }
        }

        var clusters = new Dictionary<int, List<int>>();
        for (int i = 0; i < n; i++)
        {
            int r = Find(i);
            if (!clusters.TryGetValue(r, out var list)) clusters[r] = list = new List<int>();
            list.Add(i);
        }

        var usedIds = new HashSet<int>();
        var items = new List<SteelItem>();

        foreach (var cluster in clusters.Values)
        {
            int flN = cluster.Count(i => cands[i].IsFl);
            int wbN = cluster.Count(i => cands[i].IsWb);
            if (flN < 1 || wbN < 1 || cluster.Count < 2) continue;
            if (flN < 2 && cluster.Count < 3) continue;

            var partIds = cluster.Select(i => cands[i].Id).ToList();
            if (!TryBuildAssemblyParts(partIds, entities, psets, entityToPsets,
                    out var asmParts, out var envL, out var envW, out var envH)
                || asmParts.Count < 2)
                continue;

            var member = cluster.Select(i => cands[i]).FirstOrDefault(c => c.IsMember);
            string asmName = !string.IsNullOrEmpty(member.Name) ? member.Name : "BUILT-UP";
            if (asmName.Equals("FLANGES", StringComparison.OrdinalIgnoreCase)
                || asmName.Equals("WEB", StringComparison.OrdinalIgnoreCase))
                asmName = cluster.Any(i => cands[i].Type.Contains("COLUMN", StringComparison.OrdinalIgnoreCase))
                    ? "COLUMN" : "RAFTER";

            double weight = 0;
            foreach (var pid in partIds)
            {
                var tq = GetPsetByName(pid, "Tekla Quantity", entityToPsets, psets);
                if (tq.TryGetValue("Weight", out var w) && w is double wd) { weight += wd; continue; }
                var bq = GetPsetByName(pid, "BaseQuantities", entityToPsets, psets);
                if (bq.TryGetValue("NetWeight", out var nw) && nw is double nwd) weight += nwd;
            }

            var primary = cluster.Select(i => cands[i]).OrderByDescending(c =>
                (c.MaxX - c.MinX) * (c.MaxY - c.MinY) * (c.MaxZ - c.MinZ)).First();

            // Diagnose: can we read flange clear space from IFC poses?
            double flangeGapMm = EstimateFlangeClearGapMm(asmParts);
            int flCount = asmParts.Count(p => p.PartKind == "flange"
                || IsTeklaFlangeMark(p.Name, p.ProfileDesc));
            int wbCount = asmParts.Count(p => p.PartKind == "web"
                || IsTeklaWebMark(p.Name, p.ProfileDesc));
            string gapNote = flangeGapMm > 0
                ? $"flangeClearGap={flangeGapMm:0}mm"
                : "flangeClearGap=NOT_FOUND";

            items.Add(new SteelItem
            {
                AssmMark = asmName + "-" + partIds[0],
                Qty = 1,
                AssemblyName = asmName,
                LengthMm = Math.Max(1, envL),
                WidthMm = Math.Max(1, envW),
                HeightMm = Math.Max(1, envH),
                UnitWeightKg = weight,
                TotalWeightKg = weight,
                ProfileDesc = primary.Desc,
                Section = ProfileDescParser.Parse(primary.Desc)
                    ?? new ProfileSection { ShapeKey = "plate", Raw = primary.Desc },
                IsAssembly = true,
                Parts = asmParts,
                FlangeClearGapMm = flangeGapMm,
                Remarks = $"[built-up {asmName} FL={flCount} WB={wbCount} {gapNote}; pack=assemblyAABB; webFill=flangeGap]"
            });
            ApplyShippingDimsFromParts(items[^1], asmParts, envL, envW, envH, flangeGapMm);
            foreach (var pid in partIds) usedIds.Add(pid);
        }

        items.AddRange(ExtractLooseElements(entities, psets, entityToPsets, usedIds));
        return items;
    }

    /// <summary>
    /// Derive shipping-pose L×flangeW×webH from parts + world AABB.
    /// Keeps world AABB on Length/Width/Height; stamps Shipping* when confident.
    /// </summary>
    internal static void ApplyShippingDimsFromParts(
        SteelItem item,
        List<AssemblyPart> parts,
        double envL, double envW, double envH,
        double flangeGapMm)
    {
        if (item == null || parts == null || parts.Count == 0) return;

        double flangeW = 0;
        double partMaxLen = 0;
        foreach (var p in parts)
        {
            bool isFl = p.PartKind == "flange" || IsTeklaFlangeMark(p.Name, p.ProfileDesc);
            double[] box = { p.LengthMm, p.WidthMm, p.HeightMm, p.BoxXMm, p.BoxYMm, p.BoxZMm };
            Array.Sort(box);
            // largest part axis ≈ extrusion / span contribution
            partMaxLen = Math.Max(partMaxLen, box[^1]);
            if (isFl)
            {
                // flange plate: thin × width × length — middle = seat width
                if (box.Length >= 2 && box[1] >= 40 && box[1] <= 600)
                    flangeW = Math.Max(flangeW, box[1]);
                if (p.Section?.W is > 40 and <= 600)
                    flangeW = Math.Max(flangeW, p.Section.W);
            }
        }

        if (item.Section?.W is > 40 and <= 450)
            flangeW = Math.Max(flangeW, item.Section.W);

        double spanL = Math.Max(partMaxLen, Math.Max(envL, Math.Max(envW, envH)));
        // Prefer longest env axis as span when parts lack clear extrusion
        double[] env = { envL, envW, envH };
        Array.Sort(env);
        if (spanL < env[^1] * 0.85) spanL = env[^1];

        double webH = flangeGapMm;
        if (webH < 80 && item.Section?.H is > 80 and <= 3000)
            webH = item.Section.H;
        if (webH < 80)
        {
            // middle env axis often = web depth on pitched AABB
            if (env.Length >= 2 && env[1] >= 80 && env[1] <= 3000) webH = env[1];
        }

        if (flangeW < 40)
        {
            // smallest env axis if flange-like
            if (env[0] >= 40 && env[0] <= 450) flangeW = env[0];
        }

        item.FlangeWidthMm = flangeW > 0 ? flangeW : 0;
        // Only stamp shipping when we have a usable flange seat (avoids garbage)
        if (spanL > 500 && flangeW >= 40 && flangeW <= 600 && webH >= 80)
        {
            item.ShippingLengthMm = spanL;
            item.ShippingWidthMm = flangeW;
            item.ShippingHeightMm = webH;
            item.Remarks += $" ship={spanL:0}x{flangeW:0}x{webH:0}";
        }
    }

    /// <summary>
    /// Clear space between top &amp; bottom flange inner faces (mm), from IFC part transforms.
    /// Returns 0 if flanges / depth axis cannot be resolved.
    /// </summary>
    private static double EstimateFlangeClearGapMm(List<AssemblyPart> parts)
    {
        var flanges = parts.Where(p =>
            p.PartKind == "flange" || IsTeklaFlangeMark(p.Name, p.ProfileDesc)).ToList();
        if (flanges.Count < 2) return 0;

        static (double X, double Y, double Z) Center(AssemblyPart p)
        {
            if (p.HasIfcTransform && p.Transform.Length >= 16)
                return (p.Transform[12], p.Transform[13], p.Transform[14]);
            return (p.OffsetXMm, p.OffsetYMm, p.OffsetZMm);
        }
        static double Dot((double X, double Y, double Z) a, double dx, double dy, double dz)
            => a.X * dx + a.Y * dy + a.Z * dz;

        // Depth axis: farthest flange pair (top ↔ bottom)
        double dx = 0, dy = 1, dz = 0;
        double bestD = -1;
        var cents = flanges.Select(Center).ToList();
        for (int i = 0; i < cents.Count; i++)
        {
            for (int j = i + 1; j < cents.Count; j++)
            {
                double ex = cents[j].X - cents[i].X;
                double ey = cents[j].Y - cents[i].Y;
                double ez = cents[j].Z - cents[i].Z;
                double d = Math.Sqrt(ex * ex + ey * ey + ez * ez);
                if (d > bestD)
                {
                    bestD = d;
                    if (d > 1e-6) { dx = ex / d; dy = ey / d; dz = ez / d; }
                }
            }
        }
        if (bestD < 40) return 0;

        // Prefer web mid-axis when well aligned
        var web = parts.FirstOrDefault(p =>
            p.PartKind == "web" || IsTeklaWebMark(p.Name, p.ProfileDesc));
        if (web != null && web.HasIfcTransform && web.Transform.Length >= 16)
        {
            var dims = new[] { web.LengthMm, web.HeightMm, web.WidthMm };
            var order = Enumerable.Range(0, 3).OrderByDescending(i => dims[i]).ToArray();
            int mid = order[1];
            int o = mid * 4;
            double wx = web.Transform[o], wy = web.Transform[o + 1], wz = web.Transform[o + 2];
            double wlen = Math.Sqrt(wx * wx + wy * wy + wz * wz);
            if (wlen > 1e-9)
            {
                wx /= wlen; wy /= wlen; wz /= wlen;
                double align = wx * dx + wy * dy + wz * dz;
                if (Math.Abs(align) > 0.65)
                {
                    if (align < 0) { wx = -wx; wy = -wy; wz = -wz; }
                    dx = wx; dy = wy; dz = wz;
                }
            }
        }

        static double HalfThickAlong(AssemblyPart p, double dx, double dy, double dz)
        {
            double t = p.ThicknessMm > 0.5
                ? p.ThicknessMm
                : Math.Min(p.LengthMm, Math.Min(p.HeightMm, p.WidthMm));
            // Prefer projected local extents when transform exists
            if (p.HasIfcTransform && p.Transform.Length >= 16)
            {
                var dims = new[] { p.LengthMm, p.HeightMm, p.WidthMm };
                double half = 0;
                for (int i = 0; i < 3; i++)
                {
                    int o = i * 4;
                    double ax = p.Transform[o], ay = p.Transform[o + 1], az = p.Transform[o + 2];
                    double al = Math.Sqrt(ax * ax + ay * ay + az * az);
                    if (al < 1e-9) continue;
                    ax /= al; ay /= al; az /= al;
                    half += 0.5 * dims[i] * Math.Abs(ax * dx + ay * dy + az * dz);
                }
                if (half > 0.25) return half;
            }
            return 0.5 * t;
        }

        var projs = flanges.Select(f => (
            P: Dot(Center(f), dx, dy, dz),
            Half: HalfThickAlong(f, dx, dy, dz)
        )).ToList();
        double lo = projs.Min(x => x.P), hi = projs.Max(x => x.P);
        if (hi - lo < 40) return 0;
        double midP = 0.5 * (lo + hi);
        var bot = projs.Where(x => x.P <= midP).ToList();
        var top = projs.Where(x => x.P > midP).ToList();
        if (bot.Count == 0 || top.Count == 0) return 0;
        double botInner = bot.Max(x => x.P + x.Half);
        double topInner = top.Min(x => x.P - x.Half);
        double gap = topInner - botInner;
        return gap > 20 ? gap : 0;
    }

    /// <summary>
    /// When the IFC has no IfcElementAssembly (common for non-Tekla exports),
    /// pull IfcBeam / IfcColumn / IfcMember / IfcPlate / proxies as individual items.
    /// Uses any available property sets + geometry — never requires ACERO_DATA.
    /// </summary>
    private static List<SteelItem> ExtractLooseElements(
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        Dictionary<int, PropertySet> psets,
        Dictionary<int, List<int>> entityToPsets,
        HashSet<int>? skipIds = null)
    {
        var items = new List<SteelItem>();
        var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "IFCBEAM", "IFCCOLUMN", "IFCMEMBER", "IFCPLATE",
            "IFCBUILDINGELEMENTPROXY", "IFCRAILING", "IFCFOOTING"
        };
        string[] commonPsets =
        {
            "Pset_BeamCommon", "Pset_ColumnCommon", "Pset_MemberCommon",
            "Pset_PlateCommon", "Tekla Quantity", "BaseQuantities",
            "Qto_BeamBaseQuantities", "Qto_ColumnBaseQuantities",
            "Qto_MemberBaseQuantities", "Qto_PlateBaseQuantities"
        };

        foreach (var kvp in entities)
        {
            if (!types.Contains(kvp.Value.Type)) continue;
            int eid = kvp.Key;
            if (skipIds != null && skipIds.Contains(eid)) continue;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            string? nameAttr = args.Count > 2 ? StepParser.Unwrap(args[2]) as string : null;
            string? descAttr = args.Count > 3 ? StepParser.Unwrap(args[3]) as string : null;

            // Merge all known quantity/common psets
            var dims = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            double weight = 0;
            string? mark = null;
            foreach (var psetName in commonPsets)
            {
                var ps = GetPsetByName(eid, psetName, entityToPsets, psets);
                foreach (var kv in ps)
                {
                    if (!dims.ContainsKey(kv.Key)) dims[kv.Key] = kv.Value;
                }
                if (mark == null && ps.TryGetValue("Reference", out var r) && r is string rs && !string.IsNullOrWhiteSpace(rs))
                    mark = rs;
                if (weight <= 0 && ps.TryGetValue("Weight", out var w) && w is double wd) weight = wd;
                if (weight <= 0 && ps.TryGetValue("NetWeight", out var nw) && nw is double nwd) weight = nwd;
                if (weight <= 0 && ps.TryGetValue("GrossWeight", out var gw) && gw is double gwd) weight = gwd;
            }

            // Also scan ANY property set on this entity for useful fields
            if (entityToPsets.TryGetValue(eid, out var pids))
            {
                foreach (var pid in pids)
                {
                    if (!psets.TryGetValue(pid, out var pset)) continue;
                    foreach (var kv in pset.Props)
                    {
                        if (!dims.ContainsKey(kv.Key)) dims[kv.Key] = kv.Value;
                        var key = kv.Key.ToUpperInvariant();
                        if (mark == null && (key.Contains("MARK") || key == "REFERENCE" || key == "TAG")
                            && kv.Value is string ms && !string.IsNullOrWhiteSpace(ms))
                            mark = ms;
                        if (weight <= 0 && key.Contains("WEIGHT") && kv.Value is double wv) weight = wv;
                    }
                }
            }

            double GetD(string key)
            {
                if (dims.TryGetValue(key, out var v) && v is double d) return d;
                // case-insensitive already on dict
                return 0;
            }

            double length = GetD("Length");
            double width = GetD("Width");
            double height = GetD("Height") > 0 ? GetD("Height") : GetD("Width");
            string dimensionSource = "property set";

            // Geometry fallback
            if (length <= 0 || width <= 0)
            {
                if (args.Count >= 7 && StepParser.Unwrap(args[6]) is StepRef reprRef)
                {
                    var extents = GeometryBoundingBox(reprRef.Id, entities);
                    if (extents != null)
                    {
                        length = extents[0];
                        width = extents[1];
                        height = extents[2];
                        dimensionSource = "geometry (estimated)";
                        if (weight <= 0)
                        {
                            double volM3 = (extents[0] * extents[1] * extents[2]) / 1e9;
                            weight = volM3 * SteelDensityKgPerM3;
                        }
                    }
                }
            }

            if (length <= 0 || width <= 0) continue;

            mark ??= nameAttr ?? descAttr ?? $"{kvp.Value.Type}-{eid}";
            string profileDesc = descAttr ?? nameAttr ?? "";
            var section = ProfileDescParser.Parse(profileDesc);

            items.Add(new SteelItem
            {
                AssmMark = mark,
                Qty = 1,
                AssemblyName = nameAttr ?? kvp.Value.Type.Replace("IFC", ""),
                LengthMm = length,
                WidthMm = width,
                HeightMm = height > 0 ? height : width,
                UnitWeightKg = weight,
                TotalWeightKg = weight,
                ProfileDesc = profileDesc,
                Section = section,
                WeightEstimated = dimensionSource.Contains("geometry"),
                Remarks = $"[{dimensionSource}; {kvp.Value.Type}]"
            });
            TryAttachBentSagRod(items[^1], eid, entities, items[^1].AssemblyName, profileDesc);
        }

        return items;
    }

    private const double SteelDensityKgPerM3 = 7850;

    /// <summary>Affine transform for IFC ObjectPlacement (Z-up).</summary>
    private sealed class Xform
    {
        // Columns = local axes in world; Apply: p' = T + x*XAxis + y*YAxis + z*ZAxis
        public double Xx, Yx, Zx; // local X axis
        public double Xy, Yy, Zy; // local Y axis
        public double Xz, Yz, Zz; // local Z axis
        public double Tx, Ty, Tz;

        public static Xform Identity { get; } = new()
        {
            Xx = 1, Yy = 1, Zz = 1
        };

        public (double X, double Y, double Z) Apply(double x, double y, double z) => (
            Tx + Xx * x + Xy * y + Xz * z,
            Ty + Yx * x + Yy * y + Yz * z,
            Tz + Zx * x + Zy * y + Zz * z
        );

        /// <summary>Inverse for rigid (R|t) — orthonormal rotation assumed.</summary>
        public Xform Inverse()
        {
            // M = [[Xx,Xy,Xz],[Yx,Yy,Yz],[Zx,Zy,Zz]]; R^{-1}=R^T
            return new Xform
            {
                Xx = Xx, Xy = Yx, Xz = Zx,
                Yx = Xy, Yy = Yy, Yz = Zy,
                Zx = Xz, Zy = Yz, Zz = Zz,
                Tx = -(Xx * Tx + Yx * Ty + Zx * Tz),
                Ty = -(Xy * Tx + Yy * Ty + Zy * Tz),
                Tz = -(Xz * Tx + Yz * Ty + Zz * Tz),
            };
        }

        /// <summary>this * other — apply other first, then this.</summary>
        public Xform Mul(Xform o) => new()
        {
            Xx = Xx * o.Xx + Xy * o.Yx + Xz * o.Zx,
            Xy = Xx * o.Xy + Xy * o.Yy + Xz * o.Zy,
            Xz = Xx * o.Xz + Xy * o.Yz + Xz * o.Zz,
            Tx = Tx + Xx * o.Tx + Xy * o.Ty + Xz * o.Tz,

            Yx = Yx * o.Xx + Yy * o.Yx + Yz * o.Zx,
            Yy = Yx * o.Xy + Yy * o.Yy + Yz * o.Zy,
            Yz = Yx * o.Xz + Yy * o.Yz + Yz * o.Zz,
            Ty = Ty + Yx * o.Tx + Yy * o.Ty + Yz * o.Tz,

            Zx = Zx * o.Xx + Zy * o.Yx + Zz * o.Zx,
            Zy = Zx * o.Xy + Zy * o.Yy + Zz * o.Zy,
            Zz = Zx * o.Xz + Zy * o.Yz + Zz * o.Zz,
            Tz = Tz + Zx * o.Tx + Zy * o.Ty + Zz * o.Tz,
        };
    }

    private static (double X, double Y, double Z)? ReadPoint3(int id, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(id, out var e) || e.Type != "IFCCARTESIANPOINT") return null;
        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        if (args.Count == 0 || StepParser.Unwrap(args[0]) is not List<object?> c || c.Count < 3) return null;
        if (c[0] is double x && c[1] is double y && c[2] is double z) return (x, y, z);
        // 2D point padded
        if (c.Count >= 2 && c[0] is double x2 && c[1] is double y2)
            return (x2, y2, c.Count > 2 && c[2] is double z2 ? z2 : 0);
        return null;
    }

    private static (double X, double Y, double Z)? ReadDir3(int id, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(id, out var e) || e.Type != "IFCDIRECTION") return null;
        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        if (args.Count == 0 || StepParser.Unwrap(args[0]) is not List<object?> c || c.Count < 2) return null;
        double x = c[0] is double dx ? dx : 0;
        double y = c[1] is double dy ? dy : 0;
        double z = c.Count > 2 && c[2] is double dz ? dz : 0;
        double len = Math.Sqrt(x * x + y * y + z * z);
        if (len < 1e-12) return null;
        return (x / len, y / len, z / len);
    }

    private static Xform Axis2Placement3D(int id, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(id, out var e)) return Xform.Identity;
        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        var loc = (0.0, 0.0, 0.0);
        var axis = (0.0, 0.0, 1.0);
        var xref = (1.0, 0.0, 0.0);

        if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef locRef)
        {
            var p = ReadPoint3(locRef.Id, entities);
            if (p != null) loc = p.Value;
        }
        if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef axisRef)
        {
            var d = ReadDir3(axisRef.Id, entities);
            if (d != null) axis = d.Value;
        }
        if (args.Count > 2 && StepParser.Unwrap(args[2]) is StepRef refRef)
        {
            var d = ReadDir3(refRef.Id, entities);
            if (d != null) xref = d.Value;
        }

        double zx = axis.Item1, zy = axis.Item2, zz = axis.Item3;
        double xx = xref.Item1, xy = xref.Item2, xz = xref.Item3;
        double dot = xx * zx + xy * zy + xz * zz;
        xx -= dot * zx; xy -= dot * zy; xz -= dot * zz;
        double xlen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
        if (xlen < 1e-12)
        {
            if (Math.Abs(zz) < 0.9) { xx = 1; xy = 0; xz = 0; }
            else { xx = 0; xy = 1; xz = 0; }
            dot = xx * zx + xy * zy + xz * zz;
            xx -= dot * zx; xy -= dot * zy; xz -= dot * zz;
            xlen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
        }
        xx /= xlen; xy /= xlen; xz /= xlen;
        double yx = zy * xz - zz * xy;
        double yy = zz * xx - zx * xz;
        double yz = zx * xy - zy * xx;

        return new Xform
        {
            Xx = xx, Yx = xy, Zx = xz,
            Xy = yx, Yy = yy, Zy = yz,
            Xz = zx, Yz = zy, Zz = zz,
            Tx = loc.Item1, Ty = loc.Item2, Tz = loc.Item3,
        };
    }

    private static Xform ResolveLocalPlacement(int placementId,
        Dictionary<int, (string Type, string ArgsRaw)> entities, int depth = 0)
    {
        if (depth > 64 || !entities.TryGetValue(placementId, out var e))
            return Xform.Identity;
        if (e.Type != "IFCLOCALPLACEMENT") return Xform.Identity;

        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        Xform parent = Xform.Identity;
        if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef parentRef)
            parent = ResolveLocalPlacement(parentRef.Id, entities, depth + 1);

        Xform local = Xform.Identity;
        if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef relRef)
            local = Axis2Placement3D(relRef.Id, entities);

        return parent.Mul(local);
    }

    private static Xform? CartesianTransform3D(int id, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(id, out var e)) return null;
        // IFCCARTESIANTRANSFORMATIONOPERATOR3D(Axis1, Axis2, LocalOrigin, Scale, Axis3)
        // or 3DNONUNIFORM(…, Scale1, Scale2, Scale3)
        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        var origin = (0.0, 0.0, 0.0);
        var ax1 = (1.0, 0.0, 0.0);
        var ax2 = (0.0, 1.0, 0.0);
        var ax3 = (0.0, 0.0, 1.0);
        double s1 = 1, s2 = 1, s3 = 1;

        if (args.Count > 2 && StepParser.Unwrap(args[2]) is StepRef originRef)
        {
            var p = ReadPoint3(originRef.Id, entities);
            if (p != null) origin = p.Value;
        }
        if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef a1)
        {
            var d = ReadDir3(a1.Id, entities);
            if (d != null) ax1 = d.Value;
        }
        if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef a2)
        {
            var d = ReadDir3(a2.Id, entities);
            if (d != null) ax2 = d.Value;
        }
        if (e.Type.Contains("NONUNIFORM"))
        {
            if (args.Count > 3 && StepParser.Unwrap(args[3]) is double sc1) s1 = sc1;
            if (args.Count > 4 && StepParser.Unwrap(args[4]) is double sc2) s2 = sc2;
            if (args.Count > 5 && StepParser.Unwrap(args[5]) is double sc3) s3 = sc3;
            if (args.Count > 6 && StepParser.Unwrap(args[6]) is StepRef a3)
            {
                var d = ReadDir3(a3.Id, entities);
                if (d != null) ax3 = d.Value;
            }
        }
        else
        {
            if (args.Count > 3 && StepParser.Unwrap(args[3]) is double sc) { s1 = s2 = s3 = sc; }
            if (args.Count > 4 && StepParser.Unwrap(args[4]) is StepRef a3)
            {
                var d = ReadDir3(a3.Id, entities);
                if (d != null) ax3 = d.Value;
            }
            else
            {
                // Z = X × Y
                ax3 = (
                    ax1.Item2 * ax2.Item3 - ax1.Item3 * ax2.Item2,
                    ax1.Item3 * ax2.Item1 - ax1.Item1 * ax2.Item3,
                    ax1.Item1 * ax2.Item2 - ax1.Item2 * ax2.Item1
                );
            }
        }

        return new Xform
        {
            Xx = ax1.Item1 * s1, Yx = ax1.Item2 * s1, Zx = ax1.Item3 * s1,
            Xy = ax2.Item1 * s2, Yy = ax2.Item2 * s2, Zy = ax2.Item3 * s2,
            Xz = ax3.Item1 * s3, Yz = ax3.Item2 * s3, Zz = ax3.Item3 * s3,
            Tx = origin.Item1, Ty = origin.Item2, Tz = origin.Item3,
        };
    }

    /// <summary>
    /// World AABB of a product including ObjectPlacement (assembly parts only).
    /// Handles ExtrudedAreaSolid depth + MappedItem transforms.
    /// </summary>
    private static (double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ)?
        ProductWorldBounds(int productId, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(productId, out var part)) return null;
        var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);

        Xform place = Xform.Identity;
        if (partArgs.Count > 5 && StepParser.Unwrap(partArgs[5]) is StepRef placeRef)
            place = ResolveLocalPlacement(placeRef.Id, entities);

        int? reprId = null;
        if (partArgs.Count > 6 && StepParser.Unwrap(partArgs[6]) is StepRef reprRef)
            reprId = reprRef.Id;
        if (reprId == null) return null;

        return GeometryBounds(reprId.Value, entities, place);
    }

    /// <summary>
    /// Oriented frame for an assembly part: local axes from IFC ObjectPlacement
    /// (+ ExtrudedAreaSolid Position when present) and extents along those axes.
    /// </summary>
    private static bool TryProductOrientedFrame(
        int productId,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        out Xform frameIfc,
        out double extX, out double extY, out double extZ,
        out bool isExtruded)
    {
        frameIfc = Xform.Identity;
        extX = extY = extZ = 0;
        isExtruded = false;

        if (!entities.TryGetValue(productId, out var part)) return false;
        var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);

        Xform place = Xform.Identity;
        if (partArgs.Count > 5 && StepParser.Unwrap(partArgs[5]) is StepRef placeRef)
            place = ResolveLocalPlacement(placeRef.Id, entities);

        int? reprId = null;
        if (partArgs.Count > 6 && StepParser.Unwrap(partArgs[6]) is StepRef reprRef)
            reprId = reprRef.Id;
        if (reprId == null) return false;

        Xform solidLocal = Xform.Identity;
        if (TryFindPrimaryExtrusion(reprId.Value, entities, out var extrudePos, out _, out _))
        {
            solidLocal = extrudePos;
            isExtruded = true;
        }

        frameIfc = place.Mul(solidLocal);
        var inv = frameIfc.Inverse();

        var worldPts = new List<(double X, double Y, double Z)>();
        CollectGeomPoints(reprId.Value, place, entities, worldPts, new HashSet<int>(), 0);
        if (worldPts.Count < 2) return false;

        double minX = double.MaxValue, minY = double.MaxValue, minZ = double.MaxValue;
        double maxX = double.MinValue, maxY = double.MinValue, maxZ = double.MinValue;
        foreach (var wp in worldPts)
        {
            var lp = inv.Apply(wp.X, wp.Y, wp.Z);
            if (lp.X < minX) minX = lp.X; if (lp.X > maxX) maxX = lp.X;
            if (lp.Y < minY) minY = lp.Y; if (lp.Y > maxY) maxY = lp.Y;
            if (lp.Z < minZ) minZ = lp.Z; if (lp.Z > maxZ) maxZ = lp.Z;
        }

        extX = Math.Max(0.5, maxX - minX);
        extY = Math.Max(0.5, maxY - minY);
        extZ = Math.Max(0.5, maxZ - minZ);

        // Re-origin frame at local AABB centre (mesh centred at origin)
        double cx = (minX + maxX) * 0.5;
        double cy = (minY + maxY) * 0.5;
        double cz = (minZ + maxZ) * 0.5;
        var (wx, wy, wz) = frameIfc.Apply(cx, cy, cz);
        frameIfc.Tx = wx;
        frameIfc.Ty = wy;
        frameIfc.Tz = wz;
        return true;
    }

    private static bool TryFindPrimaryExtrusion(
        int startId,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        out Xform solidPos,
        out double depth,
        out (double X, double Y, double Z) extrudeDir)
    {
        solidPos = Xform.Identity;
        depth = 0;
        extrudeDir = (0, 0, 1);
        var visited = new HashSet<int>();
        var stack = new Stack<(int Id, int Depth)>();
        stack.Push((startId, 0));
        while (stack.Count > 0)
        {
            var (eid, d) = stack.Pop();
            if (d > 80 || !visited.Add(eid) || !entities.TryGetValue(eid, out var e)) continue;

            if (e.Type is "IFCEXTRUDEDAREASOLID" or "IFCEXTRUDEDAREASOLIDTAPERED")
            {
                var args = StepParser.SplitTopLevel(e.ArgsRaw);
                if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef posRef)
                    solidPos = Axis2Placement3D(posRef.Id, entities);
                if (args.Count > 3 && StepParser.Unwrap(args[3]) is double dep) depth = dep;
                if (args.Count > 2 && StepParser.Unwrap(args[2]) is StepRef dirRef)
                {
                    var dd = ReadDir3(dirRef.Id, entities);
                    if (dd != null) extrudeDir = dd.Value;
                }
                return true;
            }

            var a = StepParser.SplitTopLevel(e.ArgsRaw);
            foreach (var arg in a)
                CollectRefs(StepParser.Unwrap(arg), stack, d + 1);
        }
        return false;
    }

    private static void CollectRefs(object? val, Stack<(int Id, int Depth)> stack, int depth)
    {
        if (val is StepRef r) stack.Push((r.Id, depth));
        else if (val is List<object?> list)
            foreach (var v in list) CollectRefs(v, stack, depth);
    }

    /// <summary>
    /// Mesh-local (X=length,Y=height,Z=width) → IFC solid axes when solid extrudes along +Z.
    /// </summary>
    private static Xform MeshToIfcExtrudeZ { get; } = new()
    {
        Xx = 0, Yx = 0, Zx = 1, // mesh X → IFC Z
        Xy = 0, Yy = 1, Zy = 0, // mesh Y → IFC Y
        Xz = 1, Yz = 0, Zz = 0, // mesh Z → IFC X
    };

    /// <summary>IFC Z-up frame (origin at part centre) → Three.js Y-up, relative to assembly centre.</summary>
    private static double[] FrameToThreeMatrix(Xform frameIfc, double asmCx, double asmCy, double asmCz)
    {
        // Three basis = remap IFC axes (x,y,z)→(x,z,y)
        double tXx = frameIfc.Xx, tYx = frameIfc.Zx, tZx = frameIfc.Yx;
        double tXy = frameIfc.Xy, tYy = frameIfc.Zy, tZy = frameIfc.Yy;
        double tXz = frameIfc.Xz, tYz = frameIfc.Zz, tZz = frameIfc.Yz;
        double tx = frameIfc.Tx - asmCx;
        double ty = frameIfc.Tz - asmCz;
        double tz = frameIfc.Ty - asmCy;
        // Column-major Matrix4
        return new[]
        {
            tXx, tYx, tZx, 0,
            tXy, tYy, tZy, 0,
            tXz, tYz, tZz, 0,
            tx,  ty,  tz,  1
        };
    }

    private static Xform ComposeMeshFrame(Xform solidFrameIfc, bool profileExtrudedAlongZ)
        => profileExtrudedAlongZ ? solidFrameIfc.Mul(MeshToIfcExtrudeZ) : solidFrameIfc;

    /// <summary>Unsorted AABB of an IFC representation sub-tree (IFC Z-up), optional world transform.</summary>
    private static (double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ)? GeometryBounds(
        int startEntityId, Dictionary<int, (string Type, string ArgsRaw)> entities, Xform? worldXf = null)
    {
        var xf = worldXf ?? Xform.Identity;
        var points = new List<(double X, double Y, double Z)>();
        CollectGeomPoints(startEntityId, xf, entities, points, new HashSet<int>(), 0);
        if (points.Count == 0) return null;
        return (
            points.Min(p => p.X), points.Min(p => p.Y), points.Min(p => p.Z),
            points.Max(p => p.X), points.Max(p => p.Y), points.Max(p => p.Z)
        );
    }

    private static void CollectGeomPoints(
        int eid, Xform xf,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        List<(double X, double Y, double Z)> points,
        HashSet<int> visited, int depth)
    {
        if (depth > 200 || !visited.Add(eid) || !entities.TryGetValue(eid, out var entity))
            return;

        if (entity.Type == "IFCCARTESIANPOINT")
        {
            var args = StepParser.SplitTopLevel(entity.ArgsRaw);
            if (args.Count > 0 && StepParser.Unwrap(args[0]) is List<object?> coords)
            {
                double x = coords.Count > 0 && coords[0] is double dx ? dx : 0;
                double y = coords.Count > 1 && coords[1] is double dy ? dy : 0;
                double z = coords.Count > 2 && coords[2] is double dz ? dz : 0;
                points.Add(xf.Apply(x, y, z));
            }
            return;
        }

        // IFCEXTRUDEDAREASOLID(SweptArea, Position, ExtrudedDirection, Depth)
        if (entity.Type is "IFCEXTRUDEDAREASOLID" or "IFCEXTRUDEDAREASOLIDTAPERED")
        {
            var args = StepParser.SplitTopLevel(entity.ArgsRaw);
            Xform solidXf = xf;
            if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef posRef)
                solidXf = xf.Mul(Axis2Placement3D(posRef.Id, entities));

            double depthVal = 0;
            if (args.Count > 3 && StepParser.Unwrap(args[3]) is double d) depthVal = d;

            var dir = (0.0, 0.0, 1.0);
            if (args.Count > 2 && StepParser.Unwrap(args[2]) is StepRef dirRef)
            {
                var dd = ReadDir3(dirRef.Id, entities);
                if (dd != null) dir = dd.Value;
            }

            var profilePts = new List<(double X, double Y, double Z)>();
            if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef areaRef)
                CollectGeomPoints(areaRef.Id, Xform.Identity, entities, profilePts, new HashSet<int>(), depth + 1);

            if (profilePts.Count == 0)
            {
                // fallback: visit children under solid placement
                if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef areaRef2)
                    CollectGeomPoints(areaRef2.Id, solidXf, entities, points, visited, depth + 1);
                return;
            }

            foreach (var p in profilePts)
            {
                points.Add(solidXf.Apply(p.X, p.Y, p.Z));
                if (depthVal > 1e-9)
                {
                    points.Add(solidXf.Apply(
                        p.X + dir.Item1 * depthVal,
                        p.Y + dir.Item2 * depthVal,
                        p.Z + dir.Item3 * depthVal));
                }
            }
            return;
        }

        // IFCMAPPEDITEM(MappingSource, MappingTarget)
        if (entity.Type == "IFCMAPPEDITEM")
        {
            var args = StepParser.SplitTopLevel(entity.ArgsRaw);
            Xform mapXf = xf;
            if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef targetRef)
            {
                var t = CartesianTransform3D(targetRef.Id, entities);
                if (t != null) mapXf = xf.Mul(t);
            }
            if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef srcRef)
            {
                // MappingSource = IfcRepresentationMap(MappingOrigin, MappedRepresentation)
                if (entities.TryGetValue(srcRef.Id, out var mapEnt) && mapEnt.Type == "IFCREPRESENTATIONMAP")
                {
                    var mapArgs = StepParser.SplitTopLevel(mapEnt.ArgsRaw);
                    Xform originXf = mapXf;
                    if (mapArgs.Count > 0 && StepParser.Unwrap(mapArgs[0]) is StepRef originRef)
                        originXf = mapXf.Mul(Axis2Placement3D(originRef.Id, entities));
                    if (mapArgs.Count > 1 && StepParser.Unwrap(mapArgs[1]) is StepRef mappedRep)
                        CollectGeomPoints(mappedRep.Id, originXf, entities, points, visited, depth + 1);
                    return;
                }
                CollectGeomPoints(srcRef.Id, mapXf, entities, points, visited, depth + 1);
            }
            return;
        }

        foreach (var arg in StepParser.SplitTopLevel(entity.ArgsRaw))
            CollectRefsInto(StepParser.Unwrap(arg), id => CollectGeomPoints(id, xf, entities, points, visited, depth + 1));
    }

    private static void CollectRefsInto(object? val, Action<int> visit)
    {
        if (val is StepRef r) visit(r.Id);
        else if (val is List<object?> list)
            foreach (var v in list) CollectRefsInto(v, visit);
    }

    /// <summary>
    /// Walks the geometry sub-tree starting from a part's Representation
    /// entity, collecting every IFCCARTESIANPOINT coordinate reachable
    /// (regardless of the exact BRep/face/loop structure in between - we
    /// don't need to understand the topology, just harvest every point),
    /// and returns the point cloud's own bounding box as
    /// [length, width, height] with length always the largest extent.
    /// Returns null if no points were found anywhere in the sub-tree.
    /// </summary>
    private static double[]? GeometryBoundingBox(int startEntityId, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        var b = GeometryBounds(startEntityId, entities);
        if (b == null) return null;
        var extents = new[] {
            b.Value.MaxX - b.Value.MinX,
            b.Value.MaxY - b.Value.MinY,
            b.Value.MaxZ - b.Value.MinZ
        };
        Array.Sort(extents);
        Array.Reverse(extents); // largest first: [length, width, height]
        return extents;
    }

    /// <summary>
    /// Tekla built-up marks: FL#### flange, WB#### web, PL/EP/BP/SSP/SWC plates.
    /// Also plain words FLANGE / STIFFENER / WEB.
    /// </summary>
    private static bool IsTeklaFlangeMark(string name, string desc)
    {
        var s = $"{name} {desc}".ToUpperInvariant();
        return s.Contains("FLANGE")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bFL\d");
    }

    private static bool IsTeklaWebMark(string name, string desc)
    {
        var s = $"{name} {desc}".ToUpperInvariant();
        return System.Text.RegularExpressions.Regex.IsMatch(s, @"\bWEB\b")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bWB\d");
    }

    private static bool IsTeklaStiffOrEndMark(string name, string desc)
    {
        var s = $"{name} {desc}".ToUpperInvariant();
        return s.Contains("STIFFENER")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bSTIFF\b")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bPL\d")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bEP\d")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bBP\d")
            || System.Text.RegularExpressions.Regex.IsMatch(s, @"\bST\d")
            || s.Contains("SSP")
            || s.Contains("SWC")
            || s.Contains("SGP")
            || s.Contains("END_PLT")
            || s.Contains("ENDPLT");
    }

    /// <summary>True when part is FLANGE or STIFFENER (word or Tekla FL/PL mark).</summary>
    private static bool NameHasFlangeOrStiffener(string name, string desc)
        => IsTeklaFlangeMark(name, desc) || IsTeklaStiffOrEndMark(name, desc);

    /// <summary>
    /// Plate-built rafter/column: web+flanges (WB+FL) and/or stiffeners/end plates.
    /// Matches shop drawings like tapered rafter with FL1022 / WB1018 / PL1007 / EP1007.
    /// </summary>
    private static bool IsPlateBuiltUpAssembly(IEnumerable<AssemblyPart> parts)
    {
        var list = parts.ToList();
        bool hasFl = list.Any(p => IsTeklaFlangeMark(p.Name, p.ProfileDesc));
        bool hasWb = list.Any(p => IsTeklaWebMark(p.Name, p.ProfileDesc));
        bool hasStiff = list.Any(p => IsTeklaStiffOrEndMark(p.Name, p.ProfileDesc));
        // Classic built-up I: flanges + web, optionally stiffeners / end plates
        return (hasFl && hasWb) || (hasFl && hasStiff) || (hasWb && hasStiff && hasFl);
    }

    /// <summary>True when part name/desc is a built-up plate (FLANGE, STIFFENER, WEB…).</summary>
    private static bool IsBuiltUpPlateName(string name, string desc)
    {
        return IsTeklaFlangeMark(name, desc)
            || IsTeklaWebMark(name, desc)
            || IsTeklaStiffOrEndMark(name, desc)
            || System.Text.RegularExpressions.Regex.IsMatch($"{name} {desc}".ToUpperInvariant(),
                @"\bPLT\b|PLATE|CLEAT|SHIM");
    }

    private static bool HasRolledIProfile(ProfileSection? sect, string desc)
    {
        if (sect?.ShapeKey == "i_beam" && !string.IsNullOrWhiteSpace(sect.Raw)
            && System.Text.RegularExpressions.Regex.IsMatch(sect.Raw, @"IPE|HEA|HEB|UB|UC|\bW\d",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return true;
        return !string.IsNullOrWhiteSpace(desc)
            && System.Text.RegularExpressions.Regex.IsMatch(desc, @"IPE|HEA|HEB|UB\s*\d|UC\s*\d",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    /// <summary>
    /// Multi-part IFC assembly only. Builds child parts with IFC relative poses
    /// (Z-up → Three.js Y-up). Returns false for single-member assemblies.
    /// Built-up COLUMN (FLANGE + STIFFENER + WEB plates) keeps parts as plates.
    /// Rolled IPE/HEA beams stay I-beam. Profile dims preferred over AABB inflate.
    /// </summary>
    private static bool TryBuildAssemblyParts(
        List<int> partIds,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        Dictionary<int, PropertySet> psets,
        Dictionary<int, List<int>> entityToPsets,
        out List<AssemblyPart> parts,
        out double envLengthMm,
        out double envWidthMm,
        out double envHeightMm)
    {
        parts = new List<AssemblyPart>();
        envLengthMm = envWidthMm = envHeightMm = 0;

        var raw = new List<(
            int ProductId,
            string Name, string IfcType, string ProfileDesc, ProfileSection? Section,
            double MinX, double MinY, double MinZ, double MaxX, double MaxY, double MaxZ,
            double Len, double Wid, double Hei,
            Xform? FrameIfc, double ExtX, double ExtY, double ExtZ, bool IsExtruded)>();

        foreach (var pid in partIds)
        {
            if (!entities.TryGetValue(pid, out var part)) continue;
            var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
            string name = partArgs.Count > 2 ? StepParser.Unwrap(partArgs[2]) as string ?? "" : "";
            string desc = partArgs.Count > 3 ? StepParser.Unwrap(partArgs[3]) as string ?? "" : "";

            var tq = GetPsetByName(pid, "Tekla Quantity", entityToPsets, psets);
            var bq = GetPsetByName(pid, "BaseQuantities", entityToPsets, psets);
            double GetQ(string key) =>
                (tq.TryGetValue(key, out var a) && a is double ad) ? ad
                : (bq.TryGetValue(key, out var b) && b is double bd) ? bd : 0;

            double len = GetQ("Length");
            double wid = GetQ("Width");
            double hei = GetQ("Height");
            if (hei <= 0) hei = wid;

            // World AABB = Representation × ObjectPlacement (real relative poses).
            var bounds = ProductWorldBounds(pid, entities);

            Xform? frame = null;
            double ex = 0, ey = 0, ez = 0;
            bool isExtruded = false;
            if (TryProductOrientedFrame(pid, entities, out var fr, out ex, out ey, out ez, out isExtruded))
                frame = fr;

            if (bounds == null && len <= 0 && frame == null) continue;

            if (bounds != null)
            {
                double sx = bounds.Value.MaxX - bounds.Value.MinX;
                double sy = bounds.Value.MaxY - bounds.Value.MinY;
                double sz = bounds.Value.MaxZ - bounds.Value.MinZ;
                if (len <= 0) len = Math.Max(sx, Math.Max(sy, sz));
                if (wid <= 0 || hei <= 0)
                {
                    var cross = new[] { sx, sy, sz }.OrderByDescending(v => v).ToArray();
                    if (wid <= 0) wid = cross.Length > 1 ? cross[1] : cross[0];
                    if (hei <= 0) hei = cross.Length > 2 ? cross[2] : wid;
                }
            }
            else if (frame != null)
            {
                bounds = (
                    frame.Tx - ex / 2, frame.Ty - ey / 2, frame.Tz - ez / 2,
                    frame.Tx + ex / 2, frame.Ty + ey / 2, frame.Tz + ez / 2);
                if (len <= 0) len = Math.Max(ex, Math.Max(ey, ez));
            }
            else
            {
                // Quantity-only fallback: no absolute pose — centre at origin
                bounds = (-len / 2, -wid / 2, -hei / 2, len / 2, wid / 2, hei / 2);
            }

            var b = bounds.Value;

            if (string.IsNullOrWhiteSpace(desc) && !string.IsNullOrWhiteSpace(name))
                desc = name;
            var sect = ProfileDescParser.Parse(desc);

            // Tekla plate thickness: prefer Quantity min(Width,Height) when thin, else AABB min
            double plateThickFromQty = 0;
            if (wid > 0 && hei > 0)
            {
                double qmin = Math.Min(wid, hei);
                double qmax = Math.Max(wid, hei);
                if (qmin <= 80 && qmax >= qmin * 3) plateThickFromQty = qmin;
            }
            // PL6×500 style in description
            if (plateThickFromQty <= 0 && sect?.T > 0) plateThickFromQty = sect.T;
            if (plateThickFromQty <= 0 && sect?.ShapeKey == "plate" && sect.H > 0 && sect.H <= 80)
                plateThickFromQty = sect.H;

            // FLANGE / STIFFENER / WEB / PLT — always plate (built-up column parts)
            bool nameIsPlate = IsBuiltUpPlateName(name, desc);
            if ((sect == null || string.IsNullOrEmpty(sect.ShapeKey) || nameIsPlate)
                && (nameIsPlate || part.Type is "IFCPLATE" or "IFCPLATESTANDARDCASE"))
            {
                double t = plateThickFromQty;
                if (t <= 0)
                {
                    var e = new[] { b.MaxX - b.MinX, b.MaxY - b.MinY, b.MaxZ - b.MinZ };
                    t = e.Where(v => v > 0.05).DefaultIfEmpty(e.Min()).Min();
                }
                if (t > 0)
                    sect = new ProfileSection { ShapeKey = "plate", H = t, W = Math.Max(wid, hei), T = t, Raw = desc };
            }

            raw.Add((
                pid,
                name, part.Type, desc, sect,
                b.MinX, b.MinY, b.MinZ,
                b.MaxX, b.MaxY, b.MaxZ,
                len, wid, hei,
                frame, ex, ey, ez, isExtruded
            ));
        }

        if (raw.Count < 2) return false;

        // Plate-built when Tekla FL/WB marks present (rafter/column shop assembly)
        bool isBuiltUpColumn = raw.Any(r => IsTeklaFlangeMark(r.Name, r.ProfileDesc)
            || IsTeklaWebMark(r.Name, r.ProfileDesc)
            || NameHasFlangeOrStiffener(r.Name, r.ProfileDesc));
        bool assemblyHasRolledI = raw.Any(r => HasRolledIProfile(r.Section, r.ProfileDesc))
            && !raw.Any(r => IsTeklaFlangeMark(r.Name, r.ProfileDesc) || IsTeklaWebMark(r.Name, r.ProfileDesc));

        double uMinX = raw.Min(r => r.MinX), uMaxX = raw.Max(r => r.MaxX);
        double uMinY = raw.Min(r => r.MinY), uMaxY = raw.Max(r => r.MaxY);
        double uMinZ = raw.Min(r => r.MinZ), uMaxZ = raw.Max(r => r.MaxZ);
        double cx = (uMinX + uMaxX) * 0.5;
        double cy = (uMinY + uMaxY) * 0.5;
        double cz = (uMinZ + uMaxZ) * 0.5;

        envLengthMm = Math.Max(1, uMaxX - uMinX);
        envHeightMm = Math.Max(1, uMaxZ - uMinZ);
        envWidthMm  = Math.Max(1, uMaxY - uMinY);

        foreach (var r in raw)
        {
            double pcx = (r.MinX + r.MaxX) * 0.5;
            double pcy = (r.MinY + r.MaxY) * 0.5;
            double pcz = (r.MinZ + r.MaxZ) * 0.5;
            double sx = Math.Max(1, r.MaxX - r.MinX);
            double sy = Math.Max(1, r.MaxY - r.MinY);
            double sz = Math.Max(1, r.MaxZ - r.MinZ);
            var ext = new[] { sx, sy, sz }.OrderByDescending(v => v).ToArray();

            bool isPlate = r.IfcType is "IFCPLATE" or "IFCPLATESTANDARDCASE"
                || (r.Section?.ShapeKey == "plate")
                || IsTeklaFlangeMark(r.Name, r.ProfileDesc)
                || IsTeklaWebMark(r.Name, r.ProfileDesc)
                || IsTeklaStiffOrEndMark(r.Name, r.ProfileDesc)
                || (IsBuiltUpPlateName(r.Name, r.ProfileDesc) && !HasRolledIProfile(r.Section, r.ProfileDesc));

            // Plate-built rafter/column: force plate parts (FL/WB/PL), not fake rolled I
            if (!isPlate && isBuiltUpColumn && !assemblyHasRolledI)
                isPlate = true;

            // Real IPE/HEA only — never demote when Tekla FL/WB marks define the build
            if (assemblyHasRolledI && HasRolledIProfile(r.Section, r.ProfileDesc))
                isPlate = false;
            if (IsTeklaFlangeMark(r.Name, r.ProfileDesc) || IsTeklaWebMark(r.Name, r.ProfileDesc)
                || IsTeklaStiffOrEndMark(r.Name, r.ProfileDesc))
                isPlate = true;

            bool isBeamLike = !isPlate && (
                r.IfcType is "IFCBEAM" or "IFCBEAMSTANDARDCASE"
                    or "IFCCOLUMN" or "IFCCOLUMNSTANDARDCASE"
                    or "IFCMEMBER" or "IFCMEMBERSTANDARDCASE"
                || (r.Section?.ShapeKey is "i_beam" or "rhs"));

            var sect = r.Section;
            if (!isPlate && isBeamLike && (sect == null || string.IsNullOrEmpty(sect.ShapeKey) || sect.ShapeKey == "unknown"))
            {
                sect = new ProfileSection
                {
                    ShapeKey = "i_beam",
                    Raw = r.ProfileDesc,
                    H = ext.Length > 1 ? ext[1] : ext[0],
                    W = ext.Length > 2 ? ext[2] : Math.Max(ext[0] * 0.4, 50),
                    Tf = 0,
                    Tw = 0,
                };
            }

            double rotX = 0, rotY = 0, rotZ = 0;
            double length, height, width;
            bool useProfileMesh = false;

            if (isPlate)
            {
                // Prefer oriented local extents (exact plate pose) over world AABB
                if (r.FrameIfc != null && r.ExtX > 0.5)
                {
                    length = r.ExtX;
                    height = r.ExtY;
                    width = r.ExtZ;
                    double thick = (sect?.T > 0) ? sect.T
                        : (sect?.H > 0 && sect.H <= 80) ? sect.H
                        : Math.Min(length, Math.Min(height, width));
                    // Snap thinnest local axis to Tekla thickness
                    if (thick > 0.5)
                    {
                        if (length <= height && length <= width) length = thick;
                        else if (height <= width) height = thick;
                        else width = thick;
                    }
                    if (sect == null || sect.ShapeKey != "plate")
                        sect = new ProfileSection { ShapeKey = "plate", H = thick, W = Math.Max(length, width), T = thick, Raw = r.ProfileDesc };
                }
                else
                {
                    double thick = (sect?.T > 0) ? sect.T
                        : (sect?.H > 0 && sect.H <= 80) ? sect.H
                        : Math.Min(sx, Math.Min(sy, sz));
                    length = Math.Max(sx, Math.Max(sy, sz));
                    width = new[] { sx, sy, sz }.OrderByDescending(v => v).Skip(1).FirstOrDefault();
                    if (width <= 0) width = length;
                    height = thick;
                    if (sect == null || sect.ShapeKey != "plate")
                        sect = new ProfileSection { ShapeKey = "plate", H = thick, W = width, T = thick, Raw = r.ProfileDesc };
                    else if (sect.T <= 0)
                    {
                        sect.T = thick;
                        sect.H = thick;
                    }
                }
                rotX = rotY = rotZ = 0;
            }
            else if (sect != null && sect.H > 0)
            {
                useProfileMesh = sect.ShapeKey is "i_beam" or "c_channel" or "z_channel" or "l_angle" or "rhs";
                length = r.Len > 0 ? r.Len : (r.IsExtruded ? Math.Max(r.ExtZ, ext[0]) : ext[0]);
                height = sect.H;
                width = sect.W > 0 ? sect.W
                      : Math.Max(height * 0.35, Math.Max(sect.T * 12, 20));
            }
            else if (isBeamLike)
            {
                useProfileMesh = true;
                length = r.Len > 0 ? r.Len : ext[0];
                height = ext.Length > 1 ? ext[1] : ext[0];
                width = ext.Length > 2 ? ext[2] : Math.Max(height * 0.4, 50);
            }
            else if (r.Hei > 0 && r.Wid > 0)
            {
                length = r.Len > 0 ? r.Len : ext[0];
                height = Math.Max(r.Hei, r.Wid);
                width = Math.Min(r.Hei, r.Wid);
                if (ext.Length >= 3 && ext[1] > 50 && ext[1] < length * 0.5)
                {
                    height = ext[1];
                    width = ext[2];
                }
            }
            else
            {
                length = ext[0];
                height = ext.Length > 1 ? ext[1] : ext[0];
                width = ext.Length > 2 ? ext[2] : height;
            }

            // Fallback Euler when no IFC matrix (legacy)
            if (!isPlate && r.FrameIfc == null)
            {
                if (sz >= sx && sz >= sy) rotZ = Math.PI / 2;
                else if (sy >= sx && sy >= sz) rotY = -Math.PI / 2;
            }

            double[] transform = Array.Empty<double>();
            bool hasXf = false;
            double slopeDeg = 0;
            if (r.FrameIfc != null)
            {
                // Plates / boxes: mesh axes = solid local axes (Identity remap)
                // Profile extrusions: mesh X=length → IFC extrude Z
                var meshFrame = ComposeMeshFrame(r.FrameIfc, useProfileMesh && r.IsExtruded);
                transform = FrameToThreeMatrix(meshFrame, cx, cy, cz);
                hasXf = true;
                // Pitch of local X (length) vs horizontal in Three Y-up: use remapped Y component
                double fx = transform[0], fy = transform[1], fz = transform[2];
                double flen = Math.Sqrt(fx * fx + fy * fy + fz * fz);
                if (flen > 1e-9)
                    slopeDeg = Math.Asin(Math.Clamp(fy / flen, -1, 1)) * 180.0 / Math.PI;
            }

            string partKind = "other";
            if (IsTeklaWebMark(r.Name, r.ProfileDesc)) partKind = "web";
            else if (IsTeklaFlangeMark(r.Name, r.ProfileDesc)) partKind = "flange";
            else if (IsTeklaStiffOrEndMark(r.Name, r.ProfileDesc)) partKind = "stiff";
            else if (isPlate) partKind = "plate";

            double thickMm = sect?.T > 0 ? sect.T
                : Math.Min(length, Math.Min(height, width));

            var profilePts = new List<double[]>();
            double profileExtrude = 0;
            // Web-first: capture IFC face profile (tapered trapezoid etc.) when available
            if (partKind is "web" or "flange" or "plate" or "stiff")
            {
                if (TryExtractExtrudedFaceProfile(r.ProductId, entities, out profilePts, out profileExtrude)
                    && profileExtrude > 0.5)
                {
                    if (thickMm < 0.5 || Math.Abs(thickMm - profileExtrude) / Math.Max(thickMm, profileExtrude) > 0.5)
                        thickMm = profileExtrude;
                }

                // Plate thickness is typically 3–80 mm. Never keep web-height as "T".
                if (thickMm > 80)
                {
                    if (profileExtrude > 0.5 && profileExtrude <= 80)
                        thickMm = profileExtrude;
                    else
                    {
                        var thinAxes = new[] { length, height, width }
                            .Where(v => v > 0.5 && v <= 80).ToArray();
                        if (thinAxes.Length > 0)
                            thickMm = thinAxes.Min();
                    }
                }

                // Snap thinnest mesh axis to true plate thickness (rafter/column FL/WB)
                if (thickMm > 0.5 && thickMm <= 80)
                {
                    if (length <= height && length <= width) length = thickMm;
                    else if (height <= width) height = thickMm;
                    else width = thickMm;
                    if (sect != null)
                    {
                        sect.T = thickMm;
                        if (sect.ShapeKey == "plate" || string.IsNullOrEmpty(sect.ShapeKey))
                            sect.H = thickMm;
                    }
                }
            }

            parts.Add(new AssemblyPart
            {
                Name = r.Name,
                IfcType = r.IfcType,
                ProfileDesc = r.ProfileDesc,
                Section = sect,
                LengthMm = Math.Max(1, length),
                WidthMm = Math.Max(1, width),
                HeightMm = Math.Max(1, height),
                // IFC Z-up → Three.js Y-up
                OffsetXMm = pcx - cx,
                OffsetYMm = pcz - cz,
                OffsetZMm = pcy - cy,
                BoxXMm = sx,
                BoxYMm = sz,
                BoxZMm = sy,
                RotX = rotX,
                RotY = rotY,
                RotZ = rotZ,
                HasIfcTransform = hasXf,
                Transform = transform,
                PartKind = partKind,
                ThicknessMm = Math.Max(0, thickMm),
                SlopeDeg = slopeDeg,
                ProfilePointsMm = profilePts,
                ProfileExtrudeMm = profileExtrude,
                IfcEntityId = r.ProductId,
            });
        }

        // Web-first design: WEB parts before flanges / stiffeners / others
        parts = parts
            .OrderBy(p => p.PartKind switch
            {
                "web" => 0,
                "flange" => 1,
                "plate" => 2,
                "stiff" => 3,
                _ => 4
            })
            .ToList();

        return parts.Count >= 2;
    }

    /// <summary>
    /// IFCEXTRUDEDAREASOLID SweptArea → centred 2D profile + extrude depth (often plate thickness).
    /// Used so web can be designed from real IFC face shape (incl. taper), not only AABB box.
    /// </summary>
    private static bool TryExtractExtrudedFaceProfile(
        int productId,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        out List<double[]> profileXyMm,
        out double extrudeMm)
    {
        profileXyMm = new List<double[]>();
        extrudeMm = 0;
        if (!entities.TryGetValue(productId, out var part)) return false;
        var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
        int? reprId = null;
        if (partArgs.Count > 6 && StepParser.Unwrap(partArgs[6]) is StepRef reprRef)
            reprId = reprRef.Id;
        if (reprId == null) return false;

        if (!TryFindPrimaryExtrusion(reprId.Value, entities, out _, out double depth, out _))
            return false;
        if (depth < 0.5) return false;

        // Re-find swept area entity to harvest profile points in local 2D
        var visited = new HashSet<int>();
        var stack = new Stack<(int Id, int Depth)>();
        stack.Push((reprId.Value, 0));
        int? areaId = null;
        while (stack.Count > 0)
        {
            var (eid, d) = stack.Pop();
            if (d > 80 || !visited.Add(eid) || !entities.TryGetValue(eid, out var e)) continue;
            if (e.Type is "IFCEXTRUDEDAREASOLID" or "IFCEXTRUDEDAREASOLIDTAPERED")
            {
                var a = StepParser.SplitTopLevel(e.ArgsRaw);
                if (a.Count > 0 && StepParser.Unwrap(a[0]) is StepRef areaRef)
                {
                    areaId = areaRef.Id;
                    break;
                }
            }
            foreach (var arg in StepParser.SplitTopLevel(e.ArgsRaw))
                CollectRefs(StepParser.Unwrap(arg), stack, d + 1);
        }
        if (areaId == null) return false;

        var rawPts = new List<(double X, double Y, double Z)>();
        CollectGeomPoints(areaId.Value, Xform.Identity, entities, rawPts, new HashSet<int>(), 0);
        if (rawPts.Count < 3) return false;

        // Drop near-duplicate points; keep XY (profile plane — Z usually ~0)
        var uniq = new List<(double X, double Y)>();
        foreach (var p in rawPts)
        {
            bool dup = uniq.Any(q => Math.Abs(q.X - p.X) < 0.05 && Math.Abs(q.Y - p.Y) < 0.05);
            if (!dup) uniq.Add((p.X, p.Y));
        }
        if (uniq.Count < 3) return false;

        double cx = uniq.Average(p => p.X);
        double cy = uniq.Average(p => p.Y);
        double maxProf = 0;
        foreach (var p in uniq)
        {
            profileXyMm.Add(new[] { p.X - cx, p.Y - cy });
            maxProf = Math.Max(maxProf, Math.Max(Math.Abs(p.X - cx), Math.Abs(p.Y - cy)));
        }

        // Face plate: thin extrude through large profile. If depth is the long span, skip (use box).
        if (depth > Math.Max(100, maxProf * 0.35))
        {
            profileXyMm.Clear();
            extrudeMm = 0;
            return false;
        }

        extrudeMm = depth;
        return true;
    }

    private static void CollectRefs(object? val, Stack<int> toVisit)
    {
        if (val is StepRef r) toVisit.Push(r.Id);
        else if (val is List<object?> list)
            foreach (var v in list) CollectRefs(v, toVisit);
    }

    /// <summary>
    /// Tekla SAG_ROD_ASSY / bent sag names — used by STEP + xBIM convert.
    /// </summary>
    internal static bool IsBentSagRodName(string name, string profileDesc)
    {
        var n = $"{name} {profileDesc}".ToUpperInvariant();
        if (System.Text.RegularExpressions.Regex.IsMatch(n,
            @"BEND_?SAG|BENT_?SAG|SAG_?BEND|SAG_?BENT|BENDSAGROD|BENTSAGROD"))
            return true;
        // SAG_ROD_ASSY / SAGROD / SAG ROD (PEB sag rod assembly — bent bar, not straight)
        if (System.Text.RegularExpressions.Regex.IsMatch(n,
            @"SAG[_\s-]*ROD|SAGROD"))
            return true;
        return false;
    }

    /// <summary>
    /// Bent sag rod only: pull IFC centerline (polyline / swept-disk / Brep medial) + diameter.
    /// Orient bend into Three X/Y plane, centre on AABB, stamp onto the item.
    /// </summary>
    private static void TryAttachBentSagRod(
        SteelItem item, int productId,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        string name, string profileDesc)
    {
        if (!IsBentSagRodName(name, profileDesc) && !IsBentSagRodName(item.AssemblyName, item.ProfileDesc)
            && !IsBentSagRodName(item.AssmMark, "")
            && !IsBentSagRodName(item.AssmMark, item.AssemblyName))
            return;

        double diam = 0;
        if (item.Section != null
            && item.Section.ShapeKey is "rod" or "bent_sag_rod"
            && item.Section.H > 0)
            diam = item.Section.H;
        var parsed = ProfileDescParser.Parse(profileDesc);
        if (diam <= 0 && parsed?.ShapeKey == "rod" && parsed.H > 0) diam = parsed.H;
        // ROD12 in description / name
        var rodM = System.Text.RegularExpressions.Regex.Match(
            $"{profileDesc} {name}", @"ROD\s*(\d+(?:\.\d+)?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (diam <= 0 && rodM.Success) diam = double.Parse(rodM.Groups[1].Value);

        var pathIfc = ExtractCenterlineWorld(productId, entities, out double diskRadius);
        if (diskRadius > 0 && diam <= 0) diam = diskRadius * 2;
        if (diam <= 0)
        {
            double w = item.WidthMm, h = item.HeightMm;
            var dims = new[] { item.LengthMm, w, h }.Where(v => v > 0).OrderBy(v => v).ToArray();
            if (dims.Length > 0 && dims[0] <= 40) diam = dims[0];
            else diam = 12;
        }
        diam = Math.Max(6, Math.Min(diam, 40));

        List<(double X, double Y, double Z)> threePts;
        if (pathIfc != null && pathIfc.Count >= 3)
        {
            // Keep IFC bend lengths/angles; only reorient so end drops VERTICAL (not Z, not flat U)
            threePts = OrientIfcPathToVerticalEndSilhouette(pathIfc);
        }
        else
        {
            threePts = BuildDoglegFallback(item.LengthMm, item.WidthMm, item.HeightMm, diam);
        }

        if (threePts.Count < 3) return;

        double minX = threePts.Min(p => p.X), maxX = threePts.Max(p => p.X);
        double minY = threePts.Min(p => p.Y), maxY = threePts.Max(p => p.Y);
        double minZ = threePts.Min(p => p.Z), maxZ = threePts.Max(p => p.Z);
        double cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;

        item.PathPointsMm = threePts
            .Select(p => new[] { p.X - cx, p.Y - cy, p.Z - cz })
            .ToList();
        item.PathDiamMm = diam;

        // Exact envelope from path (+ diameter)
        item.LengthMm = Math.Max(1, maxX - minX + diam);
        item.HeightMm = Math.Max(1, maxY - minY + diam);
        item.WidthMm = Math.Max(diam, maxZ - minZ + diam);

        // Single bent rod — never nest under plate-assembly renderer
        item.IsAssembly = false;
        item.Parts.Clear();

        item.Section = new ProfileSection
        {
            ShapeKey = "bent_sag_rod",
            Raw = string.IsNullOrWhiteSpace(profileDesc) ? $"ROD{diam:0}" : profileDesc,
            H = diam,
            W = diam,
            T = diam,
        };
        item.Remarks += $" [bent sag rod ∅{diam:0} ×{item.PathPointsMm.Count}pts IFC path]";
    }

    /// <summary>
    /// Reorient IFC centerline (preserve lengths &amp; angles) so the tip stub drops VERTICAL
    /// and the long body runs along +X — shop silhouette, not a flat Z or shallow U.
    /// </summary>
    private static List<(double X, double Y, double Z)> OrientIfcPathToVerticalEndSilhouette(
        List<(double X, double Y, double Z)> raw)
    {
        var corners = SimplifyCenterline(raw, 8.0);
        if (corners.Count < 3) corners = raw.ToList();
        if (corners.Count < 3) return BuildDoglegFallback(500, 300, 300, 12);

        // Prefer shorter end stub last (vertical candidate)
        double firstLen = Dist3(corners[0], corners[1]);
        double lastLen = Dist3(corners[^2], corners[^1]);
        if (firstLen < lastLen * 0.75)
            corners.Reverse();

        var p0 = corners[0];
        var pA = corners[^2];
        var pB = corners[^1];
        double ex = pB.X - pA.X, ey = pB.Y - pA.Y, ez = pB.Z - pA.Z;
        double eLen = Math.Sqrt(ex * ex + ey * ey + ez * ez);
        if (eLen < 1e-6) return CanonicalizeBentSagSilhouette(raw);
        ex /= eLen; ey /= eLen; ez /= eLen;

        double bx = pA.X - p0.X, by = pA.Y - p0.Y, bz = pA.Z - p0.Z;
        double bLen = Math.Sqrt(bx * bx + by * by + bz * bz);
        if (bLen < 1e-6) return CanonicalizeBentSagSilhouette(raw);
        bx /= bLen; by /= bLen; bz /= bLen;

        // Y' = −endDir (tip points down); X' = body projected ⊥ Y'
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

    /// <summary>
    /// Rebuild bent-sag as shop silhouette using IFC segment lengths + bend angle:
    /// short near-horizontal → long steep diagonal → short VERTICAL drop (not a Z).
    /// </summary>
    private static List<(double X, double Y, double Z)> CanonicalizeBentSagSilhouette(
        List<(double X, double Y, double Z)> raw)
    {
        var corners = SimplifyCenterline(raw, 8.0);
        if (corners.Count < 3) corners = raw;

        var segs = new List<double>();
        for (int i = 1; i < corners.Count; i++)
            segs.Add(Dist3(corners[i - 1], corners[i]));

        double L1, L2, L3, diagAngleDeg;

        if (segs.Count >= 3)
        {
            L1 = segs[0];
            L3 = segs[^1];
            L2 = segs.Skip(1).Take(segs.Count - 2).Sum();
            if (L2 < segs.Max() * 0.45)
            {
                // Longest is the diagonal body
                int mid = 0;
                for (int i = 1; i < segs.Count; i++)
                    if (segs[i] > segs[mid]) mid = i;
                L2 = segs[mid];
                L1 = segs[0];
                L3 = segs[^1];
            }

            // Diagonal angle from IFC: find segment with largest "rise/run"
            double bestAng = 45, bestLen = -1;
            for (int i = 1; i < corners.Count; i++)
            {
                double dx = corners[i].X - corners[i - 1].X;
                double dy = corners[i].Y - corners[i - 1].Y;
                double dz = corners[i].Z - corners[i - 1].Z;
                double len = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                if (len < bestLen) continue;
                var comps = new[] { Math.Abs(dx), Math.Abs(dy), Math.Abs(dz) }.OrderByDescending(v => v).ToArray();
                double horiz = comps[0];
                double vert = comps.Length > 1 ? comps[1] : 0;
                bestAng = horiz < 1e-6 ? 90 : Math.Atan2(vert, horiz) * 180.0 / Math.PI;
                bestLen = len;
            }
            diagAngleDeg = bestAng;
        }
        else if (segs.Count == 2)
        {
            double shortL = Math.Min(segs[0], segs[1]);
            L2 = Math.Max(segs[0], segs[1]);
            L1 = shortL * 0.4;
            L3 = shortL * 0.6;
            diagAngleDeg = 50;
        }
        else
        {
            return BuildDoglegFallback(500, 300, 300, 12);
        }

        L1 = Math.Max(L1, 30);
        L2 = Math.Max(L2, L1 * 1.5);
        L3 = Math.Max(L3, 30);
        // Steep diagonal like the reference (not flat Z)
        if (diagAngleDeg < 35) diagAngleDeg = 48;
        if (diagAngleDeg > 75) diagAngleDeg = 62;
        double th = diagAngleDeg * Math.PI / 180.0;
        double a1 = 10 * Math.PI / 180.0; // slight top slope

        // Y-up silhouette; last leg VERTICAL
        double y0 = L1 * Math.Sin(a1) + L2 * Math.Sin(th) + L3;
        double x1 = L1 * Math.Cos(a1);
        double y1 = y0 - L1 * Math.Sin(a1);
        double x2 = x1 + L2 * Math.Cos(th);
        double y2 = y1 - L2 * Math.Sin(th);

        return new List<(double, double, double)>
        {
            (0, y0, 0),
            (x1, y1, 0),
            (x2, y2, 0),
            (x2, y2 - L3, 0), // vertical end
        };
    }

    private static double Dist3((double X, double Y, double Z) a, (double X, double Y, double Z) b)
    {
        double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
        return Math.Sqrt(dx * dx + dy * dy + dz * dz);
    }

    /// <summary>Fallback silhouette — short / diagonal / VERTICAL (not Z).</summary>
    private static List<(double X, double Y, double Z)> BuildDoglegFallback(
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
        double th = Math.Atan2(rise, run);
        double a1 = 10 * Math.PI / 180.0;

        double y0 = L1 * Math.Sin(a1) + rise + L3;
        double x1 = L1 * Math.Cos(a1);
        double y1 = y0 - L1 * Math.Sin(a1);
        double x2 = x1 + run;
        double y2 = L3;
        return new List<(double, double, double)>
        {
            (0, y0, 0),
            (x1, y1, 0),
            (x2, y2, 0),
            (x2, 0, 0), // vertical end
        };
    }

    private static List<(double X, double Y, double Z)> SimplifyCenterline(
        List<(double X, double Y, double Z)> pts, double minCornerDeg)
    {
        if (pts.Count <= 3) return pts;
        var keep = new List<(double X, double Y, double Z)> { pts[0] };
        for (int i = 1; i < pts.Count - 1; i++)
        {
            var a = pts[i - 1]; var b = pts[i]; var c = pts[i + 1];
            double ax = b.X - a.X, ay = b.Y - a.Y, az = b.Z - a.Z;
            double bx = c.X - b.X, by = c.Y - b.Y, bz = c.Z - b.Z;
            double la = Math.Sqrt(ax * ax + ay * ay + az * az);
            double lb = Math.Sqrt(bx * bx + by * by + bz * bz);
            if (la < 1e-6 || lb < 1e-6) continue;
            double dot = (ax * bx + ay * by + az * bz) / (la * lb);
            dot = Math.Clamp(dot, -1, 1);
            double deg = Math.Acos(dot) * 180.0 / Math.PI;
            if (deg >= minCornerDeg) keep.Add(b);
        }
        keep.Add(pts[^1]);
        return keep.Count >= 3 ? keep : pts;
    }

    /// <summary>
    /// World-space centerline of a bent rod: SweptDiskSolid directrix, or longest polyline.
    /// </summary>
    private static List<(double X, double Y, double Z)>? ExtractCenterlineWorld(
        int productId, Dictionary<int, (string Type, string ArgsRaw)> entities, out double radius)
    {
        radius = 0;
        if (!entities.TryGetValue(productId, out var part)) return null;
        var partArgs = StepParser.SplitTopLevel(part.ArgsRaw);
        Xform place = Xform.Identity;
        if (partArgs.Count > 5 && StepParser.Unwrap(partArgs[5]) is StepRef placeRef)
            place = ResolveLocalPlacement(placeRef.Id, entities);
        int? reprId = null;
        if (partArgs.Count > 6 && StepParser.Unwrap(partArgs[6]) is StepRef reprRef)
            reprId = reprRef.Id;
        if (reprId == null) return null;

        List<(double X, double Y, double Z)>? best = null;
        double bestLen = -1;
        double foundR = 0;
        var visited = new HashSet<int>();
        WalkForCenterline(reprId.Value, place, entities, visited, 0, ref best, ref bestLen, ref foundR);
        if (best != null && best.Count >= 3)
        {
            radius = foundR;
            return best;
        }

        // Tekla BEND_SAGROD is FacetedBrep — no polyline. Derive medial path from point cloud.
        var cloud = new List<(double X, double Y, double Z)>();
        CollectGeomPoints(reprId.Value, place, entities, cloud, new HashSet<int>(), 0);
        var medial = CenterlineFromPointCloud(cloud, foundR > 0 ? foundR * 2 : 12);
        radius = foundR;
        return medial;
    }

    /// <summary>
    /// Medial centerline for a thin bent rod Brep: bin along longest AABB axis, centroid per bin.
    /// </summary>
    private static List<(double X, double Y, double Z)>? CenterlineFromPointCloud(
        List<(double X, double Y, double Z)> pts, double diamHint)
    {
        if (pts.Count < 8) return null;

        // Dedupe
        var uniq = new List<(double X, double Y, double Z)>();
        foreach (var p in pts)
        {
            bool near = false;
            foreach (var q in uniq)
            {
                double dx = p.X - q.X, dy = p.Y - q.Y, dz = p.Z - q.Z;
                if (dx * dx + dy * dy + dz * dz < 0.05 * 0.05) { near = true; break; }
            }
            if (!near) uniq.Add(p);
        }
        if (uniq.Count < 8) return null;

        double minX = uniq.Min(p => p.X), maxX = uniq.Max(p => p.X);
        double minY = uniq.Min(p => p.Y), maxY = uniq.Max(p => p.Y);
        double minZ = uniq.Min(p => p.Z), maxZ = uniq.Max(p => p.Z);
        double sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
        int axis = sx >= sy && sx >= sz ? 0 : sy >= sz ? 1 : 2;
        double span = axis == 0 ? sx : axis == 1 ? sy : sz;
        if (span < 1) return null;

        double binW = Math.Max(diamHint * 1.5, span / 16);
        var bins = new SortedDictionary<int, List<(double X, double Y, double Z)>>();
        foreach (var p in uniq)
        {
            double a = axis == 0 ? p.X : axis == 1 ? p.Y : p.Z;
            int k = (int)Math.Round(a / binW);
            if (!bins.TryGetValue(k, out var list)) bins[k] = list = new List<(double, double, double)>();
            list.Add(p);
        }
        if (bins.Count < 3) return null;

        var cents = new List<(double X, double Y, double Z)>();
        foreach (var kv in bins)
        {
            var list = kv.Value;
            cents.Add((
                list.Average(p => p.X),
                list.Average(p => p.Y),
                list.Average(p => p.Z)
            ));
        }
        return SimplifyCenterline(cents, 8.0);
    }

    private static void WalkForCenterline(
        int eid, Xform xf,
        Dictionary<int, (string Type, string ArgsRaw)> entities,
        HashSet<int> visited, int depth,
        ref List<(double X, double Y, double Z)>? best, ref double bestLen, ref double foundR)
    {
        if (depth > 120 || !visited.Add(eid) || !entities.TryGetValue(eid, out var e)) return;

        if (e.Type == "IFCSWEPTDISKSOLID")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            if (args.Count > 1 && StepParser.Unwrap(args[1]) is double r && r > 0)
                foundR = Math.Max(foundR, r);
            if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef dirRef)
            {
                var poly = ReadCurvePoints(dirRef.Id, xf, entities);
                ConsiderPoly(poly, ref best, ref bestLen);
            }
            return;
        }

        if (e.Type is "IFCPOLYLINE" or "IFCINDEXEDPOLYCURVE" or "IFCCOMPOSITECURVE")
        {
            var poly = ReadCurvePoints(eid, xf, entities);
            ConsiderPoly(poly, ref best, ref bestLen);
            return;
        }

        if (e.Type == "IFCCIRCLEPROFILEDEF" || e.Type == "IFCCIRCLEHOLLOWPROFILEDEF")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            // IFCCIRCLEPROFILEDEF(Position, Radius) — Radius often arg[2] or last number
            foreach (var a in args)
            {
                if (StepParser.Unwrap(a) is double r && r > 0 && r < 200)
                    foundR = Math.Max(foundR, r);
            }
        }

        if (e.Type == "IFCMAPPEDITEM")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            Xform mapXf = xf;
            if (args.Count > 1 && StepParser.Unwrap(args[1]) is StepRef targetRef)
            {
                var t = CartesianTransform3D(targetRef.Id, entities);
                if (t != null) mapXf = xf.Mul(t);
            }
            if (args.Count > 0 && StepParser.Unwrap(args[0]) is StepRef srcRef)
            {
                if (entities.TryGetValue(srcRef.Id, out var mapEnt) && mapEnt.Type == "IFCREPRESENTATIONMAP")
                {
                    var mapArgs = StepParser.SplitTopLevel(mapEnt.ArgsRaw);
                    Xform originXf = mapXf;
                    if (mapArgs.Count > 0 && StepParser.Unwrap(mapArgs[0]) is StepRef originRef)
                        originXf = mapXf.Mul(Axis2Placement3D(originRef.Id, entities));
                    if (mapArgs.Count > 1 && StepParser.Unwrap(mapArgs[1]) is StepRef mappedRep)
                        WalkForCenterline(mappedRep.Id, originXf, entities, visited, depth + 1, ref best, ref bestLen, ref foundR);
                    return;
                }
                WalkForCenterline(srcRef.Id, mapXf, entities, visited, depth + 1, ref best, ref bestLen, ref foundR);
            }
            return;
        }

        var childIds = new List<int>();
        foreach (var arg in StepParser.SplitTopLevel(e.ArgsRaw))
            CollectRefsInto(StepParser.Unwrap(arg), id => childIds.Add(id));
        foreach (var id in childIds)
            WalkForCenterline(id, xf, entities, visited, depth + 1, ref best, ref bestLen, ref foundR);
    }

    private static void ConsiderPoly(
        List<(double X, double Y, double Z)>? poly,
        ref List<(double X, double Y, double Z)>? best, ref double bestLen)
    {
        if (poly == null || poly.Count < 3) return;
        double len = 0;
        for (int i = 1; i < poly.Count; i++)
        {
            double dx = poly[i].X - poly[i - 1].X;
            double dy = poly[i].Y - poly[i - 1].Y;
            double dz = poly[i].Z - poly[i - 1].Z;
            len += Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
        if (len > bestLen)
        {
            bestLen = len;
            best = poly;
        }
    }

    private static List<(double X, double Y, double Z)>? ReadCurvePoints(
        int eid, Xform xf, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(eid, out var e)) return null;

        if (e.Type == "IFCPOLYLINE")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            if (args.Count == 0 || StepParser.Unwrap(args[0]) is not List<object?> pts) return null;
            var list = new List<(double X, double Y, double Z)>();
            foreach (var p in pts)
            {
                if (p is StepRef pr)
                {
                    var pt = ReadPoint3(pr.Id, entities);
                    if (pt != null) list.Add(xf.Apply(pt.Value.X, pt.Value.Y, pt.Value.Z));
                }
            }
            return list.Count >= 2 ? list : null;
        }

        if (e.Type == "IFCINDEXEDPOLYCURVE")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            if (args.Count == 0 || StepParser.Unwrap(args[0]) is not StepRef listRef) return null;
            return ReadPointList(listRef.Id, xf, entities);
        }

        if (e.Type == "IFCCOMPOSITECURVE")
        {
            var args = StepParser.SplitTopLevel(e.ArgsRaw);
            if (args.Count == 0 || StepParser.Unwrap(args[0]) is not List<object?> segs) return null;
            var list = new List<(double X, double Y, double Z)>();
            foreach (var s in segs)
            {
                if (s is not StepRef sr || !entities.TryGetValue(sr.Id, out var seg)) continue;
                // IFCCOMPOSITECURVESEGMENT(Transition, SameSense, ParentCurve)
                var segArgs = StepParser.SplitTopLevel(seg.ArgsRaw);
                if (segArgs.Count > 2 && StepParser.Unwrap(segArgs[2]) is StepRef parent)
                {
                    var sub = ReadCurvePoints(parent.Id, xf, entities);
                    if (sub == null) continue;
                    if (list.Count > 0 && sub.Count > 0) sub.RemoveAt(0); // avoid dup joint
                    list.AddRange(sub);
                }
            }
            return list.Count >= 2 ? list : null;
        }

        // IFCTRIMMEDCURVE / IFCLINE — sample endpoints via nested points
        if (e.Type is "IFCTRIMMEDCURVE" or "IFCBOUNDEDCURVE")
        {
            var pts = new List<(double X, double Y, double Z)>();
            CollectGeomPoints(eid, xf, entities, pts, new HashSet<int>(), 0);
            return pts.Count >= 2 ? pts : null;
        }

        return null;
    }

    private static List<(double X, double Y, double Z)>? ReadPointList(
        int eid, Xform xf, Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        if (!entities.TryGetValue(eid, out var e)) return null;
        // IFCCARTESIANPOINTLIST3D(( (x,y,z), ... ))
        var args = StepParser.SplitTopLevel(e.ArgsRaw);
        if (args.Count == 0 || StepParser.Unwrap(args[0]) is not List<object?> rows) return null;
        var list = new List<(double X, double Y, double Z)>();
        foreach (var row in rows)
        {
            if (row is List<object?> coords && coords.Count >= 3
                && coords[0] is double x && coords[1] is double y && coords[2] is double z)
                list.Add(xf.Apply(x, y, z));
            else if (row is StepRef pr)
            {
                var pt = ReadPoint3(pr.Id, entities);
                if (pt != null) list.Add(xf.Apply(pt.Value.X, pt.Value.Y, pt.Value.Z));
            }
        }
        return list.Count >= 2 ? list : null;
    }

    private static Dictionary<string, object?> GetPsetByName(
        int eid, string psetName,
        Dictionary<int, List<int>> entityToPsets,
        Dictionary<int, PropertySet> psets)
    {
        if (entityToPsets.TryGetValue(eid, out var pids))
        {
            foreach (var pid in pids)
            {
                if (psets.TryGetValue(pid, out var pset) && pset.Name == psetName)
                    return pset.Props;
            }
        }
        return new Dictionary<string, object?>();
    }

    /// <summary>
    /// Builds three lookup tables from the flat entity dictionary:
    ///   psets          : property-set entity id -> its name + {propName: value}
    ///   entityToPsets  : any entity id -> which property-set ids describe it
    ///                    (found via IFCRELDEFINESBYPROPERTIES)
    ///   entityToParts  : an assembly's entity id -> its constituent part ids
    ///                    (found via IFCRELAGGREGATES)
    /// </summary>
    private static (Dictionary<int, PropertySet> psets,
                    Dictionary<int, List<int>> entityToPsets,
                    Dictionary<int, List<int>> entityToParts)
        BuildIndices(Dictionary<int, (string Type, string ArgsRaw)> entities)
    {
        var psets = new Dictionary<int, PropertySet>();
        foreach (var kvp in entities)
        {
            if (kvp.Value.Type != "IFCPROPERTYSET") continue;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            if (args.Count < 5) continue;

            string name = StepParser.Unwrap(args[2]) as string ?? "";
            var propRefs = StepParser.Unwrap(args[4]) as List<object?> ?? new List<object?>();
            var props = new Dictionary<string, object?>();

            foreach (var refObj in propRefs)
            {
                if (refObj is not StepRef sref) continue;
                if (!entities.TryGetValue(sref.Id, out var pentity)) continue;
                if (pentity.Type != "IFCPROPERTYSINGLEVALUE") continue;

                var pargs = StepParser.SplitTopLevel(pentity.ArgsRaw);
                if (pargs.Count < 3) continue;
                if (StepParser.Unwrap(pargs[0]) is string pname)
                    props[pname] = StepParser.Unwrap(pargs[2]);
            }

            psets[kvp.Key] = new PropertySet { Name = name, Props = props };
        }

        var entityToPsets = new Dictionary<int, List<int>>();
        foreach (var kvp in entities)
        {
            if (kvp.Value.Type != "IFCRELDEFINESBYPROPERTIES") continue;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            if (args.Count < 6) continue;

            var related = StepParser.Unwrap(args[4]) as List<object?> ?? new List<object?>();
            if (StepParser.Unwrap(args[5]) is not StepRef pdefRef) continue;

            foreach (var r in related)
            {
                if (r is not StepRef rref) continue;
                if (!entityToPsets.TryGetValue(rref.Id, out var list))
                    entityToPsets[rref.Id] = list = new List<int>();
                list.Add(pdefRef.Id);
            }
        }

        var entityToParts = new Dictionary<int, List<int>>();
        foreach (var kvp in entities)
        {
            if (kvp.Value.Type != "IFCRELAGGREGATES") continue;
            var args = StepParser.SplitTopLevel(kvp.Value.ArgsRaw);
            if (args.Count < 6) continue;

            if (StepParser.Unwrap(args[4]) is not StepRef relObjRef) continue;
            var related = StepParser.Unwrap(args[5]) as List<object?> ?? new List<object?>();

            if (!entityToParts.TryGetValue(relObjRef.Id, out var list))
                entityToParts[relObjRef.Id] = list = new List<int>();

            foreach (var r in related)
                if (r is StepRef rref) list.Add(rref.Id);
        }

        return (psets, entityToPsets, entityToParts);
    }
}
