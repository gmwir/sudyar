@echo off
cd /d "%~dp0"
docker compose exec worker python -m sudyar radar-once
pause
