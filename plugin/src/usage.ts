import fs from "node:fs/promises";
import { extractContextUsage, readTail, TAIL_BYTES, TAIL_BYTES_FALLBACK, TranscriptLocator } from "./transcript";
import type { Session } from "./types";
import type { UsageInfo } from "./usagefmt";

export const USAGE_POLL_MS = 5000;

export { formatTokens, usageLevel, type UsageInfo, type UsageLevel } from "./usagefmt";

interface Entry {
	lastCheck: number;
	inflight: boolean;
	file?: string;
	mtimeMs?: number;
	size?: number;
	info: UsageInfo;
}

export interface UsageTrackerOptions {
	locator?: TranscriptLocator;
	now?: () => number;
	intervalMs?: number;
	log?: (msg: string) => void;
}

/**
 * 選択中タブの Claude セッション記録から、コンテキスト使用量を取る。
 * - 5 秒に 1 回だけファイルを stat し、更新日時かサイズが変わったときだけ末尾 256KB を読む。
 * - peek() は同期で、最後に分かった結果を返す(描画ループから呼ぶ)。
 */
export class UsageTracker {
	#entries = new Map<string, Entry>();
	#locator: TranscriptLocator;
	#now: () => number;
	#interval: number;
	#log: (msg: string) => void;
	/** テスト用: 実際にファイル本文を読んだ回数 */
	reads = 0;

	constructor(opts: UsageTrackerOptions = {}) {
		this.#now = opts.now ?? Date.now;
		this.#locator = opts.locator ?? new TranscriptLocator({ now: this.#now });
		this.#interval = opts.intervalMs ?? USAGE_POLL_MS;
		this.#log = opts.log ?? (() => undefined);
	}

	peek(session: Session): UsageInfo {
		if (session.agent !== "claude") return { state: "unavailable", reason: "Claude 以外" };
		return this.#entries.get(session.id)?.info ?? { state: "pending" };
	}

	/** 必要なら(前回から 5 秒以上たっていれば)取り直す。 */
	async request(session: Session): Promise<void> {
		if (session.agent !== "claude") return;
		const now = this.#now();
		let e = this.#entries.get(session.id);
		if (!e) {
			e = { lastCheck: Number.NEGATIVE_INFINITY, inflight: false, info: { state: "pending" } };
			this.#entries.set(session.id, e);
		}
		if (e.inflight || now - e.lastCheck < this.#interval) return;
		e.lastCheck = now;
		e.inflight = true;
		try {
			await this.#refresh(e, session);
		} catch (err) {
			this.#log(`usage read failed: ${String(err)}`);
			e.info = { state: "unavailable", reason: "読み取り失敗" };
			e.mtimeMs = undefined; // 次回は読み直す
		} finally {
			e.inflight = false;
		}
	}

	async #refresh(e: Entry, session: Session): Promise<void> {
		const file = await this.#locator.locate(session.id, session.transcriptPath);
		if (!file) {
			e.file = undefined;
			e.info = { state: "unavailable", reason: "記録ファイルなし" };
			return;
		}
		const st = await fs.stat(file);
		if (e.file === file && e.mtimeMs === st.mtimeMs && e.size === st.size && e.info.state !== "pending") return; // 変化なし
		let tail = await readTail(file, TAIL_BYTES);
		this.reads++;
		let u = extractContextUsage(tail.text);
		if (!u && !tail.complete && st.size > TAIL_BYTES) {
			tail = await readTail(file, TAIL_BYTES_FALLBACK); // 巨大な行が続いたときだけ 1 回広げる
			this.reads++;
			u = extractContextUsage(tail.text);
		}
		e.file = file;
		e.mtimeMs = st.mtimeMs;
		e.size = st.size;
		e.info = u ? { state: "ok", tokens: u.tokens, ...(u.model ? { model: u.model } : {}) } : { state: "unavailable", reason: "使用量の記録なし" };
	}

	/** 消えたセッションの分を捨てる。 */
	prune(aliveIds: Iterable<string>): void {
		const alive = new Set(aliveIds);
		for (const id of this.#entries.keys()) if (!alive.has(id)) this.#entries.delete(id);
	}
}
