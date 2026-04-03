param(
  [string]$TaskName = "SelfMcp-WechatLoveNote",
  [string]$StartTime = "10:00",
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-wechat-love-note.ps1"
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""

schtasks /Create /TN $TaskName /SC MINUTE /MO $EveryMinutes /ST $StartTime /TR $taskCommand /F | Out-Null
schtasks /Query /TN $TaskName /V /FO LIST
