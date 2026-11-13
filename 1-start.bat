@echo off
cd /d "%~dp0"
echo Starting Sudyar... (the first time takes a few minutes)
docker compose up -d --build
echo.
echo Done. You can close this window.
pause
