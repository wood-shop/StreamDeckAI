# StreamDeckAI v0.3

Stream Deck Neo(Windows 11)で、複数の AI エージェント(Claude Code / Codex CLI / Grok)の作業状態をひと目で見て、ボタン1つで Windows Terminal のタブへ移動し、完了・確認待ちを日本語音声で知らせる Stream Deck プラグインです。

- 上段4ボタン = **Space**(作業フォルダ=プロジェクトごと)/ 下段4ボタン = 選択中 Space の **Tab**(セッション)
- 色: 確認待ち=赤 / 作業中=黄 / 完了=ミント / 待機=青 / なし=暗い紫(ドット絵キャラが状態を演じます)
- インフォバー: 作業中・確認待ち・完了の件数、選択中タブ名、**Claude のコンテキスト使用率**(v0.2)
- 読み上げ: Windows 標準の音声(System.Speech)。完了時は直近の返答から「◯◯から。何をしたか。次にすること」を**端末内で抜き出して**読みます(v0.2。AI・追加ソフトは不要)。「定型文のみ」「効果音のみ」にも切り替えられます
- 状態の取得: エージェントの hook から `http://127.0.0.1:17890/event` へ POST(ターミナル多重化ツールは使いません)

> **v0.3 / v0.2 は実機(Stream Deck Neo / Windows 11)では未検証です。** 開発環境(Linux)でのビルド・型チェック・単体テスト・偽の Stream Deck を使った結合テストのみ実施しています。詳しくは「制限と未検証」を見てください。


## v0.3 の新機能

### 1. 完全自動アップデート
新しい Release があれば**確認ダイアログなし**でプラグインを差し替えます。

1. `updater\Install-Updater.ps1` を実行 (管理者権限不要)
2. `%LOCALAPPDATA%\StreamDeckAI\Updater\` に配置され、ログオン時に自動起動 (HKCU Run + Startup `.bat`)
3. 起動直後と **6 時間ごと**に `wood-shop/StreamDeckAI` の Releases を確認 (リポジトリ未作成時は `updater-config.json` の `versionJsonUrl` で `version.json` を指定)
4. 新しければ zip ダウンロード → StreamDeck.exe 終了 → バックアップ → 置換 → 再起動。失敗時はバックアップ復元 + ログ (+ 任意トースト)

詳細は `SPEC-v0.3.md` と `updater/README.md`。

### 2. アプリセレクタ (StreamDeckAI.Selector)
どの開発中アプリを Stream Deck に出すかを選ぶ小さな Windows アプリです。

```powershell
cd selector
.\build.ps1   # .NET 8 SDK が必要。できあがったら %LOCALAPPDATA%\StreamDeckAI\Selector\ へ配置
```

- 一覧は `%LOCALAPPDATA%\StreamDeckAI\apps.json` (無ければ Defaults: **claude-code / codex / grok-bot** が ON)
- 「カタログを再取得」で Grok App Store (`wood-shop/grokAppStore` の `AppCatalog`) を参照。`streamdeck.agent` 付き manifest だけマージ
- 「保存してプラグインへ反映」→ `apps.json` 保存 + `POST http://127.0.0.1:17890/apps` (プラグイン再起動不要)

### 3. プラグイン HTTP の追加
| 方法 | パス | 内容 |
|---|---|---|
| GET | `/version` | `{ ok, version, plugin, port }` |
| GET | `/apps` | 現在の apps.json 相当 |
| POST | `/apps` | 有効セットの更新 (フル形 or `{ "enabled": ["claude-code", ...] }`) |

無効な agent からの `POST /event` は `{ ok: true, ignored: true }` を返し、セッションには載せません。

### v0.2 からの更新手順
1. `streamdeckai-v0.3.zip` を展開して Plugins へ配置 (または開発リンク) し、Stream Deck を再起動
2. `updater\Install-Updater.ps1` で自動更新を入れる
3. (任意) `selector\build.ps1` でセレクタをビルドして起動し、表示アプリを選ぶ

---
## 必要なもの
- Windows 11 / Stream Deck アプリ **7.6 以上**(Neo のインフォバーに必要)
- [Node.js 20 以上](https://nodejs.org/)(ビルド用。プラグイン実行時は Stream Deck 同梱の Node が使われます)
- 日本語の音声(設定 → 時刻と言語 → 音声。Haruka など)。無い場合は読み上げされず、ログに残るだけです

## インストール
PowerShell で、zip を展開したフォルダ(開発ツリーでは `plugin/`)に入って実行します。

```powershell
npm install
npm run build
```

**A. 開発用リンク(おすすめ)**
```powershell
npx streamdeck link jp.example.streamdeckai.sdPlugin
npx streamdeck restart jp.example.streamdeckai
```
`@elgato/cli` を入れた場合は `streamdeck link ...` でも同じです。

**B. コピーして入れる**
```powershell
Copy-Item -Recurse -Force .\jp.example.streamdeckai.sdPlugin "$env:APPDATA\Elgato\StreamDeck\Plugins\"
```
その後 Stream Deck アプリを再起動してください(zip にはビルド済みの `bin\sdai-plugin.js` も入っているので、B だけなら `npm` は不要です)。

> **Windows メモ (Controlled Folder Access):** Elgato Plugins 配下への `plugin.js` / `streamdeckai-hook.ps1` 書き込みがブロックされる環境があるため、公式 zip では `bin/sdai-plugin.js`(manifest `CodePath`) と `hooks/sdai-hook.ps1` を使います。

## ボタンの置き方
アクション一覧の「StreamDeckAI」から:
1. 上段4つに **Space(プロジェクト)**
2. 下段4つに **Tab(セッション)**
3. インフォバーに **InfoBar**

スロットは「自動(列番号)」のままで OK です。Space が5つ以上なら、ページ2の上段にスロット 5〜8 を置きます。1つの Space にタブが5つ以上あるときは、選択中の Space をもう一度押すと次の4タブへ進みます(`1/2` 表示)。
読み上げ・ポートなどの設定は、どのアクションの設定画面からでも変えられます(全ボタン共通)。

## エージェント側の設定(hook)
hook スクリプトの **Windows 公式パスは `hooks\sdai-hook.ps1`** です(`streamdeckai-hook.ps1` はリポジトリ参照用の同内容コピー)。
次のコマンドでスクリプトのパス(スラッシュ区切り)を確認し、各スニペットの `C:/PATH/TO/` を置き換えてください。
```powershell
($env:APPDATA -replace '\\','/') + '/Elgato/StreamDeck/Plugins/jp.example.streamdeckai.sdPlugin/hooks/sdai-hook.ps1'
```

- **Claude Code**: `hooks\claude-settings.snippet.json` を `%USERPROFILE%\.claude\settings.json` にマージ。UserPromptSubmit→作業中 / Notification→確認待ち / Stop→完了。`PostToolUse`(許可後に赤→黄へ戻す)は呼び出しのたびに PowerShell が起動するので、気になる場合は外してください(外すと、許可した後も次の Stop まで赤のままです)。
- **Codex CLI**: `hooks\codex-config.snippet.toml` を `%USERPROFILE%\.codex\config.toml` に追記。`notify` は**ターン完了時しか呼ばれない**ため、Codex のボタンは「完了」だけになります(作業中・確認待ちは出ません)。
- **Grok Bot など**: `hooks\grok-example.ps1` を参照。`POST /event` に JSON を送るだけです(`Content-Type: application/json` 必須)。
  ```json
  {"session_id":"grok-1","agent":"grok","status":"blocked","name":"docs","cwd":"C:\\work\\proj","wt_window_hint":"docs","message":"build フォルダを削除してよいですか"}
  ```
  `status` は working / blocked / done / idle、`agent` は claude / codex / grok。`space` を付けるとスペース名を明示できます(省略時は cwd の最後のフォルダ名)。
  v0.2 で任意項目を 2 つ追加しました(省略可。v0.1 のイベントはそのまま使えます): `transcript_path`(Claude のセッション記録 `.jsonl` の絶対パス。`.claude` フォルダ内のものだけ読みます)と `last_assistant_message`(直近の返答の全文。最大 6000 文字)。

### Windows Terminal のタブに飛ぶためのコツ
ボタン押下は、Windows Terminal のタブ見出しに `wt_window_hint`(既定は cwd のフォルダ名。環境変数 `STREAMDECKAI_HINT` で変更可)が**含まれるタブ**を探して選択します。エージェントがタブ見出しを書き換えると見つからなくなるので、見出しを固定すると確実です。
```powershell
wt new-tab --title "請求書" --suppressApplicationTitle -d C:\work\業務自動化
```

## v0.2 の新機能

### 1. インフォバーのコンテキスト使用率
選択中タブが Claude Code のセッションなら、インフォバーの下段に使用率のバーが出ます(例: `43%  86k/200k`)。
- 色: **70% まで ミント / 90% まで 黄 / それ以上 赤**。分母より大きいときは `105%` のようにそのまま出します。
- 計算: セッション記録(JSONL)の最新のアシスタント発言の `usage` から `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` を合計し、設定の「文脈の上限」で割ります。**Claude CLI(`claude` コマンド)は使いません**。
- 記録ファイルの場所: hook が渡す `transcript_path`。無ければ `%USERPROFILE%\.claude\projects\*\<session_id>.jsonl`(`CLAUDE_CONFIG_DIR` が Stream Deck から見えていればそちらも)を探します。
- 負荷: ファイルは**末尾 256KB だけ**読みます(その範囲に使用量の行が無いときだけ 1 回 1MB まで広げます)。5 秒に 1 回だけ更新日時とサイズを確認し、変わったときだけ読み直します。
- Claude 以外(Codex / Grok)、記録ファイルが見つからない、使用量がまだ無いセッションは、推測せず **「使用率: 取得不可」** と出します。
- **「文脈の上限」**はプロパティインスペクタで 200,000(標準)/ 1,000,000 から選びます。1M のモデルを使うときは 1,000,000 にしてください(モデルの種類は記録から判別できないため、自動では切り替わりません)。
- **5 時間 / 週間の利用上限は表示しません。** それらは `claude` CLI(`/usage`)でしか取れず、この PC では CLI が使えないため、偽の値は出さずに省いています。

### 2. LLM なしの読み上げ要約
プロパティインスペクタの **「読み上げ方」** で選びます。
| 設定 | 動作 |
|---|---|
| **要約あり**(既定) | 完了時: 直近のアシスタントの返答から、コードブロック・表・見出し・URL・パスを除き、`〇〇から。<何をしたか(最初の 1〜2 文を短く)>。<次にすること(最後の質問文や「〜してください/確認」を含む文)>` を作って読みます(およそ 120 文字まで)。日本語・英語どちらの返答にも使えます。抜き出せないときは定型文に戻ります。 |
| 定型文のみ | v0.1 と同じ固定文。 |
| 効果音のみ | Windows の通知音(`SystemSounds`)だけ。完了=Asterisk / 確認待ち=Exclamation。 |

- **確認待ち**は v0.2 でも従来どおりです(通知文を読み、削除・強制・上書きなど取り消しにくい操作は必ず警告)。「効果音のみ」でも、取り消しにくい操作を含む確認待ちだけは安全のため Hand の音に続けて短く読み上げます。
- 材料の優先順: ① イベントの `last_assistant_message`(Claude の Stop hook が渡します。Claude Code 2.1.47 以降。記録ファイルより遅れないので一番確実) ② Codex / Grok の `message`・`last_assistant_message` ③ Claude の記録ファイルの末尾(Stop の直後は書き込みが遅れることがあるため 0.3 秒待ってから読み、今回の入力より前の返答は読みません)。
- 要約は「文を抜き出して短くする」だけです。言い換えや翻訳はしません(英語の返答は英語のまま日本語の音声が読みます)。

### v0.1 からの更新手順
1. 新しい zip を展開して `npm install` → `npm run build`(または同梱のビルド済みフォルダをコピー)し、Stream Deck を再起動。
2. **hook スクリプトも差し替えてください**(`hooks\sdai-hook.ps1`)。新しい版は `transcript_path` と `last_assistant_message` を送ります。古い hook のままでも動きますが、使用率は `~/.claude/projects` の検索に、要約は記録ファイルの末尾に頼ることになります。
3. `settings.json` の hook 設定は変更不要です(同じコマンドのまま)。

## 動作確認(エージェントなしで)
プラグインを動かした状態で:
```powershell
node scripts/send-fake-events.mjs          # 3秒おきに状態が変わります(--fast で短縮 / --port でポート指定)
```
ボタンの色が変わり、確認待ち・完了で読み上げが鳴れば OK です。

## 制限と未検証
- **実機未検証**: Neo 実機での表示、インフォバー(`Neo` コントローラ + `pixmap` レイアウト)、Windows 上の音声再生、UI Automation によるタブ切り替え、Windows PowerShell 5.1 での hook 実行は、実際には動かしていません(hook は PowerShell 7 でのみ実行確認)。
- **タブ移動の限界**: タブ見出しの部分一致のみ。同じ見出しが複数ある/見出しが変わる/Windows Terminal 以外では失敗します。見出しが見つからないときはウィンドウだけ前面にして**警告表示**になります。別の仮想デスクトップにあるウィンドウへの移動は未確認です。Windows の前面化制限のため、まれに前面に出ないことがあります。
- 状態は hook の通知だけが頼りです。通知が来なかった/エージェントが強制終了したセッションは、`12` 時間(設定で変更可)更新が無いと消えます。
- 完了の読み上げは「要約あり」で端末内の抜き出しです(意味を理解した要約ではないため、的外れな文を拾うことがあります。気になる場合は「定型文のみ」へ)。確認待ちは、イベントに `message` があればその先頭を読み、削除・強制・上書きなど取り消しにくい操作を検出したら必ず警告します(`message` が無い場合は「画面で確認して」とだけ言います)。
- 使用率は Claude Code のセッション記録(JSONL)の形式に依存します(2026-10 時点の `message.usage` を想定。実機の記録では未確認)。5 時間 / 週間の利用上限、VOICEVOX、LLM 要約は対象外です。
- v0.2 の使用率の表示位置・文字の大きさ、`SystemSounds` の音、日本語要約の聞こえ方は、Neo 実機・Windows では未確認です(プレビュー画像は `preview/infobar-usage-*.png`)。
- セキュリティ: サーバーは `127.0.0.1` のみ待ち受け、認証はありません(`Content-Type`/`Host` の検査のみ)。同じ PC 上のプロセスは誰でもイベントを送れます。
- `streamdeck validate` は、`layouts/infobar.json` の1件がエラー表示になります(誤検出)(CLI 1.10.1 がレイアウトを 200×100 固定で検査するためで、Neo のインフォバーは 232×50)。他の検査は通ります。

## 開発
```powershell
npm run typecheck   # 型チェック
npm test            # 単体 + 結合テスト(結合テストは先に npm run build)
npm run assets      # アイコン PNG とプレビュー画像の再生成
npm run validate    # streamdeck validate
```
構成: `src/apps.ts`(有効アプリ)/ `src/state.ts`(セッション管理)/ `svg.ts`(ボタン・インフォバー描画)/ `server.ts`(HTTP)/ `narration.ts`・`speech.ts`(読み上げ・効果音)/ `summarize.ts`(抜き出し要約)/ `transcript.ts`(記録ファイルの末尾読み・場所の特定)/ `usage.ts`・`usagefmt.ts`(使用率)/ `focus.ts`(タブ移動)/ `app.ts`(共有タイマー 150ms)/ `actions/`(Space・Tab・InfoBar)。変更履歴は `CHANGELOG.md`。
