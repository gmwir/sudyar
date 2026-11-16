@echo off
cd /d "%~dp0"
echo Put your file (xlsx or csv) in the "data" folder first.
echo Columns: variant_id and price_toman / seller_stock / lead_time / maximum_per_order
set /p F=Type the file name (for example prices.xlsx): 
docker compose exec worker python -m sudyar bulk-update "%F%"
pause
