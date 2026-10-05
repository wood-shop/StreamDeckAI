#Requires -Version 5.1
<#
.SYNOPSIS
  StreamDeckAI をアンインストールする (プラグイン + ツール + 単一ショートカット)。
.DESCRIPTION
  削除対象:
    - %APPDATA%\Elgato\StreamDeck\Plugins\jp.example.streamdeckai.sdPlugin\
    - %LOCALAPPDATA%\StreamDeckAI\ (または install.json の homeDir / Documents フォールバック)
    - デスクトップ / スタートメニューの「StreamDeckAI.lnk」のみ
    - HKCU Run\StreamDeckAI.Updater と Startup\StreamDeckAI-Updater.bat
  削除しない:
    - Claude Code / Codex CLI の hook・settings / config.toml
    - ユーザーが手で書いた他アプリの設定
#>
param(
  [switch]$KeepAppsJson,
  [switch]$Force
)
$ErrorActionPreference = "Continue"
$PluginId = "jp.example.streamdeckai.sdPlugin"
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host "StreamDeckAI アンインストール"

function Resolve-HomeCandidates {
  $list = @()
  # ホーム直下の Uninstall.ps1 から呼ばれた場合
  if (Test-Path (Join-Path $script:ScriptRoot "install.json")) { $list += $script:ScriptRoot }
  if ($env:LOCALAPPDATA) { $list += (Join-Path $env:LOCALAPPDATA "StreamDeckAI") }
  if ($env:USERPROFILE) {
    $list += (Join-Path $env:USERPROFILE "Documents\StreamDeckAI")
    $list += (Join-Path $env:USERPROFILE "StreamDeckAI")
  }
  return $list | Select-Object -Unique
}

$homes = @(Resolve-HomeCandidates | Where-Object { Test-Path $_ })
$homeDir = $null
foreach ($h in $homes) {
  $rec = Join-Path $h "install.json"
  if (Test-Path $rec) { $homeDir = $h; break }
}
if (-not $homeDir -and $homes.Count -gt 0) { $homeDir = $homes[0] }

$elgato = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$PluginId"
if (Test-Path $elgato) {
  try {
    Remove-Item -Recurse -Force $elgato
    Write-Host "  削除: $elgato"
  } catch {
    Write-Warning "プラグイン削除失敗 (Stream Deck を終了して再実行): $($_.Exception.Message)"
  }
} else {
  Write-Host "  (Elgato プラグインなし)"
}

# Run / Startup
try {
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "StreamDeckAI.Updater" -ErrorAction SilentlyContinue
  Write-Host "  削除: HKCU Run\StreamDeckAI.Updater"
} catch {}
$startupBat = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\StreamDeckAI-Updater.bat"
if (Test-Path $startupBat) {
  Remove-Item -Force $startupBat -ErrorAction SilentlyContinue
  Write-Host "  削除: $startupBat"
}

# Single shortcut only
$ws = $null
try { $ws = New-Object -ComObject WScript.Shell } catch {}
foreach ($kind in @("Programs", "Desktop")) {
  $dir = [Environment]::GetFolderPath($kind)
  if (-not $dir) { continue }
  $lnk = Join-Path $dir "StreamDeckAI.lnk"
  if (Test-Path $lnk) {
    Remove-Item -Force $lnk -ErrorAction SilentlyContinue
    Write-Host "  削除: $lnk"
  }
  # 旧個別ショートカットが残っていれば掃除 (本セットアップでは作らないが念のため)
  foreach ($legacy in @("StreamDeckAI-Selector.lnk", "StreamDeckAI-Updater.lnk", "StreamDeckAI.Selector.lnk", "StreamDeckAI.Updater.lnk")) {
    $p = Join-Path $dir $legacy
    if (Test-Path $p) {
      Remove-Item -Force $p -ErrorAction SilentlyContinue
      Write-Host "  削除 (legacy): $p"
    }
  }
}

# Home folder
if ($homeDir -and (Test-Path $homeDir)) {
  if ($KeepAppsJson) {
    Get-ChildItem -Force $homeDir | Where-Object { $_.Name -ne "apps.json" } | ForEach-Object {
      Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
    Write-Host "  ホーム整理 (apps.json 保持): $homeDir"
  } else {
    try {
      # 自分自身がホーム内なら最後に親を消すため、一時退避はしない。スクリプト終了後に残る場合あり。
      $self = $MyInvocation.MyCommand.Path
      $inside = $false
      if ($self -and $self.StartsWith($homeDir, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true }
      if ($inside) {
        # 子を先に消し、フォルダ自体は cmd で遅延削除を試みる
        Get-ChildItem -Force $homeDir | Where-Object { $_.FullName -ne $self } | ForEach-Object {
          Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
        }
        $cmd = "ping -n 2 127.0.0.1 >nul & rmdir /s /q `"$homeDir`""
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WindowStyle Hidden
        Write-Host "  ホーム削除予約: $homeDir"
      } else {
        Remove-Item -Recurse -Force $homeDir
        Write-Host "  削除: $homeDir"
      }
    } catch {
      Write-Warning "ホーム削除失敗: $($_.Exception.Message)"
    }
  }
} else {
  Write-Host "  (ホームフォルダなし)"
}

Write-Host ""
Write-Host "アンインストール処理を終えました。"
Write-Host "注意: Claude Code (%USERPROFILE%\.claude\settings.json) や Codex (%USERPROFILE%\.codex\config.toml) の"
Write-Host "      hook / notify 設定は削除していません。不要なら手で外してください。"
Write-Host "Stream Deck を再起動するとプラグイン一覧から消えます。"
