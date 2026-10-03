@echo off
title Chefdoms server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed ^(or not on your PATH^).
  echo   Get the LTS version from https://nodejs.org , install it, then run this file again.
  echo.
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo   Your Node.js is too old. Chefdoms needs Node.js 18 or newer: https://nodejs.org
  echo.
  pause
  exit /b 1
)
node server.js --open %*
echo.
echo   The Chefdoms server has stopped.
pause
