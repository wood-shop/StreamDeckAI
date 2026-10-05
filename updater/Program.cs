using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;

namespace StreamDeckAI.Updater;

internal static class Program
{

    [STAThread]
    private static int Main(string[] args)
    {
        var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDeckAI");
        Directory.CreateDirectory(home);
        var log = new Logger(Path.Combine(home, "logs"));
        var cfgPath = Path.Combine(home, "updater-config.json");
        var cfg = UpdaterConfig.LoadOrCreate(cfgPath);

        if (args.Any(a => a is "--install-runkey" or "-install-runkey"))
        {
            InstallRunKey(Environment.ProcessPath ?? "StreamDeckAI.Updater.exe");
            log.Info("registered Run key");
            return 0;
        }

        var once = args.Any(a => a is "--once" or "-once");
        var daemon = args.Any(a => a is "--daemon" or "-daemon") || !once;

        try
        {
            new UpdateService(home, cfg, log).RunOnce();
        }
        catch (Exception ex)
        {
            log.Error(ex.Message);
            if (cfg.ToastOnError) Toast.Show("StreamDeckAI 更新エラー", ex.Message);
            if (once) return 1;
        }

        if (once) return 0;

        var hours = cfg.CheckIntervalHours <= 0 ? 6 : cfg.CheckIntervalHours;
        log.Info($"daemon interval={hours}h");
        using var timer = new System.Threading.Timer(_ =>
        {
            try
            {
                cfg = UpdaterConfig.LoadOrCreate(cfgPath);
                new UpdateService(home, cfg, log).RunOnce();
            }
            catch (Exception ex)
            {
                log.Error(ex.Message);
                if (cfg.ToastOnError) Toast.Show("StreamDeckAI 更新エラー", ex.Message);
            }
        }, null, TimeSpan.FromHours(hours), TimeSpan.FromHours(hours));

        // トレイ常駐 (メッセージループ)
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Visible = true,
            Text = "StreamDeckAI Updater",
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("今すぐ確認", null, (_, _) =>
        {
            try { new UpdateService(home, UpdaterConfig.LoadOrCreate(cfgPath), log).RunOnce(); }
            catch (Exception ex) { log.Error(ex.Message); Toast.Show("StreamDeckAI 更新エラー", ex.Message); }
        });
        menu.Items.Add("終了", null, (_, _) => Application.Exit());
        icon.ContextMenuStrip = menu;
        Application.Run();
        icon.Visible = false;
        return 0;
    }

    private static void InstallRunKey(string exePath)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")!;
        key.SetValue("StreamDeckAI.Updater", $"\"{exePath}\" --daemon");
        var startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "StreamDeckAI-Updater.bat");
        File.WriteAllText(startup, $"@echo off\r\nstart \"\" \"{exePath}\" --daemon\r\n", Encoding.ASCII);
    }
}

internal sealed class Logger(string dir)
{
    public void Info(string m) => Write("INFO", m);
    public void Error(string m) => Write("ERROR", m);
    private void Write(string level, string m)
    {
        Directory.CreateDirectory(dir);
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {m}";
        File.AppendAllText(Path.Combine(dir, $"updater-{DateTime.Now:yyyyMMdd}.log"), line + Environment.NewLine, Encoding.UTF8);
        Debug.WriteLine(line);
    }
}

internal static class Toast
{
    public static void Show(string title, string body)
    {
        try
        {
            var n = new NotifyIcon { Icon = SystemIcons.Error, Visible = true };
            n.ShowBalloonTip(5000, title, body, ToolTipIcon.Error);
            Thread.Sleep(6000);
            n.Dispose();
        }
        catch { /* ignore */ }
    }
}

internal sealed class UpdaterConfig
{
    [JsonPropertyName("schema")] public int Schema { get; set; } = 1;
    [JsonPropertyName("githubOwner")] public string GithubOwner { get; set; } = "wood-shop";
    [JsonPropertyName("githubRepo")] public string GithubRepo { get; set; } = "StreamDeckAI";
    [JsonPropertyName("githubToken")] public string GithubToken { get; set; } = "";
    [JsonPropertyName("versionJsonUrl")] public string VersionJsonUrl { get; set; } = "";
    [JsonPropertyName("checkIntervalHours")] public double CheckIntervalHours { get; set; } = 6;
    [JsonPropertyName("assetNamePrefix")] public string AssetNamePrefix { get; set; } = "streamdeckai-";
    [JsonPropertyName("toastOnError")] public bool ToastOnError { get; set; } = true;

    public static UpdaterConfig LoadOrCreate(string path)
    {
        if (File.Exists(path))
        {
            try
            {
                return JsonSerializer.Deserialize<UpdaterConfig>(File.ReadAllText(path)) ?? new UpdaterConfig();
            }
            catch { /* fallthrough */ }
        }
        var c = new UpdaterConfig();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(c, new JsonSerializerOptions { WriteIndented = true }));
        return c;
    }
}

internal sealed class VersionInfo
{
    [JsonPropertyName("schema")] public int Schema { get; set; }
    [JsonPropertyName("version")] public string Version { get; set; } = "0.0.0.0";
    [JsonPropertyName("zipUrl")] public string ZipUrl { get; set; } = "";
    [JsonPropertyName("sha256")] public string? Sha256 { get; set; }
    [JsonPropertyName("notes")] public string? Notes { get; set; }
}

internal sealed class UpdateService(string home, UpdaterConfig cfg, Logger log)
{
    private static readonly HttpClient Http = new() { DefaultRequestHeaders = { { "User-Agent", "StreamDeckAI-Updater" } } };
    private readonly string _managed = Path.Combine(home, "Plugins", ProgramPluginId());
    private readonly string _elgato = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Elgato", "StreamDeck", "Plugins", ProgramPluginId());

    private static string ProgramPluginId() => "jp.example.streamdeckai.sdPlugin";

    public void RunOnce()
    {
        Directory.CreateDirectory(Path.Combine(home, "cache"));
        Directory.CreateDirectory(Path.Combine(home, "backup"));
        var installed = ReadInstalled();
        log.Info($"installed={installed}");
        var remote = FetchRemote();
        log.Info($"remote={remote.Version} url={remote.ZipUrl}");
        if (ParseVer(remote.Version) <= ParseVer(installed))
        {
            log.Info("up to date");
            return;
        }
        log.Info($"updating {installed} -> {remote.Version} (no confirmation)");
        var zip = Path.Combine(home, "cache", $"streamdeckai-{remote.Version}.zip");
        Download(remote.ZipUrl, zip, cfg);
        if (!string.IsNullOrWhiteSpace(remote.Sha256))
        {
            var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(zip))).ToLowerInvariant();
            if (!hash.Equals(remote.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"SHA-256 mismatch: got {hash}");
        }
        var extract = Path.Combine(home, "cache", "extract-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(extract);
        try
        {
            System.IO.Compression.ZipFile.ExtractToDirectory(zip, extract, true);
            var src = Directory.GetDirectories(extract, ProgramPluginId(), SearchOption.AllDirectories).FirstOrDefault()
                ?? throw new InvalidOperationException($"zip 内に {ProgramPluginId()} がありません");
            var backup = Path.Combine(home, "backup", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(backup);
            foreach (var p in new[] { _managed, _elgato })
            {
                if (Directory.Exists(p)) CopyTree(p, Path.Combine(backup, Path.GetFileName(p)));
            }
            try
            {
                StopStreamDeck();
                ReplacePlugin(src, _managed);
                ReplacePlugin(src, _elgato);
                StartStreamDeck();
                log.Info($"update OK -> {remote.Version}");
            }
            catch
            {
                var b = Path.Combine(backup, ProgramPluginId());
                if (Directory.Exists(b))
                {
                    try { ReplacePlugin(b, _managed); } catch { /* */ }
                    try { ReplacePlugin(b, _elgato); } catch { /* */ }
                }
                try { StartStreamDeck(); } catch { /* */ }
                throw;
            }
        }
        finally
        {
            try { Directory.Delete(extract, true); } catch { /* */ }
        }
    }

    private VersionInfo FetchRemote()
    {
        if (!string.IsNullOrWhiteSpace(cfg.VersionJsonUrl))
        {
            var json = Http.GetStringAsync(cfg.VersionJsonUrl).GetAwaiter().GetResult();
            return JsonSerializer.Deserialize<VersionInfo>(json) ?? throw new InvalidOperationException("bad version.json");
        }
        var api = $"https://api.github.com/repos/{cfg.GithubOwner}/{cfg.GithubRepo}/releases/latest";
        using var req = new HttpRequestMessage(HttpMethod.Get, api);
        req.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");
        var token = string.IsNullOrWhiteSpace(cfg.GithubToken)
            ? Environment.GetEnvironmentVariable("STREAMDECKAI_GITHUB_TOKEN")
            : cfg.GithubToken;
        if (!string.IsNullOrWhiteSpace(token))
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        using var res = Http.Send(req);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(res.Content.ReadAsStream());
        var root = doc.RootElement;
        var tag = root.GetProperty("tag_name").GetString() ?? "0.0.0";
        var ver = tag.TrimStart('v');
        if (ver.Split('.').Length == 3) ver += ".0";
        string? zipUrl = null;
        foreach (var a in root.GetProperty("assets").EnumerateArray())
        {
            var name = a.GetProperty("name").GetString() ?? "";
            if (name.StartsWith(cfg.AssetNamePrefix, StringComparison.OrdinalIgnoreCase) && name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                zipUrl = a.GetProperty("browser_download_url").GetString();
                break;
            }
        }
        if (zipUrl is null) throw new InvalidOperationException("Release に zip がありません");
        return new VersionInfo { Version = ver, ZipUrl = zipUrl };
    }

    private string ReadInstalled()
    {
        foreach (var p in new[] { _managed, _elgato })
        {
            var m = Path.Combine(p, "manifest.json");
            if (!File.Exists(m)) continue;
            using var doc = JsonDocument.Parse(File.ReadAllText(m));
            if (doc.RootElement.TryGetProperty("Version", out var v)) return v.GetString() ?? "0.0.0.0";
        }
        return "0.0.0.0";
    }

    private static Version ParseVer(string v)
    {
        var parts = v.TrimStart('v').Split('.');
        int n(int i) => i < parts.Length && int.TryParse(parts[i], out var x) ? x : 0;
        return new Version(n(0), n(1), n(2), n(3));
    }

    private static void Download(string url, string path, UpdaterConfig cfg)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        var token = string.IsNullOrWhiteSpace(cfg.GithubToken)
            ? Environment.GetEnvironmentVariable("STREAMDECKAI_GITHUB_TOKEN")
            : cfg.GithubToken;
        if (!string.IsNullOrWhiteSpace(token))
        {
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            req.Headers.TryAddWithoutValidation("Accept", "application/octet-stream");
        }
        using var res = Http.Send(req);
        res.EnsureSuccessStatusCode();
        using var fs = File.Create(path);
        res.Content.ReadAsStream().CopyTo(fs);
    }

    private static void StopStreamDeck()
    {
        foreach (var p in Process.GetProcessesByName("StreamDeck"))
        {
            try { p.CloseMainWindow(); } catch { /* */ }
        }
        Thread.Sleep(3000);
        foreach (var p in Process.GetProcessesByName("StreamDeck"))
        {
            try { p.Kill(true); } catch { /* */ }
        }
        Thread.Sleep(1000);
    }

    private static void StartStreamDeck()
    {
        foreach (var c in new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Elgato", "StreamDeck", "StreamDeck.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Elgato", "StreamDeck", "StreamDeck.exe"),
        })
        {
            if (File.Exists(c)) { Process.Start(new ProcessStartInfo(c) { UseShellExecute = true }); return; }
        }
    }

    private static void ReplacePlugin(string src, string dst)
    {
        if (Directory.Exists(dst)) Directory.Delete(dst, true);
        Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
        CopyTree(src, dst);
    }

    private static void CopyTree(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), true);
        foreach (var dir in Directory.GetDirectories(src))
            CopyTree(dir, Path.Combine(dst, Path.GetFileName(dir)));
    }
}
