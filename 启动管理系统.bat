@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PARTGO_PORT=COM9"
if not "%~1"=="" if /I not "%~1"=="--check" set "PARTGO_PORT=%~1"

if /I "%~1"=="--check" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\partgo_launcher.ps1" -Mode Management -Port "%PARTGO_PORT%" -CheckOnly
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\partgo_launcher.ps1" -Mode Management -Port "%PARTGO_PORT%"
)

if errorlevel 1 (
  echo.
  echo PartGo management system failed to start.
  pause
  exit /b 1
)
exit /b 0
