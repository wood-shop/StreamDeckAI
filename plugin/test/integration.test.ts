/**
 * 偽の Stream Deck(WebSocket サーバー)に、ビルド済みの bin/plugin.js をつないで、
 * 登録 → willAppear → イベント受信 → setImage/setFeedback → keyDown(showAlert) まで通す。
 * 実機ではないので、Stream Deck アプリ側の挙動(描画・Neo 実機)の保証にはならない。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../jp.example.streamdeckai.sdPlugin");
const built = fs.existsSync(path.join(root, "bin/plugin.js"));
const UUID = "jp.example.streamdeckai";

test("偽 Stream Deck 経由: 登録・描画・押下の一連", { skip: !built && "npm run build が先に必要", timeout: 30_000 }, async () => {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((r) => wss.once("listening", () => r()));
	const sdPort = (wss.address() as AddressInfo).port;
	const pluginPort = 18300 + Math.floor(Math.random() * 500);
	let stderr = "";
	let barSvg = () => "";
	const msgs: Array<Record<string, any>> = [];
	let sock: WebSocket | undefined;
	const send = (o: object) => sock!.send(JSON.stringify(o));
	const waitFor = async (pred: () => boolean, label: string, ms = 8000) => {
		const t0 = Date.now();
		while (!pred()) {
			if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}\n${[...new Set(msgs.map((m) => `${m.event}@${m.context ?? ""}`))].join(", ")}\nFB=${msgs.filter((m) => m.event === "setFeedback").length} ${barSvg().replace(/<[^>]+>/g, "|").slice(0, 300)}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	wss.on("connection", (ws) => {
		sock = ws;
		ws.on("message", (d) => {
			const m = JSON.parse(String(d));
			msgs.push(m);
			if (m.event === "getGlobalSettings") send({ event: "didReceiveGlobalSettings", payload: { settings: { port: pluginPort, narration: false } } });
		});
	});
	const info = { application: { font: "", language: "ja", platform: "windows", platformVersion: "11", version: "7.6.0" }, plugin: { uuid: UUID, version: "0.1.0.0" }, devicePixelRatio: 1, colors: {}, devices: [{ id: "dev1", name: "Neo", size: { columns: 4, rows: 2 }, type: 9 }] };
	const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(sdPort), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
	child.stderr.on("data", (d) => (stderr += d));
	try {
		await waitFor(() => msgs.some((m) => m.event === "registerPlugin" && m.uuid === UUID), "register");
		const appear = (action: string, context: string, controller: string, column: number, row: number) =>
			send({ event: "willAppear", action: `${UUID}.${action}`, context, device: "dev1", payload: { controller, coordinates: { column, row }, isInMultiAction: false, settings: {}, state: 0 } });
		appear("space", "ctx-space", "Keypad", 0, 0);
		appear("tab", "ctx-tab0", "Keypad", 0, 1);
		appear("tab", "ctx-tab1", "Keypad", 1, 1);
		appear("infobar", "ctx-bar", "Neo", 0, 0);
		await waitFor(() => msgs.some((m) => m.event === "getGlobalSettings"), "getGlobalSettings");
		await waitFor(() => msgs.some((m) => m.event === "setImage" && m.context === "ctx-tab0"), "初回描画");

		const health = async () => (await fetch(`http://127.0.0.1:${pluginPort}/health`)).status;
		await waitFor(() => health().then((s) => s === 200, () => false) as unknown as boolean, "health", 100).catch(() => undefined);
		for (let i = 0; i < 40; i++) {
			if (await health().catch(() => 0) === 200) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const post = (o: object) => fetch(`http://127.0.0.1:${pluginPort}/event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
		assert.equal((await post({ session_id: "s1", agent: "claude", status: "blocked", name: "請求書", cwd: "C:\\w\\業務自動化", message: "削除してよいですか" })).status, 200);
		assert.equal((await post({ session_id: "s2", agent: "codex", status: "working", name: "テスト", cwd: "C:\\w\\業務自動化" })).status, 200);

		const lastImage = (ctx: string) => {
			const m = [...msgs].reverse().find((x) => x.event === "setImage" && x.context === ctx);
			return m ? decodeURIComponent(String(m.payload.image).split(",")[1]!) : "";
		};
		await waitFor(() => lastImage("ctx-tab0").includes("#f7c4c6"), "blocked のタブ描画(選択中なので明るい赤)");
		await waitFor(() => lastImage("ctx-tab1").includes("#e3b100"), "working(黄)のタブ描画");
		assert.ok(lastImage("ctx-space").includes("業務自動化"));
		barSvg = () => {
			const m = [...msgs].reverse().find((x) => x.event === "setFeedback" && x.context === "ctx-bar");
			return m ? Buffer.from(String(m.payload.canvas).split(",")[1]!, "base64").toString("utf8") : "";
		};
		await waitFor(() => barSvg().includes("請求書"), "infobar への setFeedback(選択中タブ名)");
		assert.ok(barSvg().includes("確認待ち"));

		// タブ押下: この箱には Windows Terminal も powershell.exe も無いので失敗 → showAlert、成功マーク(showOk)は出ない
		send({ event: "keyDown", action: `${UUID}.tab`, context: "ctx-tab0", device: "dev1", payload: { controller: "Keypad", coordinates: { column: 0, row: 1 }, isInMultiAction: false, settings: {}, state: 0 } });
		await waitFor(() => msgs.some((m) => m.event === "showAlert" && m.context === "ctx-tab0"), "showAlert");
		assert.ok(!msgs.some((m) => m.event === "showOk"));

		// 画像は変化が無ければ再送されない
		const n = msgs.filter((m) => m.event === "setImage" && m.context === "ctx-space").length;
		await new Promise((r) => setTimeout(r, 700));
		const n2 = msgs.filter((m) => m.event === "setImage" && m.context === "ctx-space").length;
		assert.ok(n2 - n <= 0, `スペースの顔は静止 → 再送なし (${n} → ${n2})`);
		const tabImgs = msgs.filter((m) => m.event === "setImage" && m.context === "ctx-tab1").length;
		assert.ok(tabImgs >= 2, "working のタブはアニメで送られる");
	} finally {
		child.kill();
		wss.close();
		if (stderr.trim()) console.error(stderr.slice(0, 500));
	}
});
