@echo off
rem
rem Double-click this file to start the FTC Driving Simulator.
rem
rem It finds whatever web server tool your computer already has, starts the
rem simulator, and opens your browser. Nothing gets installed.
rem
setlocal

cd /d "%~dp0"

cls
echo.
echo   ================================================
echo      FTC Driving Simulator
echo   ================================================
echo.

set PORT=8080
set URL=http://127.0.0.1:%PORT%/

rem Node is preferred: it runs the project's own server, which opens the
rem browser and moves to a free port by itself if 8080 is taken.
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Starting ^(using Node^)...
    echo.
    node tools\serve.js --port %PORT%
    goto :end
)

where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Starting ^(using Python^)...
    echo.
    call :running
    start "" "%URL%"
    python -m http.server %PORT% --bind 127.0.0.1
    goto :end
)

where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Starting ^(using Python^)...
    echo.
    call :running
    start "" "%URL%"
    py -m http.server %PORT% --bind 127.0.0.1
    goto :end
)

echo   This computer does not have a web server tool installed yet.
echo.
echo   You have two options:
echo.
echo   1. Easiest: use the online version instead. No install needed.
echo      Ask your team lead for the link, or see README.md.
echo.
echo   2. Install Node once, then this file will work forever:
echo      Go to  https://nodejs.org  and download the LTS version.
echo.
pause
goto :end

:running
echo   The simulator is running at:
echo.
echo       %URL%
echo.
echo   Your browser should open automatically.
echo.
echo   Leave this window open while you drive.
echo   To stop, close this window or press Control-C.
echo.
exit /b

:end
endlocal
