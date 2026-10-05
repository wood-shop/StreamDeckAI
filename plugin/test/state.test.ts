import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStore, parseEvent, worstStatus } from "../src/state";
import type { AgentEvent } from "../src/types";

const ev = (o: Partial<AgentEvent> & { session_id: string }): AgentEvent => ({ agent: "claude", status: "working", ...o });

test("parseEvent: 正常系と正規化", () => {
	const r = parseEvent({ session_id: " s1 ", agent: "Claude", status: "WORKING", name: "n", cwd: "C:\\a\\b", wt_window_hint: "h", extra: 1 });
	assert.ok(r.ok);
	assert.deepEqual(r.event, { session_id: "s1", agent: "claude", status: "working", name: "n", cwd: "C:\\a\\b", wt_window_hint: "h" });
});

test("parseEvent: 不正入力を拒否", () => {
	for (const bad of [null, [], "x", {}, { session_id: "a" }, { session_id: "a", agent: "gpt", status: "done" }, { session_id: "a", agent: "grok", status: "sleeping" }, { session_id: 1, agent: "grok", status: "done" }]) {
		assert.equal(parseEvent(bad).ok, false, JSON.stringify(bad));
	}
});

test("parseEvent: 長すぎる文字列は切り詰め、制御文字は除去", () => {
	const r = parseEvent({ session_id: "a", agent: "grok", status: "done", name: "x".repeat(500) + "\u0007", message: "m".repeat(5000) });
	assert.ok(r.ok);
	assert.equal(r.event.name?.length, 80);
	assert.equal(r.event.message?.length, 600);
});

test("worstStatus: blocked > working > done > idle > none", () => {
	assert.equal(worstStatus(["idle", "done", "working"]), "working");
	assert.equal(worstStatus(["done", "blocked", "working"]), "blocked");
	assert.equal(worstStatus(["idle", "done"]), "done");
	assert.equal(worstStatus([]), "none");
});

test("Store: cwd でスペースにまとめ、最も深刻な状態をスペースの状態にする", () => {
	let t = 1000;
	const s = new SessionStore(() => t++);
	s.apply(ev({ session_id: "a", cwd: "C:\\work\\Proj\\", status: "done" }));
	s.apply(ev({ session_id: "b", cwd: "c:/work/proj", status: "blocked", agent: "codex" }));
	s.apply(ev({ session_id: "c", cwd: "C:\\work\\other", status: "idle", agent: "grok" }));
	const sp = s.spaces();
	assert.equal(sp.length, 2);
	assert.equal(sp[0]!.name, "Proj");
	assert.equal(sp[0]!.tabs.length, 2);
	assert.equal(sp[0]!.status, "blocked");
	assert.equal(sp[1]!.status, "idle");
	assert.deepEqual(s.counts(), { working: 0, blocked: 1, done: 1, idle: 1 });
});

test("Store: 読み上げ対象は →done / →blocked の遷移。同一状態の連打は無視、3 秒後の done は再通知", () => {
	let t = 0;
	const s = new SessionStore(() => t);
	assert.equal(s.apply(ev({ session_id: "a", status: "working" })).narrate, false);
	t += 500;
	assert.equal(s.apply(ev({ session_id: "a", status: "done" })).narrate, true);
	t += 500;
	assert.equal(s.apply(ev({ session_id: "a", status: "done" })).narrate, false, "すぐ後の重複は無視");
	t += 5000;
	assert.equal(s.apply(ev({ session_id: "a", status: "done" })).narrate, true, "Codex のように working 無しで次のターンが終わった場合");
	t += 100;
	assert.equal(s.apply(ev({ session_id: "a", status: "blocked" })).narrate, true);
	t += 100;
	assert.equal(s.apply(ev({ session_id: "a", status: "working" })).narrate, false);
	assert.equal(s.apply(ev({ session_id: "a", status: "idle" })).narrate, false);
});

test("Store: message は状態が変わったら引き継がない", () => {
	const s = new SessionStore(() => 1);
	s.apply(ev({ session_id: "a", status: "blocked", message: "rm -rf x" }));
	assert.equal(s.apply(ev({ session_id: "a", status: "working" })).session.message, "");
});

test("Store: 明示 space は cwd より優先され、以後のイベントでも維持", () => {
	const s = new SessionStore(() => 1);
	s.apply(ev({ session_id: "a", cwd: "C:\\x\\one", space: "業務自動化" }));
	s.apply(ev({ session_id: "b", cwd: "C:\\x\\two", space: "業務自動化" }));
	s.apply(ev({ session_id: "a", cwd: "C:\\x\\one", status: "done" }));
	const sp = s.spaces();
	assert.equal(sp.length, 1);
	assert.equal(sp[0]!.name, "業務自動化");
	assert.equal(sp[0]!.tabs.length, 2);
});

test("Store: TTL で期限切れセッションを消し、空スペースも消える", () => {
	let t = 0;
	const s = new SessionStore(() => t);
	s.apply(ev({ session_id: "a", cwd: "C:\\a" }));
	t = 5000;
	s.apply(ev({ session_id: "b", cwd: "C:\\b" }));
	s.selectedSpaceKey = s.spaces()[0]!.key;
	assert.equal(s.expire(3000), 1);
	assert.equal(s.spaces().length, 1);
	assert.equal(s.selectedSpaceKey, null);
	assert.equal(s.selectedSpace()?.name, "b");
});

test("Store: スペース押下で選択、選択済みを再押下すると 4 タブずつページ送り", () => {
	const s = new SessionStore(() => 1);
	for (let i = 0; i < 6; i++) s.apply(ev({ session_id: `a${i}`, cwd: "C:\\p" }));
	s.apply(ev({ session_id: "z", cwd: "C:\\q" }));
	const [p, q] = s.spaces();
	s.pressSpace(q!);
	assert.equal(s.selectedSpace()?.name, "q");
	s.pressSpace(p!);
	assert.equal(s.selectedSpace()?.name, "p");
	assert.equal(s.pageOf(p!.key), 0);
	s.pressSpace(p!);
	assert.equal(s.pageOf(p!.key), 1);
	s.pressSpace(p!);
	assert.equal(s.pageOf(p!.key), 0, "最後まで行ったら最初に戻る");
});
