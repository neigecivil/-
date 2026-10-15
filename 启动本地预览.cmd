@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 资源分享站 · 本地预览

set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"
if not defined NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE (
  echo.
  echo   没找到 Node.js，本地预览起不来。
  echo   可以到 https://nodejs.org 装一个，再双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动本地预览，浏览器会自动打开 http://127.0.0.1:4330
echo   账号和文件都留在 .devdata\ 里，关掉再开还是这些数据。
echo   想清空重来：删掉 .devdata 文件夹再启动一次。
echo.
echo   这个窗口别关，关了网站就停了。
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:4330"
"%NODE%" tools\dev.mjs

echo.
echo   本地预览已停止。
pause