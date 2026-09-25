@echo off
rem Starts the StonkFun rewards dashboard on Windows. Double-click it, or run it with --check to check this computer only.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Install the LTS version from https://nodejs.org ^(24.15 or newer^), then double-click this launcher again.
  goto failed
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)"
if errorlevel 1 (
  echo.
  for /f "delims=" %%v in ('node --version') do echo This needs Node.js 24.15 or newer, and this computer has %%v.
  echo Install the LTS version from https://nodejs.org, then double-click this launcher again.
  goto failed
)
node scripts\launch.mjs %*
if errorlevel 1 goto failed
exit /b 0

:failed
rem A double-clicked window stays open so the message can be read; --check from a terminal returns at once.
if /i not "%~1"=="--check" pause
exit /b 1
