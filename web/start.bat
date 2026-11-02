@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   技术标数据底座 · 数据浏览器
echo   ----------------------------------------
echo   启动后浏览器打开：http://127.0.0.1:8421/
echo   按 Ctrl+C 停止
echo.
python server.py 8421
pause
