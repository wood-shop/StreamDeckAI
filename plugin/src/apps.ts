import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, type AgentKind } from "./types";

export const APPS_SCHEMA = 1 as const;
export const DEFAULT_ENABLED_IDS = ["claude-code", "codex", "grok-bot"] as const;

export type AppStatus = "developing" | "released";

export interface StreamDeckMeta {
	agent: AgentKind;
	enabledDefault?: boolean;
}

export interface CatalogApp {
	id: string;
	name: string;
	category?: string;
	status?: AppStatus;
	enabled: boolean;
	streamdeck?: StreamDeckMeta;
}

export interface AppsFile {
	schema: typeof APPS_SCHEMA;
	updatedAt?: string;
	source?: string;
	apps: CatalogApp[];
}

export const DEFAULT_APPS: CatalogApp[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		category: "agent",
		status: "developing",
		enabled: true,
		streamdeck: { agent: "claude", enabledDefault: true },
	},
	{
		id: "codex",
		name: "Codex CLI",
		category: "agent",
		status: "developing",
		enabled: true,
		streamdeck: { agent: "codex", enabledDefault: true },
	},
	{
		id: "grok-bot",
		name: "Grok Bot",
		category: "agent",
		status: "developing",
		enabled: true,
		streamdeck: { agent: "grok", enabledDefault: true },
	},
];

export function defaultAppsFile(now = new Date()): AppsFile {
	return {
		schema: APPS_SCHEMA,
		updatedAt: now.toISOString(),
		source: "defaults",
		apps: DEFAULT_APPS.map((a) => ({ ...a, streamdeck: a.streamdeck ? { ...a.streamdeck } : undefined })),
	};
}

/** %LOCALAPPDATA%\StreamDeckAI\apps.json (非 Windows では ~/.local/share/StreamDeckAI/apps.json) */
export function defaultAppsPath(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(local, "StreamDeckAI", "apps.json");
	}
	const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(xdg, "StreamDeckAI", "apps.json");
}

function str(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
	return t ? t.slice(0, max) : undefined;
}

export type ParseAppsResult = { ok: true; apps: AppsFile } | { ok: false; error: string };

/** POST /apps や apps.json の JSON を検証。短縮形 { enabled: string[] } も受け付ける。 */
export function parseAppsPayload(raw: unknown, fallback = defaultAppsFile()): ParseAppsResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
	const o = raw as Record<string, unknown>;

	// 短縮形: { enabled: ["claude-code", ...] } — fallback の一覧に対して enabled だけ更新
	if (Array.isArray(o.enabled) && !Array.isArray(o.apps)) {
		const ids = new Set<string>();
		for (const x of o.enabled) {
			const id = str(x, 80)?.toLowerCase();
			if (!id) return { ok: false, error: "enabled entries must be non-empty strings" };
			ids.add(id);
		}
		const apps = fallback.apps.map((a) => ({
			...a,
			enabled: ids.has(a.id.toLowerCase()),
			streamdeck: a.streamdeck ? { ...a.streamdeck } : undefined,
		}));
		// enabled にだけ含まれて fallback に無い id は無視 (未知アプリはフル形で送る)
		return {
			ok: true,
			apps: {
				schema: APPS_SCHEMA,
				updatedAt: new Date().toISOString(),
				source: str(o.source, 80) ?? fallback.source ?? "post-enabled",
				apps,
			},
		};
	}

	if (!Array.isArray(o.apps)) return { ok: false, error: "apps must be an array" };
	const apps: CatalogApp[] = [];
	const seen = new Set<string>();
	for (const item of o.apps) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, error: "each app must be an object" };
		const a = item as Record<string, unknown>;
		const id = str(a.id, 80)?.toLowerCase();
		if (!id) return { ok: false, error: "app.id is required" };
		if (seen.has(id)) return { ok: false, error: `duplicate app id: ${id}` };
		seen.add(id);
		const name = str(a.name, 120) ?? id;
		const category = str(a.category, 80);
		const statusRaw = str(a.status, 20)?.toLowerCase();
		const status: AppStatus | undefined =
			statusRaw === "developing" || statusRaw === "released" ? statusRaw : undefined;
		const enabled = typeof a.enabled === "boolean" ? a.enabled : a.enabled === "true";
		let streamdeck: StreamDeckMeta | undefined;
		if (typeof a.streamdeck === "object" && a.streamdeck !== null && !Array.isArray(a.streamdeck)) {
			const sd = a.streamdeck as Record<string, unknown>;
			const agent = str(sd.agent, 20)?.toLowerCase();
			if (!agent || !(AGENTS as readonly string[]).includes(agent)) {
				return { ok: false, error: `streamdeck.agent must be one of ${AGENTS.join("|")}` };
			}
			streamdeck = {
				agent: agent as AgentKind,
				enabledDefault: typeof sd.enabledDefault === "boolean" ? sd.enabledDefault : undefined,
			};
		}
		const entry: CatalogApp = { id, name, enabled: !!enabled };
		if (category) entry.category = category;
		if (status) entry.status = status;
		if (streamdeck) entry.streamdeck = streamdeck;
		apps.push(entry);
	}
	return {
		ok: true,
		apps: {
			schema: APPS_SCHEMA,
			updatedAt: str(o.updatedAt, 40) ?? new Date().toISOString(),
			source: str(o.source, 80) ?? "post",
			apps,
		},
	};
}

export function enabledAgents(file: AppsFile): Set<AgentKind> {
	const set = new Set<AgentKind>();
	for (const a of file.apps) {
		if (a.enabled && a.streamdeck?.agent) set.add(a.streamdeck.agent);
	}
	return set;
}

export function enabledAppIds(file: AppsFile): string[] {
	return file.apps.filter((a) => a.enabled).map((a) => a.id);
}

export function readAppsFile(filePath: string): AppsFile {
	try {
		const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
		const parsed = parseAppsPayload(JSON.parse(text));
		if (parsed.ok) return parsed.apps;
	} catch {
		// 無いか壊れていれば Defaults
	}
	return defaultAppsFile();
}

export function writeAppsFile(filePath: string, file: AppsFile): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const out: AppsFile = { ...file, schema: APPS_SCHEMA, updatedAt: file.updatedAt ?? new Date().toISOString() };
	fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** カタログ(AppCatalog manifest 相当)とローカルをマージ。streamdeck が無いエントリは捨てる。 */
export function mergeCatalogIntoLocal(local: AppsFile, catalogEntries: unknown[]): AppsFile {
	const byId = new Map(local.apps.map((a) => [a.id.toLowerCase(), { ...a, streamdeck: a.streamdeck ? { ...a.streamdeck } : undefined }]));
	for (const raw of catalogEntries) {
		if (typeof raw !== "object" || raw === null) continue;
		const o = raw as Record<string, unknown>;
		const sdRaw = o.streamdeck;
		if (typeof sdRaw !== "object" || sdRaw === null || Array.isArray(sdRaw)) continue;
		const agent = str((sdRaw as Record<string, unknown>).agent, 20)?.toLowerCase();
		if (!agent || !(AGENTS as readonly string[]).includes(agent)) continue;
		const id = (str(o.id, 80) ?? str(o.name, 80) ?? "").toLowerCase().replace(/\s+/g, "-");
		if (!id) continue;
		const enabledDefault = typeof (sdRaw as Record<string, unknown>).enabledDefault === "boolean"
			? !!(sdRaw as Record<string, unknown>).enabledDefault
			: false;
		const existing = byId.get(id);
		const statusRaw = str(o.status, 20)?.toLowerCase();
		const status: AppStatus | undefined =
			statusRaw === "developing" || statusRaw === "released" ? statusRaw : existing?.status;
		byId.set(id, {
			id,
			name: str(o.name, 120) ?? existing?.name ?? id,
			category: str(o.category, 80) ?? existing?.category,
			status,
			enabled: existing ? existing.enabled : enabledDefault,
			streamdeck: {
				agent: agent as AgentKind,
				enabledDefault,
			},
		});
	}
	return {
		schema: APPS_SCHEMA,
		updatedAt: new Date().toISOString(),
		source: "local+catalog",
		apps: [...byId.values()],
	};
}
