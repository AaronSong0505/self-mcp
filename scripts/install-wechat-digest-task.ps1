param(
  [string]$TaskName = "SelfMcp-WechatDigestMorning",
  [string]$Time = "08:45"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-wechat-digest.ps1"
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""

schtasks /Create /TN $TaskName /SC DAILY /ST $Time /TR $taskCommand /F | Out-Null
schtasks /Query /TN $TaskName /V /FO LIST
