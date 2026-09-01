@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM  FreeVoices - build the web app and the server deploy bundle.
REM
REM    build-web.cmd              build + bundle + sync Android
REM    build-web.cmd --no-android build + bundle only
REM
REM  Run it from anywhere: it cd's to its own directory first, so being in the
REM  repo root (where there is no "build" script) cannot bite you.
REM
REM  `call` is required in front of npm/npx: they are themselves .cmd scripts,
REM  and without `call` this batch file would terminate at the first one.
REM ============================================================================

cd /d "%~dp0"

set SKIP_ANDROID=0
if /i "%~1"=="--no-android" set SKIP_ANDROID=1

echo.
echo ============================================================
echo  FreeVoices web build
echo  %CD%
echo ============================================================

REM --- 1. Angular production build -------------------------------------------
echo.
echo [1/3] Building the Angular app (production)...
call npm run build
if errorlevel 1 goto :buildfail

if not exist "www\index.html" (
  echo.
  echo   ERROR: www\index.html was not produced. Build did not complete.
  goto :fail
)

REM --- 2. Server deploy bundle ------------------------------------------------
echo.
echo [2/3] Assembling the server deploy bundle...
call node scripts\build-deploy-bundle.js
if errorlevel 1 goto :bundlefail

REM --- 3. Push the new web assets into the native project --------------------
REM  The Android app serves a COPY of www taken at sync time. Skipping this is
REM  why a rebuilt web app can appear to change nothing on a device.
echo.
if "%SKIP_ANDROID%"=="1" (
  echo [3/3] Skipping Android sync ^(--no-android^).
  echo       The native app will keep running the previously synced bundle.
) else (
  if exist "android\" (
    echo [3/3] Syncing the Android project...
    call npx cap sync android
    if errorlevel 1 goto :syncfail
  ) else (
    echo [3/3] No android\ directory - skipping native sync.
  )
)

echo.
echo ============================================================
echo  Done.
echo ============================================================
echo.
echo  Web app:       www\
echo  Deploy bundle: deploy\freevoices-server.tar.gz
echo.
echo  To deploy the server:
echo    1. Delete www\ inside /home/freevoic/freevoices on the host
echo    2. Upload and extract deploy\freevoices-server.tar.gz there
echo    3. Delete the uploaded archive
echo    4. Restart the Node app, then hard-refresh the browser
echo.
echo  Deleting www\ first matters: filenames are content-hashed, so extracting
echo  over the top leaves the previous build's bundles behind as dead weight.
echo.
goto :eof

:buildfail
echo.
echo   ERROR: the Angular build failed. Nothing was bundled or synced.
goto :fail

:bundlefail
echo.
echo   ERROR: building the deploy bundle failed.
echo   The web build in www\ is fine; only the archive is missing.
goto :fail

:syncfail
echo.
echo   ERROR: `npx cap sync android` failed.
echo   The web build and the deploy bundle are both fine - the native
echo   project just did not get the new assets.
goto :fail

:fail
echo.
exit /b 1
