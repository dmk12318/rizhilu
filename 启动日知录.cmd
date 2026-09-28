@echo off
chcp 65001 >nul
title Rizhilu - Daily News
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  Keep this file ASCII-only. cmd.exe parses .cmd files using the
rem  OEM code page (GBK on Chinese Windows), so UTF-8 Chinese text
rem  here would be read as garbage commands. All Chinese messages
rem  live in scripts\launcher.mjs instead.
rem ---------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install it first:
  echo   https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the reader. Keep this window open while reading;
echo   close it to stop the service.
echo.

node "scripts\launcher.mjs" %*

echo.
pause
