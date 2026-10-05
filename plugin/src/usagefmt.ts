/** 使用率の表示に使う純粋関数(ファイルを読まない。svg.ts からも使う)。 */

export type UsageInfo =
	| { state: "ok"; tokens: number; model?: string }
	| { state: "unavailable"; reason: string }
	| { state: "pending" };

export interface UsageLevel {
	/** 使用率(%)。100 を超えることもある(分母の設定が小さすぎるとき)。 */
	pct: number;
	color: "mint" | "yellow" | "red";
}

/** 70% まで ミント / 90% まで 黄 / それ以上 赤 */
export function usageLevel(tokens: number, contextWindow: number): UsageLevel {
	const pct = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
	return { pct, color: pct <= 70 ? "mint" : pct <= 90 ? "yellow" : "red" };
}

/** 86400 → "86k"、1000000 → "1M"、1500000 → "1.5M" */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(Math.round(n));
}
