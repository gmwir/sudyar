@echo off
cd /d "%~dp0"
echo Creating the settings file (.env)...
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\make-env.ps1"
echo.
pause
