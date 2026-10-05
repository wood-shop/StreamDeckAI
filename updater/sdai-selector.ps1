#Requires -Version 5.1
# StreamDeckAI Selector (WinForms, no .NET SDK needed)
#   通常起動: アプリ選定ウィンドウを表示
#   -FetchOnly: UI なしでカタログ取得 + マージ結果を表示 (保存しない / 動作確認用)
param([switch]$FetchOnly)
$ErrorActionPreference = 'Stop'

$localBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
$homeDir = Join-Path $localBase 'StreamDeckAI'
$appsPath = Join-Path $homeDir 'apps.json'
$updaterConfigPath = Join-Path $homeDir 'updater-config.json'
$catalogOwner = 'wood-shop'
$catalogRepo = 'grokAppStore'
$catalogDir = 'AppCatalog'
$knownAgents = @('claude', 'codex', 'grok')
$defaults = @'
{"schema":1,"updatedAt":"","source":"defaults","apps":[
{"id":"claude-code","name":"Claude Code","category":"ツール","status":"developing","enabled":true,"streamdeck":{"agent":"claude","enabledDefault":true}},
{"id":"codex","name":"Codex CLI","category":"ツール","status":"developing","enabled":true,"streamdeck":{"agent":"codex","enabledDefault":true}},
{"id":"grok-bot","name":"Grok Bot","category":"ツール","status":"developing","enabled":true,"streamdeck":{"agent":"grok","enabledDefault":true}}
]}
'@

function Load-Apps {
  if (Test-Path $appsPath) {
    try { return (Get-Content $appsPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { }
  }
  return ($defaults | ConvertFrom-Json)
}

function Save-Apps($doc) {
  New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
  $doc.updatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
  $doc.source = 'selector'
  $json = $doc | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($appsPath, $json, (New-Object Text.UTF8Encoding $false))
  try {
    $port = 17890
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/apps" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 3 | Out-Null
  } catch {
    # plugin may be stopped; file save is enough
  }
}

# --- GitHub (非公開 grokAppStore) -------------------------------------------
# トークン優先順: 環境変数 STREAMDECKAI_GITHUB_TOKEN → updater-config.json の githubToken (アップデータと共用)
function Get-SdaiGithubToken {
  if ($env:STREAMDECKAI_GITHUB_TOKEN) { return $env:STREAMDECKAI_GITHUB_TOKEN.Trim() }
  if (Test-Path $updaterConfigPath) {
    try {
      $cfg = Get-Content $updaterConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.githubToken -and ([string]$cfg.githubToken).Trim()) { return ([string]$cfg.githubToken).Trim() }
    } catch { }
  }
  return $null
}

function Get-ContentsUrl([string]$Path) {
  $segs = $Path.Split('/') | Where-Object { $_ } | ForEach-Object { [Uri]::EscapeDataString($_) }
  return "https://api.github.com/repos/$catalogOwner/$catalogRepo/contents/" + ($segs -join '/')
}

function Invoke-GithubApi([string]$Url, [string]$Token) {
  $headers = @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'StreamDeckAI-Selector/0.3'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  if ($Token) { $headers['Authorization'] = "Bearer $Token" }
  return Invoke-RestMethod -Uri $Url -Headers $headers -Method Get -TimeoutSec 20
}

function Get-HttpStatus($err) {
  try { if ($err.Exception.Response) { return [int]$err.Exception.Response.StatusCode } } catch { }
  return 0
}

# Contents API の base64 content を UTF-8 文字列へ
function ConvertFrom-GithubContent($meta) {
  if (-not $meta -or -not $meta.content) { return $null }
  if ($meta.encoding -and $meta.encoding -ne 'base64') { return [string]$meta.content }
  $b64 = ([string]$meta.content) -replace '\s', ''
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text
}

# 戻り値: @{ Ok; Message; Entries } (Entries = streamdeck 対応 manifest を apps.json 形式にしたもの)
function Get-SdaiCatalog {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $token = Get-SdaiGithubToken
  try {
    $list = Invoke-GithubApi (Get-ContentsUrl $catalogDir) $token
  } catch {
    $code = Get-HttpStatus $_
    if ($code -in 401, 403, 404) {
      if (-not $token) {
        $msg = "カタログ取得失敗 HTTP ${code}: Grok アプリストア (wood-shop/grokAppStore) は非公開のため GitHub トークンが必要です。`n" +
               "$updaterConfigPath の `"githubToken`" に repo スコープのトークンを設定してください (または環境変数 STREAMDECKAI_GITHUB_TOKEN)。`n" +
               "ローカル/既定のアプリ一覧で動作を続けます。"
      } elseif ($code -eq 401) {
        $msg = "カタログ取得失敗 HTTP 401: githubToken が無効または期限切れです。updater-config.json のトークンを更新してください (ローカルのみ使用)。"
      } else {
        $msg = "カタログ取得失敗 HTTP ${code}: トークンに wood-shop/grokAppStore の読み取り権限 (repo スコープ) がありません (ローカルのみ使用)。"
      }
      return @{ Ok = $false; Message = $msg; Entries = @() }
    }
    return @{ Ok = $false; Message = "カタログ取得エラー: $($_.Exception.Message) (ローカルのみ使用)"; Entries = @() }
  }

  $entries = @()
  $failed = 0
  foreach ($e in @($list)) {
    if ($e.type -ne 'dir' -or -not $e.name) { continue }
    $dirPath = if ($e.path) { [string]$e.path } else { "$catalogDir/$($e.name)" }
    try {
      $meta = Invoke-GithubApi (Get-ContentsUrl "$dirPath/manifest.json") $token
      $text = ConvertFrom-GithubContent $meta
      if (-not $text) { $failed++; continue }
      $m = $text | ConvertFrom-Json
    } catch {
      if ((Get-HttpStatus $_) -ne 404) { $failed++ }  # manifest 無しフォルダは無視
      continue
    }
    if (-not $m.streamdeck -or -not $m.streamdeck.agent) { continue }
    $agent = ([string]$m.streamdeck.agent).Trim().ToLowerInvariant()
    if ($knownAgents -notcontains $agent) { continue }  # プラグインは claude|codex|grok のみ受け付ける
    $id = if ($m.id) { [string]$m.id } else { ([string]$(if ($m.name) { $m.name } else { $e.name })).ToLowerInvariant().Replace(' ', '-') }
    $ed = ($m.streamdeck.enabledDefault -eq $true)
    $entries += [pscustomobject]@{
      id = $id
      name = if ($m.name) { [string]$m.name } else { $id }
      category = if ($m.category) { [string]$m.category } else { 'ツール' }
      status = if ($m.status) { [string]$m.status } else { 'released' }
      enabled = $ed
      streamdeck = [pscustomobject]@{ agent = $agent; enabledDefault = $ed }
    }
  }
  $msg = "カタログ取得OK: streamdeck 対応 $($entries.Count) 件 ($((@($entries) | ForEach-Object { $_.name }) -join ', '))"
  if ($failed -gt 0) { $msg += " / 取得失敗 $failed 件" }
  return @{ Ok = $true; Message = $msg; Entries = $entries }
}

# カタログ項目をローカルへマージ。既知 id はローカルの enabled を保持し、名前/カテゴリ/状態/agent を更新。
function Merge-Catalog($doc, $entries) {
  $apps = New-Object System.Collections.ArrayList
  foreach ($a in @($doc.apps)) { [void]$apps.Add($a) }
  $added = 0; $updated = 0
  foreach ($c in @($entries)) {
    $existing = $apps | Where-Object { $_.id -eq $c.id } | Select-Object -First 1
    if ($existing) {
      foreach ($k in 'name', 'category', 'status', 'streamdeck') {
        if ($existing.PSObject.Properties[$k]) { $existing.$k = $c.$k }
        else { $existing | Add-Member -NotePropertyName $k -NotePropertyValue $c.$k }
      }
      $updated++
    } else {
      [void]$apps.Add($c); $added++
    }
  }
  $doc.apps = @($apps | Sort-Object { [string]$_.name })
  $doc.source = 'local+catalog'
  return @{ Added = $added; Updated = $updated }
}

if ($FetchOnly) {
  $doc = Load-Apps
  $r = Get-SdaiCatalog
  Write-Output $r.Message
  if ($r.Ok) {
    $mr = Merge-Catalog $doc $r.Entries
    Write-Output "マージ: 新規 $($mr.Added) / 更新 $($mr.Updated)"
  }
  foreach ($a in @($doc.apps)) {
    $agent = if ($a.streamdeck) { $a.streamdeck.agent } else { '?' }
    Write-Output ("{0}`t{1}`tagent={2}`tcategory={3}`tenabled={4}" -f $a.id, $a.name, $agent, $a.category, $a.enabled)
  }
  return
}

# --- UI ---------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$doc = Load-Apps
$form = New-Object Windows.Forms.Form
$form.Text = 'StreamDeckAI アプリ選定'
$form.Size = New-Object Drawing.Size(560, 500)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Yu Gothic UI', 10)

$label = New-Object Windows.Forms.Label
$label.Text = "Stream Deck に出すアプリにチェックを入れて「保存」してください。`n" +
              "Grok アプリストア (AppCatalog) の streamdeck 対応アプリを起動時と「カタログ再取得」で取り込みます。" +
              "ストアは非公開のため updater-config.json に githubToken (repo スコープ) が必要です。"
$label.Location = New-Object Drawing.Point(12, 12)
$label.Size = New-Object Drawing.Size(520, 66)
$form.Controls.Add($label)

$panel = New-Object Windows.Forms.Panel
$panel.Location = New-Object Drawing.Point(12, 82)
$panel.Size = New-Object Drawing.Size(520, 230)
$panel.AutoScroll = $true
$panel.BorderStyle = 'FixedSingle'
$form.Controls.Add($panel)

$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(12, 366)
$status.Size = New-Object Drawing.Size(520, 84)
$status.Text = "読み込み: $appsPath"
$form.Controls.Add($status)

$checks = @{}
function Read-Checks {
  foreach ($a in @($doc.apps)) {
    if ($checks.ContainsKey($a.id)) { $a.enabled = [bool]$checks[$a.id].Checked }
  }
}
function Render-Checks {
  $panel.SuspendLayout()
  $panel.Controls.Clear()
  $checks.Clear()
  $y = 4
  foreach ($a in @($doc.apps)) {
    $cb = New-Object Windows.Forms.CheckBox
    $st = if ($a.status) { $a.status } else { 'released' }
    $agent = if ($a.streamdeck) { $a.streamdeck.agent } else { '?' }
    $cat = if ($a.category) { $a.category } else { '-' }
    $cb.Text = "$($a.name)  [$($a.id)]  agent=$agent  ($cat / $st)"
    $cb.Checked = [bool]$a.enabled
    $cb.Location = New-Object Drawing.Point(4, $y)
    $cb.Size = New-Object Drawing.Size(490, 28)
    $panel.Controls.Add($cb)
    $checks[$a.id] = $cb
    $y += 30
  }
  $panel.ResumeLayout()
}
function Refresh-Catalog {
  $form.Cursor = [Windows.Forms.Cursors]::WaitCursor
  $status.Text = 'カタログ取得中…'
  $form.Refresh()
  try {
    Read-Checks
    $r = Get-SdaiCatalog
    if ($r.Ok) {
      $mr = Merge-Catalog $doc $r.Entries
      Render-Checks
      $status.Text = "$($r.Message)`n新規 $($mr.Added) / 更新 $($mr.Updated) — 「保存」で apps.json に反映"
    } else {
      $status.Text = $r.Message
    }
  } finally {
    $form.Cursor = [Windows.Forms.Cursors]::Default
  }
}

Render-Checks

$btn = New-Object Windows.Forms.Button
$btn.Text = '保存'
$btn.Location = New-Object Drawing.Point(12, 320)
$btn.Size = New-Object Drawing.Size(120, 36)
$btn.Add_Click({
  Read-Checks
  Save-Apps $doc
  [Windows.Forms.MessageBox]::Show("保存しました。`n$appsPath", 'StreamDeckAI') | Out-Null
})
$form.Controls.Add($btn)

$btnFetch = New-Object Windows.Forms.Button
$btnFetch.Text = 'カタログ再取得'
$btnFetch.Location = New-Object Drawing.Point(142, 320)
$btnFetch.Size = New-Object Drawing.Size(140, 36)
$btnFetch.Add_Click({ Refresh-Catalog })
$form.Controls.Add($btnFetch)

$btnClose = New-Object Windows.Forms.Button
$btnClose.Text = '閉じる'
$btnClose.Location = New-Object Drawing.Point(292, 320)
$btnClose.Size = New-Object Drawing.Size(120, 36)
$btnClose.Add_Click({ $form.Close() })
$form.Controls.Add($btnClose)

$form.Add_Shown({ Refresh-Catalog })  # 起動時に 1 回だけ自動取得 (失敗してもローカルで動作)

[void]$form.ShowDialog()
