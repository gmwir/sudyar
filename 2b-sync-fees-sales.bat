@echo off
cd /d "%~dp0"
echo Reading Digikala commissions...
docker compose exec worker python -m sudyar sync-fees
echo.
echo Reading sales of the last 30 days...
docker compose exec worker python -m sudyar sales-sync --range last_30_days
pause
