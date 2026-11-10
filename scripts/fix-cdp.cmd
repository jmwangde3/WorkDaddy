@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
echo ==========================================================
echo  WorkDaddy CDP one-click restore
echo  Restarts WorkBuddy with --remote-debugging-port=9222.
echo  The WorkBuddy window will close and reopen automatically.
echo ==========================================================
echo.

set "DAEMON=http://127.0.0.1:47832"
set "CDP=http://127.0.0.1:9222"

echo [1/4] Checking daemon on 47832 ...
curl.exe -s --max-time 3 %DAEMON%/api/status > "%TEMP%\wd-status.json" 2>nul
if errorlevel 1 (
  echo   ERROR: daemon not reachable on 47832.
  echo   Start WorkDaddy first (double-click desktop WorkDaddy.lnk
  echo   or run scripts\launcher.cmd), then run this script again.
  echo.
  pause
  exit /b 1
)
echo   daemon OK.

echo [2/4] Checking CDP on 9222 ...
curl.exe -s --max-time 3 %CDP%/json/version >nul 2>nul
if not errorlevel 1 (
  echo   CDP already up, nothing to do.
  goto :done
)
echo   CDP down - will relaunch client.

echo [3/4] POST /api/client/relaunch ...
curl.exe -s -X POST %DAEMON%/api/client/relaunch
echo.
echo   WorkBuddy is restarting. Please wait up to 40s ...

echo [4/4] Waiting for CDP 9222 ...
set /a TRIES=0
:wait
set /a TRIES+=1
curl.exe -s --max-time 3 %CDP%/json/version > "%TEMP%\wd-cdp.json" 2>nul
if not errorlevel 1 (
  echo   CDP is UP after ~!TRIES! tries.
  type "%TEMP%\wd-cdp.json"
  echo.
  goto :done
)
if !TRIES! GEQ 20 (
  echo   TIMEOUT: CDP still unreachable after 40s.
  echo.
  echo   Manual fallback:
  echo     1. Fully quit WorkBuddy ^(including tray ^& background^).
  echo     2. powershell -Command "Start-Process 'H:\Program Files\WorkBuddy\WorkBuddy.exe' -ArgumentList '--remote-debugging-port=9222'"
  echo     3. Check: curl.exe -s http://127.0.0.1:9222/json/version
  echo.
  pause
  exit /b 2
)
timeout /t 2 >nul
goto :wait

:done
echo.
echo === daemon status ===
curl.exe -s %DAEMON%/api/status
echo.
echo.
echo Done. Refresh the WorkBuddy window; the robot button should appear.
echo.
pause
