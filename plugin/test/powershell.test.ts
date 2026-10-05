import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FOCUS_SCRIPT, focusTab } from "../src/focus";
import { encodeCommand, resolvePowerShell } from "../src/powershell";
import { SPEECH_SCRIPT, Speaker } from "../src/speech";

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;
const here = path.dirname(fileURLToPath(import.meta.url));

test("resolvePowerShell: 絶対パス(SystemRoot から組み立て)。設定で上書き可", () => {
	assert.equal(resolvePowerShell("", { SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(resolvePowerShell("", {}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(resolvePowerShell(" D:\\ps\\pwsh.exe ", {}), "D:\\ps\\pwsh.exe");
});

test("encodeCommand: UTF-16LE の base64", () => {
	assert.equal(Buffer.from(encodeCommand("日本語 abc"), "base64").toString("utf16le"), "日本語 abc");
});

test("focusTab: 終了コードを結果に対応づける", async () => {
	const run = (code: number) => async () => ({ code, stdout: "", stderr: "err" });
	assert.equal((await focusTab("x", run(0))).ok, true);
	assert.equal((await focusTab("x", run(2))).reason, "tab-not-found");
	assert.equal((await focusTab("x", run(3))).reason, "no-terminal");
	assert.equal((await focusTab("x", run(124))).reason, "error");
});

test("Speaker: 順番に再生し、溜まりすぎたら古いものを捨てる", async () => {
	const texts: string[] = [];
	let release: () => void = () => undefined;
	const gate = new Promise<void>((r) => (release = r));
	const sp = new Speaker({
		run: async (_s, env) => {
			texts.push(env.SDAI_TEXT!);
			await gate;
			return { code: 0, stdout: "", stderr: "" };
		},
		voiceName: () => "",
		rate: () => 0,
		maxQueue: 2,
	});
	for (const t of ["1", "2", "3", "4", "5"]) sp.enqueue(t);
	release();
	await new Promise((r) => setTimeout(r, 30));
	assert.deepEqual(texts, ["1", "4", "5"]);
});

test("PowerShell スクリプトの構文(pwsh のパーサで確認。5.1 固有の差異は未確認)", { skip: !hasPwsh }, () => {
	for (const [name, script] of [["focus", FOCUS_SCRIPT], ["speech", SPEECH_SCRIPT]] as const) {
		const code = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SRC,[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`;
		const r = spawnSync("pwsh", ["-NoProfile", "-Command", code], { env: { ...process.env, SRC: script }, encoding: "utf8" });
		assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
	}
});

test("フックスクリプト: stdin の Claude Code JSON から正しい POST が作られる(pwsh 実行、サーバーはモック)", { skip: !hasPwsh }, async () => {
	const { EventServer } = await import("../src/server");
	const got: unknown[] = [];
	const srv = new EventServer({ onEvent: (e) => { got.push(e); } });
	const port = await srv.start(0);
	const hook = path.resolve(here, "../jp.example.streamdeckai.sdPlugin/hooks/streamdeckai-hook.ps1");
	assert.ok(fs.existsSync(hook));
	// サーバーと同じプロセスなので spawnSync は使えない(イベントループが止まる)
	const run = (args: string[], input?: string) =>
		new Promise<{ status: number | null; stdout: string }>((resolve) => {
			const c = spawn("pwsh", ["-NoProfile", "-File", hook, ...args], { env: { ...process.env, STREAMDECKAI_PORT: String(port) } });
			let stdout = "";
			c.stdout.on("data", (d) => (stdout += d));
			c.on("close", (status) => resolve({ status, stdout }));
			c.stdin.end(input ?? "");
		});
	const claude = (o: object) => run(["-Agent", "claude"], JSON.stringify(o));
	assert.equal((await claude({ session_id: "c1", cwd: "/w/日本語プロジェクト", hook_event_name: "UserPromptSubmit" })).status, 0);
	assert.equal((await claude({ session_id: "c1", cwd: "/w/日本語プロジェクト", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })).status, 0);
	await claude({ session_id: "c1", cwd: "/w/日本語プロジェクト", hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
	await claude({ session_id: "c1", cwd: "/w/日本語プロジェクト", hook_event_name: "Stop" });
	await run(["-Agent", "codex", '{"type":"agent-turn-complete","thread-id":"x1","cwd":"/w/p","last-assistant-message":"終わりました"}']);
	await run(["-Agent", "grok", "-Status", "blocked", "-SessionId", "g1", "-Cwd", "/w/q", "-Message", "Delete it?"]);
	await srv.stop();
	const simple = (got as Array<Record<string, string>>).map((e) => `${e.agent}:${e.session_id}:${e.status}`);
	assert.deepEqual(simple, ["claude:c1:working", "claude:c1:blocked", "claude:c1:done", "codex:x1:done", "grok:g1:blocked"], "idle_prompt の Notification は送られない");
	const first = got[0] as Record<string, string>;
	assert.equal(first.name, "日本語プロジェクト");
	assert.equal((got[3] as Record<string, string>).message, "終わりました");
	// プラグインが落ちていてもフックは 0 で終わり、何も出力しない
	const down = spawnSync("pwsh", ["-NoProfile", "-File", hook, "-Agent", "grok", "-Status", "done", "-SessionId", "z", "-Port", "1"], { encoding: "utf8" });
	assert.equal(down.status, 0);
	assert.equal(down.stdout, "");
});
