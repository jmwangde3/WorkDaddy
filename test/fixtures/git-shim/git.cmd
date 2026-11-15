@echo off
REM Git shim for build-package failure-injection tests (stage 2).
REM Never touches a real repository: it either prints canned output or forwards
REM to the real git binary named by WD_REAL_GIT.
node "%~dp0git-shim.js" %*
exit /b %ERRORLEVEL%
