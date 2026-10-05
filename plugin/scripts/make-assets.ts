// アイコン PNG とプレビュー画像を生成する: npm run assets
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { characterSvg, faceSvg, renderInfobar, renderSpaceButton, renderTabButton, STATUS_COLOR } from "../src/svg";
import type { Session, Space } from "../src/types";

const out = path.resolve("jp.example.streamdeckai.sdPlugin/imgs");
fs.mkdirSync(path.join(out, "actions"), { recursive: true });

function png(svg: string, size: number, file: string, fonts = false): void {
	const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: fonts, defaultFontFamily: "Noto Sans CJK JP" } });
	fs.writeFileSync(file, r.render().asPng());
}

function icon(bg: string, inner: (s: number) => string) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="24" fill="${bg}"/>${inner(1)}</svg>`;
}
const face = (st: "blocked" | "done" | "working") => icon(STATUS_COLOR[st], () => faceSvg(st, "claude", 0, 8, 30, 16));
const body = icon(STATUS_COLOR.working, () => characterSvg("working", "claude", 0, 22, 36, 7));

const plugin = icon("#3b2a5c", () => characterSvg("done", "claude", 0, 22, 36, 7));
png(plugin, 256, path.join(out, "plugin.png"));
png(plugin, 512, path.join(out, "plugin@2x.png"));
png(plugin, 28, path.join(out, "category.png"));
png(plugin, 56, path.join(out, "category@2x.png"));
const actions: Record<string, string> = {
	space: face("done"),
	tab: body,
	infobar: icon("#12121c", () => `<rect x="10" y="40" width="30" height="30" rx="6" fill="${STATUS_COLOR.working}"/><rect x="48" y="40" width="30" height="30" rx="6" fill="${STATUS_COLOR.blocked}"/><rect x="86" y="40" width="30" height="30" rx="6" fill="${STATUS_COLOR.done}"/><rect x="10" y="84" width="106" height="14" rx="4" fill="#fff"/>`),
};
for (const [name, svg] of Object.entries(actions)) {
	png(svg, 20, path.join(out, "actions", `${name}.png`));
	png(svg, 40, path.join(out, "actions", `${name}@2x.png`));
	png(svg, 72, path.join(out, "actions", `${name}-key.png`));
	png(svg, 144, path.join(out, "actions", `${name}-key@2x.png`));
}

// ── プレビュー(確認用。zip には含めない) ──
const prev = path.resolve("../preview");
fs.mkdirSync(prev, { recursive: true });
const mk = (id: string, agent: Session["agent"], status: Session["status"], name: string): Session => ({
	id, agent, status, name, cwd: "", hint: "", message: "", spaceKey: "k", spaceName: "業務自動化", firstSeen: 0, updatedAt: 0,
});
const sessions = [
	mk("1", "claude", "blocked", "請求書"), mk("2", "codex", "working", "テスト修正"), mk("3", "grok", "done", "LongEnglishNameHere"), mk("4", "claude", "idle", "Refactor the API layer"),
];
const space: Space = { key: "k", name: "業務自動化", status: "blocked", tabs: sessions };
const tiles: string[] = [];
const cells: Array<[string, string]> = [];
for (const frame of [0, 1]) {
	sessions.forEach((s) => cells.push([`tab-${s.status}-f${frame}`, renderTabButton({ session: s, selected: false, frame })]));
	sessions.forEach((s) => cells.push([`tabsel-${s.status}-f${frame}`, renderTabButton({ session: s, selected: true, frame })]));
	cells.push([`space-f${frame}`, renderSpaceButton({ space, selected: false, frame })]);
	cells.push([`spacesel-f${frame}`, renderSpaceButton({ space, selected: true, frame, page: { index: 0, count: 2 } })]);
	cells.push([`space-empty-f${frame}`, renderSpaceButton({ selected: false, frame })]);
	cells.push([`tab-empty-f${frame}`, renderTabButton({ selected: false, frame })]);
}
cells.forEach(([name, svg], i) => {
	png(svg, 144, path.join(prev, `${name}.png`), true);
	const x = (i % 6) * 150;
	const y = Math.floor(i / 6) * 150;
	tiles.push(`<g transform="translate(${x},${y})">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g>`);
});
const rows = Math.ceil(cells.length / 6);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${rows * 150 + 70}"><rect width="100%" height="100%" fill="#222"/>${tiles.join("")}<g transform="translate(0,${rows * 150 + 10})">${renderInfobar({ counts: { working: 2, blocked: 1, done: 3, idle: 0 }, tab: sessions[0], usage: { info: { state: "ok", tokens: 86_000 }, contextWindow: 200_000 } }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></svg>`;
png(sheet, 900, path.join(prev, "sheet.png"), true);
// インフォバーの使用率(ミント/黄/赤/取得不可)
const barCounts = { working: 2, blocked: 1, done: 3, idle: 0 };
const barCases: Array<[string, Parameters<typeof renderInfobar>[0]["usage"], Session]> = [
	["infobar-usage-mint", { info: { state: "ok", tokens: 86_000 }, contextWindow: 200_000 }, sessions[0]!],
	["infobar-usage-yellow", { info: { state: "ok", tokens: 160_000 }, contextWindow: 200_000 }, sessions[0]!],
	["infobar-usage-red", { info: { state: "ok", tokens: 190_000 }, contextWindow: 200_000 }, sessions[0]!],
	["infobar-usage-1m", { info: { state: "ok", tokens: 250_000 }, contextWindow: 1_000_000 }, sessions[3]!],
	["infobar-usage-na", { info: { state: "unavailable", reason: "x" }, contextWindow: 200_000 }, sessions[1]!],
];
for (const [name, usage, tab] of barCases) png(renderInfobar({ counts: barCounts, tab, usage }), 928, path.join(prev, `${name}.png`), true);
console.log("assets written");
