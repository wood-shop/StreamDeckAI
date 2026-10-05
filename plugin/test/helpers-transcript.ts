import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 偽の Claude 設定フォルダ(~/.claude 相当)を一時ディレクトリに作る。 */
export function makeClaudeDir(): { dir: string; projects: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdai-"));
	const dir = path.join(root, ".claude");
	const projects = path.join(dir, "projects");
	fs.mkdirSync(projects, { recursive: true });
	return { dir, projects, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export const usage = (input: number, cacheRead = 0, cacheCreate = 0, output = 0) => ({
	input_tokens: input,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheCreate,
	output_tokens: output,
});

export function assistantLine(o: { text?: string; usage?: object; id?: string; model?: string; sidechain?: boolean; tool?: boolean } = {}): string {
	const content: object[] = [];
	if (o.text !== undefined) content.push({ type: "text", text: o.text });
	if (o.tool) content.push({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } });
	return JSON.stringify({
		type: "assistant",
		isSidechain: o.sidechain ?? false,
		message: { id: o.id ?? "msg_x", role: "assistant", model: o.model ?? "claude-sonnet-4-5", content, ...(o.usage ? { usage: o.usage } : {}) },
	});
}
export const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
export const toolResultLine = () => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
