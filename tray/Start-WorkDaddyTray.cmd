@echo off
rem ============================================================
rem  WorkDaddy tray launcher - double-click to show the tray icon.
rem  The tray is a single-instance app; running twice is harmless.
rem  Rebuild after editing WorkDaddyTray.cs: run build.cmd
rem ============================================================
chcp 65001 >nul 2>&1
setlocal
set "EXE=%~dp0WorkDaddyTray.exe"
if not exist "%EXE%" (
  echo ERROR: WorkDaddyTray.exe not found. Run build.cmd first.
  pause
  exit /b 1
)
start "" "%EXE%"
exit /b 0
