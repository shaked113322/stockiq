@echo off
cd /d "%~dp0"
echo Pushing to GitHub...
git add .
git commit -m "update %date% %time%"
git push
echo.
echo Done! Render will auto-deploy in ~1 minute.
pause
