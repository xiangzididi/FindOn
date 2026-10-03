param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Calibration", "Management")]
  [string]$Mode,
  [string]$Port = "COM12",
  [switch]$CheckOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime"
$modeKey = $Mode.ToLowerInvariant()
$httpPort = if ($Mode -eq "Calibration") { 3212 } else { 3210 }
$url = "http://127.0.0.1:$httpPort/"

function Resolve-PartGoCommand {
  if ($Mode -eq "Calibration") {
    # Use PlatformIO's real interpreter. The penv Scripts\python.exe launcher
    # creates a second process, which can retain COM12 after the recorded PID
    # is stopped.
    $python = Join-Path $env:USERPROFILE ".platformio\python3\python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
      $python = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"
    }
    if (-not (Test-Path -LiteralPath $python)) {
      $python = (Get-Command python -ErrorAction Stop).Source
    }
    return @{
      FilePath = $python
      Arguments = @(
        (Join-Path $root "scripts\calibration_server.py"),
        "--serial-port", $Port,
        "--http-port", [string]$httpPort
      )
    }
  }

  $node = (Get-Command node -ErrorAction Stop).Source
  return @{
    FilePath = $node
    Arguments = @((Join-Path $root "server.js"))
  }
}

function Stop-PartGoServices {
  $processIds = [System.Collections.Generic.HashSet[int]]::new()

  if (Test-Path -LiteralPath $runtime) {
    Get-ChildItem -LiteralPath $runtime -Filter "*.pid" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        $stored = 0
        if ([int]::TryParse((Get-Content -LiteralPath $_.FullName -Raw).Trim(), [ref]$stored)) {
          [void]$processIds.Add($stored)
        }
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      }
  }

  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3210, 3212 } |
    ForEach-Object { [void]$processIds.Add([int]$_.OwningProcess) }

  foreach ($processId in $processIds) {
    if ($processId -eq $PID) { continue }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  if ($processIds.Count) { Start-Sleep -Milliseconds 500 }
}

$command = Resolve-PartGoCommand
if (-not (Test-Path -LiteralPath $command.FilePath)) {
  throw "找不到启动程序：$($command.FilePath)"
}

if ($CheckOnly) {
  Write-Host "[$Mode] 启动器检查通过：$($command.FilePath)"
  exit 0
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Stop-PartGoServices

if ($Mode -eq "Management") {
  $env:PARTGO_DEVICE_MODE = "hardware"
  $env:PARTGO_SERIAL_PORT = $Port
  $env:PARTGO_SERIAL_BAUD = "115200"
}

$stdoutPath = Join-Path $runtime "$modeKey.stdout.log"
$stderrPath = Join-Path $runtime "$modeKey.stderr.log"
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$process = Start-Process `
  -FilePath $command.FilePath `
  -ArgumentList $command.Arguments `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

Set-Content -LiteralPath (Join-Path $runtime "$modeKey.pid") -Value $process.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { break }
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    # The service can take a few seconds to bind the port.
  }
}

if (-not $ready) {
  $details = @()
  if (Test-Path -LiteralPath $stderrPath) {
    $details += Get-Content -LiteralPath $stderrPath -Tail 20
  }
  if (Test-Path -LiteralPath $stdoutPath) {
    $details += Get-Content -LiteralPath $stdoutPath -Tail 20
  }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "PartGo $Mode 启动失败。`n$($details -join [Environment]::NewLine)"
}

if (-not $NoBrowser) {
  Start-Process $url
}

Write-Host "PartGo $Mode 已启动：$url"
Write-Host "串口：$Port；后台 PID：$($process.Id)"
Write-Host "日志目录：$runtime"
