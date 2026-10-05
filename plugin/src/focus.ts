import type { PsRunner } from "./powershell";

/**
 * Windows Terminal のタブを UI Automation で探して選択し、ウィンドウを前面に出す。
 * 終了コード: 0=成功 / 2=ウィンドウは前面化したがタブ見出しが見つからない / 3=Windows Terminal が無い
 * ヒントは環境変数 SDAI_HINT で渡す(スクリプトに文字列連結しない)。
 */
export const FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SdaiNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$hint = $env:SDAI_HINT
$winCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$wins = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
if ($wins.Count -eq 0) { exit 3 }
$tabCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$targetWin = $null
$targetTab = $null
if ($hint) {
  foreach ($w in $wins) {
    foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
      if ($t.Current.Name.IndexOf($hint, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $targetWin = $w; $targetTab = $t; break }
    }
    if ($targetTab) { break }
  }
}
if (-not $targetWin) { $targetWin = $wins[0] }
if ($targetTab) {
  $pat = $targetTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $pat.Select()
}
$h = [IntPtr]$targetWin.Current.NativeWindowHandle
if ([SdaiNative]::IsIconic($h)) { [void][SdaiNative]::ShowWindow($h, 9) }
# 前面化の制限を避けるため Alt キーを一度押す
[SdaiNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[SdaiNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][SdaiNative]::SetForegroundWindow($h)
if ($hint -and -not $targetTab) { exit 2 }
exit 0
`;

export interface FocusResult {
	ok: boolean;
	reason: "ok" | "tab-not-found" | "no-terminal" | "error";
	detail?: string;
}

export async function focusTab(hint: string, run: PsRunner): Promise<FocusResult> {
	const r = await run(FOCUS_SCRIPT, { SDAI_HINT: hint }, 10_000);
	switch (r.code) {
		case 0:
			return { ok: true, reason: "ok" };
		case 2:
			return { ok: false, reason: "tab-not-found", detail: `Windows Terminal のタブ見出しに「${hint}」が見つかりません(ウィンドウのみ前面化)` };
		case 3:
			return { ok: false, reason: "no-terminal", detail: "Windows Terminal のウィンドウが見つかりません" };
		default:
			return { ok: false, reason: "error", detail: r.stderr.trim().slice(0, 300) || `exit ${r.code}` };
	}
}
