using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace StreamDeckAI.Selector;

internal sealed class CatalogService
{
    private static readonly HttpClient Http = CreateClient();
    private readonly string _appsPath;
    private readonly string _defaultsPath;

    public CatalogService()
    {
        var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDeckAI");
        Directory.CreateDirectory(home);
        _appsPath = Path.Combine(home, "apps.json");
        _defaultsPath = Path.Combine(AppContext.BaseDirectory, "Defaults", "apps.json");
    }

    public string AppsPath => _appsPath;

    private static HttpClient CreateClient()
    {
        var c = new HttpClient();
        c.DefaultRequestHeaders.UserAgent.ParseAdd("StreamDeckAI-Selector/0.3");
        c.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return c;
    }

    public AppsFile LoadLocal()
    {
        if (File.Exists(_appsPath))
        {
            try { return JsonSerializer.Deserialize<AppsFile>(File.ReadAllText(_appsPath, Encoding.UTF8)) ?? Defaults(); }
            catch { /* fallthrough */ }
        }
        var d = Defaults();
        SaveLocal(d);
        return d;
    }

    public AppsFile Defaults()
    {
        if (File.Exists(_defaultsPath))
        {
            try { return JsonSerializer.Deserialize<AppsFile>(File.ReadAllText(_defaultsPath, Encoding.UTF8)) ?? Builtin(); }
            catch { /* */ }
        }
        return Builtin();
    }

    private static AppsFile Builtin() => new()
    {
        Schema = 1,
        UpdatedAt = DateTimeOffset.Now.ToString("o"),
        Source = "defaults",
        Apps =
        [
            new CatalogApp { Id = "claude-code", Name = "Claude Code", Category = "agent", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "claude", EnabledDefault = true } },
            new CatalogApp { Id = "codex", Name = "Codex CLI", Category = "agent", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "codex", EnabledDefault = true } },
            new CatalogApp { Id = "grok-bot", Name = "Grok Bot", Category = "agent", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "grok", EnabledDefault = true } },
        ],
    };

    public void SaveLocal(AppsFile file)
    {
        file.Schema = 1;
        file.UpdatedAt = DateTimeOffset.Now.ToString("o");
        Directory.CreateDirectory(Path.GetDirectoryName(_appsPath)!);
        File.WriteAllText(_appsPath, JsonSerializer.Serialize(file, new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8);
    }

    /// <summary>
    /// wood-shop/grokAppStore の AppCatalog から streamdeck 付き manifest を取り込みマージ。
    /// 現状のカタログに streamdeck が無い場合はローカルをそのまま返す。
    /// </summary>
    public async Task<(AppsFile File, string Message)> FetchAndMergeAsync(AppsFile local, CancellationToken ct = default)
    {
        const string api = "https://api.github.com/repos/wood-shop/grokAppStore/contents/AppCatalog";
        try
        {
            using var res = await Http.GetAsync(api, ct);
            if (!res.IsSuccessStatusCode)
                return (local, $"カタログ取得失敗 HTTP {(int)res.StatusCode} (ローカルのみ使用)");
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return (local, "カタログ形式が想定外です");

            var merged = Clone(local);
            var byId = merged.Apps.ToDictionary(a => a.Id, StringComparer.OrdinalIgnoreCase);
            var added = 0;
            foreach (var entry in doc.RootElement.EnumerateArray())
            {
                if (entry.TryGetProperty("type", out var t) && t.GetString() != "dir") continue;
                if (!entry.TryGetProperty("name", out var nameEl)) continue;
                var folder = nameEl.GetString();
                if (string.IsNullOrWhiteSpace(folder) || folder == "removed.json") continue;
                var url = entry.TryGetProperty("url", out var u) ? u.GetString() : null;
                // contents API で子を取るより raw の方が簡単
                var raw = $"https://raw.githubusercontent.com/wood-shop/grokAppStore/main/AppCatalog/{Uri.EscapeDataString(folder)}/manifest.json";
                try
                {
                    var text = await Http.GetStringAsync(raw, ct);
                    using var man = JsonDocument.Parse(text);
                    var root = man.RootElement;
                    if (!root.TryGetProperty("streamdeck", out var sd) || sd.ValueKind != JsonValueKind.Object) continue;
                    if (!sd.TryGetProperty("agent", out var agentEl)) continue;
                    var agent = agentEl.GetString() ?? "";
                    if (agent is not ("claude" or "codex" or "grok")) continue;
                    var id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                    if (string.IsNullOrWhiteSpace(id))
                        id = (root.TryGetProperty("name", out var n) ? n.GetString() : folder)!.ToLowerInvariant().Replace(' ', '-');
                    var enabledDefault = sd.TryGetProperty("enabledDefault", out var ed) && ed.ValueKind == JsonValueKind.True;
                    if (byId.TryGetValue(id, out var existing))
                    {
                        existing.Name = root.TryGetProperty("name", out var nm) ? nm.GetString() ?? existing.Name : existing.Name;
                        existing.Category = root.TryGetProperty("category", out var cat) ? cat.GetString() : existing.Category;
                        existing.Status = root.TryGetProperty("status", out var st) ? st.GetString() : existing.Status;
                        existing.Streamdeck = new StreamDeckMeta { Agent = agent, EnabledDefault = enabledDefault };
                    }
                    else
                    {
                        var app = new CatalogApp
                        {
                            Id = id,
                            Name = root.TryGetProperty("name", out var nm) ? nm.GetString() ?? id : id,
                            Category = root.TryGetProperty("category", out var cat) ? cat.GetString() : "agent",
                            Status = root.TryGetProperty("status", out var st) ? st.GetString() : "released",
                            Enabled = enabledDefault,
                            Streamdeck = new StreamDeckMeta { Agent = agent, EnabledDefault = enabledDefault },
                        };
                        byId[id] = app;
                        added++;
                    }
                }
                catch
                {
                    // 個別失敗は無視
                }
            }
            merged.Apps = byId.Values.OrderBy(a => a.Name).ToList();
            merged.Source = "local+catalog";
            return (merged, added > 0 ? $"カタログから {added} 件追加" : "カタログを確認しました (streamdeck 付きの新規はありません。Defaults を使用中)");
        }
        catch (Exception ex)
        {
            return (local, $"カタログ取得エラー: {ex.Message}");
        }
    }

    public async Task<(bool Ok, string Message)> PostToPluginAsync(AppsFile file, int port = 17890, CancellationToken ct = default)
    {
        try
        {
            // ポート自動検出
            try
            {
                var verJson = await Http.GetStringAsync($"http://127.0.0.1:{port}/version", ct);
                using var v = JsonDocument.Parse(verJson);
                if (v.RootElement.TryGetProperty("port", out var p) && p.TryGetInt32(out var detected))
                    port = detected;
            }
            catch { /* 既定ポートのまま */ }

            var json = JsonSerializer.Serialize(file);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var res = await Http.PostAsync($"http://127.0.0.1:{port}/apps", content, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
                return (false, $"プラグインへの反映失敗 HTTP {(int)res.StatusCode}: {body}");
            return (true, "プラグインへ反映しました (再起動不要)");
        }
        catch (Exception ex)
        {
            return (false, $"プラグイン未接続: {ex.Message} (apps.json のみ保存済み)");
        }
    }

    private static AppsFile Clone(AppsFile src) => new()
    {
        Schema = src.Schema,
        UpdatedAt = src.UpdatedAt,
        Source = src.Source,
        Apps = src.Apps.Select(a => new CatalogApp
        {
            Id = a.Id,
            Name = a.Name,
            Category = a.Category,
            Status = a.Status,
            Enabled = a.Enabled,
            Streamdeck = a.Streamdeck is null ? null : new StreamDeckMeta { Agent = a.Streamdeck.Agent, EnabledDefault = a.Streamdeck.EnabledDefault },
        }).ToList(),
    };
}
