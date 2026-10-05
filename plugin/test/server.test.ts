import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { EventServer, MAX_BODY } from "../src/server";
import type { AgentEvent } from "../src/types";

const received: AgentEvent[] = [];
const server = new EventServer({ onEvent: (e) => { received.push(e); }, sessionCount: () => received.length });
let base = "";

before(async () => {
	const port = await server.start(0);
	base = `http://127.0.0.1:${port}`;
});
after(() => server.stop());

const post = (body: string, headers: Record<string, string> = { "Content-Type": "application/json" }) => fetch(`${base}/event`, { method: "POST", headers, body });

test("127.0.0.1 だけで待ち受ける", () => {
	assert.equal(server.address()?.address, "127.0.0.1");
});

test("POST /event 正常 → 200 とイベント受信(日本語もそのまま)", async () => {
	const r = await post(JSON.stringify({ session_id: "s1", agent: "grok", status: "blocked", name: "削除確認", message: "rm -rf build ?" }));
	assert.equal(r.status, 200);
	assert.deepEqual(await r.json(), { ok: true });
	assert.equal(received.at(-1)?.name, "削除確認");
});

test("BOM 付き JSON(PowerShell 5.1)も受け付ける", async () => {
	const r = await post("\uFEFF" + JSON.stringify({ session_id: "s2", agent: "claude", status: "done" }));
	assert.equal(r.status, 200);
});

test("不正な本文は 400、イベントは増えない", async () => {
	const n = received.length;
	assert.equal((await post("{not json")).status, 400);
	assert.equal((await post(JSON.stringify({ session_id: "x", agent: "nope", status: "done" }))).status, 400);
	assert.equal((await post(JSON.stringify({ agent: "claude", status: "done" }))).status, 400);
	assert.equal(received.length, n);
});

test("Content-Type が application/json でなければ 415(ブラウザからの CSRF 対策)", async () => {
	const r = await post(JSON.stringify({ session_id: "s", agent: "claude", status: "done" }), { "Content-Type": "text/plain" });
	assert.equal(r.status, 415);
});

test("大きすぎる本文は 413", async () => {
	const res = await new Promise<number>((resolve) => {
		const req = http.request(`${base}/event`, { method: "POST", agent: false, headers: { "Content-Type": "application/json" } }, (r) => {
			resolve(r.statusCode ?? 0);
			r.resume();
		});
		req.on("error", () => resolve(413)); // 切断された場合も拒否扱い
		req.end("x".repeat(MAX_BODY + 10));
	});
	assert.equal(res, 413);
});

test("Host ヘッダが localhost 以外なら 403(DNS rebinding 対策)", async () => {
	const status = await new Promise<number>((resolve, reject) => {
		const req = http.request(`${base}/health`, { agent: false, headers: { Host: "evil.example" } }, (r) => {
			resolve(r.statusCode ?? 0);
			r.resume();
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
});

test("GET /health と未知のパス/メソッド", async () => {
	const h = await fetch(`${base}/health`);
	assert.equal(h.status, 200);
	assert.equal((await h.json() as { ok: boolean }).ok, true);
	assert.equal((await fetch(`${base}/nope`)).status, 404);
	assert.equal((await fetch(`${base}/event`)).status, 405);
});

test("ポート使用中は lastError にメッセージを残して reject", async () => {
	const other = new EventServer({ onEvent: () => undefined });
	await assert.rejects(other.start(server.port));
	assert.match(other.lastError, /使用中/);
});
