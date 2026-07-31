namespace SteelViewerApp;

/// <summary>
/// Shown for every IFC load so the user can pick a phase (or all phases).
/// Works for multi-phase Tekla files and for files with a single / no phase tag.
/// </summary>
public class PhasePickerForm : Form
{
    private readonly ListBox listBox = new();
    private readonly Button btnOk = new();
    private readonly Button btnCancel = new();
    private readonly bool _noPhaseTags;

    public double? SelectedPhase { get; private set; }
    public bool AllPhasesChosen { get; private set; }

    /// <param name="phases">Phase number + assembly/item count pairs.</param>
    /// <param name="noPhaseTags">
    /// True when the IFC has no PHASE property at all — list still shows
    /// "All items" so the user confirms the load like every other file.
    /// </param>
    public PhasePickerForm(List<(double Phase, int Count)> phases, bool noPhaseTags = false)
    {
        _noPhaseTags = noPhaseTags;
        Text = "Choose a phase to load";
        Width = 360;
        Height = 420;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        string labelText = noPhaseTags
            ? "This IFC has no phase tags. Confirm load (all items):"
            : phases.Count <= 1
                ? "Pick what to load from this IFC:"
                : "This IFC file covers multiple phases. Pick the one you're shipping:";

        var label = new Label
        {
            Text = labelText,
            Dock = DockStyle.Top,
            Height = 44,
            Padding = new Padding(8)
        };

        listBox.Dock = DockStyle.Fill;
        listBox.Items.Add(noPhaseTags
            ? $"All items combined  ({(phases.Count > 0 ? phases[0].Count : 0)} items)"
            : "All phases combined");

        if (!noPhaseTags)
        {
            foreach (var (phase, count) in phases.OrderBy(p => p.Phase))
                listBox.Items.Add($"Phase {phase:0}  ({count} assemblies)");
        }

        listBox.SelectedIndex = 0;

        var buttonPanel = new Panel { Dock = DockStyle.Bottom, Height = 44 };
        btnOk.Text = "Load";
        btnOk.Location = new Point(Width - 180, 8);
        btnOk.Click += (s, e) => { Accept(phases); DialogResult = DialogResult.OK; Close(); };

        btnCancel.Text = "Cancel";
        btnCancel.Location = new Point(Width - 90, 8);
        btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };

        buttonPanel.Controls.Add(btnOk);
        buttonPanel.Controls.Add(btnCancel);

        Controls.Add(listBox);
        Controls.Add(buttonPanel);
        Controls.Add(label);
    }

    private void Accept(List<(double Phase, int Count)> phases)
    {
        if (_noPhaseTags || listBox.SelectedIndex == 0)
        {
            AllPhasesChosen = true;
            SelectedPhase = null;
            return;
        }

        var ordered = phases.OrderBy(p => p.Phase).ToList();
        SelectedPhase = ordered[listBox.SelectedIndex - 1].Phase;
        AllPhasesChosen = false;
    }
}
