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

function Test-TcpPortOpen {
  param(
    [string]$Host,
    [int]$Port,
    [int]$TimeoutMs = 500
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect($Host, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      $client.Close()
      return $false
    }

    $client.EndConnect($asyncResult)
    $client.Close()
    return $true
  } catch {
    $client.Close()
    return $false
  }
}

if (-not $env:BLUESKY_PROXY_URL -and (Test-TcpPortOpen -Host "127.0.0.1" -Port 40008)) {
  [System.Environment]::SetEnvironmentVariable("BLUESKY_PROXY_URL", "socks5h://127.0.0.1:40008", "Process")
}

if ($env:BLUESKY_PROXY_URL) {
  [System.Environment]::SetEnvironmentVariable("ALL_PROXY", $env:BLUESKY_PROXY_URL, "Process")
  [System.Environment]::SetEnvironmentVariable("all_proxy", $env:BLUESKY_PROXY_URL, "Process")
  [System.Environment]::SetEnvironmentVariable("HTTP_PROXY", $env:BLUESKY_PROXY_URL, "Process")
  [System.Environment]::SetEnvironmentVariable("http_proxy", $env:BLUESKY_PROXY_URL, "Process")
  [System.Environment]::SetEnvironmentVariable("HTTPS_PROXY", $env:BLUESKY_PROXY_URL, "Process")
  [System.Environment]::SetEnvironmentVariable("https_proxy", $env:BLUESKY_PROXY_URL, "Process")
}

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
