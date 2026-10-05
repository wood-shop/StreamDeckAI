# StreamDeckAI v0.3 仕様書

対象: Windows 11 / Stream Deck Neo / 日本語 UI  
更新日: 2026-10-05 (JST)

## 1. 目的

v0.2 のプラグイン機能を維持したまま、次の 3 点を追加する。

1. **完全自動アップデート** — 新しい Release があれば確認ダイアログなしで差し替える
2. **セレクタアプリ** — 開発中アプリのうち Stream Deck に出すものを選ぶ小さな Windows アプリ
3. **Grok App Store カタログ連携** — `wood-shop/grokAppStore` の `AppCatalog` を情報源にする

## 2. ディレクトリとポート

| 用途 | パス / 値 |
|---|---|
| インストーラホーム | `%LOCALAPPDATA%\StreamDeckAI\` |
| 管理中プラグイン | `%LOCALAPPDATA%\StreamDeckAI\Plugins\jp.example.streamdeckai.sdPlugin\` |
| Stream Deck 実体 | `%APPDATA%\Elgato\StreamDeck\Plugins\jp.example.streamdeckai.sdPlugin\` |
| 有効アプリ一覧 | `%LOCALAPPDATA%\StreamDeckAI\apps.json` |
| アップデータ設定 | `%LOCALAPPDATA%\StreamDeckAI\updater-config.json` |
| アップデータログ | `%LOCALAPPDATA%\StreamDeckAI\logs\updater-YYYYMMDD.log` |
| バックアップ | `%LOCALAPPDATA%\StreamDeckAI\backup\<timestamp>\` |
| ダウンロード一時 | `%LOCALAPPDATA%\StreamDeckAI\cache\` |
| セレクタ実行ファイル | `%LOCALAPPDATA%\StreamDeckAI\Selector\StreamDeckAI.Selector.exe` |
| アップデータ実行ファイル | `%LOCALAPPDATA%\StreamDeckAI\Updater\StreamDeckAI.Updater.exe` (または `.ps1`) |
| プラグイン HTTP | `http://127.0.0.1:17890` (設定で変更可。既定 17890) |

更新時は管理中フォルダを差し替えたあと、同じ内容を Stream Deck 実体へ上書きコピーする。

## 3. 自動アップデート (StreamDeckAI.Updater)

### 3.1 起動タイミング

- ログオン時 (HKCU `Run` または Startup フォルダの `.bat`。管理者権限不要)
- 起動直後に 1 回チェック
- 以降 **6 時間ごと**にチェック (`System.Timers.Timer` または PowerShell ループ / スケジュール済みタスク)

管理者権限が取れない環境では **Scheduled Task ではなく** 次のいずれか:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  Name = StreamDeckAI.Updater
  Data = "C:\Users\<user>\AppData\Local\StreamDeckAI\Updater\StreamDeckAI.Updater.exe" --daemon

または
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\StreamDeckAI-Updater.bat
```

### 3.2 バージョン判定

1. インストール済み版:  
   `%LOCALAPPDATA%\StreamDeckAI\Plugins\jp.example.streamdeckai.sdPlugin\manifest.json` の `Version`  
   (無ければ `%APPDATA%\Elgato\StreamDeck\Plugins\...` を読む)
2. リモート版 (優先順):
   1. `updater-config.json` の `versionJsonUrl` があればその URL の `version.json`
   2. 無ければ GitHub Releases: `GET https://api.github.com/repos/wood-shop/StreamDeckAI/releases/latest`  
      タグ `v0.3.0` → 版 `0.3.0.0`、資産名 `streamdeckai-v0.3.zip` を想定

版比較は `Major.Minor.Build.Revision` の数値比較 (不足桁は 0)。

### 3.3 `version.json` スキーマ

```json
{
  "schema": 1,
  "version": "0.3.0.0",
  "zipUrl": "https://example.com/streamdeckai-v0.3.zip",
  "sha256": "可选・小文字 hex。空なら検証スキップ",
  "notes": "任意の日本語メモ",
  "publishedAt": "2026-10-05T12:00:00+09:00"
}
```

ローカル見本: リポジトリ直下 `version.json` / スキーマ `schemas/version.schema.json`。

### 3.4 `updater-config.json`

```json
{
  "schema": 1,
  "githubOwner": "wood-shop",
  "githubRepo": "StreamDeckAI",
  "versionJsonUrl": "",
  "checkIntervalHours": 6,
  "assetNamePrefix": "streamdeckai-",
  "toastOnError": true
}
```

`versionJsonUrl` が空でなく、かつ到達できる場合は GitHub Releases より優先する (リポジトリ未作成時のフォールバック)。

### 3.5 更新手順 (確認 UI なし)

1. リモートが新しければ zip を `cache\` へダウンロード (あれば SHA-256 検証)
2. zip 内に `jp.example.streamdeckai.sdPlugin\` があることを確認
3. `StreamDeck.exe` を終了 (温和 → 3 秒待ち → 残存なら強制)。プロセス名 `StreamDeck`
4. 現プラグインを `backup\<yyyyMMdd-HHmmss>\` へコピー
5. 管理中フォルダと Elgato Plugins フォルダを新内容で置換
6. Stream Deck を再起動 (`%ProgramFiles%\Elgato\StreamDeck\StreamDeck.exe` 等を探索)
7. ログに成功を書く

### 3.6 失敗時

- バックアップから両パスへ復元
- ログにエラー
- `toastOnError: true` なら Windows Toast (PowerShell `BurntToast` が無ければ `[Windows.UI.Notifications]` または簡易バルーン)

### 3.7 実装形態

- 推奨: .NET 8 コンソール `StreamDeckAI.Updater` (`--daemon` / `--once` / `--install-runkey`)
- フォールバック: `updater/StreamDeckAI-Updater.ps1` (SDK 無しでも動く)

## 4. セレクタアプリ (StreamDeckAI.Selector)

### 4.1 UI (日本語)

- ウィンドウタイトル: `StreamDeckAI アプリ選択`
- 一覧: チェックボックス + 名前 + カテゴリ + 状態 (`開発中` / `公開済`)
- ボタン: `カタログを再取得` / `保存してプラグインへ反映` / `閉じる`
- 既定でチェック ON: `claude-code`, `codex`, `grok-bot`

### 4.2 データソース

1. **ローカル** `%LOCALAPPDATA%\StreamDeckAI\apps.json` (無ければ同梱 Defaults を書く)
2. **Grok App Store AppCatalog** (任意・失敗してもローカルのみで続行)  
   - 既定: `https://api.github.com/repos/wood-shop/grokAppStore/contents/AppCatalog`  
   - 各フォルダの `manifest.json` を取得  
   - `streamdeck` フィールドがあるもの、または `id` があるものを Stream Deck 候補としてマージ  
   - 既存のストア用 manifest (`name`/`category`/`features`/…) はそのまま読み、拡張フィールドだけ使う

### 4.3 `apps.json` スキーマ

```json
{
  "schema": 1,
  "updatedAt": "2026-10-05T21:00:00+09:00",
  "source": "local+catalog",
  "apps": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "category": "agent",
      "status": "developing",
      "enabled": true,
      "streamdeck": {
        "agent": "claude",
        "enabledDefault": true
      }
    },
    {
      "id": "codex",
      "name": "Codex CLI",
      "category": "agent",
      "status": "developing",
      "enabled": true,
      "streamdeck": {
        "agent": "codex",
        "enabledDefault": true
      }
    },
    {
      "id": "grok-bot",
      "name": "Grok Bot",
      "category": "agent",
      "status": "developing",
      "enabled": true,
      "streamdeck": {
        "agent": "grok",
        "enabledDefault": true
      }
    }
  ]
}
```

| フィールド | 意味 |
|---|---|
| `id` | アプリ一意 ID (セレクタ・フィルタのキー) |
| `name` | 表示名 |
| `category` | 分類 (例: `agent`) |
| `status` | `developing` \| `released` |
| `enabled` | Stream Deck に出すか |
| `streamdeck.agent` | プラグイン `POST /event` の `agent` (`claude`\|`codex`\|`grok`) |
| `streamdeck.enabledDefault` | 初回の既定チェック |

### 4.4 AppCatalog manifest への拡張 (マッピング)

既存 Grok App Store の `AppCatalog/<名前>/manifest.json` (schema 1: `name`, `version`, `category`, …) に、Stream Deck 向け任意フィールドを足せる:

```json
{
  "schema": 1,
  "name": "Claude Code Bridge",
  "version": "0.1.0",
  "category": "agent",
  "id": "claude-code",
  "status": "developing",
  "streamdeck": {
    "agent": "claude",
    "enabledDefault": true
  },
  "features": "...",
  "install_type": "portable"
}
```

マッピング規則:

| AppCatalog | apps.json |
|---|---|
| `id` (無ければフォルダ名を slug 化) | `id` |
| `name` | `name` |
| `category` | `category` |
| `status` (無ければ `released`) | `status` |
| `streamdeck.agent` | 必須。無いエントリはセレクタ候補に出さない (通常のインストーラアプリを誤表示しない) |
| `streamdeck.enabledDefault` | ローカルに未登録なら初期 `enabled` |

**現状の AppCatalog には `streamdeck` が無い**ため、セレクタは同梱 Defaults (上記 3 アプリ) を使い、カタログ取得は「将来の拡張を読む」実装とする。ライブスキーマ確定後に Defaults を落とせる。

### 4.5 保存時

1. `apps.json` を書き込む
2. `POST http://127.0.0.1:<port>/apps` に同じ JSON を送り、プラグインを無再起動で再読込  
   - ポートは `GET /version` または設定の 17890。接続失敗時はファイル保存のみ成功とし、警告を出す

## 5. プラグイン変更 (v0.3.0.0)

### 5.1 新 HTTP エンドポイント

いずれも `127.0.0.1` / `localhost` のみ。`Content-Type: application/json` は POST で必須。

#### `GET /version`

```json
{
  "ok": true,
  "version": "0.3.0.0",
  "plugin": "jp.example.streamdeckai",
  "port": 17890
}
```

#### `GET /apps`

現在の有効セットを返す (`apps.json` 相当。メモリ上のコピー)。

#### `POST /apps`

本文: `apps.json` と同形 (または `{ "enabled": ["claude-code", ...] }` の短縮形も可)。

- 成功: `{ "ok": true, "apps": { ... } }`
- 失敗: `{ "ok": false, "error": "..." }` (400)

反映後:

- 有効な `streamdeck.agent` の集合を更新
- **無効化された agent のセッションをストアから削除**
- 可能なら `%LOCALAPPDATA%\StreamDeckAI\apps.json` にも書き戻す (パスが解決できるとき)

#### 既存

- `POST /event` / `GET /health` は維持

### 5.2 イベント・セッションのフィルタ

- `POST /event` 受信時、`agent` が「有効アプリのいずれかの `streamdeck.agent`」に含まれなければ **200 は返すが適用しない** (`{ ok: true, ignored: true }` でも可。互換のため `ok: true` は維持し `ignored` を付ける)
- 表示・件数・読み上げは有効セッションのみ
- 起動時: `apps.json` があれば読み、無ければ Defaults (3 アプリすべて有効)

### 5.3 バージョン

- `manifest.json` → `0.3.0.0`
- `package.json` → `0.3.0`

## 6. 成果物

| 成果物 | 場所 |
|---|---|
| プラグイン zip | `/workspace/streamdeckai/streamdeckai-v0.3.zip` (プラグインのみ) |
| アップデータソース | `/workspace/streamdeckai/updater/` |
| セレクタソース | `/workspace/streamdeckai/selector/` |
| Windows ビルド | `/workspace/streamdeckai/dist/` (.NET SDK がある場合) |
| 本仕様 | `/workspace/streamdeckai/SPEC-v0.3.md` |

## 7. GitHub Releases

更新チャネル: `wood-shop/StreamDeckAI` Releases。タグ `v0.3.0`、資産 `streamdeckai-v0.3.zip` (および tools zip)。  
公式 zip の CodePath は `bin/sdai-plugin.js`、hook は `hooks/sdai-hook.ps1`。

プライベートリポジトリの場合、アップデータは `updater-config.json` の **`githubToken`** (PAT: `repo` スコープ) が必要。未設定だと Releases API が 404 になる。

## 8. インストール手順 (要約)

1. `streamdeckai-v0.3.zip` を展開し、従来どおり Plugins へ配置 (または `streamdeck link`)
2. `updater/` の `Install-Updater.ps1` を実行 → Run キー登録 + 初回チェック
3. `selector/` を `dotnet publish -c Release -r win-x64 --self-contained false` でビルドし、`%LOCALAPPDATA%\StreamDeckAI\Selector\` へ配置
4. セレクタで表示アプリを選び「保存してプラグインへ反映」
