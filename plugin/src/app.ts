import { focusTab } from "./focus";
import { planNarration, type NarrationPlan } from "./narration";
import { makeRunner, resolvePowerShell, type PsRunner } from "./powershell";
import { EventServer } from "./server";
import { Speaker } from "./speech";
import { extractLastAssistantText, readTail, TAIL_BYTES, TranscriptLocator } from "./transcript";
import { UsageTracker } from "./usage";
import { SessionStore, baseName } from "./state";
import { renderInfobar, renderSpaceButton, renderTabButton } from "./svg";
import {
	defaultAppsFile,
	defaultAppsPath,
	enabledAgents,
	parseAppsPayload,
	readAppsFile,
	writeAppsFile,
	type AppsFile,
} from "./apps";
import { DEFAULT_GLOBAL_SETTINGS, NARRATION_STYLES, type AgentEvent, type AgentKind, type GlobalSettings, type NarrationStyle, type Session } from "./types";

/** manifest / package と揃えるプラグイン版 (GET /version)。 */
export const PLUGIN_VERSION = "0.3.0.0";
export const PLUGIN_UUID = "jp.example.streamdeckai";

export const REDRAW_MS = 150;
export const HOUSEKEEPING_EVERY = 8; // 8 × 150ms = 1.2 秒
export const FRAME_MS = 450; // アニメ 1 コマの長さ

export type SurfaceKind = "space" | "tab" | "infobar";

/** 画面に出ている 1 つのボタン/インフォバー。SDK には依存しない。 */
export interface Surface {
	id: string;
	kind: SurfaceKind;
	/** 設定の slot("auto" または 1〜16) */
	slot: number | "auto";
	column: number;
	push: (svg: string) => Promise<void>;
	last?: string;
}

export function sanitizeSettings(raw: Partial<Record<string, unknown>> | undefined): GlobalSettings {
	const d = DEFAULT_GLOBAL_SETTINGS;
	const num = (v: unknown, lo: number, hi: number, def: number) => {
		const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
		return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : def;
	};
	const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : def);
	const s = raw ?? {};
	return {
		port: num(s.port, 1024, 65535, d.port),
		narration: bool(s.narration, d.narration),
		voiceName: typeof s.voiceName === "string" ? s.voiceName.trim() : d.voiceName,
		rate: num(s.rate, -10, 10, d.rate),
		includeMessage: bool(s.includeMessage, d.includeMessage),
		powershellPath: typeof s.powershellPath === "string" ? s.powershellPath.trim() : d.powershellPath,
		ttlHours: num(s.ttlHours, 1, 168, d.ttlHours),
		narrationStyle: (NARRATION_STYLES as readonly unknown[]).includes(s.narrationStyle) ? (s.narrationStyle as NarrationStyle) : d.narrationStyle,
		contextWindow: num(s.contextWindow, 10_000, 10_000_000, d.contextWindow),
	};
}

export function resolveSlot(slot: number | "auto" | string | undefined, column: number): number {
	const n = typeof slot === "string" ? Number(slot) : slot;
	if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 16) return n;
	return Math.min(16, Math.max(1, column + 1));
}

export interface AppDeps {
	now?: () => number;
	runner?: PsRunner;
	log?: (msg: string) => void;
	/** Claude の設定フォルダ(既定: CLAUDE_CONFIG_DIR と ~/.claude)。テスト用に差し替えられる。 */
	claudeDirs?: string[];
	/** Stop 直後に記録ファイルを読むまでの待ち(ms)。既定 300。 */
	transcriptDelayMs?: number;
	/** apps.json のパス。テスト用に差し替え可能。空文字ならファイル I/O しない。 */
	appsPath?: string;
	/** 起動時の apps。指定があればファイルより優先。 */
	initialApps?: AppsFile;
}

export class App {
	store: SessionStore;
	settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
	surfaces = new Map<string, Surface>();
	server: EventServer;
	speaker: Speaker;
	usage: UsageTracker;
	locator: TranscriptLocator;
	apps: AppsFile;
	#appsPath: string;
	#enabledAgents: Set<AgentKind>;
	#transcriptDelayMs: number;
	#runner: PsRunner;
	#now: () => number;
	#timer: NodeJS.Timeout | null = null;
	#ticks = 0;
	log: (msg: string) => void;

	constructor(deps: AppDeps = {}) {
		this.#now = deps.now ?? Date.now;
		this.log = deps.log ?? (() => undefined);
		this.store = new SessionStore(this.#now);
		this.#runner = deps.runner ?? ((script, env, t) => makeRunner(resolvePowerShell(this.settings.powershellPath))(script, env, t));
		this.speaker = new Speaker({
			run: this.#runner,
			voiceName: () => this.settings.voiceName,
			rate: () => this.settings.rate,
			log: (m) => this.log(m),
		});
		this.locator = new TranscriptLocator({ now: this.#now, ...(deps.claudeDirs ? { claudeDirs: deps.claudeDirs } : {}) });
		this.usage = new UsageTracker({ locator: this.locator, now: this.#now, log: (m) => this.log(m) });
		this.#transcriptDelayMs = deps.transcriptDelayMs ?? 300;
		this.#appsPath = deps.appsPath === undefined ? defaultAppsPath() : deps.appsPath;
		if (deps.initialApps) {
			this.apps = deps.initialApps;
		} else if (this.#appsPath) {
			this.apps = readAppsFile(this.#appsPath);
		} else {
			this.apps = defaultAppsFile();
		}
		this.#enabledAgents = enabledAgents(this.apps);
		this.server = new EventServer({
			onEvent: (ev) => this.handleEvent(ev),
			sessionCount: () => this.store.size,
			log: (m) => this.log(m),
			getApps: () => this.apps,
			setApps: (raw) => this.applyApps(raw),
			getVersion: () => ({ version: PLUGIN_VERSION, plugin: PLUGIN_UUID, port: this.server.port || this.settings.port }),
		});
	}

	isAgentEnabled(agent: AgentKind): boolean {
		return this.#enabledAgents.has(agent);
	}

	/** POST /apps およびセレクタからの反映。 */
	applyApps(raw: unknown): { ok: true; apps: AppsFile } | { ok: false; error: string } {
		const parsed = parseAppsPayload(raw, this.apps);
		if (!parsed.ok) return parsed;
		this.apps = parsed.apps;
		this.#enabledAgents = enabledAgents(this.apps);
		const removed = this.store.retainAgents(this.#enabledAgents);
		if (removed) this.log(`removed ${removed} session(s) for disabled agents`);
		if (this.#appsPath) {
			try {
				writeAppsFile(this.#appsPath, this.apps);
			} catch (e) {
				this.log(`write apps.json failed: ${String(e)}`);
			}
		}
		return { ok: true, apps: this.apps };
	}

	#applying: Promise<void> = Promise.resolve();

	/**
	 * 設定を反映。ポートが変わったらサーバーを作り直す。
	 * getGlobalSettings の応答と didReceiveGlobalSettings が連続で来るので、直列に処理する。
	 */
	applySettings(raw: Partial<Record<string, unknown>> | undefined): Promise<void> {
		this.#applying = this.#applying.then(async () => {
			const next = sanitizeSettings(raw);
			const needStart = !this.server.listening || this.server.port !== next.port;
			this.settings = next;
			if (needStart) {
				try {
					await this.server.start(next.port);
				} catch {
					// lastError がインフォバーに出る
				}
			}
		});
		return this.#applying;
	}

	handleEvent(ev: AgentEvent): { ignored?: boolean } {
		if (!this.isAgentEnabled(ev.agent)) {
			this.log(`ignored event from disabled agent: ${ev.agent}`);
			return { ignored: true };
		}
		const r = this.store.apply(ev);
		if (r.narrate && this.settings.narration && (r.session.status === "done" || r.session.status === "blocked")) {
			this.narrate(r.session, r.session.status).catch((e) => this.log(`narration failed: ${String(e)}`));
		}
		return {};
	}

	/** 読み上げの材料(最後のアシスタント発言)。イベントが運んできたものを優先し、Claude だけ記録ファイルの末尾を読む。 */
	#eventText(session: Session): string | undefined {
		return session.lastAssistantMessage ?? (session.agent !== "claude" ? session.message : undefined) ?? undefined;
	}

	async #transcriptText(session: Session): Promise<string | undefined> {
		if (session.agent !== "claude") return undefined;
		if (this.#transcriptDelayMs > 0) await new Promise((r) => setTimeout(r, this.#transcriptDelayMs)); // 記録ファイルへの書き込みを少し待つ
		const file = await this.locator.locate(session.id, session.transcriptPath);
		if (!file) return undefined;
		return extractLastAssistantText((await readTail(file, TAIL_BYTES)).text);
	}

	/** 設定のスタイルに従って、効果音と読み上げを順番待ちに入れる。 */
	async narrate(session: Session, status: "done" | "blocked"): Promise<NarrationPlan> {
		const style = this.settings.narrationStyle;
		const opts = { includeMessage: this.settings.includeMessage };
		let assistantText: string | undefined;
		if (style === "summary" && status === "done") {
			assistantText = this.#eventText(session);
			if (!assistantText) {
				try {
					assistantText = await this.#transcriptText(session);
				} catch (e) {
					this.log(`transcript read failed: ${String(e)}`);
				}
			}
		}
		const plan = planNarration(session, status, style, { ...opts, ...(assistantText ? { assistantText } : {}) });
		if (plan.sound) this.speaker.enqueueSound(plan.sound);
		if (plan.text) this.speaker.enqueue(plan.text);
		return plan;
	}

	register(s: Surface): void {
		this.surfaces.set(s.id, s);
	}
	unregister(id: string): void {
		this.surfaces.delete(id);
	}

	/** 現在の状態から surface の SVG を作る。 */
	renderSurface(s: Surface, frame: number): string {
		const spaces = this.store.spaces();
		const selSpace = this.store.selectedSpace(spaces);
		if (s.kind === "infobar") {
			const tab = this.store.selectedTab(spaces);
			return renderInfobar({
				counts: this.store.counts(),
				tab,
				notice: this.server.lastError || undefined,
				...(tab ? { usage: { info: this.usage.peek(tab), contextWindow: this.settings.contextWindow } } : {}),
			});
		}
		const slot = resolveSlot(s.slot, s.column);
		if (s.kind === "space") {
			const space = spaces[slot - 1];
			const selected = !!space && selSpace?.key === space.key;
			const pages = space ? Math.ceil(space.tabs.length / 4) : 0;
			return renderSpaceButton({
				space,
				selected,
				frame,
				page: selected && pages > 1 ? { index: this.store.pageOf(space.key), count: pages } : undefined,
			});
		}
		const offset = selSpace && slot <= 4 ? this.store.pageOf(selSpace.key) * 4 : 0;
		const session = selSpace?.tabs[slot - 1 + offset];
		return renderTabButton({ session, selected: !!session && this.store.selectedTab(spaces)?.id === session.id, frame });
	}

	/** 全ボタン共有の 1 回分の描画。前回と同じ画像は送らない。送った数を返す。 */
	tick(): number {
		this.#ticks++;
		if (this.#ticks % HOUSEKEEPING_EVERY === 0) {
			this.store.expire(this.settings.ttlHours * 3_600_000);
			this.usage.prune(this.store.sessionIds());
		}
		this.#pollUsage();
		const frame = Math.floor(this.#now() / FRAME_MS) % 2;
		let sent = 0;
		for (const s of this.surfaces.values()) {
			const svg = this.renderSurface(s, frame);
			if (svg === s.last) continue;
			s.last = svg;
			sent++;
			s.push(svg).catch((e) => {
				s.last = undefined; // 失敗したら次回また送る
				this.log(`push failed: ${String(e)}`);
			});
		}
		return sent;
	}

	/** インフォバーがあるときだけ、選択中タブの使用量を(5 秒に 1 回まで)確認する。 */
	#pollUsage(): void {
		let hasBar = false;
		for (const s of this.surfaces.values()) if (s.kind === "infobar") hasBar = true;
		if (!hasBar) return;
		const tab = this.store.selectedTab();
		if (tab) void this.usage.request(tab);
	}

	startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => this.tick(), REDRAW_MS);
	}
	stopTimer(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	/** スペースボタン押下。空スロットなら false(警告表示)。 */
	pressSpace(s: Surface): boolean {
		const spaces = this.store.spaces();
		const space = spaces[resolveSlot(s.slot, s.column) - 1];
		if (!space) return false;
		this.store.pressSpace(space);
		return true;
	}

	/** タブボタン押下。Windows Terminal を前面にして該当タブへ。失敗なら false。 */
	async pressTab(s: Surface): Promise<boolean> {
		const spaces = this.store.spaces();
		const selSpace = this.store.selectedSpace(spaces);
		if (!selSpace) return false;
		const slot = resolveSlot(s.slot, s.column);
		const offset = slot <= 4 ? this.store.pageOf(selSpace.key) * 4 : 0;
		const session = selSpace.tabs[slot - 1 + offset];
		if (!session) return false;
		this.store.selectedTabId = session.id;
		const hint = session.hint || session.name || baseName(session.cwd);
		const r = await focusTab(hint, this.#runner);
		if (!r.ok) this.log(`focus failed: ${r.reason} ${r.detail ?? ""}`);
		return r.ok;
	}

	async shutdown(): Promise<void> {
		this.stopTimer();
		await this.server.stop();
	}
}
