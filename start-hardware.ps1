param(
  [string]$Port = "COM12",
  [int]$Baud = 115200
)

$ErrorActionPreference = "Stop"
$env:PARTGO_DEVICE_MODE = "hardware"
$env:PARTGO_SERIAL_PORT = $Port
$env:PARTGO_SERIAL_BAUD = [string]$Baud
node (Join-Path $PSScriptRoot "server.js")
