import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { extractContextUsage, extractLastAssistantText, isAllowedTranscriptPath, parseJsonl, readTail, TranscriptLocator } from "../src/transcript";
import { assistantLine, makeClaudeDir, toolResultLine, usage, userLine } from "./helpers-transcript";

test("extractContextUsage: 最新の assistant の usage を input+cache_read+cache_creation+output で合計", () => {
	const t = [
		assistantLine({ usage: usage(10, 1000, 500, 5) }),
		userLine("次"),
		assistantLine({ usage: usage(3, 120_000, 4_000, 800), text: "ok" }),
	].join("\n");
	assert.deepEqual(extractContextUsage(t), { tokens: 3 + 120_000 + 4_000 + 800, model: "claude-sonnet-4-5" });
	assert.equal(extractContextUsage(t, { includeOutput: false })?.tokens, 124_003);
});

test("extractContextUsage: 合成メッセージ・サブエージェント・空 usage・壊れた行は飛ばし、無ければ undefined", () => {
	const t = [
		assistantLine({ usage: usage(1, 50_000, 0, 10) }),
		assistantLine({ usage: usage(0, 0, 0, 0) }),
		assistantLine({ usage: usage(9, 900_000, 0, 0), model: "<synthetic>" }),
		assistantLine({ usage: usage(9, 900_000, 0, 0), sidechain: true }),
		'{"type":"assistant","message":{"usage":{"input_tokens":',
		"garbage line",
	].join("\n");
	assert.equal(extractContextUsage(t)?.tokens, 50_011);
	assert.equal(extractContextUsage([userLine("hi"), "{}"].join("\n")), undefined);
	assert.equal(extractContextUsage(""), undefined);
});

test("readTail: 末尾だけ読み、先頭の欠けた行(日本語の途中を含む)は捨てる", async () => {
	const { dir, cleanup } = makeClaudeDir();
	try {
		const f = path.join(dir, "big.jsonl");
		const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: "user", message: { content: `日本語の行 ${i} ${"あ".repeat(40)}` } }));
		fs.writeFileSync(f, lines.join("\n") + "\n");
		const size = fs.statSync(f).size;
		assert.ok(size > 100_000);
		const tail = await readTail(f, 4096);
		assert.equal(tail.complete, false);
		assert.ok(tail.text.length < 4096);
		const parsed = parseJsonl(tail.text);
		assert.equal(parsed.length, tail.text.split("\n").filter(Boolean).length, "全ての行が完全な JSON");
		assert.ok(JSON.stringify(parsed.at(-1)).includes("日本語の行 1999"));
		assert.ok(!tail.text.includes("\uFFFD"), "UTF-8 の途中で切れた文字が混ざらない");
		const all = await readTail(f, size + 10);
		assert.equal(all.complete, true);
		assert.equal(parseJsonl(all.text).length, 2000);
	} finally {
		cleanup();
	}
});

test("extractLastAssistantText: 日本語。同じ message.id の連続行は連結、tool_use だけの行は飛ばす", () => {
	const t = [
		userLine("請求書の集計を直して"),
		assistantLine({ id: "m1", text: "まず確認します。", tool: true }),
		toolResultLine(),
		assistantLine({ id: "m2", text: "集計処理を修正しました。" }),
		assistantLine({ id: "m2", text: "テストもすべて通りました。" }),
		assistantLine({ id: "m2", tool: true }),
	].join("\n");
	assert.equal(extractLastAssistantText(t), "集計処理を修正しました。\nテストもすべて通りました。");
});

test("extractLastAssistantText: 英語。サブエージェントの発言は無視", () => {
	const t = [userLine("fix it"), assistantLine({ id: "a", text: "Fixed the bug." }), assistantLine({ id: "b", text: "subagent chatter", sidechain: true })].join("\n");
	assert.equal(extractLastAssistantText(t), "Fixed the bug.");
});

test("extractLastAssistantText: 今回の入力より前の返答(前のターンの古い文)は返さない", () => {
	const t = [userLine("前の依頼"), assistantLine({ text: "前のターンの返事" }), userLine("今回の依頼"), assistantLine({ tool: true }), toolResultLine()].join("\n");
	assert.equal(extractLastAssistantText(t), undefined);
	// content が文字列の assistant も読める
	const s = JSON.stringify({ type: "assistant", message: { id: "z", content: "文字列で来た返事" } });
	assert.equal(extractLastAssistantText([userLine("q"), s].join("\n")), "文字列で来た返事");
});

test("isAllowedTranscriptPath: .claude 配下の絶対パスの *.jsonl だけ", () => {
	assert.ok(isAllowedTranscriptPath("C:\\Users\\me\\.claude\\projects\\C--work-proj\\abc.jsonl", []));
	assert.ok(isAllowedTranscriptPath("/home/me/.claude/projects/x/abc.jsonl", []));
	assert.ok(isAllowedTranscriptPath("D:\\cfg\\claude\\projects\\x\\a.jsonl", ["D:\\cfg\\claude"]));
	for (const bad of ["", "relative/.claude/a.jsonl", "C:\\Users\\me\\.ssh\\id_rsa", "C:\\Users\\me\\.claude\\settings.json", "C:\\Users\\me\\.claude\\..\\secret.jsonl", "C:\\Users\\me\\notes.jsonl"])
		assert.equal(isAllowedTranscriptPath(bad, []), false, bad);
});

test("TranscriptLocator: hook の transcript_path → projects/*/<session_id>.jsonl の順。変な session_id は探さない", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "C--work-a"));
		fs.mkdirSync(path.join(projects, "C--work-b"));
		const target = path.join(projects, "C--work-b", "sess-1.jsonl");
		fs.writeFileSync(target, "{}\n");
		let t = 0;
		const loc = new TranscriptLocator({ claudeDirs: [dir], now: () => t, missRetryMs: 1000 });
		assert.equal(await loc.locate("sess-1"), target);
		assert.equal(await loc.locate("sess-1", "/etc/passwd"), target, "許可されないパスは無視して探索に戻る");
		const other = path.join(projects, "C--work-a", "other.jsonl");
		fs.writeFileSync(other, "{}\n");
		assert.equal(await loc.locate("zzz", other), other, "hook が教えたパスを優先");
		assert.equal(await loc.locate("../../etc/passwd"), undefined);
		assert.equal(await loc.locate("nope"), undefined);
		fs.writeFileSync(path.join(projects, "C--work-a", "nope.jsonl"), "{}\n");
		assert.equal(await loc.locate("nope"), undefined, "見つからなかった直後は探し直さない(読み取り負荷対策)");
		t = 1500;
		assert.equal(await loc.locate("nope"), path.join(projects, "C--work-a", "nope.jsonl"));
	} finally {
		cleanup();
	}
});
