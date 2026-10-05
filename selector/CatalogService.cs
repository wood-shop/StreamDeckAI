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
            new CatalogApp { Id = "claude-code", Name = "Claude Code", Category = "ツール", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "claude", EnabledDefault = true } },
            new CatalogApp { Id = "codex", Name = "Codex CLI", Category = "ツール", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "codex", EnabledDefault = true } },
            new CatalogApp { Id = "grok-bot", Name = "Grok Bot", Category = "ツール", Status = "developing", Enabled = true, Streamdeck = new StreamDeckMeta { Agent = "grok", EnabledDefault = true } },
        ],
    };

    public void SaveLocal(AppsFile file)
    {
        file.Schema = 1;
        file.UpdatedAt = DateTimeOffset.Now.ToString("o");
        Directory.CreateDirectory(Path.GetDirectoryName(_appsPath)!);
        File.WriteAllText(_appsPath, JsonSerializer.Serialize(file, new JsonSerializerOptions { WriteIndented = true }), Encoding.UTF8);
    }

    private const string CatalogOwner = "wood-shop";
    private const string CatalogRepo = "grokAppStore";
    private const string CatalogDir = "AppCatalog";
    private static readonly string[] KnownAgents = ["claude", "codex", "grok"];

    /// <summary>
    /// GitHub トークンを解決する。優先順:
    /// 1. 環境変数 STREAMDECKAI_GITHUB_TOKEN
    /// 2. %LOCALAPPDATA%\StreamDeckAI\updater-config.json の githubToken (アップデータと共用)
    /// </summary>
    public static string? ResolveGithubToken()
    {
        var env = Environment.GetEnvironmentVariable("STREAMDECKAI_GITHUB_TOKEN");
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
        try
        {
            var cfg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDeckAI", "updater-config.json");
            if (File.Exists(cfg))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(cfg, Encoding.UTF8));
                if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                    doc.RootElement.TryGetProperty("githubToken", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    var v = t.GetString();
                    if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
                }
            }
        }
        catch { /* 読めなければトークン無し扱い */ }
        return null;
    }

    private static HttpRequestMessage GithubRequest(string url, string? token)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.Clear();
        req.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
        req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
        if (!string.IsNullOrWhiteSpace(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return req;
    }

    private static string ContentsUrl(string path) =>
        $"https://api.github.com/repos/{CatalogOwner}/{CatalogRepo}/contents/" +
        string.Join('/', path.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.EscapeDataString));

    private static string AuthErrorMessage(int status, bool hasToken)
    {
        if (!hasToken)
            return $"カタログ取得失敗 HTTP {status}: grokAppStore は非公開リポジトリのため GitHub トークンが必要です。" +
                   "%LOCALAPPDATA%\\StreamDeckAI\\updater-config.json の \"githubToken\" に repo スコープのトークンを設定してください " +
                   "(または環境変数 STREAMDECKAI_GITHUB_TOKEN)。ローカル/同梱 Defaults で動作を続けます。";
        return status == 401
            ? $"カタログ取得失敗 HTTP 401: githubToken が無効または期限切れです。updater-config.json のトークンを更新してください (ローカルのみ使用)。"
            : $"カタログ取得失敗 HTTP {status}: トークンに wood-shop/grokAppStore の読み取り権限 (repo スコープ) がありません (ローカルのみ使用)。";
    }

    /// <summary>
    /// wood-shop/grokAppStore (非公開) の AppCatalog から streamdeck 付き manifest を取り込みマージ。
    /// 一覧・manifest とも GitHub Contents API (base64 の content) で取得する。raw.githubusercontent.com は非公開リポジトリで使えないため使わない。
    /// 既知 id のローカル enabled 状態は保持する。
    /// </summary>
    public async Task<(AppsFile File, string Message)> FetchAndMergeAsync(AppsFile local, CancellationToken ct = default)
    {
        var token = ResolveGithubToken();
        var hasToken = !string.IsNullOrWhiteSpace(token);
        try
        {
            using var listReq = GithubRequest(ContentsUrl(CatalogDir), token);
            using var res = await Http.SendAsync(listReq, ct);
            var status = (int)res.StatusCode;
            if (status is 401 or 403 or 404)
                return (local, status == 403 && res.Headers.TryGetValues("X-RateLimit-Remaining", out var rl) && rl.FirstOrDefault() == "0"
                    ? "カタログ取得失敗 HTTP 403: GitHub API のレート制限に達しました。しばらく待つか githubToken を設定してください (ローカルのみ使用)。"
                    : AuthErrorMessage(status, hasToken));
            if (!res.IsSuccessStatusCode)
                return (local, $"カタログ取得失敗 HTTP {status} (ローカルのみ使用)");
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return (local, "カタログ形式が想定外です (ローカルのみ使用)");

            var merged = Clone(local);
            var byId = merged.Apps.ToDictionary(a => a.Id, StringComparer.OrdinalIgnoreCase);
            int added = 0, updated = 0, failed = 0;
            foreach (var entry in doc.RootElement.EnumerateArray())
            {
                if (!entry.TryGetProperty("type", out var t) || t.GetString() != "dir") continue;
                if (!entry.TryGetProperty("name", out var nameEl)) continue;
                var folder = nameEl.GetString();
                if (string.IsNullOrWhiteSpace(folder)) continue;
                var dirPath = entry.TryGetProperty("path", out var pEl) && !string.IsNullOrWhiteSpace(pEl.GetString())
                    ? pEl.GetString()!
                    : $"{CatalogDir}/{folder}";
                try
                {
                    using var manReq = GithubRequest(ContentsUrl($"{dirPath}/manifest.json"), token);
                    using var manRes = await Http.SendAsync(manReq, ct);
                    if (manRes.StatusCode == System.Net.HttpStatusCode.NotFound) continue; // manifest 無しフォルダ
                    if (!manRes.IsSuccessStatusCode) { failed++; continue; }
                    using var meta = JsonDocument.Parse(await manRes.Content.ReadAsStringAsync(ct));
                    var text = DecodeContent(meta.RootElement);
                    if (text is null) { failed++; continue; }
                    using var man = JsonDocument.Parse(text);
                    var root = man.RootElement;
                    if (!root.TryGetProperty("streamdeck", out var sd) || sd.ValueKind != JsonValueKind.Object) continue;
                    if (!sd.TryGetProperty("agent", out var agentEl) || agentEl.ValueKind != JsonValueKind.String) continue;
                    var agent = (agentEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (!KnownAgents.Contains(agent)) continue; // プラグイン側が claude|codex|grok のみ受け付ける
                    var id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                    if (string.IsNullOrWhiteSpace(id))
                        id = (root.TryGetProperty("name", out var n) ? n.GetString() : folder)!.ToLowerInvariant().Replace(' ', '-');
                    var enabledDefault = sd.TryGetProperty("enabledDefault", out var ed) && ed.ValueKind == JsonValueKind.True;
                    string? Str(string key) => root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                    if (byId.TryGetValue(id, out var existing))
                    {
                        // ローカルの enabled は保持
                        existing.Name = Str("name") ?? existing.Name;
                        existing.Category = Str("category") ?? existing.Category;
                        existing.Status = Str("status") ?? existing.Status;
                        existing.Streamdeck = new StreamDeckMeta { Agent = agent, EnabledDefault = enabledDefault };
                        updated++;
                    }
                    else
                    {
                        byId[id] = new CatalogApp
                        {
                            Id = id,
                            Name = Str("name") ?? id,
                            Category = Str("category") ?? "ツール",
                            Status = Str("status") ?? "released",
                            Enabled = enabledDefault,
                            Streamdeck = new StreamDeckMeta { Agent = agent, EnabledDefault = enabledDefault },
                        };
                        added++;
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch
                {
                    failed++; // 個別失敗は集計のみ
                }
            }
            merged.Apps = byId.Values.OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
            merged.Source = "local+catalog";
            var msg = $"カタログ取得OK: streamdeck 対応 {added + updated} 件 (新規 {added} / 更新 {updated})";
            if (failed > 0) msg += $"、取得失敗 {failed} 件";
            return (merged, msg);
        }
        catch (OperationCanceledException) { return (local, "カタログ取得を中止しました (ローカルのみ使用)"); }
        catch (Exception ex)
        {
            return (local, $"カタログ取得エラー: {ex.Message} (ローカルのみ使用)");
        }
    }

    /// <summary>Contents API 応答の base64 content を UTF-8 文字列に戻す。</summary>
    internal static string? DecodeContent(JsonElement meta)
    {
        if (meta.ValueKind != JsonValueKind.Object) return null;
        if (!meta.TryGetProperty("content", out var c) || c.ValueKind != JsonValueKind.String) return null;
        var enc = meta.TryGetProperty("encoding", out var e) ? e.GetString() : "base64";
        var raw = c.GetString() ?? "";
        if (!string.Equals(enc, "base64", StringComparison.OrdinalIgnoreCase)) return raw;
        var b64 = raw.Replace("\n", "").Replace("\r", "").Trim();
        var text = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
        return text.Length > 0 && text[0] == '\uFEFF' ? text[1..] : text;
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
