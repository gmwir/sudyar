@echo off
cd /d "%~dp0"
echo Put your file (xlsx or csv) in the "data" folder first.
set /p F=Type the file name (for example costs.xlsx): 
echo.
echo --- Test run (nothing is saved) ---
docker compose exec worker python -m sudyar import-costs "/data/%F%" --dry-run
echo.
set /p OK=Looks fine? Type YES to save: 
if /i "%OK%"=="YES" docker compose exec worker python -m sudyar import-costs "/data/%F%"
pause
