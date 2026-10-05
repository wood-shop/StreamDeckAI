export const AGENTS = ["claude", "codex", "grok"] as const;
export type AgentKind = (typeof AGENTS)[number];

/** イベントで受け取れる状態。 */
export const EVENT_STATUSES = ["working", "blocked", "done", "idle"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** 表示用の状態("none" = エージェントなし)。 */
export type DisplayStatus = EventStatus | "none";

/** POST /event の本文。 */
export interface AgentEvent {
	session_id: string;
	agent: AgentKind;
	status: EventStatus;
	name?: string;
	cwd?: string;
	/** Windows Terminal のタブ見出しに含まれる文字列(部分一致)。 */
	wt_window_hint?: string;
	/** 任意。確認待ちの内容(読み上げに使う)。 */
	message?: string;
	/** 任意。スペース名を明示したいとき(省略時は cwd の最後のフォルダ名)。 */
	space?: string;
	/** 任意(v0.2)。Claude のセッション記録(JSONL)のパス。使用率の取得に使う。 */
	transcript_path?: string;
	/** 任意(v0.2)。直近のアシスタント発言の全文(Claude Stop hook の last_assistant_message / Codex の last-assistant-message)。要約読み上げに使う。 */
	last_assistant_message?: string;
}

export interface Session {
	id: string;
	agent: AgentKind;
	status: EventStatus;
	name: string;
	cwd: string;
	hint: string;
	message: string;
	spaceKey: string;
	spaceName: string;
	firstSeen: number;
	updatedAt: number;
	/** v0.2: セッション記録(JSONL)のパス(hook が教えてくれた場合) */
	transcriptPath?: string;
	/** v0.2: 直近のイベントが運んできたアシスタント発言(状態が変わるたびに入れ替わる) */
	lastAssistantMessage?: string;
}

export interface Space {
	key: string;
	name: string;
	status: DisplayStatus;
	tabs: Session[];
}

/** 読み上げスタイル: 要約あり / 定型文のみ / 効果音のみ */
export const NARRATION_STYLES = ["summary", "template", "sound"] as const;
export type NarrationStyle = (typeof NARRATION_STYLES)[number];
export const NARRATION_STYLE_LABEL: Record<NarrationStyle, string> = {
	summary: "要約あり",
	template: "定型文のみ",
	sound: "効果音のみ",
};

export interface GlobalSettings {
	port: number;
	narration: boolean;
	/** 空なら ja-JP の音声を自動選択。 */
	voiceName: string;
	/** -10(遅い)〜10(速い) */
	rate: number;
	/** 確認待ち/完了のイベントに message があれば読み上げに含める。 */
	includeMessage: boolean;
	/** 空なら %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe */
	powershellPath: string;
	/** この時間(時間)更新が無いセッションは消す。 */
	ttlHours: number;
	/** v0.2: 読み上げスタイル */
	narrationStyle: NarrationStyle;
	/** v0.2: コンテキストウィンドウ(トークン)。使用率の分母。 */
	contextWindow: number;
	[key: string]: string | number | boolean;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	port: 17890,
	narration: true,
	voiceName: "",
	rate: 1,
	includeMessage: true,
	powershellPath: "",
	ttlHours: 12,
	narrationStyle: "summary",
	contextWindow: 200_000,
};

export const AGENT_LABEL: Record<AgentKind, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
};
