@echo off
cd /d "%~dp0"
echo Pricing bot: ONE test round. With WRITE_MODE=off nothing is sent, decisions are only shown.
docker compose exec worker python -m sudyar reprice-once
pause
