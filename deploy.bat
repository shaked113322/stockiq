@echo off
cd /d "%~dp0"
echo.
echo ============================
echo   StockIQ  ^|  Deploy
echo ============================
echo.

git add -A

git diff --cached --quiet
if %errorlevel%==0 (
  echo [INFO] No new changes to commit.
  echo        Pushing anyway in case something is pending...
) else (
  echo [OK] Changes detected — committing...
  git commit -m "update %date% %time%"
)

git push
if %errorlevel%==0 (
  echo.
  echo [DONE] Render will auto-deploy in ~60 seconds.
  echo        Check: https://dashboard.render.com
) else (
  echo.
  echo [ERROR] Push failed. Check your internet / GitHub connection.
)

echo.
pause
