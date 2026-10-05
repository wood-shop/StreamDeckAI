# StreamDeckAI オントロジー(v0.2)

出典: https://tech-lab.sios.jp/archives/54936 (SIOS Tech Lab 2026-09-30)
目的: Stream Deck から、複数の AI エージェント(Claude Code 等)の作業状態を一目で把握し、ワンボタンで該当ターミナルへ移動し、完了・確認待ちを音声で知らせる。

## 1. クラス(概念)
| クラス | 説明 |
|---|---|
| Space(スペース) | プロジェクト単位の作業場所。複数の Tab を持つ |
| Tab(タブ) | Space 内の作業単位。1 つ以上の Pane を持つ |
| Pane(ペイン) | 1 つのターミナル。Agent が動く。session_id と cwd を持つ |
| Agent(エージェント) | Pane で動く AI(例: Claude Code) |
| AgentStatus | working(作業中) / blocked(確認待ち) / done(完了) / idle(待機中) / none(エージェントなし) |
| Terminal Multiplexer | Space/Tab/Pane と状態を提供する外部ツール(記事では herdr) |
| StreamDeckDevice | ボタンと(機種によって)インフォバーを持つ物理デバイス |
| Button(ボタン) | Space または Tab に割り当てる。状態色とキャラクターを表示 |
| Slot(スロット) | ボタンが何番目の Space/Tab を表示するかの番号(1〜16) |
| InfoBar(インフォバー) | コンテキスト使用率と利用上限を表示する横長画面 |
| Character(キャラクター) | 状態を演じるドット絵(working=タイピング、blocked=手を振る、done=バンザイ、idle=居眠り、none=空席) |
| Poller(ポーラー) | 約 1.2 秒ごとに状態を取得する単一のループ |
| Narration(読み上げ) | 完了/確認待ちを「何をした→どうなった→次にすること」で伝える音声 |
| Summarizer | 読み上げ文を作る処理。v0.2 では LLM なしの抽出型(直近の返答から文を抜き出して短くする)。LLM は使わない |
| TTS | 読み上げ文を音声にするエンジン(記事では VOICEVOX・ずんだもん) |
| UsageProbe | コンテキスト使用率を取得する処理。v0.2 ではセッション記録(JSONL)の末尾の usage を読む。5 時間/1 週間の利用上限は claude CLI が要るため対象外 |
| NarrationStyle | 読み上げ方の設定: 要約あり / 定型文のみ / 効果音のみ |
| TerminalApp | ターミナルを動かすアプリ。ボタン押下時に前面へ出す |

## 2. 関係
- Space hasMany Tab / Tab hasMany Pane / Pane runs 0..1 Agent
- Tab.status = Pane の状態のうち最も深刻なもの(blocked > working > done > idle)
- Space.status は表示用に、含まれる Tab の顔(キャラクター)を並べる
- Button displays Space | Tab / Button.color = AgentStatus の色
- Button.press(Space) → 下段を選択 Space の Tab に切替(Tab が 5 つ以上なら再押下で次の 4 つ)
- Button.press(Tab) → Multiplexer.focus(Tab) → TerminalApp を前面化
- Poller reads Multiplexer(Space/Tab/Pane/状態)→ 状態遷移を検出
- 状態遷移 working→done、または →blocked が Narration を発火
- Narration: 直近のアシスタントの返答(hook の last_assistant_message または記録ファイル末尾)→ Summarizer → TTS → 再生(NarrationStyle が効果音のみなら SystemSounds だけ)
- InfoBar shows UsageProbe(選択中 Tab の session_id のコンテキスト + 利用上限)

## 3. 状態と色・表現
| 状態 | 背景色 | キャラクター | 読み上げ内容 |
|---|---|---|---|
| blocked | 赤 | 手を振る+「!」 | 何の作業の途中か/何の許可・質問か(削除など取り消しにくい操作は必ず言う)/どう答えるか(推薦はしない) |
| working | 黄 | タイピング | なし |
| done | ミント | バンザイ | 何をしたか/結果/次にユーザーがすること |
| idle | 青 | 居眠り | なし |
| none | 暗い紫 | 空席 | なし |
使用率の色: 70% まで ミント / 90% まで 黄 / それ以上 赤。

## 4. ルール(制約)
1. エージェントなしのタブは、他タブの情報で推定せず「Claude なし」と表示する
2. ポーリングは全ボタンで 1 本だけ(1.2 秒)。描画は 150ms、前回と同じ画像は送らない
3. 押下の成功マークは出さず、失敗時のみ警告表示
4. 読み上げ文頭にスペース名を付ける(例: 「業務自動化から。」)
5. 実行ファイルは絶対パスで呼ぶ(Stream Deck 起動プロセスは PATH を持たない)
6. 破壊的操作の確認待ちは必ず読み上げに含める

## 5. 未確定(開発ボットが関口さんに確認)
- 使用中の OS(M6_Ultra は Mac と思われるが未確認)と Stream Deck の機種
- ターミナル管理ツールは記事と同じ herdr か、別(tmux 等)か
- 読み上げは記事と同じ VOICEVOX + ローカル LLM か、別の方法か
- 対象エージェントは Claude Code のみか、他も含めるか
