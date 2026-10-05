#Requires -Version 5.1
<#
.SYNOPSIS
  StreamDeckAI Updater を %LOCALAPPDATA%\StreamDeckAI\ へ配置し、ログオン時起動を登録する。
#>
$ErrorActionPreference = "Stop"
$HomeDir = Join-Path $env:LOCALAPPDATA "StreamDeckAI"
$Dest = Join-Path $HomeDir "Updater"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -Force (Join-Path $here "StreamDeckAI-Updater.ps1") (Join-Path $Dest "StreamDeckAI-Updater.ps1")
if (Test-Path (Join-Path $here "updater-config.json")) {
  Copy-Item -Force (Join-Path $here "updater-config.json") (Join-Path $HomeDir "updater-config.json")
} elseif (-not (Test-Path (Join-Path $HomeDir "updater-config.json"))) {
  Copy-Item -Force (Join-Path $here "updater-config.sample.json") (Join-Path $HomeDir "updater-config.json")
}
& (Join-Path $Dest "StreamDeckAI-Updater.ps1") -InstallRunKey
& (Join-Path $Dest "StreamDeckAI-Updater.ps1") -Once
Write-Host "インストール完了: $Dest"
Write-Host "ログ: $(Join-Path $HomeDir 'logs')"
