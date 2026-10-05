import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNarration, detectDestructive, excerpt } from "../src/narration";
import type { Session } from "../src/types";

const s = (o: Partial<Session> = {}): Session => ({
	id: "1", agent: "claude", status: "blocked", name: "請求書", cwd: "", hint: "", message: "", spaceKey: "k", spaceName: "業務自動化", firstSeen: 0, updatedAt: 0, ...o,
});

test("完了: 先頭にスペース名、次にすることを伝える", () => {
	const t = buildNarration(s({ status: "done" }), "done", { includeMessage: true });
	assert.ok(t.startsWith("業務自動化から。"));
	assert.ok(t.includes("完了しました"));
	assert.ok(t.includes("次の指示"));
});

test("確認待ち + 削除系 message: 取り消しにくい操作を必ず言う(本文を読まない設定でも)", () => {
	for (const includeMessage of [true, false]) {
		const t = buildNarration(s({ message: "node_modules を削除するコマンド rm -rf node_modules を実行してよいですか" }), "blocked", { includeMessage });
		assert.ok(t.startsWith("業務自動化から。"));
		assert.ok(t.includes("削除"), t);
		assert.ok(t.includes("取り消しにくい操作"), t);
		assert.equal(t.includes("rm -rf"), includeMessage);
	}
});

test("確認待ち: どれを選ぶべきかは勧めない", () => {
	const t = buildNarration(s({ message: "Run npm test?" }), "blocked", { includeMessage: true });
	assert.ok(!/おすすめ|推奨|許可してください|断ってください/.test(t));
	assert.ok(t.includes("許可するか断るか"));
	assert.ok(!t.includes("取り消しにくい"), "破壊的でなければ警告しない");
});

test("確認待ち message なし: 画面で確認を促す", () => {
	const t = buildNarration(s(), "blocked", { includeMessage: true });
	assert.ok(t.includes("画面で確認"));
});

test("detectDestructive: 英日の代表パターン", () => {
	assert.deepEqual(detectDestructive("Delete the file?"), ["削除"]);
	assert.ok(detectDestructive("git reset --hard HEAD~3").includes("強制的な変更"));
	assert.ok(detectDestructive("git push origin main --force").includes("強制的な変更"));
	assert.ok(detectDestructive("DROP TABLE users").includes("データの破棄"));
	assert.ok(detectDestructive("Remove-Item C:\\x -Recurse").includes("削除"));
	assert.deepEqual(detectDestructive("Run npm test"), []);
	assert.deepEqual(detectDestructive(undefined), []);
});

test("excerpt: 記号を除き 90 文字で切る", () => {
	assert.equal(excerpt("a `b` *c*\n d"), "a b c d");
	assert.ok(excerpt("あ".repeat(200)).endsWith("以下省略"));
});

test("name がスペース名と同じなら繰り返さない", () => {
	const t = buildNarration(s({ name: "業務自動化", agent: "grok", status: "done" }), "done", { includeMessage: false });
	assert.ok(t.startsWith("業務自動化から。Grokが完了しました"));
});
