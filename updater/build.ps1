#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "..\dist\Updater"
dotnet publish (Join-Path $here "StreamDeckAI.Updater.csproj") -c Release -r win-x64 --self-contained false -o $out
Copy-Item -Force (Join-Path $here "StreamDeckAI-Updater.ps1") $out
Copy-Item -Force (Join-Path $here "Install-Updater.ps1") $out
Copy-Item -Force (Join-Path $here "updater-config.sample.json") $out
Write-Host "ビルド完了: $out"
