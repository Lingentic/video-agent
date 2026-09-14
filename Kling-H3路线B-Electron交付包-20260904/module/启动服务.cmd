@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.scripts\start-service.ps1"
if errorlevel 1 (
  echo.
  echo Service failed to start. Check .runtime\service-error.log.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:8794/"
endlocal
