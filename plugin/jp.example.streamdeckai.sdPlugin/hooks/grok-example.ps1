# Grok Bot / any other agent: just POST JSON. Examples (PowerShell 5.1 compatible, ASCII only).
$hook = "C:/PATH/TO/sdai-hook.ps1"
$ps   = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

# 1) via the helper script
& $ps -NoProfile -ExecutionPolicy Bypass -File $hook -Agent grok -Status working -SessionId grok-1 -Name "my-task" -Cwd "C:\work\proj"
& $ps -NoProfile -ExecutionPolicy Bypass -File $hook -Agent grok -Status blocked -SessionId grok-1 -Message "Delete the build folder?"
& $ps -NoProfile -ExecutionPolicy Bypass -File $hook -Agent grok -Status done    -SessionId grok-1

# 2) raw HTTP (curl.exe ships with Windows 11). Content-Type: application/json is required.
# curl.exe -s -X POST http://127.0.0.1:17890/event -H "Content-Type: application/json" -d "{\"session_id\":\"grok-1\",\"agent\":\"grok\",\"status\":\"done\",\"name\":\"my-task\",\"cwd\":\"C:\\work\\proj\"}"
