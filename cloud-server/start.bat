@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Quick Phrase AI 云存档服务器（http://127.0.0.1:8787）...
echo 按 Ctrl+C 可停止服务。
echo.
node server.js
pause
