#Requires -Version 5.1
<#
.SYNOPSIS
  StreamDeckAI ランチャー (Selector を起動)。ストア / デスクトップの単一エントリポイント。
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# セットアップ展開直下から起動された場合は、インストール先を優先
$candidates = @(
  (Join-Path $env:LOCALAPPDATA "StreamDeckAI\Selector\StreamDeckAI-Selector.ps1"),
  (Join-Path $env:USERPROFILE "Documents\StreamDeckAI\Selector\StreamDeckAI-Selector.ps1"),
  (Join-Path $root "Selector\StreamDeckAI-Selector.ps1"),
  (Join-Path $root "tools\StreamDeckAI-Selector.ps1")
)
$sel = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sel) {
  [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
  [System.Windows.Forms.MessageBox]::Show(
    "StreamDeckAI Selector が見つかりません。Install.ps1 を実行してください。",
    "StreamDeckAI", "OK", "Warning") | Out-Null
  throw "Selector が見つかりません"
}
& $sel @args
