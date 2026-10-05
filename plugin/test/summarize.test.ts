import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanForSpeech, isNextAction, shorten, splitSentences, summarizeForSpeech } from "../src/summarize";

const JA = `承知しました。

## 変更内容

\`src/invoice/total.ts\` の合計金額の丸め処理を修正し、請求書の集計が正しく出るようにしました。テストも追加して、すべて通ることを確認しました。

\`\`\`ts
const total = items.reduce((a, b) => a + b.price, 0);
\`\`\`

| 項目 | 値 |
|------|----|
| 件数 | 42 |

詳細は https://example.com/docs/invoice を見てください。

- **注意**: C:\\Users\\me\\proj\\請求書.xlsx は変更していません
- \`npm run build\` も成功しています

この内容でコミットしてよろしいですか？`;

const EN = `Sure, I've fixed the failing test in \`tests/invoice.test.ts\` by correcting the rounding logic in the total calculation. All 42 tests pass now.

\`\`\`
npm test
\`\`\`

See https://example.com/x for the details.

Please review the diff and let me know if you want me to open a pull request.`;

test("cleanForSpeech: コードブロック・表・見出し・URL・パスを落とす(日本語)", () => {
	const text = cleanForSpeech(JA).join("\n");
	for (const bad of ["```", "const total", "|", "##", "変更内容", "https://", "example.com", "src/", "total.ts", "C:\\", ".xlsx", "npm run", "**"]) assert.ok(!text.includes(bad), `${bad} が残っている:\n${text}`);
	for (const good of ["丸め処理を修正し", "リンク", "ファイル", "コマンド", "よろしいですか"]) assert.ok(text.includes(good), `${good} が無い:\n${text}`);
});

test("cleanForSpeech: 英語。URL・パスは英語の語に置き換わり、フェンスの中身は読まない", () => {
	const text = cleanForSpeech(EN).join("\n");
	assert.ok(!/https?:|tests\/|invoice\.test|npm test|```/.test(text), text);
	assert.ok(text.includes("the file") && text.includes("a link"));
});

test("cleanForSpeech: 閉じていないコードブロックも以降を捨てる。絵文字・リンク記法・強調を整理", () => {
	assert.deepEqual(cleanForSpeech("完了 ✅ です\n```bash\nrm -rf x\n"), ["完了です"]);
	assert.deepEqual(cleanForSpeech("[ドキュメント](https://a.example/b) を **更新** しました"), ["ドキュメントを更新しました"]);
	assert.deepEqual(cleanForSpeech("```\nonly code\n```"), []);
});

test("splitSentences: 日本語は 。！？ で、英語は ピリオド+空白+大文字 で切る(v0.2.0 のような版番号では切らない)", () => {
	assert.deepEqual(splitSentences(["修正しました。確認してください！OK？"]), ["修正しました。", "確認してください！", "OK？"]);
	assert.deepEqual(splitSentences(["Updated to v0.2.0 today. Please check it."]), ["Updated to v0.2.0 today.", "Please check it."]);
});

test("isNextAction: 質問・お願い・確認を含む文だけ。「確認しました」は報告なので対象外", () => {
	for (const s of ["よろしいですか？", "確認してください。", "ご確認をお願いします", "Should I continue?", "Please review the diff.", "Let me know if it works."]) assert.ok(isNextAction(s), s);
	for (const s of ["動作を確認しました。", "テストが通りました。", "I fixed the bug."]) assert.ok(!isNextAction(s), s);
});

test("shorten: 日本語は読点で、英語は節・単語の切れ目で切り、尻切れの接続語を残さない", () => {
	assert.equal(shorten("あ".repeat(10) + "、" + "い".repeat(30), 20), "あ".repeat(10));
	assert.equal(shorten("短い文です。", 20), "短い文です");
	const en = shorten("Please review the diff and let me know if you want me to open a pull request.", 45);
	assert.ok(en.length <= 45 && !/\b(if|and|the|to)$/.test(en), en);
});

test("日本語の要約: 「<スペース>から。<何をしたか>。<次にすること>」で約 120 文字以内", () => {
	const r = summarizeForSpeech(JA, "業務自動化")!;
	assert.ok(r.line.startsWith("業務自動化から。"), r.line);
	assert.ok(r.what.startsWith("合計金額の丸め処理") || r.what.startsWith("ファイルの合計金額"), r.what);
	assert.ok(!/承知/.test(r.line), "相づちは読まない");
	assert.equal(r.next, "この内容でコミットしてよろしいですか");
	assert.ok(r.line.endsWith("よろしいですか？"), r.line);
	assert.ok(r.line.length <= 125, `${r.line.length}: ${r.line}`);
	assert.ok(!/https?:|```|\||src\//.test(r.line));
});

test("英語の要約: 最初の 1〜2 文 + 最後のお願い文。120 文字前後", () => {
	const r = summarizeForSpeech(EN, "invoice")!;
	assert.ok(r.line.startsWith("invoiceから。"), r.line);
	assert.ok(/fixed the failing test/.test(r.what), r.what);
	assert.ok(/^Please review the diff/.test(r.next), r.next);
	assert.ok(r.line.length <= 125, `${r.line.length}: ${r.line}`);
	assert.ok(!/Sure|https?:|`/.test(r.line), r.line);
});

test("要約: 次にすることが無ければ定番の締めを足す。質問だけの発言は繰り返さない", () => {
	assert.equal(summarizeForSpeech("ビルドが成功しました。", "A")!.line, "Aから。ビルドが成功しました。画面で結果を確認してください。");
	assert.equal(summarizeForSpeech("テストを実行してよろしいですか？", "A")!.line, "Aから。テストを実行してよろしいですか？");
});

test("要約: 長い文でも上限を守る。スペース名が長くても破綻しない", () => {
	const long = "とても長い説明が続きます、" .repeat(30) + "。最後に、ブラウザで画面を開いて表示を確認してください。";
	const r = summarizeForSpeech(long, "業務自動化")!;
	assert.ok(r.line.length <= 125, `${r.line.length}`);
	assert.ok(r.line.includes("確認してください"));
	const r2 = summarizeForSpeech("ログを整理しました。", "とても長いプロジェクト名のスペース名です")!;
	assert.ok(r2.line.length <= 125);
});

test("要約: 読める文が無い(コードだけ・空・記号だけ)なら undefined → 呼び出し側が定型文に戻す", () => {
	assert.equal(summarizeForSpeech("```\nnpm test\n```", "A"), undefined);
	assert.equal(summarizeForSpeech("", "A"), undefined);
	assert.equal(summarizeForSpeech(undefined, "A"), undefined);
	assert.equal(summarizeForSpeech("---\n|a|b|\n", "A"), undefined);
	assert.equal(summarizeForSpeech("はい。", "A"), undefined);
});
