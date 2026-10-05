import assert from "node:assert/strict";
import { test } from "node:test";
import { XMLValidator } from "fast-xml-parser";
import { layoutName, lighten, renderInfobar, renderSpaceButton, renderTabButton, STATUS_COLOR, textWidth, toDataUri } from "../src/svg";
import type { DisplayStatus, Session, Space } from "../src/types";

const session = (status: Session["status"], name = "タブ", agent: Session["agent"] = "claude"): Session => ({
	id: name, agent, status, name, cwd: "", hint: "", message: "", spaceKey: "k", spaceName: "S", firstSeen: 0, updatedAt: 0,
});
const wellFormed = (svg: string) => assert.equal(XMLValidator.validate(svg), true);

test("タブボタン: 144x144 で整形式、状態色の背景", () => {
	for (const st of ["blocked", "working", "done", "idle"] as const) {
		const svg = renderTabButton({ session: session(st), selected: false, frame: 0 });
		wellFormed(svg);
		assert.match(svg, /width="144" height="144"/);
		assert.ok(svg.includes(`<rect width="144" height="144" fill="${STATUS_COLOR[st]}"/>`), st);
	}
});

test("エージェントなしのタブは暗い紫 + 「なし」(他のタブの情報で推定しない)", () => {
	const svg = renderTabButton({ selected: false, frame: 0 });
	wellFormed(svg);
	assert.ok(svg.includes(STATUS_COLOR.none));
	assert.ok(svg.includes("なし"));
});

test("選択中は背景が明るく、文字は濃い紺。非選択は白文字 + 影", () => {
	const sel = renderTabButton({ session: session("blocked"), selected: true, frame: 0 });
	const non = renderTabButton({ session: session("blocked"), selected: false, frame: 0 });
	assert.ok(sel.includes(lighten(STATUS_COLOR.blocked, 0.68)));
	assert.ok(sel.includes('fill="#14143c"'));
	assert.ok(non.includes('fill="#ffffff"'));
	assert.ok(non.includes('fill-opacity="0.3"'));
	assert.notEqual(sel, non);
});

test("アニメーション: frame が違えば絵が変わり、同じなら完全に同一(同一画像スキップの前提)", () => {
	for (const st of ["blocked", "working", "done", "idle"] as const) {
		const a0 = renderTabButton({ session: session(st), selected: false, frame: 0 });
		const a0b = renderTabButton({ session: session(st), selected: false, frame: 0 });
		const a1 = renderTabButton({ session: session(st), selected: false, frame: 1 });
		assert.equal(a0, a0b);
		assert.notEqual(a0, a1, st);
	}
});

test("状態ごとにキャラクターの絵が違う", () => {
	const imgs = new Set((["blocked", "working", "done", "idle"] as const).map((st) => renderTabButton({ session: session(st), selected: false, frame: 0 }).replace(/<rect width="144"[^>]*\/>/, "")));
	assert.equal(imgs.size, 4);
});

test("スペースボタン: 顔が並び、5 タブ以上の選択中は 1/2 を表示", () => {
	const tabs = ["blocked", "working", "done", "idle", "done"].map((s, i) => ({ ...session(s as Session["status"], `t${i}`), id: `t${i}` }));
	const space: Space = { key: "k", name: "業務自動化", status: "blocked", tabs };
	const svg = renderSpaceButton({ space, selected: true, frame: 0, page: { index: 0, count: 2 } });
	wellFormed(svg);
	assert.ok(svg.includes("1/2"));
	assert.ok(svg.includes("業務自動化"));
	const plain = renderSpaceButton({ space, selected: false, frame: 0 });
	assert.ok(!plain.includes("1/2"));
	wellFormed(renderSpaceButton({ selected: false, frame: 1 }));
});

test("名前のレイアウト: 全角 4 文字は 32px 1 行", () => {
	assert.deepEqual(layoutName("請求書管理"), { lines: ["請求書管理"], fontSize: 25 }, "5 文字は少しはみ出す → 縮めて 1 行");
	assert.deepEqual(layoutName("業務自動"), { lines: ["業務自動"], fontSize: 32 });
});

test("名前のレイアウト: 長い名前は最大 2 行、はみ出さない", () => {
	for (const n of ["みどりの工数管理システム", "Refactor the API layer", "Claude Code 日本語", "super-long-project-name-that-keeps-going", "StreamDeckAI", "あ".repeat(40)]) {
		const l = layoutName(n);
		assert.ok(l.lines.length >= 1 && l.lines.length <= 2, n);
		for (const line of l.lines) assert.ok(textWidth(line, l.fontSize) <= 128.5, `${n} → ${line}`);
	}
	assert.equal(layoutName("StreamDeckAI").lines.length, 1, "空白のない英単語は折り返さない");
});

test("名前の XML エスケープ", () => {
	const svg = renderTabButton({ session: session("done", `<b>&"x"`), selected: false, frame: 0 });
	wellFormed(svg);
	assert.ok(!svg.includes("<b>"));
});

test("インフォバー: 232x50、件数と選択中タブ名、エラー表示", () => {
	const svg = renderInfobar({ counts: { working: 2, blocked: 1, done: 3, idle: 0 }, tab: session("blocked", "請求書") });
	wellFormed(svg);
	assert.match(svg, /width="232" height="50"/);
	for (const s of ["作業中", "確認待ち", "完了", "請求書", ">2<", ">1<", ">3<"]) assert.ok(svg.includes(s), s);
	const none = renderInfobar({ counts: { working: 0, blocked: 0, done: 0, idle: 0 } });
	assert.ok(none.includes("エージェントなし"));
	const err = renderInfobar({ counts: { working: 0, blocked: 0, done: 0, idle: 0 }, notice: "ポート 17890 は使用中です" });
	wellFormed(err);
	assert.ok(err.includes("使用中"));
});

test("data URI は元の SVG に戻せる", () => {
	const svg = renderInfobar({ counts: { working: 0, blocked: 0, done: 0, idle: 0 } });
	const uri = toDataUri(svg);
	assert.equal(decodeURIComponent(uri.split(",")[1]!), svg);
});

test("STATUS_COLOR は仕様どおりの 5 色", () => {
	const keys: DisplayStatus[] = ["blocked", "working", "done", "idle", "none"];
	assert.equal(new Set(keys.map((k) => STATUS_COLOR[k])).size, 5);
});
