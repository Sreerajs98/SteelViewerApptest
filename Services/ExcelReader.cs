using ClosedXML.Excel;
using SteelPackingApp.Models;

namespace SteelPackingApp.Services;

/// <summary>
/// Reads a "Shipping List" export in the standard AEM template layout:
///   Row 6  : Job No (D6), Bldg No (F6), Phase No (H6), Customer (L6)
///   Row 8  : Column headers
///   Row 10+: Data rows, one per assembly mark, until ASSM MARK column is blank
///
/// Column layout (as found in A1442-01-101-R0_Shipping_List.xlsx):
///   C = ASSM MARK   D = QTY   E = ASSEMBLY NAME   H = OVERALL SIZE (LxWxH, e.g. "8572x20x20")
///   J = LENGTH (mm) K = UNIT WT (kg)   L = TOT WT (kg)   M = REMARKS
/// </summary>
public static class ExcelReader
{
    public static (JobInfo job, List<SteelItem> items) ReadShippingList(string filePath)
    {
        using var workbook = new XLWorkbook(filePath);
        var ws = workbook.Worksheets.First();

        var job = new JobInfo
        {
            JobNo = ws.Cell(6, 4).GetString(),
            BldgNo = ws.Cell(6, 6).GetString(),
            PhaseNo = ws.Cell(6, 8).GetString(),
            Customer = ws.Cell(6, 12).GetString()
        };

        var items = new List<SteelItem>();
        int row = 10;
        int consecutiveBlankRows = 0;

        while (consecutiveBlankRows < 3) // stop after a few blank rows in a row (end of table)
        {
            var markCell = ws.Cell(row, 3);
            string mark = markCell.GetString().Trim();

            if (string.IsNullOrWhiteSpace(mark))
            {
                consecutiveBlankRows++;
                row++;
                continue;
            }

            consecutiveBlankRows = 0;

            int qty = (int)ws.Cell(row, 4).GetValue<double>();
            string name = ws.Cell(row, 5).GetString().Trim();
            string overallSize = ws.Cell(row, 8).GetString().Trim();
            double length = ws.Cell(row, 10).GetValue<double>();
            double unitWt = ws.Cell(row, 11).GetValue<double>();
            double totWt = ws.Cell(row, 12).GetValue<double>();
            string remarks = ws.Cell(row, 13).GetString().Trim();

            var (l, w, h) = ParseOverallSize(overallSize, length);

            items.Add(new SteelItem
            {
                AssmMark = mark,
                Qty = qty,
                AssemblyName = name,
                LengthMm = l,
                WidthMm = w,
                HeightMm = h,
                UnitWeightKg = unitWt,
                TotalWeightKg = totWt,
                Remarks = remarks
            });

            row++;
        }

        return (job, items);
    }

    /// <summary>
    /// "8572x20x20" -> (8572, 20, 20). Falls back to the LENGTH column
    /// (and zero width/height) if OVERALL SIZE is missing or malformed.
    /// </summary>
    private static (double length, double width, double height) ParseOverallSize(string overallSize, double fallbackLength)
    {
        if (string.IsNullOrWhiteSpace(overallSize))
            return (fallbackLength, 0, 0);

        var parts = overallSize.Split(new[] { 'x', 'X' }, StringSplitOptions.RemoveEmptyEntries);

        if (parts.Length == 3
            && double.TryParse(parts[0], out double l)
            && double.TryParse(parts[1], out double w)
            && double.TryParse(parts[2], out double h))
        {
            return (l, w, h);
        }

        return (fallbackLength, 0, 0);
    }
}
