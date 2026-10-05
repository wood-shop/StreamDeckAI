# StreamDeckAI セットアップ (v0.3.0)

Stream Deck 用プラグイン・アプリセレクタ・自動アップデータを **1 つのアプリ「StreamDeckAI」** として入れるパッケージです。

## 必要なもの

- Windows 10 / 11
- [Elgato Stream Deck](https://www.elgato.com/stream-deck) アプリ **7.6 以上**
- PowerShell 5.1 以上（標準添付。.NET SDK は不要）

## インストール手順

1. この zip を適当なフォルダへ展開する
2. **`Install.bat`** をダブルクリック（または PowerShell で `.\Install.ps1`）
3. Stream Deck アプリを再起動する
4. アクション一覧の「StreamDeckAI」から Space / Tab / InfoBar を配置する
5. スタートメニューまたはデスクトップの **「StreamDeckAI」** でセレクタを開き、表示するアプリを選ぶ

インストール先の目安:

| 内容 | 場所 |
|---|---|
| プラグイン | `%APPDATA%\Elgato\StreamDeck\Plugins\jp.example.streamdeckai.sdPlugin\` |
| ツール一式 | `%LOCALAPPDATA%\StreamDeckAI\`（書けない場合は `Documents\StreamDeckAI`） |
| ショートカット | 「StreamDeckAI」**1 本のみ**（セレクタ起動） |
| Updater | ログオン時に裏で起動（Run キー + Startup）。デスクトップには出さない |

## アンインストール

`Uninstall.bat` を実行するか、`%LOCALAPPDATA%\StreamDeckAI\Uninstall.ps1` を実行してください。

削除されるもの: プラグインフォルダ、StreamDeckAI ツール、単一ショートカット、Updater の自動起動登録。

**削除されないもの:** Claude Code / Codex の hook 設定（`settings.json` / `config.toml`）。不要なら手で外してください。

## Controlled Folder Access (CFA) について

一部環境では Windows の「制御されたフォルダー アクセス」が Elgato Plugins 配下への書き込みを止めます。

- 公式パッケージは **`bin\sdai-plugin.js`** と **`hooks\sdai-hook.ps1`** を使います（`plugin.js` / `streamdeckai-hook.ps1` は使いません）
- それでもコピーに失敗したら、Stream Deck を終了したうえで手動コピーするか、PowerShell / Stream Deck を CFA の許可一覧に追加してください
- ツール類は `%LOCALAPPDATA%` 優先。ダメなら `Documents\StreamDeckAI` へフォールバックします

## エージェント側 hook（任意）

プラグイン導入後、各エージェントから状態を送るには:

```powershell
($env:APPDATA -replace '\\','/') + '/Elgato/StreamDeck/Plugins/jp.example.streamdeckai.sdPlugin/hooks/sdai-hook.ps1'
```

- Claude Code: `hooks\claude-settings.snippet.json` を `%USERPROFILE%\.claude\settings.json` にマージ
- Codex CLI: `hooks\codex-config.snippet.toml` を `%USERPROFILE%\.codex\config.toml` に追記
- Grok: `hooks\grok-example.ps1` を参照（`POST http://127.0.0.1:17890/event`）

## プライベート Release 用トークン

自動更新や Grok App Store カタログ取得で private リポジトリを読む場合、`%LOCALAPPDATA%\StreamDeckAI\updater-config.json` に `"githubToken": "ghp_..."`（`repo` スコープ）を書いてください。環境変数 `STREAMDECKAI_GITHUB_TOKEN` でも可。

## バージョン

- 本セットアップ: **0.3.0**
- プラグイン manifest: **0.3.0.0**
- GitHub Release: **v0.3.0**
