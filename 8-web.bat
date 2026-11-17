@echo off
cd /d "%~dp0"
echo Starting the Sudyar web page...
docker compose up -d --build web
echo.
echo Opening http://127.0.0.1:8080 in your browser.
start "" http://127.0.0.1:8080
pause
