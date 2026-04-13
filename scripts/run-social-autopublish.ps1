param(
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

[System.Environment]::SetEnvironmentVariable("BLUESKY_SOCIAL_ROOT", $rootDir, "Process")
[System.Environment]::SetEnvironmentVariable("BLUESKY_SOCIAL_CONFIG_DIR", (Join-Path $rootDir "config"), "Process")

function Resolve-NodeExe {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }

  $candidates = @(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Unable to locate node.exe for social autopublish runner."
}

$node = Resolve-NodeExe
$entry = Join-Path $rootDir "dist\\services\\social-outbox-mcp\\src\\run-autopublish.js"
$args = @($entry)
if ($DryRun) {
  $args += "--dry-run"
}

& $node @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
