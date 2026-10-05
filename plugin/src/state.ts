import { EVENT_STATUSES, AGENTS, type AgentEvent, type AgentKind, type DisplayStatus, type EventStatus, type Session, type Space } from "./types";

export const REPEAT_NARRATE_MS = 3000;
const SEVERITY: Record<DisplayStatus, number> = { blocked: 4, working: 3, done: 2, idle: 1, none: 0 };

/** 一番深刻な状態を返す(blocked > working > done > idle > none)。 */
export function worstStatus(list: Iterable<DisplayStatus>): DisplayStatus {
	let worst: DisplayStatus = "none";
	for (const s of list) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
	return worst;
}

export type ParseResult = { ok: true; event: AgentEvent } | { ok: false; error: string };

function str(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
	return t ? t.slice(0, max) : undefined;
}

/** 外部から来た JSON を検証して AgentEvent にする。 */
export function parseEvent(raw: unknown): ParseResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
	const o = raw as Record<string, unknown>;
	const session_id = str(o.session_id, 200);
	if (!session_id) return { ok: false, error: "session_id is required" };
	const agent = str(o.agent, 20)?.toLowerCase();
	if (!agent || !(AGENTS as readonly string[]).includes(agent)) return { ok: false, error: `agent must be one of ${AGENTS.join("|")}` };
	const status = str(o.status, 20)?.toLowerCase();
	if (!status || !(EVENT_STATUSES as readonly string[]).includes(status)) return { ok: false, error: `status must be one of ${EVENT_STATUSES.join("|")}` };
	const event: AgentEvent = { session_id, agent: agent as AgentKind, status: status as EventStatus };
	const name = str(o.name, 80);
	const cwd = str(o.cwd, 260);
	const hint = str(o.wt_window_hint, 120);
	const message = str(o.message, 600);
	const space = str(o.space, 80);
	const transcript = str(o.transcript_path, 520);
	const lastMsg = str(o.last_assistant_message, 6000);
	if (transcript) event.transcript_path = transcript;
	if (lastMsg) event.last_assistant_message = lastMsg;
	if (name) event.name = name;
	if (cwd) event.cwd = cwd;
	if (hint) event.wt_window_hint = hint;
	if (message) event.message = message;
	if (space) event.space = space;
	return { ok: true, event };
}

/** "C:\Users\me\Proj\" → "c:/users/me/proj" */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function baseName(p: string): string {
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

export interface ApplyResult {
	session: Session;
	prevStatus: EventStatus | undefined;
	/** 状態が前回から変わったか(新規セッションも true)。 */
	changed: boolean;
	/** 読み上げ対象(→done / →blocked)か。 */
	narrate: boolean;
}

export class SessionStore {
	#sessions = new Map<string, Session>();
	#spaceOrder: string[] = [];
	#now: () => number;
	/** 選択中のスペース、スペースごとの下段ページ、選択中のタブ */
	selectedSpaceKey: string | null = null;
	#pages = new Map<string, number>();
	selectedTabId: string | null = null;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	sessionIds(): string[] {
		return [...this.#sessions.keys()];
	}

	get size(): number {
		return this.#sessions.size;
	}

	apply(ev: AgentEvent): ApplyResult {
		const now = this.#now();
		const prev = this.#sessions.get(ev.session_id);
		const cwd = ev.cwd ?? prev?.cwd ?? "";
		let spaceKey: string;
		let spaceName: string;
		if (ev.space) {
			spaceKey = `space:${ev.space.toLowerCase()}`;
			spaceName = ev.space;
		} else if (prev?.spaceKey.startsWith("space:")) {
			// 以前に明示されたスペース名は維持する
			spaceKey = prev.spaceKey;
			spaceName = prev.spaceName;
		} else if (cwd) {
			spaceKey = normalizePath(cwd);
			spaceName = baseName(cwd) || cwd;
		} else {
			spaceKey = "(none)";
			spaceName = "未分類";
		}
		const name = ev.name ?? prev?.name ?? (cwd ? baseName(cwd) : "");
		const session: Session = {
			id: ev.session_id,
			agent: ev.agent,
			status: ev.status,
			name: name || ev.session_id.slice(0, 8),
			cwd,
			hint: ev.wt_window_hint ?? prev?.hint ?? "",
			// message は状態が変わるたびに入れ替える(古い確認内容を引きずらない)
			message: ev.message ?? (prev && prev.status === ev.status ? prev.message : ""),
			spaceKey,
			spaceName,
			firstSeen: prev?.firstSeen ?? now,
			updatedAt: now,
		};
		const transcriptPath = ev.transcript_path ?? prev?.transcriptPath;
		if (transcriptPath) session.transcriptPath = transcriptPath;
		if (ev.last_assistant_message) session.lastAssistantMessage = ev.last_assistant_message;
		this.#sessions.set(session.id, session);
		if (!this.#spaceOrder.includes(spaceKey)) this.#spaceOrder.push(spaceKey);
		if (prev && prev.spaceKey !== spaceKey) this.#gcSpaces();
		const changed = !prev || prev.status !== ev.status;
		// →done/→blocked への遷移で読み上げる。Codex は working イベントが無く done が続けて来るので、
		// 同じ状態でも 3 秒以上空いて届いた done/blocked は「次のターンの完了」として扱う。
		const fresh = changed || now - (prev?.updatedAt ?? 0) > REPEAT_NARRATE_MS;
		const narrate = fresh && (ev.status === "done" || ev.status === "blocked");
		return { session, prevStatus: prev?.status, changed, narrate };
	}

	/** TTL を過ぎたセッションを消す。消した数を返す。 */
	expire(ttlMs: number): number {
		const limit = this.#now() - ttlMs;
		let n = 0;
		for (const [id, s] of this.#sessions) {
			if (s.updatedAt < limit) {
				this.#sessions.delete(id);
				n++;
			}
		}
		if (n) this.#gcSpaces();
		return n;
	}

	#gcSpaces(): void {
		const alive = new Set([...this.#sessions.values()].map((s) => s.spaceKey));
		this.#spaceOrder = this.#spaceOrder.filter((k) => alive.has(k));
		for (const k of [...this.#pages.keys()]) if (!alive.has(k)) this.#pages.delete(k);
		if (this.selectedSpaceKey && !alive.has(this.selectedSpaceKey)) this.selectedSpaceKey = null;
		if (this.selectedTabId && !this.#sessions.has(this.selectedTabId)) this.selectedTabId = null;
	}

	/** 表示順(初めて見た順)のスペース一覧。 */
	spaces(): Space[] {
		const byKey = new Map<string, Session[]>();
		for (const s of [...this.#sessions.values()].sort((a, b) => a.firstSeen - b.firstSeen)) {
			const list = byKey.get(s.spaceKey) ?? [];
			list.push(s);
			byKey.set(s.spaceKey, list);
		}
		const out: Space[] = [];
		for (const key of this.#spaceOrder) {
			const tabs = byKey.get(key);
			if (!tabs?.length) continue;
			out.push({ key, name: tabs[0]!.spaceName, status: worstStatus(tabs.map((t) => t.status)), tabs });
		}
		return out;
	}

	/** 選択中スペース(未選択/消えたときは先頭)。 */
	selectedSpace(spaces = this.spaces()): Space | undefined {
		return spaces.find((s) => s.key === this.selectedSpaceKey) ?? spaces[0];
	}

	/** 選択中タブ(未選択なら選択スペースの先頭タブ)。 */
	selectedTab(spaces = this.spaces()): Session | undefined {
		const sp = this.selectedSpace(spaces);
		if (!sp) return undefined;
		return sp.tabs.find((t) => t.id === this.selectedTabId) ?? sp.tabs[0];
	}

	pageOf(spaceKey: string): number {
		return this.#pages.get(spaceKey) ?? 0;
	}

	/** スペースボタン押下。選択済みで 5 タブ以上なら次の 4 タブへ。 */
	pressSpace(space: Space, perPage = 4): void {
		const current = this.selectedSpace();
		if (current?.key === space.key) {
			const pages = Math.max(1, Math.ceil(space.tabs.length / perPage));
			this.#pages.set(space.key, (this.pageOf(space.key) + 1) % pages);
		} else {
			this.selectedSpaceKey = space.key;
			this.#pages.set(space.key, 0);
			this.selectedTabId = null;
		}
	}

	/** 指定 agent のセッションを削除。消した数を返す。 */
	removeByAgents(agents: Iterable<AgentKind>): number {
		const ban = new Set(agents);
		let n = 0;
		for (const [id, s] of this.#sessions) {
			if (ban.has(s.agent)) {
				this.#sessions.delete(id);
				n++;
			}
		}
		if (n) this.#gcSpaces();
		return n;
	}

	/** agent が許可集合に含まれるセッションだけ残す。 */
	retainAgents(allowed: ReadonlySet<AgentKind>): number {
		let n = 0;
		for (const [id, s] of this.#sessions) {
			if (!allowed.has(s.agent)) {
				this.#sessions.delete(id);
				n++;
			}
		}
		if (n) this.#gcSpaces();
		return n;
	}

	/** 状態ごとの件数(タブ単位)。 */
	counts(): Record<EventStatus, number> {

		const c: Record<EventStatus, number> = { working: 0, blocked: 0, done: 0, idle: 0 };
		for (const s of this.#sessions.values()) c[s.status]++;
		return c;
	}
}
