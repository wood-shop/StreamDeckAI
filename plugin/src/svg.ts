/**
 * ボタン(144x144)とインフォバー(232x50)の SVG をコードで生成する。
 * 外部ライブラリなし。副作用なし(時刻は frame 引数で渡す)ので単体テストできる。
 */
import { formatTokens, usageLevel, type UsageInfo } from "./usagefmt";
import { AGENT_LABEL, type AgentKind, type DisplayStatus, type EventStatus, type Session, type Space } from "./types";

export const BUTTON_SIZE = 144;
export const INFOBAR_W = 232;
export const INFOBAR_H = 50;
export const FONT = `'Yu Gothic UI','Meiryo UI','Noto Sans CJK JP','Segoe UI',sans-serif`;

/** 状態色: blocked 赤 / working 黄 / done ミント / idle 青 / none 暗い紫 */
export const STATUS_COLOR: Record<DisplayStatus, string> = {
	blocked: "#e5484d",
	working: "#e3b100",
	done: "#3ecf9a",
	idle: "#3b82f6",
	none: "#3b2a5c",
};
export const NAVY = "#14143c";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
	blocked: "確認待ち",
	working: "作業中",
	done: "完了",
	idle: "待機中",
	none: "なし",
};

export function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** #rrggbb を白と混ぜて明るくする(選択中ボタンの背景)。 */
export function lighten(hex: string, amount: number): string {
	const n = parseInt(hex.slice(1), 16);
	const mix = (c: number) => Math.round(c + (255 - c) * amount);
	const r = mix((n >> 16) & 255);
	const g = mix((n >> 8) & 255);
	const b = mix(n & 255);
	return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ───────────── 文字のレイアウト ─────────────

/** 全角は 1em、英大文字/数字 0.62em、小文字 0.55em、空白 0.3em で概算する。 */
export function charWidth(ch: string, fs: number): number {
	const c = ch.codePointAt(0) ?? 0;
	if (c === 32) return fs * 0.3;
	if (c < 0x80) return fs * (/[A-Z0-9@#%&MW]/.test(ch) ? 0.62 : /[il.,:;'|!]/.test(ch) ? 0.3 : 0.55);
	return fs; // CJK・全角・絵文字は 1em
}
export function textWidth(s: string, fs: number): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch, fs);
	return w;
}

export interface NameLayout {
	lines: string[];
	fontSize: number;
}

/** 折り返し候補に分ける。空白は捨て、- _ / は直前の語にくっつけ、全角 1 文字ずつは独立。 */
function tokenize(t: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	const flush = () => {
		if (cur) tokens.push(cur);
		cur = "";
	};
	for (const ch of t) {
		if (ch === " ") flush();
		else if ((ch.codePointAt(0) ?? 0) >= 0x80) {
			flush();
			tokens.push(ch);
		} else {
			cur += ch;
			if (ch === "-" || ch === "_" || ch === "/") flush();
		}
	}
	flush();
	return tokens;
}

/** fs で最大 2 行に収まるなら行を返す(収まらなければ null)。 */
function wrapTwoLines(tokens: string[], fs: number, maxW: number): string[] | null {
	const lines: string[] = [];
	let cur = "";
	for (const tok of tokens) {
		if (textWidth(tok, fs) > maxW) return null; // 1 語が 1 行に入らない
		// 全角どうし・記号つなぎは空白なしで連結、英単語どうしは空白を入れる
		const glue = cur && /[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(tok) ? " " : "";
		if (cur && textWidth(cur + glue + tok, fs) > maxW) {
			lines.push(cur);
			cur = tok;
		} else cur = cur + glue + tok;
	}
	if (cur) lines.push(cur);
	return lines.length <= 2 ? lines : null;
}

/**
 * 名前を「全角 4 文字ちょうど=32px」で最大 2 行に収める。
 * 少しはみ出す名前・空白のない英単語は折り返さず縮めて 1 行にする(縮めすぎないよう下限あり)。
 */
export function layoutName(text: string, maxW = 128, base = 32): NameLayout {
	const t = text.trim() || " ";
	const total = textWidth(t, base);
	if (total <= maxW) return { lines: [t], fontSize: base };
	const asciiNoSpace = /^[\x21-\x7e]+$/.test(t);
	if (asciiNoSpace || total <= maxW * 1.25) {
		const min = asciiNoSpace ? 14 : 24;
		const fs = Math.max(min, Math.floor((maxW / total) * base));
		return { lines: [truncate(t, maxW, fs)], fontSize: fs };
	}
	const tokens = tokenize(t);
	const minFs = /[^\x00-\x7f]/.test(t) ? 20 : 16;
	for (let fs = base; fs >= minFs; fs -= 2) {
		const lines = wrapTwoLines(tokens, fs, maxW);
		if (lines) return { lines, fontSize: fs };
	}
	// 最小サイズでも入らない: 2 行目を省略記号で切る
	const fs = minFs;
	const chars = [...t];
	let n = 0;
	let w = 0;
	while (n < chars.length && w + charWidth(chars[n]!, fs) <= maxW) w += charWidth(chars[n++]!, fs);
	return { lines: [chars.slice(0, n).join("").trim(), truncate(chars.slice(n).join("").trim(), maxW, fs)], fontSize: fs };
}

function truncate(s: string, maxW: number, fs: number): string {
	if (textWidth(s, fs) <= maxW) return s;
	let out = "";
	for (const ch of s) {
		if (textWidth(out + ch + "…", fs) > maxW) break;
		out += ch;
	}
	return out + "…";
}

// ───────────── ドット絵 ─────────────

const GW = 14;
const GH = 12;
type Grid = (string | null)[][];

const SKIN = "#ffd9b3";
const EYE = "#1b1b3a";
const SHIRT = "#f4f4fb";
const LEGS = "#2b2b4a";
const MOUTH = "#c0392b";
const DESK = "#8b5a2b";
const DESK2 = "#6b4423";

export const HAIR_COLOR: Record<AgentKind, string> = {
	claude: "#c4561f",
	codex: "#1f6f5c",
	grok: "#2b2b2b",
};

function grid(): Grid {
	return Array.from({ length: GH }, () => Array<string | null>(GW).fill(null));
}
function px(g: Grid, x: number, y: number, c: string): void {
	if (x >= 0 && x < GW && y >= 0 && y < GH) g[y]![x] = c;
}
function rect(g: Grid, x: number, y: number, w: number, h: number, c: string): void {
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(g, x + i, y + j, c);
}

function drawHead(g: Grid, status: EventStatus, hair: string, dy: number, frame: number): void {
	rect(g, 4, 0 + dy, 6, 1, hair);
	rect(g, 3, 1 + dy, 8, 1, hair);
	rect(g, 3, 2 + dy, 1, 2, hair);
	rect(g, 10, 2 + dy, 1, 2, hair);
	rect(g, 4, 2 + dy, 6, 3, SKIN);
	const open = status === "working" || status === "blocked" || status === "done";
	if (open) {
		px(g, 5, 3 + dy, EYE);
		px(g, 5, 4 + dy, EYE);
		px(g, 8, 3 + dy, EYE);
		px(g, 8, 4 + dy, EYE);
	} else {
		px(g, 5, 4 + dy, EYE);
		px(g, 8, 4 + dy, EYE);
	}
	void frame;
}

function drawFigure(status: DisplayStatus, frame: number, hair: string): Grid {
	const g = grid();
	const f = frame & 1;
	if (status === "none") {
		rect(g, 4, 2, 6, 5, "#8a7aa8"); // 背もたれ
		rect(g, 3, 7, 8, 2, "#a695c4"); // 座面
		rect(g, 6, 9, 2, 2, "#6c5c8a"); // 支柱
		rect(g, 3, 11, 8, 1, "#6c5c8a"); // 脚
		return g;
	}
	if (status === "working") {
		drawHead(g, status, hair, 0, f);
		rect(g, 4, 5, 6, 3, SHIRT);
		rect(g, 4, 10, 2, 2, LEGS);
		rect(g, 8, 10, 2, 2, LEGS);
		rect(g, 0, 8, 14, 1, DESK);
		rect(g, 0, 9, 14, 1, DESK2);
		rect(g, 4, 6, 6, 2, "#9aa0b4"); // ノート PC の背面
		rect(g, 6, 6, 2, 1, "#ffffff");
		px(g, 3, 7 + f, SKIN); // 手(タイピング)
		px(g, 10, 8 - f, SKIN);
		px(g, 11, 1 + f, "#7ee0ff"); // 汗
		px(g, 11, 2 + f, "#7ee0ff");
		return g;
	}
	if (status === "idle") {
		drawHead(g, status, hair, 1, f);
		rect(g, 4, 6, 6, 2, SHIRT);
		rect(g, 4, 10, 2, 2, LEGS);
		rect(g, 8, 10, 2, 2, LEGS);
		rect(g, 0, 8, 14, 1, DESK);
		rect(g, 0, 9, 14, 1, DESK2);
		rect(g, 3, 7, 8, 1, "#e8c49a"); // 机に突っ伏す腕
		const zx = 10 + f;
		const zy = 0 + (1 - f);
		for (const [x, y] of [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [0, 3], [1, 3], [2, 3]] as const) px(g, zx + x, zy + y, "#ffffff");
		return g;
	}
	// blocked / done は立ち姿
	drawHead(g, status, hair, 0, f);
	rect(g, 4, 5, 6, 4, SHIRT);
	rect(g, 4, 9, 2, 3, LEGS);
	rect(g, 8, 9, 2, 3, LEGS);
	if (status === "blocked") {
		rect(g, 6, 4, 2, 1, MOUTH);
		rect(g, 3, 5, 1, 3, SHIRT); // 左腕は下
		px(g, 3, 8, SKIN);
		// 右腕を上げて手を振る
		px(g, 10, 5, SHIRT);
		rect(g, 11, 3, 1, 3, SHIRT);
		px(g, 11 + f, 2, SKIN);
		if (f) px(g, 12, 3, SHIRT);
		// 吹き出しの「!」
		rect(g, 1, 0, 2, 3, "#ffffff");
		rect(g, 1, 4, 2, 1, "#ffffff");
	} else {
		rect(g, 5, 4, 4, 1, MOUTH);
		// バンザイ
		px(g, 3, 5, SHIRT);
		px(g, 10, 5, SHIRT);
		rect(g, 2 - f, 3, 1, 3, SHIRT);
		rect(g, 11 + f, 3, 1, 3, SHIRT);
		px(g, 2 - f, 2, SKIN);
		px(g, 11 + f, 2, SKIN);
		const confetti: Array<[number, number, string]> =
			f === 0
				? [[0, 0, "#ff5ca8"], [13, 1, "#ffe14d"], [0, 7, "#5cc8ff"], [13, 7, "#ff5ca8"], [6, 0, "#ffffff"]]
				: [[1, 1, "#ffe14d"], [12, 0, "#ff5ca8"], [13, 5, "#5cc8ff"], [0, 9, "#ffe14d"], [8, 0, "#5cc8ff"]];
		for (const [x, y, c] of confetti) if (!g[y]![x]) px(g, x, y, c);
	}
	return g;
}

/** グリッドを <rect> に変換(横に同色が続く所は 1 つにまとめる)。 */
function gridToSvg(g: Grid, x0: number, y0: number, scale: number, cols: [number, number] = [0, GW], rows: [number, number] = [0, GH]): string {
	let out = "";
	for (let y = rows[0]; y < rows[1]; y++) {
		let x = cols[0];
		while (x < cols[1]) {
			const c = g[y]![x];
			if (!c) {
				x++;
				continue;
			}
			let w = 1;
			while (x + w < cols[1] && g[y]![x + w] === c) w++;
			out += `<rect x="${x0 + (x - cols[0]) * scale}" y="${y0 + (y - rows[0]) * scale}" width="${w * scale}" height="${scale}" fill="${c}"/>`;
			x += w;
		}
	}
	return `<g shape-rendering="crispEdges">${out}</g>`;
}

/** 全身(14x12 マス)。 */
export function characterSvg(status: DisplayStatus, agent: AgentKind | undefined, frame: number, x: number, y: number, scale: number): string {
	return gridToSvg(drawFigure(status, frame, HAIR_COLOR[agent ?? "claude"]), x, y, scale);
}

/** 顔だけ(8x5 マス)。スペースボタン用。 */
export function faceSvg(status: DisplayStatus, agent: AgentKind, frame: number, x: number, y: number, scale: number): string {
	if (status === "none") {
		const g = grid();
		rect(g, 4, 0, 6, 5, "#6c5c8a");
		return gridToSvg(g, x, y, scale, [3, 11], [0, 5]);
	}
	const g = grid();
	drawHead(g, status, HAIR_COLOR[agent], 0, frame);
	if (status === "blocked") rect(g, 6, 4, 2, 1, MOUTH);
	if (status === "done") rect(g, 5, 4, 4, 1, MOUTH);
	return gridToSvg(g, x, y, scale, [3, 11], [0, 5]);
}

// ───────────── ボタン ─────────────

function wrap(inner: string, bg: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" viewBox="0 0 ${BUTTON_SIZE} ${BUTTON_SIZE}"><rect width="${BUTTON_SIZE}" height="${BUTTON_SIZE}" fill="${bg}"/>${inner}</svg>`;
}

function nameSvg(text: string, selected: boolean, top = 70): string {
	const { lines, fontSize } = layoutName(text);
	const areaH = BUTTON_SIZE - top - 4;
	const lh = fontSize;
	const blockH = lines.length * lh;
	// ベースライン: ブロックを領域の中央に置く
	const startY = top + (areaH - blockH) / 2 + fontSize * 0.82;
	let out = "";
	lines.forEach((line, i) => {
		const y = Math.round((startY + i * lh) * 10) / 10;
		const common = `x="72" y="${y}" font-family="${FONT}" font-size="${fontSize}" font-weight="700" text-anchor="middle"`;
		if (!selected) out += `<text ${common} dx="1.5" dy="1.5" fill="#000000" fill-opacity="0.3">${esc(line)}</text>`;
		out += `<text ${common} fill="${selected ? NAVY : "#ffffff"}">${esc(line)}</text>`;
	});
	return out;
}

function bgFor(status: DisplayStatus, selected: boolean): string {
	const base = STATUS_COLOR[status];
	return selected ? lighten(base, status === "none" ? 0.45 : 0.68) : base;
}

export interface TabButtonInput {
	session?: Session;
	selected: boolean;
	frame: number;
}

/** 下段: タブ(セッション)ボタン。 */
export function renderTabButton({ session, selected, frame }: TabButtonInput): string {
	if (!session) {
		const inner = characterSvg("none", undefined, frame, 37, 6, 5) + nameSvg("なし", selected);
		return wrap(inner, bgFor("none", selected));
	}
	const badge = `<text x="6" y="18" font-family="${FONT}" font-size="14" font-weight="700" fill="${selected ? NAVY : "#ffffff"}" fill-opacity="0.85">${esc(AGENT_LABEL[session.agent].slice(0, 3).toUpperCase())}</text>`;
	const inner = characterSvg(session.status, session.agent, frame, 37, 6, 5) + badge + nameSvg(session.name, selected);
	return wrap(inner, bgFor(session.status, selected));
}

export interface SpaceButtonInput {
	space?: Space;
	selected: boolean;
	frame: number;
	/** 選択中で 5 タブ以上のとき "1/2" を出す */
	page?: { index: number; count: number };
}

/** 上段: スペースボタン。中のタブの顔を並べる。 */
export function renderSpaceButton({ space, selected, frame, page }: SpaceButtonInput): string {
	if (!space) {
		return wrap(`<g opacity="0.8">${faceSvg("none", "claude", frame, 40, 22, 8)}</g>` + nameSvg("なし", selected, 70), bgFor("none", selected));
	}
	const MAX = 8;
	const shown = space.tabs.slice(0, MAX);
	const cols = 4;
	const cellW = 32;
	const cellH = 24;
	const scale = 3;
	let faces = "";
	shown.forEach((t, i) => {
		const cx = 8 + (i % cols) * cellW + (cellW - 8 * scale) / 2;
		const cy = 6 + Math.floor(i / cols) * cellH + 2;
		faces += faceSvg(t.status, t.agent, frame, cx, cy, scale);
	});
	let extra = "";
	if (space.tabs.length > MAX) extra = `<text x="138" y="54" font-family="${FONT}" font-size="12" font-weight="700" text-anchor="end" fill="${selected ? NAVY : "#fff"}">+${space.tabs.length - MAX}</text>`;
	let pageMark = "";
	if (page && page.count > 1) {
		pageMark = `<text x="6" y="54" font-family="${FONT}" font-size="12" font-weight="700" fill="${NAVY}">${page.index + 1}/${page.count}</text>`;
	}
	return wrap(faces + extra + pageMark + nameSvg(space.name, selected, 56), bgFor(space.status, selected));
}

// ───────────── インフォバー ─────────────

export interface InfobarUsage {
	info: UsageInfo;
	/** 使用率の分母(トークン) */
	contextWindow: number;
}

export interface InfobarInput {
	counts: Record<EventStatus, number>;
	tab?: Session;
	frame?: number;
	/** サーバーのエラーなど。あれば下段に赤字で出す。 */
	notice?: string;
	/** 選択中タブのコンテキスト使用率(v0.2)。省略時は使用率の行を出さない。 */
	usage?: InfobarUsage;
}

const USAGE_COLOR = { mint: STATUS_COLOR.done, yellow: STATUS_COLOR.working, red: STATUS_COLOR.blocked } as const;

/** 使用率の行(y=39〜49)。取れないときは推測せず「取得不可」と出す。 */
function usageRow({ info, contextWindow }: InfobarUsage): string {
	if (info.state !== "ok") {
		const label = info.state === "pending" ? "使用率: 確認中…" : "使用率: 取得不可";
		return `<text x="8" y="48" font-family="${FONT}" font-size="11" fill="#8a8aa8">${label}</text>`;
	}
	const { pct, color } = usageLevel(info.tokens, contextWindow);
	const fill = USAGE_COLOR[color];
	const trackW = 120;
	const w = Math.max(3, Math.min(1, pct / 100) * trackW);
	const shown = pct >= 1000 ? ">999" : String(Math.round(pct));
	return (
		`<rect x="6" y="40" width="${trackW}" height="8" rx="4" fill="#2a2a44"/>` +
		`<rect x="6" y="40" width="${w.toFixed(1)}" height="8" rx="4" fill="${fill}"/>` +
		`<text x="132" y="48" font-family="${FONT}" font-size="12" font-weight="800" fill="${fill}">${shown}%<tspan font-size="10" font-weight="400" fill="#b9b9d6" dx="4">${formatTokens(info.tokens)}/${formatTokens(contextWindow)}</tspan></text>`
	);
}

export function renderInfobar({ counts, tab, notice, usage }: InfobarInput): string {
	const chips: Array<[EventStatus, string]> = [
		["working", "作業中"],
		["blocked", "確認待ち"],
		["done", "完了"],
	];
	let out = `<rect width="${INFOBAR_W}" height="${INFOBAR_H}" fill="#12121c"/>`;
	const w = 74;
	const compact = !!usage && !notice && !!tab;
	const chipH = compact ? 20 : 25;
	chips.forEach(([st, label], i) => {
		const x = 2 + i * (w + 3);
		const n = counts[st];
		out += `<g opacity="${n > 0 ? 1 : 0.4}"><rect x="${x}" y="${compact ? 1 : 2}" width="${w}" height="${chipH}" rx="6" fill="${STATUS_COLOR[st]}"/>`;
		out += `<text x="${x + 6}" y="${compact ? 15 : 19}" font-family="${FONT}" font-size="${compact ? 11 : 12}" font-weight="700" fill="${NAVY}">${label}</text>`;
		out += `<text x="${x + w - 6}" y="${compact ? 18 : 22}" font-family="${FONT}" font-size="${compact ? 16 : 19}" font-weight="800" text-anchor="end" fill="${NAVY}">${n}</text></g>`;
	});
	if (notice) {
		out += `<text x="8" y="45" font-family="${FONT}" font-size="14" font-weight="700" fill="${STATUS_COLOR.blocked}">${esc(truncate(notice, 216, 14))}</text>`;
	} else if (tab && usage) {
		const fs = 13;
		const maxW = 232 - 18 - 8 - 44;
		out += `<circle cx="9" cy="30" r="4" fill="${STATUS_COLOR[tab.status]}"/>`;
		out += `<text x="18" y="35" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#ffffff">${esc(truncate(tab.name, maxW, fs))}</text>`;
		out += `<text x="228" y="35" font-family="${FONT}" font-size="11" font-weight="700" text-anchor="end" fill="#b9b9d6">${esc(AGENT_LABEL[tab.agent])}</text>`;
		out += usageRow(usage);
	} else if (tab) {
		const fs = 16;
		const maxW = 232 - 14 - 8 - 44;
		const label = truncate(tab.name, maxW, fs);
		out += `<circle cx="9" cy="39" r="5" fill="${STATUS_COLOR[tab.status]}"/>`;
		out += `<text x="20" y="45" font-family="${FONT}" font-size="${fs}" font-weight="700" fill="#ffffff">${esc(label)}</text>`;
		out += `<text x="228" y="45" font-family="${FONT}" font-size="12" font-weight="700" text-anchor="end" fill="#b9b9d6">${esc(AGENT_LABEL[tab.agent])}</text>`;
	} else {
		out += `<text x="10" y="45" font-family="${FONT}" font-size="14" fill="#8a8aa8">エージェントなし</text>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${INFOBAR_W}" height="${INFOBAR_H}" viewBox="0 0 ${INFOBAR_W} ${INFOBAR_H}">${out}</svg>`;
}

export function toDataUri(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
export function toBase64Uri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
