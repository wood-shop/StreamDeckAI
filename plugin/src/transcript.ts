import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePath } from "./state";

/** 使用率・要約に使う、セッション記録(Claude Code の JSONL)の読み取り。依存ソフト不要。 */

export const TAIL_BYTES = 256 * 1024;
/** 末尾 256KB に目的の行が無かったときだけ、1 回だけ広げて読む上限。 */
export const TAIL_BYTES_FALLBACK = 1024 * 1024;

export interface Tail {
	text: string;
	size: number;
	mtimeMs: number;
	/** ファイルの先頭まで読めたか(false なら先頭の欠けた行は捨ててある) */
	complete: boolean;
}

/** ファイルの末尾 maxBytes だけを読む。先頭の欠けた行は捨てる。 */
export async function readTail(file: string, maxBytes = TAIL_BYTES): Promise<Tail> {
	const fh = await fs.open(file, "r");
	try {
		const st = await fh.stat();
		const start = Math.max(0, st.size - maxBytes);
		const len = st.size - start;
		let buf = Buffer.alloc(len);
		let got = 0;
		while (got < len) {
			const r = await fh.read(buf, got, len - got, start + got);
			if (r.bytesRead === 0) break;
			got += r.bytesRead;
		}
		buf = buf.subarray(0, got);
		if (start > 0) {
			const nl = buf.indexOf(0x0a);
			buf = nl < 0 ? buf.subarray(buf.length) : buf.subarray(nl + 1);
		}
		return { text: buf.toString("utf8").replace(/^\uFEFF/, ""), size: st.size, mtimeMs: st.mtimeMs, complete: start === 0 };
	} finally {
		await fh.close();
	}
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSONL を壊れた行を飛ばしながら読む(行の順序は保つ)。 */
export function parseJsonl(text: string): Json[] {
	const out: Json[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		try {
			const o: unknown = JSON.parse(t);
			if (isObj(o)) out.push(o);
		} catch {
			// 途中で切れた行・書き込み中の行は無視
		}
	}
	return out;
}

export interface ContextUsage {
	/** input + cache_read + cache_creation (+ output) */
	tokens: number;
	model?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** 最新のアシスタント発言の message.usage からコンテキストの大きさ(トークン)を出す。無ければ undefined。 */
export function extractContextUsage(text: string, opts: { includeOutput?: boolean } = {}): ContextUsage | undefined {
	const includeOutput = opts.includeOutput ?? true;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (!line.includes('"usage"')) continue; // 安い事前チェック
		let o: unknown;
		try {
			o = JSON.parse(line.trim());
		} catch {
			continue;
		}
		if (!isObj(o) || o.type !== "assistant" || o.isSidechain === true || !isObj(o.message)) continue;
		const model = typeof o.message.model === "string" ? o.message.model : undefined;
		if (model === "<synthetic>") continue;
		const u = o.message.usage;
		if (!isObj(u)) continue;
		const tokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + (includeOutput ? num(u.output_tokens) : 0);
		if (tokens <= 0) continue; // 中断・エラーなどの空の usage は飛ばす
		return model ? { tokens, model } : { tokens };
	}
	return undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Json => isObj(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/** ユーザー本人の入力か(tool_result だけの user 行や isMeta は除く)。 */
function isRealUserPrompt(o: Json): boolean {
	if (o.isMeta === true || !isObj(o.message)) return false;
	const c = o.message.content;
	if (typeof c === "string") return c.trim() !== "";
	return Array.isArray(c) && c.some((b) => isObj(b) && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

/**
 * 末尾から見て最後のアシスタントの文章(text ブロック)を返す。同じ message.id の連続行は連結する。
 * 今回のユーザー入力より前の発言(=前のターンの古い返答)は返さない。
 */
export function extractLastAssistantText(text: string): string | undefined {
	const entries = parseJsonl(text).filter((o) => o.isSidechain !== true);
	for (let i = entries.length - 1; i >= 0; i--) {
		const o = entries[i]!;
		if (o.type === "user") {
			if (isRealUserPrompt(o)) return undefined;
			continue;
		}
		if (o.type !== "assistant" || !isObj(o.message)) continue;
		const t = textOf(o.message.content).trim();
		if (!t) continue;
		const id = typeof o.message.id === "string" ? o.message.id : undefined;
		const parts = [t];
		for (let j = i - 1; id && j >= 0; j--) {
			const p = entries[j]!;
			if (p.type !== "assistant" || !isObj(p.message) || p.message.id !== id) break;
			const pt = textOf(p.message.content).trim();
			if (pt) parts.unshift(pt);
		}
		return parts.join("\n");
	}
	return undefined;
}

// ───────────── 場所の特定 ─────────────

/** Claude の設定フォルダ候補(CLAUDE_CONFIG_DIR → ~/.claude)。 */
export function defaultClaudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
	const dirs: string[] = [];
	if (env.CLAUDE_CONFIG_DIR?.trim()) dirs.push(env.CLAUDE_CONFIG_DIR.trim());
	dirs.push(path.join(home, ".claude"));
	return dirs;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * hook から来た transcript_path を読んでよいか。HTTP は同じ PC のどのプロセスからも叩けるので、
 * 「絶対パスの *.jsonl で、Claude の設定フォルダ(.claude)配下」のものだけに限る。
 */
export function isAllowedTranscriptPath(p: string, claudeDirs: string[] = defaultClaudeDirs()): boolean {
	if (!p || p.includes("\0")) return false;
	const n = p.replace(/\\/g, "/");
	if (!/^([a-zA-Z]:\/|\/)/.test(n)) return false;
	if (n.split("/").includes("..")) return false;
	if (!n.toLowerCase().endsWith(".jsonl")) return false;
	const low = normalizePath(n);
	if (low.includes("/.claude/")) return true;
	return claudeDirs.some((d) => {
		const nd = normalizePath(d);
		return nd !== "" && low.startsWith(`${nd}/`);
	});
}

export interface LocatorOptions {
	claudeDirs?: string[];
	now?: () => number;
	/** 見つからなかったときに、次に探し直すまでの待ち(ms) */
	missRetryMs?: number;
}

/**
 * セッションの記録ファイルを探す。
 *  1. hook が教えた transcript_path(許可された場所で、存在するなら)
 *  2. <claude dir>/projects/*\/<session_id>.jsonl を探す
 */
export class TranscriptLocator {
	#dirs: string[];
	#now: () => number;
	#missRetryMs: number;
	#found = new Map<string, string>();
	#missAt = new Map<string, number>();

	constructor(opts: LocatorOptions = {}) {
		this.#dirs = opts.claudeDirs ?? defaultClaudeDirs();
		this.#now = opts.now ?? Date.now;
		this.#missRetryMs = opts.missRetryMs ?? 30_000;
	}

	async #exists(p: string): Promise<boolean> {
		try {
			return (await fs.stat(p)).isFile();
		} catch {
			return false;
		}
	}

	async locate(sessionId: string, hookPath?: string): Promise<string | undefined> {
		if (hookPath && isAllowedTranscriptPath(hookPath, this.#dirs) && (await this.#exists(hookPath))) return hookPath;
		const cached = this.#found.get(sessionId);
		if (cached) {
			if (await this.#exists(cached)) return cached;
			this.#found.delete(sessionId);
		}
		if (!SAFE_ID.test(sessionId)) return undefined;
		const missAt = this.#missAt.get(sessionId);
		if (missAt !== undefined && this.#now() - missAt < this.#missRetryMs) return undefined;
		for (const dir of this.#dirs) {
			const projects = path.join(dir, "projects");
			let subs: string[];
			try {
				subs = await fs.readdir(projects);
			} catch {
				continue;
			}
			for (const sub of subs) {
				const candidate = path.join(projects, sub, `${sessionId}.jsonl`);
				if (await this.#exists(candidate)) {
					this.#found.set(sessionId, candidate);
					this.#missAt.delete(sessionId);
					return candidate;
				}
			}
		}
		this.#missAt.set(sessionId, this.#now());
		return undefined;
	}
}
