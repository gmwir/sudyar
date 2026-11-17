@echo off
cd /d "%~dp0"
echo Starting the pricing bot (runs every 15 minutes).
echo It changes prices ONLY if WRITE_MODE=live is in the .env file.
docker compose --profile bot up -d --build
pause
