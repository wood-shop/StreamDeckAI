namespace StreamDeckAI.Selector;

internal sealed class MainForm : Form
{
    private readonly CatalogService _svc = new();
    private readonly CheckedListBox _list = new() { Dock = DockStyle.Fill, CheckOnClick = true, Font = new Font("Yu Gothic UI", 10f) };
    private readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 56, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(8, 0, 8, 0) };
    private readonly CheckBox _showDeveloping = new()
    {
        Text = "開発中のアプリも表示",
        AutoSize = true,
        Checked = true,
        Padding = new Padding(8, 8, 8, 0),
    };
    private AppsFile _apps = new();
    private bool _loading;

    public MainForm()
    {
        Text = "StreamDeckAI アプリ選択";
        Width = 560;
        Height = 500;
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
            Height = 52,
            Padding = new Padding(8, 4, 8, 4),
            Text = "Stream Deck に出すアプリにチェックを付けて保存します。既定で開発中アプリ (Claude Code / Codex / Grok Bot) も表示します。「カタログを再取得」で Grok アプリストア (AppCatalog) の streamdeck 対応アプリを取り込みます。ストアは非公開のため updater-config.json の githubToken が必要です。",
        };

        _showDeveloping.Dock = DockStyle.Top;
        _showDeveloping.CheckedChanged += (_, _) =>
        {
            if (_loading) return;
            ReadChecksIntoApps();
            _apps.ShowDeveloping = _showDeveloping.Checked;
            BindList();
        };

        Controls.Add(_list);
        Controls.Add(_status);
        Controls.Add(top);
        Controls.Add(_showDeveloping);
        Controls.Add(hint);

        Load += async (_, _) =>
        {
            _loading = true;
            try
            {
                _apps = _svc.LoadLocal();
                // Persist showDeveloping:true on first-run / legacy files so Defaults agents stay visible next open.
                if (_apps.ShowDeveloping is null)
                {
                    _apps.ShowDeveloping = true;
                    _svc.SaveLocal(_apps);
                }
                _showDeveloping.Checked = _apps.ShowDevelopingOrDefault;
                BindList();
                _status.Text = $"読み込み: {_svc.AppsPath}";
            }
            finally { _loading = false; }

            // Auto-fetch catalog on open when token may be available; Defaults remain if fetch fails.
            await RefreshCatalogAsync(quiet: true);
        };
    }

    private IEnumerable<CatalogApp> VisibleApps()
    {
        var showDev = _apps.ShowDevelopingOrDefault;
        return _apps.Apps
            .Where(a => showDev || !string.Equals(a.Status, "developing", StringComparison.OrdinalIgnoreCase))
            .OrderBy(x => x.Name);
    }

    private void BindList()
    {
        _list.Items.Clear();
        foreach (var a in VisibleApps())
        {
            var status = a.Status == "developing" ? "開発中" : a.Status == "released" ? "公開済" : (a.Status ?? "-");
            var agent = a.Streamdeck?.Agent ?? "?";
            var label = $"{a.Name}  [{a.Category ?? "-"} / {status} / agent={agent}]";
            _list.Items.Add(new AppItem(a.Id, label), a.Enabled);
        }
    }

    private void ReadChecksIntoApps()
    {
        // Only update visible rows — hidden developing apps keep their enabled flag.
        var enabled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visible = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < _list.Items.Count; i++)
        {
            if (_list.Items[i] is not AppItem item) continue;
            visible.Add(item.Id);
            if (_list.GetItemChecked(i)) enabled.Add(item.Id);
        }
        foreach (var a in _apps.Apps)
        {
            if (visible.Contains(a.Id))
                a.Enabled = enabled.Contains(a.Id);
        }
    }

    private async Task RefreshCatalogAsync(bool quiet = false)
    {
        if (!quiet) _status.Text = "カタログ取得中…";
        else _status.Text = "カタログ取得中… (起動時)";
        UseWaitCursor = true;
        try
        {
            ReadChecksIntoApps();
            var (file, msg) = await _svc.FetchAndMergeAsync(_apps);
            // Keep UI preference across merge
            file.ShowDeveloping = _showDeveloping.Checked;
            _apps = file;
            // Never leave the list empty: ensure Defaults agents remain
            CatalogService.EnsureDefaultsAgents(_apps);
            BindList();
            _status.Text = msg;
        }
        finally { UseWaitCursor = false; }
    }

    private async Task SaveAsync()
    {
        ReadChecksIntoApps();
        _apps.ShowDeveloping = _showDeveloping.Checked;
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
