import assert from "node:assert/strict";
import { test } from "node:test";
import { App, resolveSlot, sanitizeSettings, type Surface } from "../src/app";
import type { PsResult, PsRunner } from "../src/powershell";
import type { AgentEvent } from "../src/types";

const ev = (o: Partial<AgentEvent> & { session_id: string }): AgentEvent => ({ agent: "claude", status: "working", ...o });

function makeApp(result: Partial<PsResult> = {}) {
	const calls: Array<{ script: string; env: Record<string, string> }> = [];
	const runner: PsRunner = async (script, env) => {
		calls.push({ script, env });
		return { code: 0, stdout: "", stderr: "", ...result };
	};
	let t = 1_000_000;
	const app = new App({ runner, now: () => t });
	return { app, calls, advance: (ms: number) => (t += ms) };
}

function surface(app: App, id: string, kind: Surface["kind"], column = 0, slot: Surface["slot"] = "auto") {
	const pushed: string[] = [];
	const s: Surface = { id, kind, slot, column, push: async (svg) => void pushed.push(svg) };
	app.register(s);
	return { s, pushed };
}

test("sanitizeSettings: 範囲外・文字列・欠落を既定値に直す", () => {
	assert.equal(sanitizeSettings(undefined).port, 17890);
	assert.equal(sanitizeSettings({ port: "18000" }).port, 18000);
	assert.equal(sanitizeSettings({ port: 80 }).port, 17890);
	assert.equal(sanitizeSettings({ port: "abc" }).port, 17890);
	assert.equal(sanitizeSettings({ rate: 99 }).rate, 1);
	assert.equal(sanitizeSettings({ narration: "false" }).narration, false);
});

test("resolveSlot: select は文字列で来るので数値に直す。auto は列番号+1", () => {
	assert.equal(resolveSlot("5", 0), 5);
	assert.equal(resolveSlot(undefined, 2), 3);
	assert.equal(resolveSlot("auto", 3), 4);
	assert.equal(resolveSlot(99, 1), 2);
});

test("tick: 初回は全ボタンに送り、状態が変わらなければ送らない(同一画像スキップ)", () => {
	const { app } = makeApp();
	const a = surface(app, "a", "space", 0);
	const b = surface(app, "b", "tab", 0);
	const c = surface(app, "c", "infobar");
	assert.equal(app.tick(), 3);
	assert.equal(app.tick(), 0);
	assert.equal(a.pushed.length + b.pushed.length + c.pushed.length, 3);
	app.handleEvent(ev({ session_id: "s1", cwd: "C:\\w\\p", status: "blocked" }));
	assert.equal(app.tick(), 3, "状態が変われば全て再描画");
	assert.equal(app.tick(), 0);
});

test("tick: アニメ frame が変わると working のボタンだけ送られる", () => {
	const { app, advance } = makeApp();
	app.handleEvent(ev({ session_id: "s1", cwd: "C:\\w\\p", status: "working" }));
	surface(app, "sp", "space", 0);
	surface(app, "tab", "tab", 0);
	surface(app, "bar", "infobar");
	app.tick();
	advance(450);
	assert.equal(app.tick(), 1, "動くのはタブのキャラクターだけ(スペースの顔とインフォバーは静止)");
});

test("tick: push が失敗したら次回また送る", async () => {
	const { app } = makeApp();
	let fail = true;
	const calls: string[] = [];
	app.register({ id: "x", kind: "infobar", slot: "auto", column: 0, push: async (svg) => { calls.push(svg); if (fail) throw new Error("boom"); } });
	app.tick();
	await new Promise((r) => setImmediate(r));
	fail = false;
	assert.equal(app.tick(), 1);
	assert.equal(calls.length, 2);
});

test("レイアウト: 上段=スペース n 番目、下段=選択スペースのタブ n 番目", () => {
	const { app } = makeApp();
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\alpha", name: "A1" }));
	app.handleEvent(ev({ session_id: "b", cwd: "C:\\w\\alpha", name: "A2", agent: "codex" }));
	app.handleEvent(ev({ session_id: "c", cwd: "C:\\w\\beta", name: "B1", agent: "grok" }));
	const sp0 = surface(app, "sp0", "space", 0).s;
	const sp1 = surface(app, "sp1", "space", 1).s;
	const t0 = surface(app, "t0", "tab", 0).s;
	const t1 = surface(app, "t1", "tab", 1).s;
	const t2 = surface(app, "t2", "tab", 2).s;
	assert.match(app.renderSurface(sp0, 0), /alpha/);
	assert.match(app.renderSurface(sp1, 0), /beta/);
	assert.match(app.renderSurface(t0, 0), /A1/);
	assert.match(app.renderSurface(t1, 0), /A2/);
	assert.ok(app.renderSurface(t2, 0).includes("なし"), "タブが無い列は「なし」");
	assert.ok(app.pressSpace(sp1));
	assert.match(app.renderSurface(t0, 0), /B1/);
});

test("pressSpace: 空スロットは false(showAlert)", () => {
	const { app } = makeApp();
	const s = surface(app, "s", "space", 3).s;
	assert.equal(app.pressSpace(s), false);
});

test("pressTab: PowerShell に絶対ヒント(環境変数)を渡し、成功なら true・タブを選択", async () => {
	const { app, calls } = makeApp({ code: 0 });
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\alpha", name: "A1" }));
	app.handleEvent(ev({ session_id: "b", cwd: "C:\\w\\alpha", name: "A2", wt_window_hint: "tab-two" }));
	const t1 = surface(app, "t1", "tab", 1).s;
	assert.equal(await app.pressTab(t1), true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.env.SDAI_HINT, "tab-two");
	assert.ok(!calls[0]!.script.includes("tab-two"), "ヒントはスクリプトに埋め込まない(インジェクション対策)");
	assert.equal(app.store.selectedTab()?.id, "b");
});

test("pressTab: ヒントが無ければ name → cwd フォルダ名の順にフォールバック", async () => {
	const { app, calls } = makeApp();
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\alpha" , name: "請求書"}));
	await app.pressTab(surface(app, "t0", "tab", 0).s);
	assert.equal(calls[0]!.env.SDAI_HINT, "請求書");
});

test("pressTab: タブ見出しが見つからない(exit 2)/端末なし(exit 3)/空スロットは false", async () => {
	for (const code of [2, 3, 1]) {
		const { app } = makeApp({ code, stderr: "x" });
		app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\alpha" }));
		assert.equal(await app.pressTab(surface(app, "t0", "tab", 0).s), false, `exit ${code}`);
	}
	const { app, calls } = makeApp();
	assert.equal(await app.pressTab(surface(app, "t0", "tab", 0).s), false);
	assert.equal(calls.length, 0, "セッションが無ければ PowerShell を起動しない");
});

test("読み上げ: →done / →blocked でだけ PowerShell(System.Speech)が呼ばれる。narration=false なら無し", async () => {
	const { app, calls } = makeApp();
	const flush = () => new Promise((r) => setTimeout(r, 20));
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "working" }));
	await flush();
	assert.equal(calls.length, 0);
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "blocked", message: "ファイルを削除してよいですか" }));
	await flush();
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.script.includes("System.Speech"));
	assert.ok(calls[0]!.env.SDAI_TEXT?.startsWith("業務自動化から。"));
	assert.ok(calls[0]!.env.SDAI_TEXT?.includes("取り消しにくい"));
	await app.applySettings({ narration: false, port: 0 + 17999 });
	app.handleEvent(ev({ session_id: "a", status: "done" }));
	await flush();
	assert.equal(calls.length, 1);
	await app.shutdown();
});

test("applySettings: ポートを変えるとサーバーが作り直される", async () => {
	const { app } = makeApp();
	await app.applySettings({ port: 18123 });
	assert.equal(app.server.port, 18123);
	const r = await fetch("http://127.0.0.1:18123/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "z", agent: "grok", status: "idle", cwd: "C:\\q\\zed" }) });
	assert.equal(r.status, 200);
	assert.equal(app.store.spaces()[0]?.name, "zed");
	await app.applySettings({ port: 18124 });
	assert.equal(app.server.port, 18124);
	await assert.rejects(fetch("http://127.0.0.1:18123/health"));
	await app.shutdown();
});

test("applySettings: getGlobalSettings と didReceiveGlobalSettings が同時に来てもサーバーは 1 回だけ起動(実機の連続通知への対策)", async () => {
	const { app } = makeApp();
	await Promise.all([app.applySettings({ port: 18150 }), app.applySettings({ port: 18150 })]);
	assert.equal(app.server.listening, true);
	assert.equal(app.server.lastError, "");
	await app.shutdown();
});
