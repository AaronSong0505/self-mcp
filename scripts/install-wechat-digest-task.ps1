param(
  [string]$MorningTaskName = "SelfMcp-WechatDigestMorning",
  [string]$MorningTime = "08:45",
  [string]$EveningTaskName = "SelfMcp-WechatDigestEvening",
  [string]$EveningTime = "18:40",
  [string]$FollowupTaskName = "SelfMcp-WechatDigestLearningFollowup",
  [string]$FollowupTime = "19:30"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-wechat-digest.ps1"
$morningTaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode morning"
$eveningTaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode morning"
$followupTaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode followup"

schtasks /Create /TN $MorningTaskName /SC DAILY /ST $MorningTime /TR $morningTaskCommand /F | Out-Null
schtasks /Create /TN $EveningTaskName /SC DAILY /ST $EveningTime /TR $eveningTaskCommand /F | Out-Null
schtasks /Create /TN $FollowupTaskName /SC DAILY /ST $FollowupTime /TR $followupTaskCommand /F | Out-Null

schtasks /Query /TN $MorningTaskName /V /FO LIST
Write-Host ""
schtasks /Query /TN $EveningTaskName /V /FO LIST
Write-Host ""
schtasks /Query /TN $FollowupTaskName /V /FO LIST
