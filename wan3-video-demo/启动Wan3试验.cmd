@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
set GRADIO_ANALYTICS_ENABLED=False
"C:\Users\17794\miniconda3\envs\facefusion\python.exe" app.py
if errorlevel 1 pause
