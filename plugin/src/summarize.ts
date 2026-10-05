/**
 * LLM なしの抽出型要約。アシスタントの最後の発言から、読み上げ用の 1 行を作る。
 *   「<スペース名>から。<何をしたか>。<次にすること>」(全体でおよそ 120 文字)
 * 日本語・英語の両方に対応(英語は文を短く切って読むだけ。翻訳はしない)。
 */

export const SUMMARY_MAX_CHARS = 120;
const NEXT_MAX = 45;

const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
const CJK_G = /[\u3040-\u30ff\u3400-\u9fff]/g;

function isJapanese(text: string): boolean {
	const letters = text.replace(/\s/g, "");
	if (!letters) return false;
	return (letters.match(CJK_G)?.length ?? 0) / letters.length > 0.2;
}

interface Tokens {
	file: string;
	link: string;
	command: string;
}
const TOK_JA: Tokens = { file: "ファイル", link: "リンク", command: "コマンド" };
const TOK_EN: Tokens = { file: "the file", link: "a link", command: "a command" };

const EXT = "ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|txt|py|ps1|psm1|sh|bat|cmd|yml|yaml|toml|ini|cfg|conf|html|css|scss|csv|tsv|xml|sql|log|lock|zip|png|jpg|jpeg|gif|svg|pdf|docx|xlsx|pptx|exe|dll|cs|java|go|rs|rb|php|c|h|cpp";

/** 1 行ぶんの Markdown 記号・URL・パスなどを読み上げ向けに直す。 */
function cleanLine(line: string, tok: Tokens): string {
	let s = line;
	// 画像・リンク
	s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
	// インラインコード: パス→ファイル / 空白を含む→コマンド / 単語→そのまま
	s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
		const c = code.trim();
		if (/^[A-Za-z]:[\\/]/.test(c) || /[\\/]/.test(c) || new RegExp(`\\.(${EXT})$`, "i").test(c)) return tok.file;
		if (/\s/.test(c) || /[()=<>|;&$]/.test(c)) return tok.command;
		return c;
	});
	s = s.replace(/`+/g, "");
	// URL
	s = s.replace(/(?:https?|ftp|file):\/\/[^\s)）」』>]+/gi, tok.link);
	s = s.replace(/\bwww\.[^\s)）」』>]+/gi, tok.link);
	// Windows パス / UNC / Unix 風パス / 拡張子つきファイル名
	s = s.replace(/(?:\\\\|[A-Za-z]:[\\/])[^\s"'<>|*?、。，）」』]*/g, tok.file);
	s = s.replace(/(^|[^\w/\\.@\-])((?:\.{1,2}\/|~\/|\/)?[\w.@\-]+(?:\/[\w.@\-]+)+\/?)(?=$|[^\w/\\.@\-]|[.,:;](?:\s|$))/g, `$1${tok.file}`);
	s = s.replace(new RegExp(`(^|[^\\w/\\\\.])[\\w\\-]+(?:\\.[\\w\\-]+)*\\.(?:${EXT})\\b`, "gi"), `$1${tok.file}`);
	// HTML タグ・強調・取り消し線
	s = s.replace(/<\/?[A-Za-z][^>]*>/g, "");
	s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
	s = s.replace(/(^|[\s(（「])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s)）」、。,.!?！？])/g, "$1$2");
	s = s.replace(/~~(.+?)~~/g, "$1");
	// 絵文字・記号
	s = s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u2713\u2714\u2705\u274C]/gu, "");
	return s.replace(/\s+/g, " ").trim();
}

/** 連続した「ファイル」などをまとめる。 */
function squeezeTokens(s: string, tok: Tokens): string {
	let out = s;
	for (const t of [tok.file, tok.link, tok.command]) {
		const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`${esc}(?:\\s*(?:、|,|と|や|・|及び|and|or)?\\s*${esc})+`, "g"), t);
	}
	return out;
}

/**
 * Markdown のコードブロック・表・見出し・URL・パスなどを取り除く。
 * 戻り値は 1 行 1 項目(リストの項目は 1 文として扱えるよう句点を補う)。
 */
export function cleanForSpeech(markdown: string): string[] {
	const src = markdown.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	const noFence = src.replace(/(```|~~~)[\s\S]*?(\1|$)/g, "\n");
	const tok = isJapanese(noFence) ? TOK_JA : TOK_EN;
	const out: string[] = [];
	for (const raw of noFence.split("\n")) {
		let line = raw;
		if (!line.trim()) continue;
		if (/^\s*\|/.test(line) || (line.match(/\|/g)?.length ?? 0) >= 2) continue; // 表
		if (/^\s*([-*_]\s*){3,}$/.test(line) || /^\s*[=-]{3,}\s*$/.test(line)) continue; // 区切り線
		if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) continue; // 見出し
		line = line.replace(/^\s*>+\s?/, "");
		const list = /^\s*(?:[-*+•・]|\d+[.)])\s+/.test(line);
		line = line.replace(/^\s*(?:[-*+•・]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "");
		line = squeezeTokens(cleanLine(line, tok), tok);
		if (!line) continue;
		// 空白の整理: 日本語の前後の空白は不要
		line = line.replace(/(?<=[\u3000-\u9fff\uff00-\uffef]) +| +(?=[\u3000-\u9fff\uff00-\uffef])/g, "");
		if (!/[\p{L}\p{N}]/u.test(line)) continue;
		if (list && !/[。！？!?.]$/.test(line)) line += CJK.test(line) ? "。" : ".";
		out.push(line);
	}
	return out;
}

/** 文に分ける(日本語は 。！？、英語は ". " の後ろ)。末尾の句読点は残す。 */
export function splitSentences(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const parts = line
			.split(/(?<=[。！？!?])\s*|(?<=[.])\s+(?=[A-Z0-9“"'(])/)
			.map((p) => p.trim())
			.filter(Boolean);
		for (const p of parts) out.push(p);
	}
	return out;
}

const ACK_ONLY = /^(?:はい|了解(?:です|しました)?|承知(?:しました|です)?|かしこまりました|わかりました|分かりました|OK|Okay|Sure|Got it|Great|Alright|Done|Understood|Certainly|All set|Perfect)[、,.!！。]*$/i;
const ACK_PREFIX = /^(?:はい|了解しました|承知しました|かしこまりました|わかりました|分かりました|Sure|Okay|OK|Great|Alright|Certainly|Understood)[、,!！.]\s*/i;

const NEXT_LEAD = /^(?:Next|Then|After that)\b|^(?:次に|次は|その後)/i;
const QUESTION = /[？?]$|(?:ですか|ますか|ませんか|でしょうか|いかがでしょう|いかがですか)[。]?$/;
const REQUEST_JA = /ください|下さい|お願い|いただけ|ほしい|欲しい|確認が必要|確認の?(?:うえ|上)|確認して|必要があります|必要です|待っています/;
const REQUEST_EN = /\b(?:please|let me know|would you like|do you want|should I|shall I|want me to|can you|could you|need(?:s)? your|to confirm|please confirm|review (?:it|this|the)|next step|let's know)\b/i;

/** 「次にすること」に当たる文か(質問、またはお願い・確認を含む文)。 */
export function isNextAction(sentence: string): boolean {
	return NEXT_LEAD.test(sentence.trim()) || QUESTION.test(sentence.trim()) || REQUEST_JA.test(sentence) || REQUEST_EN.test(sentence);
}

function stripEnd(s: string): string {
	return s.replace(/[\s。.！!？?、,:：;；]+$/u, "");
}

const EN_DANGLING = /\s+(?:if|and|or|but|the|a|an|to|of|in|on|for|with|by|that|so|as|at|is|are|be|you|me|we|it|this|these|those|when|while|because|which|let|know)$/i;

/** 長い文を max 文字以内に短くする(読点・節・単語の切れ目を優先)。 */
export function shorten(sentence: string, max: number): string {
	const s = stripEnd(sentence);
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	if (isJapanese(s)) {
		const idx = Math.max(cut.lastIndexOf("、"), cut.lastIndexOf("，"), cut.lastIndexOf(","));
		return stripEnd(idx >= Math.floor(max * 0.5) ? cut.slice(0, idx) : cut);
	}
	// 英語: 節の切れ目(コンマ・and・by など)→ 単語の切れ目の順。文が尻切れにならないよう、末尾の接続語は落とす。
	let best = -1;
	for (const m of cut.matchAll(/,|;| and | by | because | which | while | so | to /g)) best = m.index ?? best;
	let out = best >= Math.floor(max * 0.4) ? cut.slice(0, best) : cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
	for (let i = 0; i < 3 && EN_DANGLING.test(out); i++) out = out.replace(EN_DANGLING, "");
	return stripEnd(out);
}

/** 文末の句点(英語だけの文は "."、日本語を含む文は "。")。 */
function stop(s: string, q = false): string {
	if (q) return CJK.test(s) ? "？" : "?";
	return CJK.test(s) ? "。" : ".";
}

/** 英語だけの文どうしの間には空白を入れる。 */
function gap(s: string): string {
	return CJK.test(s) ? "" : " ";
}

export interface SummaryParts {
	what: string;
	next: string;
	line: string;
}

/**
 * 読み上げ用の 1 行を作る。使える文が無ければ undefined(呼び出し側は定型文に戻す)。
 * space はスペース名(先頭に「<名前>から。」を付ける)。
 */
export function summarizeForSpeech(text: string | undefined, space: string, maxChars = SUMMARY_MAX_CHARS): SummaryParts | undefined {
	if (!text || !text.trim()) return undefined;
	let sentences = splitSentences(cleanForSpeech(text))
		.map((s, i) => (i === 0 ? s.replace(ACK_PREFIX, "") : s))
		.filter((s) => s.length >= 2 && /[\p{L}\p{N}]/u.test(s) && !ACK_ONLY.test(s.trim()));
	// 「変更点:」のようにコロンで終わる短い導入文は、中身が無いので読まない
	sentences = sentences.filter((s) => !(/[:：]$/.test(s) && s.length < 30 && !isNextAction(s)));
	if (!sentences.length) return undefined;

	// 次にすること: 末尾から探した最初の質問/お願いの文
	let nextIdx = -1;
	for (let i = sentences.length - 1; i >= 0; i--) {
		if (isNextAction(sentences[i]!)) {
			nextIdx = i;
			break;
		}
	}
	const head = `${space}から。`;
	const nextRaw = nextIdx > 0 || (nextIdx === 0 && sentences.length > 1) ? sentences[nextIdx]! : "";
	const asQuestion = QUESTION.test(nextRaw.trim()) && /[？?]$/.test(nextRaw.trim());
	const next = nextRaw ? shorten(nextRaw, NEXT_MAX) : "";
	const nextPart = next ? `${next}${stop(next, asQuestion)}` : "";

	const budget = Math.max(24, maxChars - head.length - nextPart.length - 1);
	const body = sentences.filter((_s, i) => i !== nextIdx || !nextRaw);
	const first = body[0] ?? sentences[0]!;
	let what = shorten(first, budget);
	const firstIsQuestion = /[？?]$/.test(first.trim());
	const room = budget - what.length - 1;
	let end = stop(what, firstIsQuestion);
	if (body[1] && room >= 16) {
		const second = body[1];
		what += `${stop(what)}${gap(what)}${shorten(second, room)}`;
		end = stop(what, /[？?]$/.test(second.trim()));
	}
	let line = `${head}${what}${end}${gap(what)}${nextPart}`;
	// 「何をしたか」だけが質問・お願いのとき以外は、定番の締めを足す
	if (!nextPart && !isNextAction(what) && line.length + 14 <= maxChars + 6) line += "画面で結果を確認してください。";
	line = line.trim();
	return { what, next, line };
}
