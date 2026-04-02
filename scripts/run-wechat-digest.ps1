param(
  [string]$Date,
  [string]$Target = "aaron-wechat",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$oneCompanyRoot = Join-Path (Split-Path -Parent $rootDir) "one-company"
$openclawRoot = Join-Path $oneCompanyRoot "openclaw"
$envFile = Join-Path $openclawRoot ".env"

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) {
      return
    }
    [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
  }
}

[System.Environment]::SetEnvironmentVariable("WECHAT_DIGEST_ROOT", $rootDir, "Process")
[System.Environment]::SetEnvironmentVariable("WECHAT_DIGEST_CONFIG_DIR", (Join-Path $rootDir "config"), "Process")
[System.Environment]::SetEnvironmentVariable("WECHAT_DIGEST_DATA_DIR", (Join-Path $rootDir "data"), "Process")
[System.Environment]::SetEnvironmentVariable("WECHAT_DIGEST_OPENAI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1", "Process")
[System.Environment]::SetEnvironmentVariable("OPENCLAW_CLI_WRAPPER", (Join-Path $openclawRoot "scripts\\openclaw.ps1"), "Process")

$node = "node"
$entry = Join-Path $rootDir "dist\\services\\wechat-digest-mcp\\src\\run-morning.js"
$args = @($entry, "--target", $Target)
if ($Date) {
  $args += @("--date", $Date)
}
if ($DryRun) {
  $args += "--dry-run"
}

& $node @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
