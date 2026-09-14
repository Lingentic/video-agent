@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.scripts\stop-service.ps1"
if errorlevel 1 pause
endlocal
