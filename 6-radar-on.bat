@echo off
cd /d "%~dp0"
docker compose --profile radar up -d --build
pause
