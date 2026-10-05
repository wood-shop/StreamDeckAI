import { summarizeForSpeech } from "./summarize";
import type { SoundName } from "./speech";
import { AGENT_LABEL, type NarrationStyle, type Session } from "./types";

/** 取り消しにくい操作を示すキーワード(読み上げで必ず伝える)。 */
const DESTRUCTIVE: Array<[RegExp, string]> = [
	[/(^|[\s;&|"'`(])(rm|rmdir|rd|del|erase|unlink)(\s|$)|remove-item|\bdelete\b|削除|消去|消す|\bclean\s+-[a-z]*f/i, "削除"],
	[/\bdrop\s+(table|database|schema)\b|\btruncate\b/i, "データの破棄"],
	[/reset\s+--hard|push\s+(\S+\s+)*(-f\b|--force)|--force\b|強制/i, "強制的な変更"],
	[/\bformat\b|mkfs|diskpart|フォーマット/i, "フォーマット"],
	[/overwrite|上書き/i, "上書き"],
	[/uninstall|アンインストール/i, "アンインストール"],
];

/** message から取り消しにくい操作の種類を拾う(重複なし)。 */
export function detectDestructive(message: string | undefined): string[] {
	if (!message) return [];
	const found: string[] = [];
	for (const [re, label] of DESTRUCTIVE) if (re.test(message) && !found.includes(label)) found.push(label);
	return found;
}

/** TTS 向けに整形して先頭 max 文字に切る。 */
export function excerpt(message: string, max = 90): string {
	const clean = message
		.replace(/[`*#|<>\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max)}、以下省略`;
}

export interface NarrationOptions {
	includeMessage: boolean;
}

/**
 * 固定テンプレートの読み上げ文(LLM なし)。
 * 先頭にスペース名を付ける。確認待ちは選択肢を勧めない。
 */
export function buildNarration(session: Session, status: "done" | "blocked", opts: NarrationOptions): string {
	const agent = AGENT_LABEL[session.agent];
	const who = session.name && session.name !== session.spaceName ? `${agent}の「${session.name}」` : agent;
	const head = `${session.spaceName}から。`;
	if (status === "done") {
		let s = `${head}${who}が完了しました。`;
		if (opts.includeMessage && session.message) s += `報告は、${excerpt(session.message)}。`;
		return `${s}画面で結果を確認して、次の指示を出してください。`;
	}
	let s = `${head}${who}が確認を待っています。`;
	if (session.message) {
		if (opts.includeMessage) s += `内容は、${excerpt(session.message)}。`;
		const d = detectDestructive(session.message);
		if (d.length) s += `${d.join("、")}など、取り消しにくい操作が含まれています。内容をよく確認してください。`;
		return `${s}画面で、許可するか断るかを選んでください。`;
	}
	return `${s}内容は画面で確認して、許可するか断るかを選んでください。`;
}

// ───────────── v0.2: 読み上げスタイル ─────────────

/** 実際に鳴らすもの。sound があれば先に効果音、text があれば続けて読み上げる。 */
export interface NarrationPlan {
	sound?: SoundName;
	text?: string;
}

/**
 * スタイルに応じた読み上げを決める(同期)。
 *  - 要約あり: 完了は assistantText からローカル要約。取れなければ定型文。確認待ちは従来どおり(通知文+破壊的操作の警告)。
 *  - 定型文のみ: v0.1 と同じ。
 *  - 効果音のみ: 効果音だけ。ただし確認待ちで取り消しにくい操作を検出したときは、安全のため短い警告も読む。
 */
export function planNarration(
	session: Session,
	status: "done" | "blocked",
	style: NarrationStyle,
	opts: NarrationOptions & { assistantText?: string },
): NarrationPlan {
	if (style === "sound") {
		if (status === "done") return { sound: "Asterisk" };
		const d = detectDestructive(session.message);
		if (d.length) return { sound: "Hand", text: `${session.spaceName}から。${d.join("、")}など、取り消しにくい操作の確認待ちです。画面で確認してください。` };
		return { sound: "Exclamation" };
	}
	if (style === "summary" && status === "done") {
		const sum = summarizeForSpeech(opts.assistantText, session.spaceName);
		if (sum) return { text: sum.line };
	}
	return { text: buildNarration(session, status, opts) };
}
