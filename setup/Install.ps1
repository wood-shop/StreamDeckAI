#Requires -Version 5.1
<#
.SYNOPSIS
  StreamDeckAI を 1 アプリとしてインストールする (プラグイン + Selector + Updater)。
.DESCRIPTION
  - Elgato プラグイン: %APPDATA%\Elgato\StreamDeck\Plugins\jp.example.streamdeckai.sdPlugin\
    (bin/sdai-plugin.js / hooks/sdai-hook.ps1 — CFA 向け。plugin.js は使わない)
  - ツール類: %LOCALAPPDATA%\StreamDeckAI\ (書けない場合は Documents\StreamDeckAI)
  - ショートカットは「StreamDeckAI」1 本のみ (Selector 起動)。Updater はサイレント登録。
  - Claude / Codex の hook 設定は触らない。
.NOTES
  管理者権限不要。Stream Deck アプリ 7.6+ / Windows 10+。
#>
param(
  [switch]$NoShortcut,
  [switch]$NoUpdater,
  [switch]$SkipPlugin,
  [string]$HomeDirOverride = ""
)
$ErrorActionPreference = "Stop"
$Version = "0.3.0"
$PluginId = "jp.example.streamdeckai.sdPlugin"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "StreamDeckAI Setup $Version"
Write-Host "  source: $here"

function Test-WritableDir([string]$Dir) {
  try {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $probe = Join-Path $Dir (".sdai-write-" + [guid]::NewGuid().ToString("N"))
    [IO.File]::WriteAllText($probe, "ok")
    Remove-Item -Force $probe -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Resolve-HomeDir {
  if ($HomeDirOverride) {
    New-Item -ItemType Directory -Force -Path $HomeDirOverride | Out-Null
    return (Resolve-Path $HomeDirOverride).Path
  }
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "StreamDeckAI") }
  if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE "Documents\StreamDeckAI")
    $candidates += (Join-Path $env:USERPROFILE "StreamDeckAI")
  }
  foreach ($c in $candidates) {
    if (Test-WritableDir $c) {
      Write-Host "  home: $c"
      return $c
    }
    Write-Warning "書けません (CFA 等?): $c"
  }
  throw "StreamDeckAI 用フォルダを作成できません。-HomeDirOverride で書き込み可能なパスを指定してください。"
}

function Copy-Tree([string]$Src, [string]$Dst) {
  if (-not (Test-Path $Src)) { throw "見つかりません: $Src" }
  if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
  New-Item -ItemType Directory -Force -Path (Split-Path $Dst) | Out-Null
  Copy-Item -Recurse -Force $Src $Dst
}

function New-SdaiShortcut([string]$Name, [string]$TargetPs1, [string]$WorkDir, [string]$IconPath) {
  $ws = New-Object -ComObject WScript.Shell
  $made = @()
  $targets = @(
    [Environment]::GetFolderPath("Programs"),
    [Environment]::GetFolderPath("Desktop")
  ) | Where-Object { $_ }
  $args = "-NoProfile -ExecutionPolicy Bypass -File `"$TargetPs1`""
  foreach ($dir in $targets) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lnkPath = Join-Path $dir ($Name + ".lnk")
    $s = $ws.CreateShortcut($lnkPath)
    $s.TargetPath = "powershell.exe"
    $s.Arguments = $args
    $s.WorkingDirectory = $WorkDir
    $s.WindowStyle = 1
    $s.Description = "StreamDeckAI アプリセレクタ"
    if ($IconPath -and (Test-Path $IconPath)) { $s.IconLocation = "$IconPath,0" }
    $s.Save()
    $made += $lnkPath
    Write-Host "  shortcut: $lnkPath"
  }
  return $made
}

# --- paths ---
$HomeDir = Resolve-HomeDir
$SelectorDir = Join-Path $HomeDir "Selector"
$UpdaterDir  = Join-Path $HomeDir "Updater"
$ManagedPlugin = Join-Path $HomeDir "Plugins\$PluginId"
$ElgatoPlugin = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$PluginId"
$LogsDir = Join-Path $HomeDir "logs"

New-Item -ItemType Directory -Force -Path $HomeDir, $SelectorDir, $UpdaterDir, $LogsDir, (Split-Path $ManagedPlugin) | Out-Null

# --- locate payload ---
$pluginSrc = $null
foreach ($cand in @(
  (Join-Path $here "plugin\$PluginId"),
  (Join-Path $here $PluginId)
)) {
  if (Test-Path (Join-Path $cand "manifest.json")) { $pluginSrc = $cand; break }
}
if (-not $pluginSrc) { throw "プラグインフォルダ ($PluginId) がセットアップ内にありません。" }

$codePath = Join-Path $pluginSrc "bin\sdai-plugin.js"
if (-not (Test-Path $codePath)) {
  throw "bin\sdai-plugin.js がありません (CFA 対策の正式名)。plugin.js は使いません。"
}
$hookPath = Join-Path $pluginSrc "hooks\sdai-hook.ps1"
if (-not (Test-Path $hookPath)) {
  Write-Warning "hooks\sdai-hook.ps1 がありません。エージェント hook 設定時に必要です。"
}

$selectorSrc = $null
foreach ($cand in @(
  (Join-Path $here "tools\StreamDeckAI-Selector.ps1"),
  (Join-Path $here "tools\sdai-selector.ps1"),
  (Join-Path $here "StreamDeckAI-Selector.ps1")
)) { if (Test-Path $cand) { $selectorSrc = $cand; break } }
if (-not $selectorSrc) { throw "StreamDeckAI-Selector.ps1 が見つかりません。" }

$updaterSrc = $null
foreach ($cand in @(
  (Join-Path $here "tools\StreamDeckAI-Updater.ps1"),
  (Join-Path $here "tools\sdai-updater.ps1"),
  (Join-Path $here "StreamDeckAI-Updater.ps1")
)) { if (Test-Path $cand) { $updaterSrc = $cand; break } }
if (-not $updaterSrc) { throw "StreamDeckAI-Updater.ps1 が見つかりません。" }

$defaultsSrc = Join-Path $here "tools\Defaults\apps.json"
$configSample = Join-Path $here "tools\updater-config.sample.json"
$launcherSrc = Join-Path $here "StreamDeckAI.ps1"
$iconSrc = Join-Path $pluginSrc "imgs\plugin.ico"
if (-not (Test-Path $iconSrc)) { $iconSrc = Join-Path $pluginSrc "imgs\plugin.png" }

# --- install plugin ---
if (-not $SkipPlugin) {
  Write-Host "プラグインを配置..."
  try {
    Copy-Tree $pluginSrc $ManagedPlugin
    Write-Host "  managed: $ManagedPlugin"
  } catch {
    Write-Warning "管理用コピー失敗: $($_.Exception.Message)"
  }
  try {
    Copy-Tree $pluginSrc $ElgatoPlugin
    Write-Host "  elgato:  $ElgatoPlugin"
  } catch {
    Write-Warning @"
Elgato Plugins へのコピーが失敗しました (Controlled Folder Access の可能性)。
  対処:
    1. Windows セキュリティ → ランサムウェア防止 → 制御されたフォルダー アクセス
       で PowerShell / Stream Deck を許可する
    2. または Stream Deck を一度終了し、手動で次へコピー:
       $pluginSrc
       → $ElgatoPlugin
管理用コピー ($ManagedPlugin) は済んでいる場合があります。Updater は次回そこから同期を試みます。
"@
  }
}

# --- tools ---
Write-Host "Selector / Updater を配置..."
Copy-Item -Force $selectorSrc (Join-Path $SelectorDir "StreamDeckAI-Selector.ps1")
Copy-Item -Force $updaterSrc  (Join-Path $UpdaterDir  "StreamDeckAI-Updater.ps1")

# Launcher (単一の StreamDeckAI 起動口)
$launcherDst = Join-Path $HomeDir "StreamDeckAI.ps1"
if (Test-Path $launcherSrc) {
  Copy-Item -Force $launcherSrc $launcherDst
} else {
  # 同梱が無い場合は Selector を呼ぶ薄いラッパを書く
  $body = @"
#Requires -Version 5.1
`$ErrorActionPreference = 'Stop'
`$sel = Join-Path `$PSScriptRoot 'Selector\StreamDeckAI-Selector.ps1'
if (-not (Test-Path `$sel)) { throw "Selector が見つかりません: `$sel" }
& `$sel @args
"@
  [IO.File]::WriteAllText($launcherDst, $body, (New-Object Text.UTF8Encoding $true))
}
Write-Host "  launcher: $launcherDst"

# Defaults → apps.json (既存があれば上書きしない)
$appsPath = Join-Path $HomeDir "apps.json"
if (-not (Test-Path $appsPath) -and (Test-Path $defaultsSrc)) {
  Copy-Item -Force $defaultsSrc $appsPath
  Write-Host "  apps.json: Defaults を初回配置 (claude / codex / grok)"
} elseif (Test-Path $appsPath) {
  Write-Host "  apps.json: 既存を保持"
}

# updater-config (既存があれば保持)
$configPath = Join-Path $HomeDir "updater-config.json"
if (-not (Test-Path $configPath) -and (Test-Path $configSample)) {
  Copy-Item -Force $configSample $configPath
  Write-Host "  updater-config.json: sample を配置 (githubToken は必要なら追記)"
}

# アイコン (ショートカット用にコピー)
$iconDst = $null
if ($iconSrc -and (Test-Path $iconSrc)) {
  $iconDst = Join-Path $HomeDir ("StreamDeckAI" + [IO.Path]::GetExtension($iconSrc))
  Copy-Item -Force $iconSrc $iconDst
}

# install 記録 (検出・アンインストール用)
$record = [ordered]@{
  schema      = 1
  name        = "StreamDeckAI"
  version     = $Version
  installedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
  homeDir     = $HomeDir
  pluginId    = $PluginId
  elgatoPath  = $ElgatoPlugin
  managedPath = $ManagedPlugin
  launcher    = $launcherDst
}
$recordPath = Join-Path $HomeDir "install.json"
[IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

# Uninstall もホームへ
$unSrc = Join-Path $here "Uninstall.ps1"
if (Test-Path $unSrc) { Copy-Item -Force $unSrc (Join-Path $HomeDir "Uninstall.ps1") }

# --- single shortcut ---
if (-not $NoShortcut) {
  Write-Host "ショートカット「StreamDeckAI」を作成 (Selector)..."
  [void](New-SdaiShortcut -Name "StreamDeckAI" -TargetPs1 $launcherDst -WorkDir $HomeDir -IconPath $iconDst)
}

# --- updater silent register ---
if (-not $NoUpdater) {
  Write-Host "Updater をサイレント登録 (Startup / Run)..."
  $upd = Join-Path $UpdaterDir "StreamDeckAI-Updater.ps1"
  try {
    & $upd -InstallRunKey
    Write-Host "  Run キー + Startup bat 登録 OK"
  } catch {
    Write-Warning @"
Updater の自動起動登録に失敗しました: $($_.Exception.Message)
  手動: 次を実行
    powershell -NoProfile -ExecutionPolicy Bypass -File `"$upd`" -InstallRunKey
  または タスク スケジューラ / スタートアップに追加してください。
"@
  }
  try {
    & $upd -Once
  } catch {
    Write-Warning "初回アップデートチェック失敗 (続行): $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "インストール完了: StreamDeckAI $Version"
Write-Host "  ホーム:     $HomeDir"
Write-Host "  起動:       スタートメニュー / デスクトップの「StreamDeckAI」"
Write-Host "  アンインストール: $HomeDir\Uninstall.ps1"
Write-Host "  注意: Claude/Codex の hook 設定は変更していません。"
Write-Host "  Stream Deck アプリを再起動するとプラグインが読み込まれます。"
