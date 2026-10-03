param(
  [string]$Port = "COM9",
  [int]$HttpPort = 3212,
  [switch]$Simulate
)

$python = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
$arguments = @("scripts/calibration_server.py", "--serial-port", $Port, "--http-port", $HttpPort)
if ($Simulate) { $arguments += "--simulate" }
& $python @arguments
