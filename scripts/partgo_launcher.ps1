param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Calibration", "Management")]
  [string]$Mode,
  [string]$Port = "COM9",
  [switch]$CheckOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime"
$modeKey = $Mode.ToLowerInvariant()
$httpPort = if ($Mode -eq "Calibration") { 3212 } else { 3210 }
$url = "http://127.0.0.1:$httpPort/"

function Resolve-PartGoPython {
  $candidates = [System.Collections.Generic.List[string]]::new()
  $candidates.Add((Join-Path $env:USERPROFILE ".platformio\penv\Scripts\python.exe"))
  $systemPython = Get-Command python -ErrorAction SilentlyContinue
  if ($systemPython) { $candidates.Add($systemPython.Source) }

  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    & $candidate -c "import serial" *> $null
    if ($LASTEXITCODE -eq 0) { return $candidate }
  }
  throw "找不到已安装 pyserial 的 Python；请运行 python -m pip install -r requirements.txt"
}

$serialPython = Resolve-PartGoPython

function Resolve-PartGoCommand {
  if ($Mode -eq "Calibration") {
    return @{
      FilePath = $serialPython
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

function Get-RunningPartGoTarget {
  $pidPath = Join-Path $runtime "$modeKey.pid"
  if (-not (Test-Path -LiteralPath $pidPath)) { return $null }

  $stored = 0
  $rawPid = ([string](Get-Content -LiteralPath $pidPath -Raw)).Trim()
  if (-not [int]::TryParse($rawPid, [ref]$stored)) { return $null }

  $processInfo = Get-CimInstance -ClassName Win32_Process `
    -Filter "ProcessId = $stored" -ErrorAction SilentlyContinue
  if (-not $processInfo) { return $null }

  $expectedEntryPoint = if ($Mode -eq "Management") {
    Join-Path $root "server.js"
  } else {
    Join-Path $root "scripts\calibration_server.py"
  }
  $allowedExecutables = if ($Mode -eq "Management") {
    @("node.exe")
  } else {
    @("python.exe", "python3.exe")
  }
  $actualExecutable = [System.IO.Path]::GetFileName([string]$processInfo.ExecutablePath)
  $commandLine = [string]$processInfo.CommandLine
  if (($allowedExecutables -notcontains $actualExecutable) -or
    $commandLine.IndexOf($expectedEntryPoint, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $null
  }

  $listeners = @(
    Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $httpPort `
      -State Listen -ErrorAction SilentlyContinue
  )
  $ownedListener = $false
  foreach ($listener in $listeners) {
    if ($listener.OwningProcess -eq $stored) {
      $ownedListener = $true
      break
    }
    $listenerProcess = Get-CimInstance -ClassName Win32_Process `
      -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $listenerProcess -or $listenerProcess.ParentProcessId -ne $stored) { continue }
    $listenerExecutable = [System.IO.Path]::GetFileName([string]$listenerProcess.ExecutablePath)
    $listenerCommandLine = [string]$listenerProcess.CommandLine
    if (($allowedExecutables -contains $listenerExecutable) -and
      $listenerCommandLine.IndexOf($expectedEntryPoint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $ownedListener = $true
      break
    }
  }
  if (-not $ownedListener) { return $null }

  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $null }
  } catch {
    return $null
  }
  return $processInfo
}

function Assert-PartGoServiceIdle {
  param(
    [Parameter(Mandatory = $true)][string]$Service,
    [Parameter(Mandatory = $true)][int]$ProcessId
  )

  $servicePort = if ($Service -eq "management") { 3210 } else { 3212 }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$servicePort/api/state" `
      -UseBasicParsing -TimeoutSec 2
    $serviceState = $response.Content | ConvertFrom-Json
  } catch {
    throw "为避免在机构可能运动时强制结束进程，启动器已保留 PartGo $Service (PID $ProcessId)。请先在原页面停止任务；若页面失去响应，先切断 12V 电机电源，再人工处理该进程。"
  }

  if ($Service -eq "management") {
    # Switching to the calibration console is a supported recovery path once
    # all automatic motion has stopped.  Keep blocking active motion and an
    # outstanding operator confirmation, but preserve PRESENTED/RECOVERY_REQUIRED
    # in the database and allow the calibration console to take over COM9.
    $blockedStates = @("HOMING", "BUSY", "AWAITING_CONFIRMATION")
    $stateFields = @($serviceState.PSObject.Properties.Name)
    $unsafe = -not ($stateFields -contains "active_task_id") -or
      -not ($stateFields -contains "pending_task_id") -or
      -not ($stateFields -contains "device_state") -or
      $null -ne $serviceState.active_task_id -or
      $null -ne $serviceState.pending_task_id -or
      $serviceState.device.busy -eq $true -or
      $blockedStates -contains [string]$serviceState.device_state
    if ($unsafe) {
      throw "PartGo 管理系统仍有运动或待确认操作，启动器不会强制切换。请先在原页面停止任务或完成盒位确认。"
    }
  } elseif (-not (@($serviceState.PSObject.Properties.Name) -contains "moving") -or
    $serviceState.moving -ne $false) {
    throw "PartGo 标定台仍在执行有限运动，启动器不会强制切换。请等待停止回执；异常时先切断 12V 电机电源。"
  }
}

function Stop-PartGoServices {
  $stoppedOwnedProcess = $false
  if (Test-Path -LiteralPath $runtime) {
    $pidFiles = @(
      Get-ChildItem -LiteralPath $runtime -Filter "*.pid" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -in "management", "calibration" }
    )

    foreach ($pidFile in $pidFiles) {
      $stored = 0
      $rawPid = ([string](Get-Content -LiteralPath $pidFile.FullName -Raw)).Trim()
      if (-not [int]::TryParse($rawPid, [ref]$stored)) {
        Write-Warning "忽略无效的 PartGo PID 文件：$($pidFile.FullName)"
        Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
        continue
      }

      $processInfo = Get-CimInstance -ClassName Win32_Process `
        -Filter "ProcessId = $stored" -ErrorAction Stop
      if (-not $processInfo) {
        Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
        continue
      }

      $expectedEntryPoint = if ($pidFile.BaseName -eq "management") {
        Join-Path $root "server.js"
      } else {
        Join-Path $root "scripts\calibration_server.py"
      }
      $allowedExecutables = if ($pidFile.BaseName -eq "management") {
        @("node.exe")
      } else {
        @("python.exe", "python3.exe")
      }
      $actualExecutable = [System.IO.Path]::GetFileName([string]$processInfo.ExecutablePath)
      $commandLine = [string]$processInfo.CommandLine
      $executablePath = [string]$processInfo.ExecutablePath
      $quotedExecutable = '"' + $executablePath + '"'
      $argumentTail = $null
      if ($commandLine.StartsWith($quotedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
        $argumentTail = $commandLine.Substring($quotedExecutable.Length).Trim()
      } elseif ($commandLine.StartsWith($executablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        $argumentTail = $commandLine.Substring($executablePath.Length).Trim()
      }

      $entryPointMatches = $false
      if ($null -ne $argumentTail) {
        $entryPointForms = @($expectedEntryPoint, ('"' + $expectedEntryPoint + '"'))
        foreach ($entryPointForm in $entryPointForms) {
          if ($pidFile.BaseName -eq "management") {
            $entryPointMatches = $argumentTail.Equals(
              $entryPointForm,
              [System.StringComparison]::OrdinalIgnoreCase
            )
          } else {
            $entryPointMatches = $argumentTail.Equals(
              $entryPointForm,
              [System.StringComparison]::OrdinalIgnoreCase
            ) -or $argumentTail.StartsWith(
              "$entryPointForm ",
              [System.StringComparison]::OrdinalIgnoreCase
            )
          }
          if ($entryPointMatches) { break }
        }
      }
      $ownedByPartGo = ($allowedExecutables -contains $actualExecutable) -and $entryPointMatches

      if (-not $ownedByPartGo) {
        Write-Warning "PID $stored 与 $($pidFile.Name) 不匹配；为防止误关其他程序，已保留该进程。"
        Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
        continue
      }

      Assert-PartGoServiceIdle -Service $pidFile.BaseName -ProcessId $stored
      Stop-Process -Id $stored -Force -ErrorAction Stop
      $stoppedOwnedProcess = $true
      Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
    }
  }

  if ($stoppedOwnedProcess) { Start-Sleep -Milliseconds 500 }

  # Never infer ownership from a TCP port.  Anything still listening after the
  # verified PID cleanup belongs to an unknown/stale service and must be left
  # alone for the operator to inspect.
  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in 3210, 3212 } |
      Sort-Object LocalPort, OwningProcess -Unique
  )
  if ($listeners.Count -gt 0) {
    $details = foreach ($listener in $listeners) {
      $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      $ownerName = if ($owner) { $owner.ProcessName } else { "未知进程" }
      "端口 $($listener.LocalPort)：PID $($listener.OwningProcess) ($ownerName)"
    }
    throw "PartGo 未启动：所需端口已被其他程序占用，启动器不会自动结束它。请先确认并关闭对应程序。`n$($details -join [Environment]::NewLine)"
  }
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
$existingTarget = Get-RunningPartGoTarget
if ($existingTarget) {
  if (-not $NoBrowser) {
    Start-Process $url
  }
  Write-Host "PartGo $Mode 已在运行：$url"
  Write-Host "串口：$Port；后台 PID：$($existingTarget.ProcessId)"
  exit 0
}
Stop-PartGoServices

if ($Mode -eq "Management") {
  $env:PARTGO_DEVICE_MODE = "hardware"
  $env:PARTGO_SERIAL_PORT = $Port
  $env:PARTGO_SERIAL_BAUD = "115200"
  $env:PARTGO_PYTHON = $serialPython
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
