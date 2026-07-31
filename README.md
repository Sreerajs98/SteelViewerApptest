# Steel Container 3D Viewer - WinForms desktop app

A native Windows desktop app (WinForms, like AJM) with two buttons and an
embedded 3D view:

- **Upload Shipping List Excel...** - opens a file picker, reads the Excel
  with `ExcelReader.cs`, and pushes the parsed items straight into the 3D
  view. No manual JSON step, no separate browser window.
- **Quick view** - fast rough preview (items grouped by category, laid out
  compressed to fit).
- **Optimize packing** - runs the real 3D bin-packing algorithm (a shelf
  algorithm: height split into shelves, each shelf split into rows across
  the container's width, pieces laid end to end along the length within a
  row) and shows both weight and volume utilization.

Everything is driven from this one C# app - the 3D rendering itself runs in
an embedded WebView2 browser control (WinForms has no built-in 3D surface,
so this is the standard way to get real 3D inside a desktop app), but you
never leave the app window or touch a file picker for JSON.

## Requirements

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download)
- **WebView2 Runtime** - this ships pre-installed with Windows 10/11 and
  Edge, so most machines already have it. If the app shows a WebView2 error
  on first run, download the "Evergreen Runtime" from Microsoft's WebView2
  page and install it once.
- Internet access the first time you build (to restore NuGet packages)

## How to run

```bash
cd SteelViewerApp
dotnet restore
dotnet run
```

A window opens. Click **Upload Shipping List Excel...** and pick any
Shipping List file (a sample is included at
`SampleData/A1442-01-101-R0_Shipping_List.xlsx` if you just want to try it
immediately). The 3D view loads automatically in "Quick view" mode - click
**Optimize packing** to see the real packed arrangement.

## If `dotnet restore` can't find a package version

Open `SteelViewerApp.csproj` and remove the `Version="..."` attribute from
whichever `PackageReference` line is failing, then run `dotnet restore`
again - it will pull the latest available version instead.

## Project structure

```
SteelViewerApp/
  Program.cs                 - entry point
  MainForm.cs                 - the whole window: upload button, mode
                                 buttons, embedded WebView2, wiring
  Viewer3D.html                - the 3D view + both packing algorithms
                                 (JavaScript - this is where the 3D
                                 rendering and the shelf-packing optimizer
                                 actually run)
  Models/
    SteelItem.cs                 - one assembly row
    Container.cs                  - 40ft container defaults
  Services/
    ExcelReader.cs                  - parses the Shipping List xlsx layout
    ShapeCategorizer.cs              - detects beam/rod/plate/purlin from
                                        the assembly name text
    SceneBuilder.cs                    - packages items + container spec
                                          into the JSON the 3D view expects
  SampleData/
    A1442-01-101-R0_Shipping_List.xlsx  - your real file, for testing
```

## Adjusting the container spec

Edit `Models/Container.cs`:

```csharp
public double LengthMm { get; set; } = 12000;
public double WidthMm  { get; set; } = 2350;
public double HeightMm { get; set; } = 2690;
public double MaxWeightKg { get; set; } = 26000;
```

## Handling assembly names the categorizer doesn't recognise yet

`Services/ShapeCategorizer.cs` looks for keywords like COLUMN, RAFTER,
ROD, PLATE, PURLIN in the ASSEMBLY NAME column. As you run this against
other jobs, add any new assembly-name keywords you see there so those
items get colour-coded and shaped sensibly instead of falling into the
generic "other" bucket.

## Uploading an IFC file directly (no Excel, no Python)

Click **"Upload IFC..."** and pick a Tekla IFC export. This is parsed
natively in C# - `Services/StepParser.cs` reads the raw IFC/STEP text
directly (no xBIM, no external IFC library, no Python), and
`Services/IfcAssemblyReader.cs` pulls out exactly what's needed:

- `IfcElementAssembly` = one real shippable assembly. Its `ACERO_DATA`
  property set gives `ASSEMBLY_MARK` / `ASSEMBLY_NAME` directly (same
  meaning as the Excel's ASSM MARK / ASSEMBLY NAME).
- `Tekla Assembly` property set gives the assembly's real total weight
  (`Assembly/Cast unit weight`) - already includes welded-on plates,
  stiffeners, etc.
- Its main structural part carries a `Tekla Quantity` property set with
  exact `Height` / `Width` / `Length` in mm - computed by Tekla itself, not
  re-derived from a bounding-box guess the way the Excel's OVERALL SIZE
  text column had to be parsed.
- Bolts/washers (`IfcMechanicalFastener`) are excluded from the shipping
  envelope - they travel attached to the assembly, same as BuyOut List
  items were excluded in the Excel-based flow.

**One IFC file can cover an entire building across multiple phases** -
this is different from a Shipping List Excel, which is already scoped to a
single phase. If the app detects more than one phase in the file, a picker
dialog appears so you choose which phase you're actually shipping (or
"All phases combined").

### How the parser was validated before being trusted

This isn't a from-scratch parser shipped on faith. The exact extraction
logic (tokenize the STEP text -> find property sets -> find assembly parts
-> pick the main part -> read its quantities) was first prototyped in
Python and run against a real 5MB / 75,000-entity Tekla IFC export,
cross-checked item-by-item against `ifcopenshell` (the industry-standard
IFC library) - **every single one of the 1240 assemblies across all 6
phases matched exactly** (mark, length, width, height, and weight). Only
after that 100% match was the logic ported to the C# version above,
statement for statement.

### If a different Tekla export doesn't have "ACERO_DATA"

`ACERO_DATA` is a custom property set (specific to how this company's
Tekla models are configured) - a different project/template might not
include it. In that case `IfcAssemblyReader.Convert` falls back to
`Tekla Assembly`'s own "Assembly/Cast unit Mark" for the mark, and the
`IfcElementAssembly`'s own `Name` attribute for the assembly name - so it
should still mostly work, just without phase filtering (since `PHASE`
currently only comes from `ACERO_DATA`). If you hit an export that's
structured differently, share a sample and the property-set names can be
adjusted.

## Robustness improvements

**Property-set fallbacks.** Different Tekla export configurations name
property sets slightly differently. `IfcAssemblyReader.cs` now tries a
short list of candidates for each piece of data instead of assuming one
fixed name:
- Mark: `ACERO_DATA.ASSEMBLY_MARK` -> `Tekla Assembly."Assembly/Cast unit Mark"`
  -> a part's own `Reference` property (checked across
  `Pset_ColumnCommon`/`Pset_BeamCommon`/`Pset_MemberCommon`/`Pset_PlateCommon`)
  -> the assembly's own IFC `Name` attribute -> `ASM-<entityId>` as a last
  resort, so an assembly is never silently dropped just for lacking a mark.
- Weight: assembly-level `Assembly/Cast unit weight` -> summed from each
  part's own `Tekla Quantity.Weight` or `BaseQuantities.NetWeight`.
- Dimensions: each part's `Tekla Quantity` (Length/Width/Height) merged
  over `BaseQuantities` (Length, and whatever else is present) - so a part
  missing one property set still contributes whatever the other has.

**Data-quality validation.** Before anything reaches the packing algorithm
or the 3D scene, every item is checked for a genuinely invalid or garbage
value (missing, zero/negative, or absurdly large - over 50m or 50 tonnes,
sanity ceilings no real steel piece would exceed). Anything failing is
excluded and listed by mark in a "Data issues" panel instead of silently
producing a broken-looking 3D view.

**On "100% correct":** the IFC-reading logic itself (tokenize -> find
property sets -> find assembly parts -> pick the main part -> read its
quantities) was prototyped in Python first and cross-checked item-by-item
against `ifcopenshell` (the industry-standard IFC library) on a real
5MB/75,000-entity Tekla export - every one of 1240 assemblies across 6
phases matched exactly before the logic was ported to the C# above. That
proves the *algorithm* is sound for this export style. It cannot promise
every possible Tekla template/configuration in the world behaves
identically - that's exactly what the fallback chains and the data-quality
panel are for: when something doesn't match the primary property names,
the app tries the fallbacks, and if it still can't get a sane value, it
tells you exactly which mark and why, instead of guessing silently.

**On packing non-standard shapes (L-angles, tapered members):** the
packer works on each piece's bounding box, same as the real-world container
loading software this is modelled on. An L-angle's *true* cross-section
could nest into a corner more tightly than its bounding box suggests -
capturing that would mean exact non-rectangular collision geometry per
profile family, which is a genuinely different (and much bigger) problem
than container-level packing. The practical answer here is the manual
placement feature below: select any piece the algorithm placed
conservatively and nudge/rotate it into a tighter real-world position by
hand, with the app checking the result for you.

## Two-tier data extraction - property sets, then real geometry

Some Tekla export configurations skip the "Quantities" export option
entirely - no `Tekla Quantity`, no `Tekla Assembly`, no `BaseQuantities` on
any part, just the custom `ACERO_DATA` set (mark/name/phase) and a raw BRep
mesh for geometry. The earlier fallback chain still comes up empty in that
case, so there's a second tier:

**`GeometryBoundingBox` in `IfcAssemblyReader.cs`** walks a part's actual 3D
representation (whatever BRep/face/loop structure it uses - the exact
topology doesn't matter), collects every `IFCCARTESIANPOINT` coordinate
reachable from it, and takes that point cloud's own bounding box as
(length, width, height) - always assigning the largest extent to length,
since a real shippable steel piece is never wider/thicker than it is long.

Weight falls back the same way: if no assembly or part carries any real
weight, it's estimated as bounding-box volume x steel density (7850 kg/m3).
This is exact for flat plates (this is the case that actually came up: a
job built entirely from welded plate members, where each part genuinely
*is* a solid rectangular plate) and an overestimate for a genuinely hollow
rolled section - items using this estimate are marked
`[geometry (estimated)]` in their Remarks so it's never confused with a
real Tekla-calculated weight.

**Validated against two real, differently-configured exports** before
being trusted:
- A rich export (`Tekla Quantity`/`Tekla Assembly` present on every part):
  1240/1240 assemblies extracted via property sets, 0 via geometry, 0
  skipped - unchanged from before, confirming this tier doesn't interfere
  when good data already exists.
- A sparse export (no quantity property sets anywhere): 0/808 via property
  sets, 808/808 via geometry fallback, 0 skipped - where the old code found
  nothing for any assembly, matching exactly the "select this IFC and get
  no data" problem this tier was built to fix.

## Packing improvements - fewer containers, real nesting

Two upgrades aimed directly at "why does this need 3-5 containers when 1-2
should hold it":

**Best-fit across every open container.** The old algorithm tried
containers in the order they were created and grabbed the first one with
room anywhere. It now checks every open container and every valid spot in
each, and picks whichever leaves the least leftover space - opening a new
container only when a piece genuinely doesn't fit anywhere that already
exists.

**Two orientations per piece.** Every piece is tried both as-is and turned
90 degrees (its own width running along the container's length instead) -
whichever orientation actually fits somewhere is used. A piece only goes
to the oversized pile if neither orientation fits anywhere.

**Channel/purlin nesting.** A C-channel is open on one side, so identical
channels tuck partly inside each other rather than sitting fully side by
side (this is how they're genuinely stacked and shipped in practice).
Same-mark purlin/channel pieces are now merged into one nested bundle
before packing: the first channel needs its full width, and each
additional identical one only adds ~35% of a width instead of a whole one.
Tested on 20 identical 200mm-wide purlins: instead of needing 4000mm laid
flat side by side, the nested bundle needs about 1530mm - packed
accordingly, and rendered as several real channel cross-sections offset
into each other, not a single guessed-at wide box.

## Manual placement - select, move, rotate

Click any placed piece (in either Quick view or Optimize packing) to
select it. A control panel appears next to it:
- **Move** in 100mm steps along X/Y/Z.
- **Rotate** in 90-degree steps around X/Y/Z.
- A live **fit check** after every action - Three.js's own bounding-box
  math (which correctly accounts for the piece's current rotation, not an
  approximation) checks the piece against every other placed piece and
  against the container walls. It turns green ("Fits - no overlap") or red
  ("Doesn't fit - overlaps SGA301" / "...outside the container") so you
  always know before moving on.

Rotation is deliberately restricted to 90-degree steps: it keeps the fit
check exact (a box rotated by a multiple of 90 degrees is still an exact
axis-aligned box, no approximation needed) while covering the real case
that matters most - turning a piece to face a different way so it fits
better.

Switching between "Quick view" and "Optimize packing" rebuilds the scene
from scratch, so manual adjustments only persist within the current mode -
finish arranging in whichever mode you're using before switching.

## Known limitations (be upfront about these)

- The packing algorithm is a heuristic (shelf/guillotine style), not a
  guaranteed-optimal 3D solver - genuinely hard 3D bin packing is an
  NP-hard problem, so this is the same practical trade-off real
  cutting-stock/container-loading software makes.
- Multiple jobs/revisions: load one Shipping List at a time. Each upload
  replaces the current 3D view - there's no side-by-side comparison yet.
- Oversized items (bigger than the container in any dimension) are flagged
  and shown outside the container, not packed.
