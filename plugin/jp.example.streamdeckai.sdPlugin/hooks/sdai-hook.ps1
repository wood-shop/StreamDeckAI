<#
 StreamDeckAI hook: posts one event to the local plugin server (127.0.0.1).
 ASCII only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).

 Claude Code : same command for every hook; status is derived from hook_event_name on stdin.
     -Agent claude
 Codex CLI   : notify = [powershell, ..., this.ps1, -Agent, codex]; Codex appends the JSON as the last argument.
 Grok / any  : -Agent grok -Status working|blocked|done|idle -SessionId <id> [-Name ..] [-Cwd ..] [-Hint ..] [-Message ..]
              [-TranscriptPath <claude session .jsonl>] [-LastMessage <last assistant text>]  (both optional, v0.2)

 v0.2: Claude's transcript_path and (Stop) last_assistant_message are forwarded to the plugin as
       transcript_path / last_assistant_message. Codex's last-assistant-message is forwarded as last_assistant_message.

 Env overrides: STREAMDECKAI_PORT (default 17890), STREAMDECKAI_NAME, STREAMDECKAI_HINT, STREAMDECKAI_SPACE
 This script never prints anything and always exits 0 so it can not disturb the agent.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'grok')][string]$Agent,
    [ValidateSet('auto', 'working', 'blocked', 'done', 'idle')][string]$Status = 'auto',
    [string]$SessionId,
    [string]$Name,
    [string]$Cwd,
    [string]$Hint,
    [string]$Space,
    [string]$Message,
    [string]$TranscriptPath,
    [string]$LastMessage,
    [int]$Port = 0,
    [switch]$DryRun,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

function Get-Prop($obj, [string]$prop) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$prop]
    if ($p) { return $p.Value }
    return $null
}

# Keep the beginning and the end of long text (the plugin summarizes the first sentences and the closing question)
function Limit-Text([string]$t, [int]$max) {
    if (-not $t -or $t.Length -le $max) { return $t }
    $head = [int][Math]::Floor($max * 0.6)
    return $t.Substring(0, $head) + "`n" + $t.Substring($t.Length - ($max - $head))
}

try {
    $ErrorActionPreference = 'Stop'
    $payload = $null

    if ($Agent -eq 'claude' -and [Console]::IsInputRedirected) {
        # Read raw bytes as UTF-8 (the default console code page would garble Japanese paths)
        $stdin = [Console]::OpenStandardInput()
        $ms = New-Object System.IO.MemoryStream
        $stdin.CopyTo($ms)
        $text = [Text.Encoding]::UTF8.GetString($ms.ToArray()).TrimStart([char]0xFEFF)
        if ($text.Trim()) { $payload = $text | ConvertFrom-Json }
    }
    elseif ($Rest -and $Rest.Count -gt 0) {
        try { $payload = $Rest[$Rest.Count - 1] | ConvertFrom-Json } catch { $payload = $null }
    }

    $sid = $SessionId
    $cwdv = $Cwd
    $msg = $Message
    $tpath = $TranscriptPath
    $lastMsg = $LastMessage
    $st = $Status

    if ($Agent -eq 'claude' -and $payload) {
        if (-not $sid) { $sid = [string](Get-Prop $payload 'session_id') }
        if (-not $cwdv) { $cwdv = [string](Get-Prop $payload 'cwd') }
        if (-not $tpath) { $tpath = [string](Get-Prop $payload 'transcript_path') }
        if (-not $lastMsg) { $lastMsg = [string](Get-Prop $payload 'last_assistant_message') }
        $ev = [string](Get-Prop $payload 'hook_event_name')
        if ($st -eq 'auto') {
            switch ($ev) {
                'UserPromptSubmit' { $st = 'working' }
                'PreToolUse'       { $st = 'working' }
                'PostToolUse'      { $st = 'working' }
                'Stop'             { $st = 'done' }
                'SessionStart'     { $st = 'idle' }
                'SessionEnd'       { $st = 'idle' }
                'Notification' {
                    $nt = [string](Get-Prop $payload 'notification_type')
                    $nm = [string](Get-Prop $payload 'message')
                    # "waiting for your input" after a finished turn is not a permission request
                    if ($nt -eq 'idle_prompt' -or $nm -match 'waiting for your input') { exit 0 }
                    $st = 'blocked'
                    if (-not $msg) { $msg = $nm }
                }
                default { exit 0 }
            }
        }
    }
    elseif ($Agent -eq 'codex' -and $payload) {
        if (-not $sid) { $sid = [string](Get-Prop $payload 'thread-id') }
        if (-not $cwdv) { $cwdv = [string](Get-Prop $payload 'cwd') }
        $type = [string](Get-Prop $payload 'type')
        if (-not $lastMsg -and $type -eq 'agent-turn-complete') { $lastMsg = [string](Get-Prop $payload 'last-assistant-message') }
        if ($st -eq 'auto') {
            if ($type -eq 'agent-turn-complete') { $st = 'done'; if (-not $msg) { $msg = [string](Get-Prop $payload 'last-assistant-message') } }
            elseif ($type -like '*approval*') { $st = 'blocked'; if (-not $msg) { $msg = [string](Get-Prop $payload 'command') } }
            else { exit 0 }
        }
    }

    if ($st -eq 'auto') { exit 0 }                       # nothing to report
    if (-not $cwdv) { $cwdv = (Get-Location).Path }
    if (-not $sid) { $sid = "$Agent`:$cwdv" }            # generic agents without a session id: one session per folder
    $leaf = Split-Path -Leaf $cwdv
    if (-not $Name) { $Name = $env:STREAMDECKAI_NAME }
    if (-not $Name) { $Name = $leaf }
    if (-not $Hint) { $Hint = $env:STREAMDECKAI_HINT }
    if (-not $Hint) { $Hint = $leaf }
    if (-not $Space) { $Space = $env:STREAMDECKAI_SPACE }
    if ($Port -le 0) { $Port = if ($env:STREAMDECKAI_PORT) { [int]$env:STREAMDECKAI_PORT } else { 17890 } }

    $body = [ordered]@{
        session_id     = $sid
        agent          = $Agent
        status         = $st
        name           = $Name
        cwd            = $cwdv
        wt_window_hint = $Hint
    }
    if ($msg) { $body['message'] = $msg }
    if ($Space) { $body['space'] = $Space }
    if ($tpath) { $body['transcript_path'] = $tpath }
    if ($lastMsg) { $body['last_assistant_message'] = Limit-Text $lastMsg 4000 }
    $json = $body | ConvertTo-Json -Compress

    if ($DryRun) { Write-Output $json; exit 0 }

    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/event" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 2
}
catch {
    # plugin not running etc.: stay silent
}
exit 0
