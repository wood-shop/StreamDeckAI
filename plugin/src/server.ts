import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseEvent } from "./state";
import type { AgentEvent } from "./types";
import type { AppsFile } from "./apps";

export const MAX_BODY = 64 * 1024;

export interface EventServerOptions {
	onEvent: (ev: AgentEvent) => { ignored?: boolean } | void;
	sessionCount?: () => number;
	log?: (msg: string) => void;
	/** GET /apps */
	getApps?: () => AppsFile;
	/** POST /apps — 検証済み本文を受け取り反映。失敗時は error を返す。 */
	setApps?: (raw: unknown) => { ok: true; apps: AppsFile } | { ok: false; error: string };
	/** GET /version */
	getVersion?: () => { version: string; plugin: string; port: number };
}

/**
 * 127.0.0.1 だけで待ち受ける小さな HTTP サーバー。
 *  POST /event  {session_id, agent, status, ...}
 *  GET  /health
 *  GET  /version
 *  GET|POST /apps
 * ブラウザ経由の送信(CSRF)を避けるため Content-Type: application/json を必須にし、
 * Host ヘッダが localhost/127.0.0.1 以外なら拒否する(DNS rebinding 対策)。
 */
export class EventServer {
	#server: http.Server | null = null;
	#opts: EventServerOptions;
	port = 0;
	lastError = "";

	constructor(opts: EventServerOptions) {
		this.#opts = opts;
	}

	get listening(): boolean {
		return this.#server?.listening ?? false;
	}

	address(): AddressInfo | null {
		const a = this.#server?.address();
		return a && typeof a === "object" ? a : null;
	}

	async start(port: number): Promise<number> {
		await this.stop();
		const server = http.createServer((req, res) => this.#handle(req, res));
		this.lastError = "";
		await new Promise<void>((resolve, reject) => {
			server.once("error", (e: NodeJS.ErrnoException) => {
				this.lastError = e.code === "EADDRINUSE" ? `ポート ${port} は使用中です` : String(e.message);
				this.#opts.log?.(`server error: ${e.message}`);
				reject(e);
			});
			server.listen(port, "127.0.0.1", () => resolve());
		});
		this.#server = server;
		this.port = (server.address() as AddressInfo).port;
		this.#opts.log?.(`listening on 127.0.0.1:${this.port}`);
		return this.port;
	}

	async stop(): Promise<void> {
		const s = this.#server;
		this.#server = null;
		if (!s) return;
		s.closeAllConnections?.();
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}

	#send(res: http.ServerResponse, code: number, body: unknown): void {
		const text = JSON.stringify(body);
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
		res.end(text);
	}

	#readJson(req: http.IncomingMessage, res: http.ServerResponse, then: (json: unknown) => void): void {
		if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
			return this.#send(res, 415, { ok: false, error: "Content-Type must be application/json" });
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		req.on("data", (c: Buffer) => {
			if (aborted) return;
			size += c.length;
			if (size > MAX_BODY) {
				aborted = true;
				this.#send(res, 413, { ok: false, error: "body too large" });
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (aborted) return;
			let json: unknown;
			try {
				json = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
			} catch {
				return this.#send(res, 400, { ok: false, error: "invalid JSON" });
			}
			then(json);
		});
		req.on("error", () => undefined);
	}

	#handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return this.#send(res, 403, { ok: false, error: "bad host" });
		const url = (req.url ?? "").split("?")[0];

		if (req.method === "GET" && url === "/health") {
			return this.#send(res, 200, { ok: true, sessions: this.#opts.sessionCount?.() ?? 0 });
		}
		if (req.method === "GET" && url === "/version") {
			const v = this.#opts.getVersion?.() ?? { version: "0.0.0.0", plugin: "jp.example.streamdeckai", port: this.port };
			return this.#send(res, 200, { ok: true, ...v });
		}
		if (url === "/apps") {
			if (req.method === "GET") {
				const apps = this.#opts.getApps?.();
				if (!apps) return this.#send(res, 500, { ok: false, error: "apps not configured" });
				return this.#send(res, 200, { ok: true, apps });
			}
			if (req.method === "POST") {
				return this.#readJson(req, res, (json) => {
					if (!this.#opts.setApps) return this.#send(res, 500, { ok: false, error: "apps not configured" });
					try {
						const r = this.#opts.setApps(json);
						if (!r.ok) return this.#send(res, 400, { ok: false, error: r.error });
						return this.#send(res, 200, { ok: true, apps: r.apps });
					} catch (e) {
						this.#opts.log?.(`setApps failed: ${String(e)}`);
						return this.#send(res, 500, { ok: false, error: "internal error" });
					}
				});
			}
			return this.#send(res, 405, { ok: false, error: "use GET or POST" });
		}

		if (url !== "/event") return this.#send(res, 404, { ok: false, error: "not found" });
		if (req.method !== "POST") return this.#send(res, 405, { ok: false, error: "use POST" });
		this.#readJson(req, res, (json) => {
			const parsed = parseEvent(json);
			if (!parsed.ok) return this.#send(res, 400, { ok: false, error: parsed.error });
			try {
				const result = this.#opts.onEvent(parsed.event);
				if (result && typeof result === "object" && result.ignored) {
					return this.#send(res, 200, { ok: true, ignored: true });
				}
			} catch (e) {
				this.#opts.log?.(`onEvent failed: ${String(e)}`);
				return this.#send(res, 500, { ok: false, error: "internal error" });
			}
			this.#send(res, 200, { ok: true });
		});
	}
}
