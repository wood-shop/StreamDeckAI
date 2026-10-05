import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_APPS,
	defaultAppsFile,
	enabledAgents,
	mergeCatalogIntoLocal,
	parseAppsPayload,
	readAppsFile,
	writeAppsFile,
} from "../src/apps";
import { App, PLUGIN_UUID, PLUGIN_VERSION } from "../src/app";
import { EventServer } from "../src/server";
import { SessionStore } from "../src/state";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdPlugin = path.resolve(here, "../jp.example.streamdeckai.sdPlugin");
const tmpDirs: string[] = [];
after(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "sdai-v03-"));
	tmpDirs.push(d);
	return d;
};

test("バージョン: PLUGIN_VERSION / manifest / package が 0.3", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(sdPlugin, "manifest.json"), "utf8"));
	const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8"));
	assert.equal(PLUGIN_VERSION, "0.3.0.0");
	assert.equal(PLUGIN_UUID, "jp.example.streamdeckai");
	assert.equal(manifest.Version, "0.3.0.0");
	assert.equal(pkg.version, "0.3.0");
});

test("parseAppsPayload: フル形と短縮形 {enabled}", () => {
	const full = parseAppsPayload({
		schema: 1,
		apps: [
			{ id: "claude-code", name: "Claude Code", enabled: true, streamdeck: { agent: "claude" } },
			{ id: "codex", name: "Codex", enabled: false, streamdeck: { agent: "codex" } },
		],
	});
	assert.ok(full.ok);
	if (full.ok) {
		assert.equal(full.apps.apps.length, 2);
		assert.deepEqual([...enabledAgents(full.apps)], ["claude"]);
	}
	const short = parseAppsPayload({ enabled: ["codex", "GROK-BOT"] }, defaultAppsFile());
	assert.ok(short.ok);
	if (short.ok) {
		assert.equal(short.apps.apps.find((a) => a.id === "codex")?.enabled, true);
		assert.equal(short.apps.apps.find((a) => a.id === "grok-bot")?.enabled, true);
		assert.equal(short.apps.apps.find((a) => a.id === "claude-code")?.enabled, false);
		assert.deepEqual([...enabledAgents(short.apps)].sort(), ["codex", "grok"]);
	}
	assert.equal(parseAppsPayload({ apps: [{ name: "x", enabled: true }] }).ok, false);
	assert.equal(parseAppsPayload({ apps: [{ id: "x", name: "x", enabled: true, streamdeck: { agent: "nope" } }] }).ok, false);
});

test("apps.json の読み書きと Defaults", () => {
	const dir = tmp();
	const file = path.join(dir, "apps.json");
	assert.equal(readAppsFile(file).apps.length, DEFAULT_APPS.length, "無いファイルは Defaults");
	const apps = defaultAppsFile();
	apps.apps[0]!.enabled = false;
	writeAppsFile(file, apps);
	const again = readAppsFile(file);
	assert.equal(again.apps[0]!.enabled, false);
});

test("mergeCatalogIntoLocal: streamdeck 付きだけ取り込む", () => {
	const local = defaultAppsFile();
	const merged = mergeCatalogIntoLocal(local, [
		{ name: "PCsecurity", category: "ツール", version: "0.1.1" },
		{ id: "extra-agent", name: "Extra", status: "developing", streamdeck: { agent: "grok", enabledDefault: true } },
		{ id: "claude-code", name: "Claude Code (catalog)", streamdeck: { agent: "claude", enabledDefault: false } },
	]);
	assert.ok(merged.apps.some((a) => a.id === "extra-agent" && a.enabled === true));
	assert.equal(merged.apps.find((a) => a.id === "claude-code")?.name, "Claude Code (catalog)");
	assert.equal(merged.apps.find((a) => a.id === "claude-code")?.enabled, true, "既存の enabled は維持");
	assert.ok(!merged.apps.some((a) => a.name === "PCsecurity"));
});

test("SessionStore.retainAgents / removeByAgents", () => {
	const store = new SessionStore(() => 1000);
	store.apply({ session_id: "a", agent: "claude", status: "working" });
	store.apply({ session_id: "b", agent: "codex", status: "done" });
	store.apply({ session_id: "c", agent: "grok", status: "idle" });
	assert.equal(store.removeByAgents(["codex"]), 1);
	assert.equal(store.size, 2);
	assert.equal(store.retainAgents(new Set(["claude"])), 1);
	assert.equal(store.size, 1);
});

test("無効 agent のイベントは ignored、有効なら適用", async () => {
	const dir = tmp();
	const appsPath = path.join(dir, "apps.json");
	const apps = defaultAppsFile();
	for (const a of apps.apps) a.enabled = a.id === "claude-code";
	writeAppsFile(appsPath, apps);
	const app = new App({
		appsPath,
		runner: async () => ({ code: 0, stdout: "", stderr: "" }),
		claudeDirs: [],
	});
	await app.applySettings({ port: 18501, narration: false });
	const post = (o: object) =>
		fetch("http://127.0.0.1:18501/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
	const ignored = await post({ session_id: "g1", agent: "grok", status: "blocked", name: "x" });
	assert.equal(ignored.status, 200);
	assert.deepEqual(await ignored.json(), { ok: true, ignored: true });
	assert.equal(app.store.size, 0);
	const ok = await post({ session_id: "c1", agent: "claude", status: "working", name: "y" });
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { ok: true });
	assert.equal(app.store.size, 1);
	await app.shutdown();
});

test("GET /version と GET|POST /apps", async () => {
	const dir = tmp();
	const appsPath = path.join(dir, "apps.json");
	const app = new App({
		appsPath,
		initialApps: defaultAppsFile(),
		runner: async () => ({ code: 0, stdout: "", stderr: "" }),
		claudeDirs: [],
	});
	await app.applySettings({ port: 18502, narration: false });
	const base = "http://127.0.0.1:18502";

	const ver = await (await fetch(`${base}/version`)).json() as { ok: boolean; version: string; plugin: string; port: number };
	assert.equal(ver.ok, true);
	assert.equal(ver.version, "0.3.0.0");
	assert.equal(ver.plugin, "jp.example.streamdeckai");
	assert.equal(ver.port, 18502);

	const get = await (await fetch(`${base}/apps`)).json() as { ok: boolean; apps: { apps: { id: string; enabled: boolean }[] } };
	assert.equal(get.ok, true);
	assert.equal(get.apps.apps.length, 3);

	app.store.apply({ session_id: "g1", agent: "grok", status: "working", name: "keep?" });
	app.store.apply({ session_id: "c1", agent: "claude", status: "working" });
	assert.equal(app.store.size, 2);

	const post = await fetch(`${base}/apps`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled: ["claude-code"] }),
	});
	assert.equal(post.status, 200);
	const body = await post.json() as { ok: boolean; apps: { apps: { id: string; enabled: boolean }[] } };
	assert.equal(body.ok, true);
	assert.equal(body.apps.apps.find((a) => a.id === "claude-code")?.enabled, true);
	assert.equal(body.apps.apps.find((a) => a.id === "grok-bot")?.enabled, false);
	assert.equal(app.store.size, 1, "無効化した grok セッションは削除");
	assert.ok(fs.existsSync(appsPath), "apps.json に書き戻す");

	const bad = await fetch(`${base}/apps`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ apps: [{ id: "x", name: "x", enabled: true, streamdeck: { agent: "nope" } }] }),
	});
	assert.equal(bad.status, 400);

	await app.shutdown();
});

test("EventServer 単体でも /version /apps が動く", async () => {
	let apps = defaultAppsFile();
	const server = new EventServer({
		onEvent: () => undefined,
		getApps: () => apps,
		setApps: (raw) => {
			const p = parseAppsPayload(raw, apps);
			if (!p.ok) return p;
			apps = p.apps;
			return { ok: true, apps };
		},
		getVersion: () => ({ version: "0.3.0.0", plugin: "jp.example.streamdeckai", port: 0 }),
	});
	const port = await server.start(0);
	const base = `http://127.0.0.1:${port}`;
	assert.equal((await (await fetch(`${base}/version`)).json() as { version: string }).version, "0.3.0.0");
	const r = await fetch(`${base}/apps`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled: ["codex"] }),
	});
	assert.equal(r.status, 200);
	assert.deepEqual([...enabledAgents(apps)], ["codex"]);
	await server.stop();
});
