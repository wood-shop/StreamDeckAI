import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { App, sanitizeSettings } from "../src/app";
import { planNarration } from "../src/narration";
import type { PsRunner } from "../src/powershell";
import { EventServer } from "../src/server";
import { SOUND_SCRIPT, Speaker } from "../src/speech";
import { parseEvent } from "../src/state";
import type { AgentEvent, Session } from "../src/types";
import { assistantLine, makeClaudeDir, userLine } from "./helpers-transcript";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdPlugin = path.resolve(here, "../jp.example.streamdeckai.sdPlugin");
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;
const s = (o: Partial<Session> = {}): Session => ({
	id: "1", agent: "claude", status: "done", name: "請求書", cwd: "", hint: "", message: "", spaceKey: "k", spaceName: "業務自動化", firstSeen: 0, updatedAt: 0, ...o,
});
const ev = (o: Partial<AgentEvent> & { session_id: string }): AgentEvent => ({ agent: "claude", status: "working", ...o });
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("バージョン: manifest は package と一致 (v0.3 で更新)", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(sdPlugin, "manifest.json"), "utf8"));
	const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8"));
	assert.equal(manifest.Version, "0.3.0.0");
	assert.equal(pkg.version, "0.3.0");
});

test("parseEvent: transcript_path / last_assistant_message は任意で受け取る(無くても v0.1 のイベントはそのまま通る)", () => {
	const old = parseEvent({ session_id: "a", agent: "claude", status: "done", message: "m" });
	assert.ok(old.ok && !("transcript_path" in old.event) && !("last_assistant_message" in old.event));
	const r = parseEvent({ session_id: "a", agent: "claude", status: "done", transcript_path: " C:\\u\\.claude\\projects\\x\\a.jsonl ", last_assistant_message: "あ".repeat(7000), unknown_field: 1 });
	assert.ok(r.ok);
	if (r.ok) {
		assert.equal(r.event.transcript_path, "C:\\u\\.claude\\projects\\x\\a.jsonl");
		assert.equal(r.event.last_assistant_message?.length, 6000);
	}
	const bad = parseEvent({ session_id: "a", agent: "claude", status: "done", transcript_path: 123, last_assistant_message: {} });
	assert.ok(bad.ok && bad.event.transcript_path === undefined && bad.event.last_assistant_message === undefined);
});

test("HTTP /event: 新しい項目つきでも 200。セッションに保存され、次のイベントでも transcript_path は引き継ぐ", async () => {
	const app = new App({ runner: async () => ({ code: 0, stdout: "", stderr: "" }), claudeDirs: [] });
	await app.applySettings({ port: 18420, narration: false });
	const post = (o: object) => fetch("http://127.0.0.1:18420/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
	assert.equal((await post({ session_id: "c1", agent: "claude", status: "working", cwd: "C:\\w\\p", transcript_path: "C:\\Users\\me\\.claude\\projects\\p\\c1.jsonl" })).status, 200);
	assert.equal((await post({ session_id: "c1", agent: "claude", status: "done", last_assistant_message: "修正しました。" })).status, 200);
	const t = app.store.selectedTab()!;
	assert.equal(t.transcriptPath, "C:\\Users\\me\\.claude\\projects\\p\\c1.jsonl");
	assert.equal(t.lastAssistantMessage, "修正しました。");
	assert.equal((await post({ session_id: "c1", agent: "claude", status: "working" })).status, 200);
	assert.equal(app.store.selectedTab()!.lastAssistantMessage, undefined, "前のターンの発言は引きずらない");
	await app.shutdown();
});

test("sanitizeSettings: narrationStyle / contextWindow の既定値と不正値", () => {
	const d = sanitizeSettings(undefined);
	assert.equal(d.narrationStyle, "summary");
	assert.equal(d.contextWindow, 200_000);
	assert.equal(sanitizeSettings({ narrationStyle: "template" }).narrationStyle, "template");
	assert.equal(sanitizeSettings({ narrationStyle: "sound" }).narrationStyle, "sound");
	assert.equal(sanitizeSettings({ narrationStyle: "ずんだもん" }).narrationStyle, "summary");
	assert.equal(sanitizeSettings({ contextWindow: "1000000" }).contextWindow, 1_000_000);
	assert.equal(sanitizeSettings({ contextWindow: 5 }).contextWindow, 200_000);
	assert.equal(sanitizeSettings({ contextWindow: "abc" }).contextWindow, 200_000);
});

test("planNarration: 要約あり=完了は要約、取れなければ定型文 / 確認待ちは従来どおり", () => {
	const text = "請求書の集計を直しました。テストも通りました。この内容でコミットしてよろしいですか？";
	const sum = planNarration(s(), "done", "summary", { includeMessage: true, assistantText: text });
	assert.ok(sum.text?.startsWith("業務自動化から。請求書の集計を直しました。"), sum.text);
	assert.ok(sum.text?.endsWith("コミットしてよろしいですか？"));
	assert.equal(sum.sound, undefined);
	const fallback = planNarration(s(), "done", "summary", { includeMessage: true, assistantText: "```\ncode only\n```" });
	assert.ok(fallback.text?.includes("完了しました") && fallback.text.includes("次の指示"), "抽出できなければ固定テンプレート");
	assert.ok(planNarration(s(), "done", "summary", { includeMessage: true })?.text?.includes("完了しました"));
	const blocked = planNarration(s({ status: "blocked", message: "build フォルダを削除してよいですか" }), "blocked", "summary", { includeMessage: true, assistantText: text });
	assert.ok(blocked.text?.includes("取り消しにくい操作") && blocked.text.includes("許可するか断るか"), "確認待ちは要約を使わない");
});

test("planNarration: 定型文のみ=v0.1 と同じ文 / 効果音のみ=音だけ(取り消しにくい操作の確認待ちだけは短く警告)", () => {
	const tpl = planNarration(s(), "done", "template", { includeMessage: true, assistantText: "要約されてはいけない。" });
	assert.ok(tpl.text?.startsWith("業務自動化から。Claudeの「請求書」が完了しました。") && !tpl.text.includes("要約"));
	assert.deepEqual(planNarration(s(), "done", "sound", { includeMessage: true, assistantText: "x" }), { sound: "Asterisk" });
	assert.deepEqual(planNarration(s({ status: "blocked", message: "Run npm test?" }), "blocked", "sound", { includeMessage: true }), { sound: "Exclamation" });
	const d = planNarration(s({ status: "blocked", message: "rm -rf build を実行してよいですか" }), "blocked", "sound", { includeMessage: false });
	assert.equal(d.sound, "Hand");
	assert.ok(d.text?.startsWith("業務自動化から。削除") && d.text.includes("取り消しにくい操作"));
});

test("Speaker: 効果音は SystemSounds の PowerShell を環境変数付きで呼び、読み上げと同じ順番待ち", async () => {
	const calls: Array<{ script: string; env: Record<string, string> }> = [];
	const sp = new Speaker({ run: async (script, env) => (calls.push({ script, env }), { code: 0, stdout: "", stderr: "" }), voiceName: () => "", rate: () => 0 });
	sp.enqueueSound("Hand");
	sp.enqueue("こんにちは");
	await flush();
	assert.equal(calls.length, 2);
	assert.ok(calls[0]!.script.includes("System.Media.SystemSounds") && calls[0]!.env.SDAI_SOUND === "Hand");
	assert.ok(!calls[0]!.script.includes("Hand\n$"), "音の名前は環境変数で渡す");
	assert.equal(calls[1]!.env.SDAI_TEXT, "こんにちは");
	assert.deepEqual(sp.sounds, ["Hand"]);
});

test("SOUND_SCRIPT の構文(pwsh のパーサ)", { skip: !hasPwsh }, () => {
	const code = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SRC,[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`;
	const r = spawnSync("pwsh", ["-NoProfile", "-Command", code], { env: { ...process.env, SRC: SOUND_SCRIPT }, encoding: "utf8" });
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

function appWithRunner(dirs: string[] = []) {
	const calls: Array<{ script: string; env: Record<string, string> }> = [];
	const runner: PsRunner = async (script, env) => (calls.push({ script, env }), { code: 0, stdout: "", stderr: "" });
	const app = new App({ runner, claudeDirs: dirs, transcriptDelayMs: 0 });
	return { app, calls };
}

test("App 読み上げ(要約あり): Stop の last_assistant_message を優先して要約して読む", async () => {
	const { app, calls } = appWithRunner();
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "working" }));
	app.handleEvent(ev({ session_id: "a", status: "done", last_assistant_message: "請求書の合計を直しました。次はテストを回してください。" }));
	await flush();
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.script.includes("System.Speech"));
	assert.equal(calls[0]!.env.SDAI_TEXT, "業務自動化から。請求書の合計を直しました。次はテストを回してください。");
});

test("App 読み上げ(要約あり): last_assistant_message が無い Claude は記録ファイルの末尾から。無ければ定型文", async () => {
	const { dir, projects, cleanup } = makeClaudeDir();
	try {
		fs.mkdirSync(path.join(projects, "p"));
		const f = path.join(projects, "p", "t1.jsonl");
		fs.writeFileSync(f, [userLine("直して"), assistantLine({ id: "m", text: "Fixed the rounding bug in the invoice total. Please review the diff." })].join("\n") + "\n");
		const { app, calls } = appWithRunner([dir]);
		app.handleEvent(ev({ session_id: "t1", cwd: "C:\\w\\proj", status: "working", transcript_path: f }));
		app.handleEvent(ev({ session_id: "t1", status: "done" }));
		await flush(100);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.env.SDAI_TEXT, "projから。Fixed the rounding bug in the invoice total. Please review the diff.");
		// ファイルが無い/空のセッションは定型文
		app.handleEvent(ev({ session_id: "nofile", cwd: "C:\\w\\q", status: "done" }));
		await flush(100);
		assert.ok(calls[1]!.env.SDAI_TEXT!.startsWith("qから。Claudeが完了しました"));
	} finally {
		cleanup();
	}
});

test("App 読み上げ(要約あり): Codex / Grok は last_assistant_message または message から", async () => {
	const { app, calls } = appWithRunner();
	app.handleEvent(ev({ session_id: "x", agent: "codex", status: "done", cwd: "C:\\w\\cx", message: "Updated README. Please check the wording.", last_assistant_message: "Updated README and CHANGELOG. Please check the wording." }));
	app.handleEvent(ev({ session_id: "g", agent: "grok", status: "done", cwd: "C:\\w\\gk", message: "テストを追加しました。結果を確認してください。" }));
	await flush();
	assert.equal(calls[0]!.env.SDAI_TEXT, "cxから。Updated README and CHANGELOG. Please check the wording.");
	assert.equal(calls[1]!.env.SDAI_TEXT, "gkから。テストを追加しました。結果を確認してください。");
});

test("App 読み上げ(定型文のみ): v0.1 と同じ。要約の材料があっても使わない", async () => {
	const { app, calls } = appWithRunner();
	await app.applySettings({ narrationStyle: "template", port: 18421 });
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "done", last_assistant_message: "要約されてはいけない文です。" }));
	await flush();
	assert.ok(calls[0]!.env.SDAI_TEXT!.includes("が完了しました") && !calls[0]!.env.SDAI_TEXT!.includes("要約されてはいけない"));
	await app.shutdown();
});

test("App 読み上げ(効果音のみ): System.Speech は呼ばず SystemSounds だけ。取り消しにくい確認待ちは警告も読む", async () => {
	const { app, calls } = appWithRunner();
	await app.applySettings({ narrationStyle: "sound", port: 18422 });
	app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "done", last_assistant_message: "終わりました。" }));
	await flush();
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.script.includes("SystemSounds") && !calls[0]!.script.includes("System.Speech"));
	app.handleEvent(ev({ session_id: "b", cwd: "C:\\w\\業務自動化", status: "blocked", message: "git push --force してよいですか" }));
	await flush();
	assert.equal(calls.length, 3, "Hand の効果音 + 警告の読み上げ");
	assert.equal(calls[1]!.env.SDAI_SOUND, "Hand");
	assert.ok(calls[2]!.env.SDAI_TEXT!.includes("取り消しにくい操作"));
	await app.shutdown();
});

test("App 読み上げ(確認待ち): 要約あり/定型文のみでは従来どおり通知文を読み、削除は必ず警告", async () => {
	for (const style of ["summary", "template"]) {
		const { app, calls } = appWithRunner();
		await app.applySettings({ narrationStyle: style, port: 18423 });
		app.handleEvent(ev({ session_id: "a", cwd: "C:\\w\\業務自動化", status: "blocked", message: "ファイルを削除してよいですか", last_assistant_message: "無関係な最後の発言です。" }));
		await flush();
		const t = calls[0]!.env.SDAI_TEXT!;
		assert.ok(t.includes("削除してよいですか") && t.includes("取り消しにくい操作") && !t.includes("無関係"), `${style}: ${t}`);
		await app.shutdown();
	}
});

test("フックスクリプト(pwsh): transcript_path と last_assistant_message を転送。Codex は last-assistant-message も。従来の項目は変わらない", { skip: !hasPwsh }, async () => {
	const got: AgentEvent[] = [];
	const srv = new EventServer({ onEvent: (e) => { got.push(e); } });
	const port = await srv.start(0);
	const hook = path.join(sdPlugin, "hooks/streamdeckai-hook.ps1");
	const run = (args: string[], input?: string) =>
		new Promise<number | null>((resolve) => {
			const c = spawn("pwsh", ["-NoProfile", "-File", hook, ...args], { env: { ...process.env, STREAMDECKAI_PORT: String(port) } });
			c.on("close", resolve);
			c.stdin.end(input ?? "");
		});
	const tp = "C:\\Users\\me\\.claude\\projects\\C--w-日本語\\c1.jsonl";
	await run(["-Agent", "claude"], JSON.stringify({ session_id: "c1", cwd: "/w/日本語", hook_event_name: "UserPromptSubmit", transcript_path: tp }));
	await run(["-Agent", "claude"], JSON.stringify({ session_id: "c1", cwd: "/w/日本語", hook_event_name: "Stop", transcript_path: tp, last_assistant_message: "修正しました。\n確認してください。" }));
	await run(["-Agent", "codex", '{"type":"agent-turn-complete","thread-id":"x1","cwd":"/w/p","last-assistant-message":"Done. Please review."}']);
	await run(["-Agent", "grok", "-Status", "done", "-SessionId", "g1", "-Cwd", "/w/q", "-TranscriptPath", "/x/y.jsonl", "-LastMessage", "ok"]);
	await run(["-Agent", "claude"], JSON.stringify({ session_id: "c2", cwd: "/w/p", hook_event_name: "Stop" }));
	await srv.stop();
	assert.equal(got.length, 5);
	assert.equal(got[0]!.transcript_path, tp);
	assert.equal(got[0]!.last_assistant_message, undefined);
	assert.equal(got[1]!.status, "done");
	assert.equal(got[1]!.last_assistant_message, "修正しました。\n確認してください。");
	assert.equal(got[2]!.message, "Done. Please review.", "Codex の message は従来どおり");
	assert.equal(got[2]!.last_assistant_message, "Done. Please review.");
	assert.equal(got[3]!.transcript_path, "/x/y.jsonl");
	assert.equal(got[3]!.last_assistant_message, "ok");
	assert.equal(got[4]!.transcript_path, undefined, "payload に無ければ送らない(従来と同じ本文)");
});
