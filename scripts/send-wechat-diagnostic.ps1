param(
  [string]$Target = "aaron-wechat",
  [string]$Title = "Xiaoxiong Diagnostic",
  [string]$Body = "This message is sent through the formal UTF-8 delivery path."
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
[System.Environment]::SetEnvironmentVariable("OPENCLAW_CLI_WRAPPER", (Join-Path $openclawRoot "scripts\\openclaw.ps1"), "Process")

$entry = Join-Path $rootDir "dist\\services\\wechat-digest-mcp\\src\\run-diagnostic.js"

& node $entry "--target" $Target "--title" $Title "--body" $Body
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
