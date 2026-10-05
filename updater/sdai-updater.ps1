#Requires -Version 5.1
<#
.SYNOPSIS
  StreamDeckAI 自動アップデータ (確認ダイアログなし)。
.DESCRIPTION
  起動時と 6 時間ごとに GitHub Releases または version.json URL を確認し、
  新しければ zip を入れて StreamDeck を再起動する。.NET 無しでも動くフォールバック。
.PARAMETER Once
  1 回だけチェックして終了。
.PARAMETER Daemon
  常駐して IntervalHours ごとにチェック (既定)。
.PARAMETER InstallRunKey
  HKCU Run に自分を登録して終了。
.PARAMETER ConfigPath
  updater-config.json のパス。
#>
[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Daemon,
  [switch]$InstallRunKey,
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$PluginId = "jp.example.streamdeckai.sdPlugin"
$HomeDir = Join-Path $env:LOCALAPPDATA "StreamDeckAI"
$PluginManaged = Join-Path $HomeDir "Plugins\$PluginId"
$PluginElgato = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$PluginId"
$LogDir = Join-Path $HomeDir "logs"
$CacheDir = Join-Path $HomeDir "cache"
$BackupRoot = Join-Path $HomeDir "backup"
if (-not $ConfigPath) { $ConfigPath = Join-Path $HomeDir "updater-config.json" }

function Write-Log([string]$Message, [string]$Level = "INFO") {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $line = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Level, $Message
  $file = Join-Path $LogDir ("updater-{0:yyyyMMdd}.log" -f (Get-Date))
  Add-Content -Path $file -Value $line -Encoding UTF8
  Write-Host $line
}

function Show-Toast([string]$Title, [string]$Body) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Error
    $n.Visible = $true
    $n.BalloonTipTitle = $Title
    $n.BalloonTipText = $Body
    $n.ShowBalloonTip(5000)
    Start-Sleep -Seconds 6
    $n.Dispose()
  } catch {
    Write-Log "toast failed: $($_.Exception.Message)" "WARN"
  }
}

function Get-DefaultConfig {
  [pscustomobject]@{
    schema = 1
    githubOwner = "wood-shop"
    githubRepo = "StreamDeckAI"
    githubToken = ""
    versionJsonUrl = ""
    checkIntervalHours = 6
    assetNamePrefix = "streamdeckai-"
    toastOnError = $true
  }
}

function Read-Config {
  if (Test-Path $ConfigPath) {
    try { return Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Write-Log "config read failed, using defaults: $($_.Exception.Message)" "WARN" }
  }
  $c = Get-DefaultConfig
  New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
  ($c | ConvertTo-Json -Depth 5) | Set-Content -Path $ConfigPath -Encoding UTF8
  return $c
}

function Convert-Version([string]$v) {
  $parts = ($v -replace '^v', '') -split '\.'
  while ($parts.Count -lt 4) { $parts += "0" }
  return [version]::new([int]$parts[0], [int]$parts[1], [int]$parts[2], [int]$parts[3])
}

function Get-InstalledVersion {
  foreach ($p in @($PluginManaged, $PluginElgato)) {
    $m = Join-Path $p "manifest.json"
    if (Test-Path $m) {
      $j = Get-Content $m -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.Version) { return [string]$j.Version }
    }
  }
  return "0.0.0.0"
}


function Select-PluginZipAsset {
  param(
    [Parameter(Mandatory=$true)]$Assets,
    [Parameter(Mandatory=$true)][string]$Prefix
  )
  # Prefer plugin zip (streamdeckai-vX.Y[.Z].zip); never pick *-tools.zip.
  # GitHub lists assets alphabetically, so streamdeckai-v0.3-tools.zip would
  # otherwise win over streamdeckai-v0.3.zip with a naive First match.
  $candidates = @(
    $Assets | Where-Object {
      $n = [string]$_.name
      $n -and ($n -like "$Prefix*.zip") -and ($n -notmatch '(?i)-tools')
    }
  )
  if ($candidates.Count -eq 0) { return $null }
  $exact = @(
    $candidates | Where-Object {
      [string]$_.name -match ('(?i)^' + [regex]::Escape($Prefix) + 'v?\d+(\.\d+)*\.zip$')
    }
  )
  if ($exact.Count -gt 0) { return $exact[0] }
  return $candidates[0]
}

function Get-RemoteInfo($Config) {
  if ($Config.versionJsonUrl) {
    Write-Log "fetch version.json: $($Config.versionJsonUrl)"
    $json = Invoke-RestMethod -Uri $Config.versionJsonUrl -Headers @{ "User-Agent" = "StreamDeckAI-Updater" }
    return [pscustomobject]@{
      Version = [string]$json.version
      ZipUrl  = [string]$json.zipUrl
      Sha256  = [string]$json.sha256
      Notes   = [string]$json.notes
      Source  = "versionJson"
    }
  }
  $api = "https://api.github.com/repos/$($Config.githubOwner)/$($Config.githubRepo)/releases/latest"
  Write-Log "fetch GitHub release: $api"
  $headers = @{ "User-Agent" = "StreamDeckAI-Updater"; "Accept" = "application/vnd.github+json" }
  $token = [string]$Config.githubToken
  if (-not $token -and $env:STREAMDECKAI_GITHUB_TOKEN) { $token = $env:STREAMDECKAI_GITHUB_TOKEN }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  $rel = Invoke-RestMethod -Uri $api -Headers $headers
  $tag = [string]$rel.tag_name
  $ver = ($tag -replace '^v', '')
  if ($ver -notmatch '\.\d+\.\d+\.\d+$' -and $ver -match '^\d+\.\d+\.\d+$') { $ver = "$ver.0" }
  elseif ($ver -match '^\d+\.\d+$') { $ver = "$ver.0.0" }
  $prefix = [string]$Config.assetNamePrefix
  $asset = Select-PluginZipAsset -Assets @($rel.assets) -Prefix $prefix
  if (-not $asset) { throw "Release に ${prefix}*.zip (非 tools) がありません" }
  return [pscustomobject]@{
    Version = $ver
    ZipUrl  = [string]$asset.browser_download_url
    Sha256  = ""
    Notes   = [string]$rel.body
    Source  = "github"
  }
}

function Stop-StreamDeck {
  $procs = Get-Process -Name "StreamDeck" -ErrorAction SilentlyContinue
  if (-not $procs) { return }
  Write-Log "stopping StreamDeck.exe (n=$($procs.Count))"
  $procs | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
  Start-Sleep -Seconds 3
  Get-Process -Name "StreamDeck" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "force kill pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

function Start-StreamDeck {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Elgato\StreamDeck\StreamDeck.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Elgato\StreamDeck\StreamDeck.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) {
      Write-Log "starting $c"
      Start-Process -FilePath $c | Out-Null
      return
    }
  }
  Write-Log "StreamDeck.exe が見つかりません" "WARN"
}

function Copy-PluginTree([string]$Src, [string]$Dst) {
  if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
  New-Item -ItemType Directory -Force -Path (Split-Path $Dst) | Out-Null
  Copy-Item -Recurse -Force $Src $Dst
}

function Invoke-Update($Config) {
  New-Item -ItemType Directory -Force -Path $HomeDir, $CacheDir, $BackupRoot, (Split-Path $PluginManaged) | Out-Null
  $installed = Get-InstalledVersion
  Write-Log "installed=$installed"
  $remote = Get-RemoteInfo $Config
  Write-Log "remote=$($remote.Version) source=$($remote.Source) url=$($remote.ZipUrl)"
  if ((Convert-Version $remote.Version) -le (Convert-Version $installed)) {
    Write-Log "up to date"
    return
  }
  Write-Log "updating $installed -> $($remote.Version) (no confirmation)"
  $zipPath = Join-Path $CacheDir ("streamdeckai-{0}.zip" -f $remote.Version)
  $dlHeaders = @{ "User-Agent" = "StreamDeckAI-Updater" }
  $token = [string]$Config.githubToken
  if (-not $token -and $env:STREAMDECKAI_GITHUB_TOKEN) { $token = $env:STREAMDECKAI_GITHUB_TOKEN }
  if ($token) { $dlHeaders["Authorization"] = "Bearer $token"; $dlHeaders["Accept"] = "application/octet-stream" }
  Invoke-WebRequest -Uri $remote.ZipUrl -OutFile $zipPath -Headers $dlHeaders
  if ($remote.Sha256) {
    $hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $remote.Sha256.ToLowerInvariant()) { throw "SHA-256 mismatch: got $hash" }
  }
  $extract = Join-Path $CacheDir ("extract-{0}" -f ([guid]::NewGuid().ToString("N")))
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $srcPlugin = Get-ChildItem -Path $extract -Recurse -Directory -Filter $PluginId | Select-Object -First 1
  if (-not $srcPlugin) { throw "zip 内に $PluginId がありません" }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backup = Join-Path $BackupRoot $stamp
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($p in @($PluginManaged, $PluginElgato)) {
    if (Test-Path $p) {
      $name = Split-Path $p -Leaf
      Copy-Item -Recurse -Force $p (Join-Path $backup $name)
    }
  }

  try {
    Stop-StreamDeck
    Copy-PluginTree $srcPlugin.FullName $PluginManaged
    Copy-PluginTree $srcPlugin.FullName $PluginElgato
    Start-StreamDeck
    Write-Log "update OK -> $($remote.Version)"
  }
  catch {
    Write-Log "update failed, restoring backup: $($_.Exception.Message)" "ERROR"
    $bManaged = Join-Path $backup $PluginId
    if (Test-Path $bManaged) {
      try { Copy-PluginTree $bManaged $PluginManaged } catch {}
      try { Copy-PluginTree $bManaged $PluginElgato } catch {}
    }
    try { Start-StreamDeck } catch {}
    if ($Config.toastOnError) { Show-Toast "StreamDeckAI update failed" $_.Exception.Message }
    throw
  }
  finally {
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue }
  }
}

function Install-RunKey {
  $script = $PSCommandPath
  if (-not $script) { $script = Join-Path $HomeDir "Updater\StreamDeckAI-Updater.ps1" }
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Daemon"
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "StreamDeckAI.Updater" -Value $cmd
  # Startup .bat も用意 (Run が無効な環境向け)
  $startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
  New-Item -ItemType Directory -Force -Path $startup | Out-Null
  $bat = Join-Path $startup "StreamDeckAI-Updater.bat"
  $batBody = '@echo off' + [char]13 + [char]10 + ('start "" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Daemon' -f $script) + [char]13 + [char]10
  [IO.File]::WriteAllText($bat, $batBody)
  Write-Log "registered Run key and Startup bat"
}

# --- main ---
$Config = Read-Config
if ($InstallRunKey) { Install-RunKey; exit 0 }
if (-not $Once -and -not $Daemon) { $Daemon = $true }

try {
  Invoke-Update $Config
} catch {
  Write-Log $_.Exception.Message "ERROR"
  if ($Config.toastOnError) { Show-Toast "StreamDeckAI update error" $_.Exception.Message }
  if ($Once) { exit 1 }
}

if ($Once) { exit 0 }

$hours = [double]$Config.checkIntervalHours
if ($hours -le 0) { $hours = 6 }
Write-Log "daemon interval=${hours}h"
while ($true) {
  Start-Sleep -Seconds ([int]($hours * 3600))
  try { Invoke-Update (Read-Config) }
  catch {
    Write-Log $_.Exception.Message "ERROR"
    if ($Config.toastOnError) { Show-Toast "StreamDeckAI update error" $_.Exception.Message }
  }
}
