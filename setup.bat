@echo off
chcp 65001 >nul 2>&1
title FirstClaw Installer
color 0A

echo.
echo  ============================================
echo       FirstClaw One-Click Setup
echo  ============================================
echo.
echo  This will automatically:
echo    1. Check / install Node.js (^>=22)
echo    2. Check / install pnpm
echo    3. Install project dependencies
echo    4. Build the project
echo.
echo  Estimated time: 5-15 minutes.
echo  Make sure you have an internet connection.
echo.
echo  Press any key to start, or close this window to cancel ...
pause >nul

:: Run the PowerShell bootstrap script
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\bootstrap.ps1"

if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [ERROR] Setup failed. Please check the errors above.
    echo  Contact your project admin for help.
    echo.
    pause
    exit /b 1
)

echo.
echo  Setup complete! Press any key to close ...
pause >nul
