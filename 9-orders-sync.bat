@echo off
cd /d "%~dp0"
echo Reading yesterday's real sales from Digikala (read-only)...
docker compose exec worker python -m sudyar orders-sync --days 1 --force
echo.
docker compose exec worker python -m sudyar orders-show
pause
