@echo off
setlocal
cd /d "%~dp0"
title Beat Track Studio - Portable Source Backend
color 0B

if not exist "runtime\python.exe" (
    echo [ERROR] Portable Python runtime is missing.
    pause
    exit /b 1
)

set "PATH=%CD%\runtime;%CD%\runtime\Library\bin;%CD%\runtime\Scripts;%PATH%"

if not exist "runtime\.portable_ready" (
    echo [SETUP] Relocating the portable Python environment...
    "runtime\python.exe" "runtime\Scripts\conda-unpack-script.py"
    if errorlevel 1 (
        echo [ERROR] Environment relocation failed.
        pause
        exit /b 1
    )
    echo ready>"runtime\.portable_ready"
)

echo ============================================================
echo   Beat Track Studio - Portable Source
echo   URL: http://127.0.0.1:8765
echo   Close this window to stop the backend.
echo ============================================================
echo.

start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8765'"
"runtime\python.exe" -u webui_server.py

echo.
echo [STOPPED] Backend process has exited.
pause
endlocal
