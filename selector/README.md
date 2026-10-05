# StreamDeckAI.Selector

Stream Deck に出す開発中アプリを選ぶ小さな WinForms (.NET 8) アプリ。日本語 UI。
.NET SDK が無い PC では PowerShell 版 `updater/StreamDeckAI-Selector.ps1` (同内容の `sdai-selector.ps1`) を使えます。

## ビルド (Windows + .NET 8 SDK)

```powershell
cd selector
.\build.ps1
```

または:

```powershell
dotnet publish StreamDeckAI.Selector.csproj -c Release -r win-x64 --self-contained false -o ..\dist\Selector
Copy-Item -Recurse Defaults ..\dist\Selector\Defaults
```

## 動作

1. `%LOCALAPPDATA%\StreamDeckAI\apps.json` を読み込み (無ければ Defaults: claude-code / codex / grok-bot、カテゴリ「ツール」)
2. 「カタログを再取得」(PowerShell 版は起動時にも 1 回自動) で `wood-shop/grokAppStore` の `AppCatalog/*/manifest.json` を取得し、`streamdeck.agent` が `claude` / `codex` / `grok` のものだけマージ
   - 一覧も manifest も **GitHub Contents API** (`https://api.github.com/repos/wood-shop/grokAppStore/contents/AppCatalog/{フォルダ}/manifest.json`) で取得し、`content` (base64) をデコード。非公開リポジトリでは使えない `raw.githubusercontent.com` は使いません
   - 既に一覧にある id は **ローカルのチェック状態 (enabled) を保持** し、名前・カテゴリ・状態・agent をカタログの値で更新。新規 id は `streamdeck.enabledDefault` で初期チェック
3. 「保存してプラグインへ反映」で apps.json 保存 + `POST http://127.0.0.1:17890/apps`

## カタログは非公開リポジトリ — GitHub トークンが必要

Grok アプリストア (`wood-shop/grokAppStore`) は private のため、未認証だと HTTP 404 になります。
トークンは次の順で探します (アップデータと同じ設定を共用):

1. 環境変数 `STREAMDECKAI_GITHUB_TOKEN`
2. `%LOCALAPPDATA%\StreamDeckAI\updater-config.json` の `"githubToken"` (PAT。`repo` スコープ、または grokAppStore の Contents: Read を持つ fine-grained トークン)

```json
{ "githubToken": "ghp_xxxxxxxx" }
```

トークンが無い/無効なときは日本語のメッセージを表示し、ローカルの apps.json / 同梱 Defaults で動作を続けます。トークンはリポジトリにコミットしないでください。

## 現在カタログに載っている streamdeck 対応アプリ

| フォルダ | id | streamdeck.agent |
|---|---|---|
| `AppCatalog/Claude Code` | `claude-code` | `claude` |
| `AppCatalog/Codex CLI` | `codex` | `codex` |
| `AppCatalog/Grok Bot` | `grok-bot` | `grok` |

## 動作確認 (UI なし)

```powershell
$env:STREAMDECKAI_GITHUB_TOKEN = '<token>'   # 省略時は updater-config.json の githubToken
.\updater\StreamDeckAI-Selector.ps1 -FetchOnly  # 取得 + マージ結果を表示 (保存はしない)
```
