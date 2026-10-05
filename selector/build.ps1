#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "..\dist\Selector"
dotnet publish (Join-Path $here "StreamDeckAI.Selector.csproj") -c Release -r win-x64 --self-contained false -o $out
Copy-Item -Recurse -Force (Join-Path $here "Defaults") (Join-Path $out "Defaults")
$dest = Join-Path $env:LOCALAPPDATA "StreamDeckAI\Selector"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force "$out\*" $dest
Write-Host "ビルド完了: $out"
Write-Host "配置: $dest"
Write-Host "起動: $dest\StreamDeckAI.Selector.exe"
