@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" goto missing

start "" "%CD%\node_modules\electron\dist\electron.exe" .
exit /b 0

:missing
echo Electron is not installed. Run npm install in this folder first.
pause
exit /b 1
