@echo off
rem ============================================================
rem  WorkDaddyTray.exe build script
rem  Uses the .NET Framework 4.x compiler shipped with Windows.
rem  No Visual Studio, no NuGet, no SDK required.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo ERROR: csc.exe not found under %WINDIR%\Microsoft.NET\Framework64 or Framework.
  exit /b 1
)

set "SRC=%~dp0WorkDaddyTray.cs"
set "OUT=%~dp0WorkDaddyTray.exe"
if not exist "%SRC%" (
  echo ERROR: %SRC% not found.
  exit /b 1
)

echo Compiling WorkDaddyTray.exe ...
"%CSC%" /nologo /target:winexe /optimize+ /codepage:65001 ^
  /out:"%OUT%" ^
  /r:System.dll ^
  /r:System.Core.dll ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Management.dll ^
  "%SRC%"

if errorlevel 1 (
  echo.
  echo BUILD FAILED
  exit /b 1
)

echo.
echo BUILD OK: %OUT%
for %%F in ("%OUT%") do echo Size: %%~zF bytes
exit /b 0
