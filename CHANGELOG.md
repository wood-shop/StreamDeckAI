# 変更履歴

## 未リリース (main)
### 追加
- **統合セットアップ** (`setup/` → Release 資産 `StreamDeckAI-Setup-0.3.0.zip`): プラグイン + Selector + Updater を一括インストール。ショートカットは「StreamDeckAI」1 本のみ (Selector)。Updater は Run/Startup にサイレント登録。Uninstall.ps1 同梱。`.NET SDK` 不要 (PowerShell)。
- ストア向け下書き `schemas/AppCatalog-StreamDeckAI/manifest.json` (streamdeck フィールドなし)。

### 修正
- **セットアップ ps1 の UTF-8 BOM** (`setup/Install.ps1` / `Uninstall.ps1` / `StreamDeckAI.ps1`): Windows PowerShell 5.1 が BOM 無し UTF-8 の日本語を ParserError にする問題を修正。Release の `StreamDeckAI-Setup-0.3.0.zip` を再アップロード (プラグイン版は据え置き)。
- **セレクタのカタログ取得** (C# `selector/CatalogService.cs` / PowerShell `updater/StreamDeckAI-Selector.ps1`・`sdai-selector.ps1`): 非公開の `wood-shop/grokAppStore` に対応。トークンを `STREAMDECKAI_GITHUB_TOKEN` → `updater-config.json` の `githubToken` の順で読み、`Authorization: Bearer` を付与。manifest は `raw.githubusercontent.com` ではなく Contents API (base64) で取得。401/404 時は日本語で githubToken 設定を案内し、ローカル Defaults で継続。
- PowerShell セレクタに「カタログ再取得」ボタンと起動時の自動取得、`-FetchOnly` (UI なし確認) を追加。既知 id のチェック状態は保持。ファイルを UTF-8 BOM 付きに (Windows PowerShell 5.1 の文字化け防止)。
- セレクタ Defaults のカテゴリを `agent` → `ツール` (ストアと統一)。

## v0.3.0 (2026-10-05)
### 追加
- **完全自動アップデート** (`updater/`): 起動時と 6 時間ごとに GitHub Releases または `versionJsonUrl` の `version.json` を確認し、新しければ確認なしでプラグインを差し替え。失敗時はバックアップ復元・ログ・任意トースト。HKCU Run / Startup `.bat` でログオン時起動 (管理者不要)。PowerShell 版 + .NET 8 ソース。
- **アプリセレクタ** (`selector/`): WinForms (.NET 8) 日本語 UI。`apps.json` と Grok App Store `AppCatalog` (`streamdeck` 拡張) をマージし、チェックしたアプリだけ Stream Deck に出す。保存時に `POST /apps` でプラグインへ即反映。
- HTTP **`GET /version`** / **`GET|POST /apps`**。無効 agent のイベントは `{ ok:true, ignored:true }` で適用しない。無効化時は該当セッションを削除。
- `apps.json` / `version.json` スキーマと Defaults (claude-code / codex / grok-bot)。
- 仕様書 `SPEC-v0.3.md`。

### 変更
- プラグイン版 `0.3.0.0`。既存の Space/Tab/InfoBar・使用率・要約読み上げはそのまま。
- **Windows CFA 回避の公式ファイル名**: zip 内は `bin/sdai-plugin.js`(manifest `CodePath`) と `hooks/sdai-hook.ps1`。`streamdeckai-hook.ps1` はソース参照用に残す。

## v0.2.0 (2026-10-04)
### 追加
- **インフォバーにコンテキスト使用率**: 選択中タブの Claude セッション記録(JSONL)の末尾 256KB から最新の `message.usage` を読み、バー+% +`86k/200k` を表示。70% まで ミント / 90% まで 黄 / それ以上 赤。5 秒に 1 回、更新日時・サイズが変わったときだけ再読込。Claude 以外・記録なし・使用量なしは「使用率: 取得不可」。5 時間/週間の利用上限は claude CLI が必要なため表示しない。
- 設定「文脈の上限」(200,000 / 1,000,000)。
- **LLM なしの読み上げ要約**: 完了時に直近の返答からコードブロック・表・見出し・URL・パスを除き、「◯◯から。<何をしたか>。<次にすること>」(約 120 文字)を作って読む。抜き出せないときは定型文に戻る。
- 設定「読み上げ方」: 要約あり(既定)/ 定型文のみ / 効果音のみ(Windows `SystemSounds`)。効果音のみでも、取り消しにくい操作の確認待ちは短く読み上げる。
- hook(`streamdeckai-hook.ps1`)が `transcript_path` と `last_assistant_message` を送る。Codex の `last-assistant-message` も `last_assistant_message` として送る。`-TranscriptPath` / `-LastMessage` 引数も追加。
- HTTP `/event` に任意項目 `transcript_path` / `last_assistant_message` を追加(既存の項目・応答は変更なし)。`transcript_path` は `.claude` 内の絶対パスの `*.jsonl` だけ読む。
- テスト 58 → 99 件(使用率、記録ファイルの読み取り、要約、読み上げスタイル、hook の転送)。

### 変更
- インフォバーのレイアウト(タブ名の行を小さくして使用率の行を追加。エラー表示・「エージェントなし」は従来どおり)。

## v0.1.0 (2026-10-02)
- 最初の版。Space / Tab / InfoBar、状態色とドット絵、Windows Terminal のタブ移動、System.Speech の定型文読み上げ、HTTP `/event`、Claude / Codex / Grok 用 hook。
