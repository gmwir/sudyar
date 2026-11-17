@echo off
cd /d "%~dp0"
docker compose --profile radar down
pause
