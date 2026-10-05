# StreamDeckAI 使い方マニュアル(v0.2.0)

Stream Deck Neo(Windows 11)で、AI エージェントの状態を見て、ボタンでターミナルへ移動し、完了や確認待ちを音声で知らせるアプリです。対象は Claude Code、Codex、Grok Bot です。

## 1. 画面の見方

Stream Deck Neo のプロファイル「StreamDeckAI」に切り替えて使います。

| 場所 | 役割 |
|---|---|
| 上段の4つ | スペース(プロジェクト=作業フォルダ単位) |
| 下段の4つ | 選んでいるスペースのタブ(セッション) |
| インフォバー | 作業中・確認待ち・完了の数、選択中タブのコンテキスト使用率 |

### 色とキャラクター

| 状態 | 色 | キャラクター | 意味 |
|---|---|---|---|
| 確認待ち | 赤 | 手を振る | 許可や質問の返事を待っている |
| 作業中 | 黄 | タイピング | 作業している |
| 完了 | ミント | バンザイ | 作業が終わった |
| 待機中 | 青 | 居眠り | 何もしていない |
| なし | 暗い紫 | 空席 | エージェントがいない |

スペースの色は、中のタブのうち一番急ぐもの(確認待ち > 作業中 > 完了 > 待機中)で決まります。選んでいるボタンは、背景が明るくなります。

## 2. ボタンの操作

- 上段のスペースを押す: そのスペースを選び、下段にそのタブを出します。
- 下段のタブを押す: Windows Terminal の該当タブへ移動します。
- タブが5つ以上あるとき: 選んでいるスペースをもう一度押すと、下段が次の4つに切り替わります。
- 移動に失敗したときだけ、警告マークが出ます。成功のマークは出ません。

### タブへ移動できないとき
タブ名に、作業フォルダ名が含まれている必要があります。タブ名が変わる場合は、次のようにタブ名を固定してください。

```
wt new-tab --title "フォルダ名" --suppressApplicationTitle
```

## 3. 音声読み上げ

状態が「作業中」から「完了」または「確認待ち」に変わった瞬間に、Windows 標準の音声で読み上げます。例:

> プロジェクト名から。ログイン画面のバグを修正しました。デプロイして問題ないか確認してください。

- 文は、最後の返答から「何をしたか」と「次にすること」を抜き出して作ります(AI の要約ではないため、ずれることがあります)。
- 確認待ちのときは、許可を求めている内容を読み上げます。削除など取り消しにくい操作は、必ず含めます。
- 同じ状態をもう一度送っても、読み上げません。

### 読み上げ方(プラグイン設定の「読み上げ方」で変更)
- 要約あり(標準)
- 定型文のみ
- 効果音のみ(削除など危険な確認待ちだけ、短い警告を読み上げます)

## 4. 設定

ボタンを選ぶと、Stream Deck アプリの右側に設定が出ます。

| 項目 | 内容 |
|---|---|
| スロット | そのボタンが何番目のスペース/タブを表示するか(上段は1〜4、下段も1〜4) |
| 読み上げ | 読み上げのオン/オフ |
| 読み上げ方 | 要約あり / 定型文のみ / 効果音のみ |
| 本文を読む | 確認待ちや完了の本文を読み上げに含めるか |
| 音声名・速さ | Windows の音声と、話す速さ(-10〜10) |
| 文脈の上限 | コンテキストの大きさ。標準 200000、1Mモデルは 1000000 |
| ポート | 標準 17890 |
| 残す時間 | 更新が無いセッションを消すまでの時間。標準12時間 |
| PowerShell | PowerShell の場所(通常は変更不要) |

## 5. 各エージェントとの連携

設定済みです。入れ直したときの参考にしてください。

| エージェント | 連携方法 | 表示される状態 |
|---|---|---|
| Claude Code | `C:\Users\AIPC\.claude\settings.json` のフック | 作業中・確認待ち・完了 |
| Codex | `C:\Users\AIPC\.streamdeckai\codex-notify-relay.ps1` を通す(元の通知も呼びます) | 完了のみ |
| Grok Bot | 下記の送信方法 | 送った状態 |

Claude Code のツール実行後フックは、ツールを実行するたびに PowerShell が動きます。重いと感じたら、`settings.json` の `PostToolUse` を消してください。その場合は、許可した後も、ターン終了まで赤のままになります。

### 他のエージェントから状態を送る
`http://127.0.0.1:17890/event` に JSON を POST します。

```
{"session_id":"任意のID","agent":"grok","status":"working",
 "name":"表示名","cwd":"C:\\work\\demo"}
```

status は `working` / `blocked` / `done` / `idle` です。送り方の例は、プラグインの `hooks\grok-example.ps1` にあります。

## 6. 動作確認の方法

PowerShell に貼ると、テスト用のタブが出て、読み上げが流れます。

```
$u='http://127.0.0.1:17890/event'; $b={param($s) [Text.Encoding]::UTF8.GetBytes((@{session_id='t1';agent='claude';status=$s;name='テスト';cwd='C:\work\demo';last_assistant_message='修正しました。確認してください。'}|ConvertTo-Json))}
'working','done' | % { Invoke-WebRequest $u -Method POST -Body (& $b $_) -ContentType 'application/json; charset=utf-8' -UseBasicParsing | Out-Null; Start-Sleep 2 }
```

## 7. 困ったとき

| 症状 | 確認すること |
|---|---|
| ボタンに何も出ない | プロファイルが「StreamDeckAI」か。Stream Deck アプリを再起動 |
| 状態が変わらない | エージェントのフックが動いているか。上の動作確認を試す |
| 声が出ない | 音量、Windows の日本語音声、設定の「読み上げ」「読み上げ方」 |
| 使用率が「取得不可」 | Claude Code 以外、または会話記録が見つからない |
| Codex が「完了」しか出ない | Codex の通知仕様です |
| Codex アプリ更新後に連携が切れた | `config.toml` の `notify` が戻っていないか確認 |

## 8. できないこと

- 5時間・1週間の利用上限の表示(Claude の CLI が必要)
- AI による高度な要約読み上げ(ローカル LLM は未使用)
- Codex の作業中・確認待ちの表示

## 9. 元に戻す

- プロファイル: Stream Deck アプリで「StreamDeckAI」プロファイルを削除します。元の設定は `C:\Users\AIPC\StreamDeckBackup-20261004-070740` にあります。
- Codex: `C:\Users\AIPC\.codex\config.toml.bak-streamdeckai` を `config.toml` に戻します。
- Claude Code: `C:\Users\AIPC\.claude\settings.json` の `hooks` を消します。
- プラグイン: Stream Deck アプリの終了後、`%APPDATA%\Elgato\StreamDeck\Plugins\jp.example.streamdeckai.sdPlugin` を削除します。
