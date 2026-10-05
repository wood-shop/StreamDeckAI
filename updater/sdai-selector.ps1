#Requires -Version 5.1
# StreamDeckAI Selector (WinForms, no .NET SDK needed)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$homeDir = Join-Path $env:LOCALAPPDATA 'StreamDeckAI'
$appsPath = Join-Path $homeDir 'apps.json'
$defaults = @'
{"schema":1,"updatedAt":"","source":"defaults","apps":[
{"id":"claude-code","name":"Claude Code","category":"agent","status":"developing","enabled":true,"streamdeck":{"agent":"claude","enabledDefault":true}},
{"id":"codex","name":"Codex CLI","category":"agent","status":"developing","enabled":true,"streamdeck":{"agent":"codex","enabledDefault":true}},
{"id":"grok-bot","name":"Grok Bot","category":"agent","status":"developing","enabled":true,"streamdeck":{"agent":"grok","enabledDefault":true}}
]}
'@

function Load-Apps {
  if (Test-Path $appsPath) {
    return (Get-Content $appsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
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
    $cfg = Join-Path $homeDir 'updater-config.json'
    # plugin port from event; try /apps
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/apps" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 3 | Out-Null
  } catch {
    # plugin may be stopped; file save is enough
  }
}

$doc = Load-Apps
$form = New-Object Windows.Forms.Form
$form.Text = 'StreamDeckAI アプリ選定'
$form.Size = New-Object Drawing.Size(520, 420)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Yu Gothic UI', 10)

$label = New-Object Windows.Forms.Label
$label.Text = "Stream Deck に出すアプリにチェックを入れて「保存」してください。`nカタログ連携(Grokアプリストア)は status/streamdeck 拡張後に自動で増えます。"
$label.Location = New-Object Drawing.Point(12, 12)
$label.Size = New-Object Drawing.Size(480, 48)
$form.Controls.Add($label)

$panel = New-Object Windows.Forms.Panel
$panel.Location = New-Object Drawing.Point(12, 70)
$panel.Size = New-Object Drawing.Size(480, 250)
$panel.AutoScroll = $true
$form.Controls.Add($panel)

$checks = @{}
$y = 4
foreach ($a in $doc.apps) {
  $cb = New-Object Windows.Forms.CheckBox
  $st = if ($a.status) { $a.status } else { 'released' }
  $agent = if ($a.streamdeck) { $a.streamdeck.agent } else { '?' }
  $cb.Text = "$($a.name)  [$($a.id)]  agent=$agent  ($st)"
  $cb.Checked = [bool]$a.enabled
  $cb.Location = New-Object Drawing.Point(4, $y)
  $cb.Size = New-Object Drawing.Size(450, 28)
  $panel.Controls.Add($cb)
  $checks[$a.id] = $cb
  $y += 30
}

$btn = New-Object Windows.Forms.Button
$btn.Text = '保存'
$btn.Location = New-Object Drawing.Point(12, 330)
$btn.Size = New-Object Drawing.Size(120, 36)
$btn.Add_Click({
  foreach ($a in $doc.apps) {
    if ($checks.ContainsKey($a.id)) { $a.enabled = [bool]$checks[$a.id].Checked }
  }
  Save-Apps $doc
  [Windows.Forms.MessageBox]::Show("保存しました。`n$appsPath", 'StreamDeckAI') | Out-Null
})
$form.Controls.Add($btn)

$btnClose = New-Object Windows.Forms.Button
$btnClose.Text = '閉じる'
$btnClose.Location = New-Object Drawing.Point(150, 330)
$btnClose.Size = New-Object Drawing.Size(120, 36)
$btnClose.Add_Click({ $form.Close() })
$form.Controls.Add($btnClose)

[void]$form.ShowDialog()
