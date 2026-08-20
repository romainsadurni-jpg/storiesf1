@echo off
start "Stories Server" cmd /k "cd /d C:\Users\romai\stories && npm run dev"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3004"
