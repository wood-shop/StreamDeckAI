import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { App } from "../src/app";
import { renderInfobar } from "../src/svg";
import { TAIL_BYTES, TranscriptLocator } from "../src/transcript";
import type { AgentEvent, Session } from "../src/types";
import { formatTokens, UsageTracker, usageLevel } from "../src/usage";
import { assistantLine, makeClaudeDir, usage, userLine } from "./helpers-transcript";

const sess = (o: Partial<Session> = {}): Session => ({
	id: "sess-1", agent: "claude", status: "working", name: "請求書", cwd: "", hint: "", message: "", spaceKey: "k", spaceName: "業務自動化", firstSeen: 0, updatedAt: 0, ...o,
});
const counts = { working: 1, blocked: 0, done: 0, idle: 0 };

test("usageLevel: 70% までミント、90% まで黄、それ以上は赤(境界を含む)", () => {
	assert.equal(usageLevel(140_000, 200_000).color, "mint"); // ちょうど 70%
	assert.equal(usageLevel(140_001, 200_000).color, "yellow");
	assert.equal(usageLevel(180_000, 200_000).color, "yellow"); // ちょうど 90%
	assert.equal(usageLevel(180_001, 200_000).color, "red");
	assert.equal(usageLevel(0, 200_000).color, "mint");
	assert.equal(Math.round(usageLevel(500_000, 1_000_000).pct), 50);
	assert.equal(usageLevel(1, 0).pct, 0, "分母 0 でも壊れない");
});

test("formatTokens", () => {
	assert.equal(formatTokens(86_400), "86k");
	assert.equal(formatTokens(200_000), "200k");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(1_500_000), "1.5M");
	assert.equal(formatTokens(950), "950");
});

test("インフォバー: 使用率の行(バー・%・k 表記、色は 3 段階)と「取得不可」", () => {
	const bar = (tokens: number, win = 200_000) => renderInfobar({ counts, tab: sess(), usage: { info: { state: "ok", tokens }, contextWindow: win } });
	const ok = bar(100_000);
	assert.match(ok, /width="232" height="50"/);
	assert.ok(ok.includes("50%") && ok.includes("100k/200k"));
	assert.ok(ok.includes("#3ecf9a"), "ミント");
	assert.ok(bar(160_000).includes("#e3b100"), "黄");
	assert.ok(bar(190_000).includes("#e5484d"), "赤");
	assert.ok(bar(100_000, 1_000_000).includes("10%") && bar(100_000, 1_000_000).includes("100k/1M"));
	assert.ok(bar(300_000).includes("150%"), "分母より大きいときは正直に 100% 超を出す");
	const na = renderInfobar({ counts, tab: sess({ agent: "codex" }), usage: { info: { state: "unavailable", reason: "x" }, contextWindow: 200_000 } });
	assert.ok(na.includes("使用率: 取得不可"));
	assert.ok(!/\d%/.test(na.replace(/<[^>]+>/g, "|")), "推測の数字は出さない");
	// usage を渡さない呼び出し(v0.1 互換)は従来のレイアウト
	assert.ok(!renderInfobar({ counts, tab: sess() }).includes("使用率"));
});

test("UsageTracker: 変化が無ければ読み直さない / 5 秒未満は stat もしない / 更新されたら読む", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "p"));
		const f = path.join(projects, "p", "sess-1.jsonl");
		fs.writeFileSync(f, [userLine("hi"), assistantLine({ usage: usage(5, 40_000, 1_000, 100), text: "a" })].join("\n") + "\n");
		let t = 100_000;
		const tr = new UsageTracker({ locator: new TranscriptLocator({ claudeDirs: [dir], now: () => t }), now: () => t });
		const s = sess();
		assert.equal(tr.peek(s).state, "pending");
		await tr.request(s);
		assert.deepEqual(tr.peek(s), { state: "ok", tokens: 41_105, model: "claude-sonnet-4-5" });
		assert.equal(tr.reads, 1);
		t += 1000;
		await tr.request(s);
		t += 5000;
		await tr.request(s); // 5 秒たったので stat はするが、mtime/size 同じ → 読まない
		assert.equal(tr.reads, 1);
		fs.appendFileSync(f, assistantLine({ usage: usage(5, 90_000, 0, 50), text: "b", id: "m2" }) + "\n");
		t += 1000;
		await tr.request(s); // 前回から 1 秒 → まだ見ない
		assert.equal(tr.peek(s).state === "ok" && (tr.peek(s) as { tokens: number }).tokens, 41_105);
		t += 5000;
		await tr.request(s);
		assert.equal((tr.peek(s) as { tokens: number }).tokens, 90_055);
		assert.equal(tr.reads, 2);
	} finally {
		cleanup();
	}
});

test("UsageTracker: Claude 以外・記録なし・usage なしは「取得不可」(推測しない)", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "p"));
		fs.writeFileSync(path.join(projects, "p", "sess-1.jsonl"), userLine("hi") + "\n");
		let t = 0;
		const tr = new UsageTracker({ locator: new TranscriptLocator({ claudeDirs: [dir], now: () => t }), now: () => t });
		assert.equal(tr.peek(sess({ agent: "codex" })).state, "unavailable");
		assert.equal(tr.peek(sess({ agent: "grok" })).state, "unavailable");
		await tr.request(sess());
		assert.equal(tr.peek(sess()).state, "unavailable", "usage の無い記録");
		t += 6000;
		await tr.request(sess({ id: "ghost" }));
		assert.equal(tr.peek(sess({ id: "ghost" })).state, "unavailable", "記録ファイルなし");
		assert.equal(tr.reads, 1, "Codex/Grok ではファイルを読まない");
	} finally {
		cleanup();
	}
});

test("UsageTracker: 末尾 256KB に assistant 行が無いほど巨大な行が続くときは 1 回だけ 1MB まで広げる", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "p"));
		const f = path.join(projects, "p", "sess-1.jsonl");
		const huge = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(TAIL_BYTES + 50_000) }] } });
		fs.writeFileSync(f, [assistantLine({ usage: usage(1, 70_000, 0, 9) }), huge].join("\n") + "\n");
		const tr = new UsageTracker({ locator: new TranscriptLocator({ claudeDirs: [dir] }) });
		await tr.request(sess());
		assert.equal((tr.peek(sess()) as { tokens: number }).tokens, 70_010);
		assert.equal(tr.reads, 2);
	} finally {
		cleanup();
	}
});

test("App: インフォバーに選択中タブの使用率が出る。hook の transcript_path を優先、設定の上限で割る", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "C--w-proj"));
		const f = path.join(projects, "C--w-proj", "sess-1.jsonl");
		fs.writeFileSync(f, assistantLine({ usage: usage(2, 150_000, 0, 10) }) + "\n");
		let t = 1_000_000;
		const app = new App({ now: () => t, claudeDirs: [dir], runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
		const pushed: string[] = [];
		app.register({ id: "bar", kind: "infobar", slot: "auto", column: 0, push: async (svg) => void pushed.push(svg) });
		const ev = (o: Partial<AgentEvent>): AgentEvent => ({ session_id: "sess-1", agent: "claude", status: "working", cwd: "C:\\w\\proj", name: "請求書", ...o });
		app.handleEvent(ev({ transcript_path: f }));
		assert.equal(app.store.selectedTab()?.transcriptPath, f);
		app.tick();
		assert.ok(pushed.at(-1)!.includes("使用率: 確認中"));
		await new Promise((r) => setTimeout(r, 50));
		app.tick();
		assert.ok(pushed.at(-1)!.includes("75%") && pushed.at(-1)!.includes("150k/200k"), pushed.at(-1));
		assert.ok(pushed.at(-1)!.includes("#e3b100"), "75% は黄");
		await app.applySettings({ port: 18401, contextWindow: 1_000_000 });
		app.tick();
		assert.ok(pushed.at(-1)!.includes("15%") && pushed.at(-1)!.includes("150k/1M"));
		// 別のエージェントを選ぶと「取得不可」
		app.handleEvent(ev({ session_id: "cx", agent: "codex", cwd: "C:\\w\\proj", name: "codex" }));
		app.store.selectedTabId = "cx";
		app.tick();
		assert.ok(pushed.at(-1)!.includes("使用率: 取得不可"));
		await app.shutdown();
	} finally {
		cleanup();
	}
});
