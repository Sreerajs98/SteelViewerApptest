namespace SteelViewerApp;

static class Program
{
    /// <summary>Set when launched with --grouping-tests (headless suite in WebView).</summary>
    public static bool RunGroupingTests { get; private set; }
    /// <summary>Set when launched with --step1-tests (cross-section extraction suite).</summary>
    public static bool RunStep1Tests { get; private set; }
    /// <summary>Set when launched with --step2-tests (cross-section analysis suite).</summary>
    public static bool RunStep2Tests { get; private set; }
    /// <summary>Set when launched with --step3-tests (orientation scoring suite).</summary>
    public static bool RunStep3Tests { get; private set; }
    /// <summary>Set when launched with --step4-tests (apply orientation suite).</summary>
    public static bool RunStep4Tests { get; private set; }
    /// <summary>Set when launched with --step5-tests (shape matching / grouping suite).</summary>
    public static bool RunStep5Tests { get; private set; }
    /// <summary>Set when launched with --step6-tests (nest method assignment suite).</summary>
    public static bool RunStep6Tests { get; private set; }
    /// <summary>Set when launched with --ground-tests (ground-stable rest pose suite).</summary>
    public static bool RunGroundTests { get; private set; }
    /// <summary>Set when launched with --step7-tests (nesting offset suite).</summary>
    public static bool RunStep7Tests { get; private set; }
    /// <summary>Set when launched with --warehouse-tests (AABB ground-sit suite).</summary>
    public static bool RunWarehouseTests { get; private set; }
    /// <summary>Set when launched with --z-ground-tests (Z MOVE-to-ground measure).</summary>
    public static bool RunZGroundTests { get; private set; }
    /// <summary>Optional IFC path from CLI (auto-load all phases after WebView ready).</summary>
    public static string? StartupIfcPath { get; private set; }

    [STAThread]
    static void Main(string[] args)
    {
        RunGroupingTests = args.Any(a =>
            string.Equals(a, "--grouping-tests", StringComparison.OrdinalIgnoreCase));
        RunStep1Tests = args.Any(a =>
            string.Equals(a, "--step1-tests", StringComparison.OrdinalIgnoreCase));
        RunStep2Tests = args.Any(a =>
            string.Equals(a, "--step2-tests", StringComparison.OrdinalIgnoreCase));
        RunStep3Tests = args.Any(a =>
            string.Equals(a, "--step3-tests", StringComparison.OrdinalIgnoreCase));
        RunStep4Tests = args.Any(a =>
            string.Equals(a, "--step4-tests", StringComparison.OrdinalIgnoreCase));
        RunStep5Tests = args.Any(a =>
            string.Equals(a, "--step5-tests", StringComparison.OrdinalIgnoreCase));
        RunStep6Tests = args.Any(a =>
            string.Equals(a, "--step6-tests", StringComparison.OrdinalIgnoreCase));
        RunGroundTests = args.Any(a =>
            string.Equals(a, "--ground-tests", StringComparison.OrdinalIgnoreCase));
        RunStep7Tests = args.Any(a =>
            string.Equals(a, "--step7-tests", StringComparison.OrdinalIgnoreCase));
        RunWarehouseTests = args.Any(a =>
            string.Equals(a, "--warehouse-tests", StringComparison.OrdinalIgnoreCase));
        RunZGroundTests = args.Any(a =>
            string.Equals(a, "--z-ground-tests", StringComparison.OrdinalIgnoreCase));

        // First .ifc path arg, or --ifc <path>
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--ifc", StringComparison.OrdinalIgnoreCase)
                && i + 1 < args.Length)
            {
                StartupIfcPath = args[i + 1];
                break;
            }
            if (args[i].EndsWith(".ifc", StringComparison.OrdinalIgnoreCase)
                && File.Exists(args[i]))
            {
                StartupIfcPath = args[i];
                break;
            }
        }

        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}
