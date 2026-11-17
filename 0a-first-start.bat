@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo First run 0-make-env.bat
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is not running. Open it, wait until it is ready, then run this file again.
  pause
  exit /b 1
)
echo First start of Sudyar. This can take 5-10 minutes the first time...
docker compose up -d --build
if errorlevel 1 (
  echo Start failed. Take a photo of this window.
  pause
  exit /b 1
)
echo Waiting 20 seconds for the database...
timeout /t 20 /nobreak >nul
docker compose exec worker python -m sudyar check-config
echo.
echo If you see "Configuration OK", run 9-orders-sync.bat next.
pause
