@echo off
rem ============================================================
rem  WorkDaddy patch deployer - double click to run.
rem
rem  Copies the 12 patched files into your installed WorkDaddy,
rem  rebinds the panel button, and restarts the daemon.
rem
rem  Safe to run repeatedly. Backs up every file it overwrites.
rem ============================================================
setlocal
chcp 65001 >nul 2>&1

if not exist "%~dp0deploy.ps1" (
  echo ERROR: deploy.ps1 not found next to this file.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo Done.
) else (
  echo Finished with exit code %EXITCODE%. Read the messages above.
)
echo.
pause
exit /b %EXITCODE%
