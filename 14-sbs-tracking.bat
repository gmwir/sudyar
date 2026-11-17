@echo off
cd /d "%~dp0"
echo Put your file (xlsx or csv) in the "data" folder first. Columns: shipment_id, tracking_code
set /p F=Type the file name (for example tracking.xlsx): 
docker compose exec worker python -m sudyar sbs-tracking "%F%"
pause
