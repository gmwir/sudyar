@echo off
cd /d "%~dp0"
echo Reading stock, invoices, payouts, ship-by-seller orders and promotions (read-only)...
docker compose exec worker python -m sudyar inventory-sync
docker compose exec worker python -m sudyar finance-sync
docker compose exec worker python -m sudyar sbs-sync
docker compose exec worker python -m sudyar promo-sync
echo.
docker compose exec worker python -m sudyar low-stock
docker compose exec worker python -m sudyar finance-show
docker compose exec worker python -m sudyar promo-show
pause
