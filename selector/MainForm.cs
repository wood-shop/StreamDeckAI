namespace StreamDeckAI.Selector;

internal sealed class MainForm : Form
{
    private readonly CatalogService _svc = new();
    private readonly CheckedListBox _list = new() { Dock = DockStyle.Fill, CheckOnClick = true, Font = new Font("Yu Gothic UI", 10f) };
    private readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 28, TextAlign = ContentAlignment.MiddleLeft };
    private AppsFile _apps = new();

    public MainForm()
    {
        Text = "StreamDeckAI アプリ選択";
        Width = 520;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Yu Gothic UI", 9f);

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(8) };
        var btnRefresh = new Button { Text = "カタログを再取得", AutoSize = true };
        var btnSave = new Button { Text = "保存してプラグインへ反映", AutoSize = true };
        var btnClose = new Button { Text = "閉じる", AutoSize = true };
        btnRefresh.Click += async (_, _) => await RefreshCatalogAsync();
        btnSave.Click += async (_, _) => await SaveAsync();
        btnClose.Click += (_, _) => Close();
        top.Controls.AddRange([btnRefresh, btnSave, btnClose]);

        var hint = new Label
        {
            Dock = DockStyle.Top,
            Height = 36,
            Padding = new Padding(8, 4, 8, 4),
            Text = "Stream Deck に出す開発中アプリにチェックを付けて保存します。既定: Claude Code / Codex / Grok Bot",
        };

        Controls.Add(_list);
        Controls.Add(_status);
        Controls.Add(top);
        Controls.Add(hint);

        Load += (_, _) =>
        {
            _apps = _svc.LoadLocal();
            BindList();
            _status.Text = $"読み込み: {_svc.AppsPath}";
        };
    }

    private void BindList()
    {
        _list.Items.Clear();
        foreach (var a in _apps.Apps.OrderBy(x => x.Name))
        {
            var status = a.Status == "developing" ? "開発中" : a.Status == "released" ? "公開済" : (a.Status ?? "-");
            var agent = a.Streamdeck?.Agent ?? "?";
            var label = $"{a.Name}  [{a.Category ?? "-"} / {status} / agent={agent}]";
            _list.Items.Add(new AppItem(a.Id, label), a.Enabled);
        }
    }

    private void ReadChecksIntoApps()
    {
        var enabled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < _list.Items.Count; i++)
        {
            if (_list.GetItemChecked(i) && _list.Items[i] is AppItem item)
                enabled.Add(item.Id);
        }
        foreach (var a in _apps.Apps) a.Enabled = enabled.Contains(a.Id);
    }

    private async Task RefreshCatalogAsync()
    {
        _status.Text = "カタログ取得中…";
        UseWaitCursor = true;
        try
        {
            ReadChecksIntoApps();
            var (file, msg) = await _svc.FetchAndMergeAsync(_apps);
            _apps = file;
            BindList();
            _status.Text = msg;
        }
        finally { UseWaitCursor = false; }
    }

    private async Task SaveAsync()
    {
        ReadChecksIntoApps();
        _apps.Source = _apps.Source ?? "local";
        _svc.SaveLocal(_apps);
        _status.Text = "保存中…";
        var (ok, msg) = await _svc.PostToPluginAsync(_apps);
        _status.Text = ok ? $"保存OK — {msg}" : $"保存OK (ファイル) — {msg}";
        if (!ok) MessageBox.Show(this, msg, "プラグインへの反映", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        else MessageBox.Show(this, msg, "保存", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private sealed record AppItem(string Id, string Label)
    {
        public override string ToString() => Label;
    }
}
