// StreamDeckAI にダミーイベントを送って動作を確認する。
//   node scripts/send-fake-events.mjs [--port 17890] [--fast]
// プラグインを起動した Stream Deck 側で、ボタンの色が変わり、読み上げが鳴れば OK。
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.STREAMDECKAI_PORT) || 17890;
const delay = args.includes("--fast") ? 300 : 3000;
const url = `http://127.0.0.1:${port}/event`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(ev) {
	const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
	console.log(`${res.status} ${JSON.stringify(ev.status)} ${ev.agent}/${ev.name}`, await res.text());
	if (!res.ok) process.exitCode = 1;
}

const A = { agent: "claude", session_id: "fake-claude-1", name: "請求書", cwd: "C:\\work\\業務自動化", wt_window_hint: "請求書" };
const B = { agent: "codex", session_id: "fake-codex-1", name: "テスト修正", cwd: "C:\\work\\業務自動化", wt_window_hint: "テスト修正" };
const C = { agent: "grok", session_id: "fake-grok-1", name: "docs", cwd: "C:\\work\\StreamDeckAI", wt_window_hint: "docs" };

try {
	await send({ ...A, status: "working" });
	await send({ ...B, status: "working" });
	await send({ ...C, status: "idle" });
	await sleep(delay);
	await send({ ...A, status: "blocked", message: "node_modules を削除して再インストールするコマンド (rm -rf node_modules) の実行許可を求めています" });
	await sleep(delay);
	await send({ ...A, status: "working" });
	await send({ ...C, status: "working" });
	await sleep(delay);
	await send({ ...B, status: "done" });
	await send({ ...A, status: "done" });
	await send({ ...C, status: "done", message: "README を更新しました" });
} catch (e) {
	console.error(`送信できません: ${e.cause?.code ?? e.message}  (Stream Deck でプラグインが動いていますか? ポート ${port})`);
	process.exit(1);
}
