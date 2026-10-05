import { spawn } from "node:child_process";
import path from "node:path";

export interface PsResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type PsRunner = (script: string, env: Record<string, string>, timeoutMs: number) => Promise<PsResult>;

/** Stream Deck から起動されたプロセスは PATH を持たないので、絶対パスで呼ぶ。 */
export function resolvePowerShell(override: string, env: NodeJS.ProcessEnv = process.env): string {
	if (override.trim()) return override.trim();
	const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
	return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function encodeCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** PowerShell でスクリプトを実行する。値は環境変数で渡し、スクリプトに文字列連結しない(インジェクション対策)。 */
export function makeRunner(exe: string): PsRunner {
	return (script, env, timeoutMs) =>
		new Promise<PsResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let done = false;
			const finish = (r: PsResult) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(r);
				}
			};
			const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand(script)], {
				env: { ...process.env, ...env },
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const timer = setTimeout(() => {
				child.kill();
				finish({ code: 124, stdout, stderr: `${stderr}\ntimeout` });
			}, timeoutMs);
			child.stdout.on("data", (d) => (stdout += String(d)));
			child.stderr.on("data", (d) => (stderr += String(d)));
			child.on("error", (e) => finish({ code: 127, stdout, stderr: String(e) }));
			child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
		});
}
