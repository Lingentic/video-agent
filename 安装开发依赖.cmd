@echo off
setlocal
cd /d "%~dp0"

call npm ci
if errorlevel 1 goto failed

call npm ci --prefix "video-shot-engine-electron-delivery-20260904"
if errorlevel 1 goto failed

echo.
echo Development dependencies installed successfully.
pause
exit /b 0

:failed
echo.
echo Dependency installation failed. Check the error above.
pause
exit /b 1
