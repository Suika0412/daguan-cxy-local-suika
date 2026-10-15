@echo off
setlocal
cd /d "%~dp0"

set "release_dir=%~dp0..\daguan-math-v1.1.6-release"
set "apk_name=daguan-math-community-v1.1.6.apk"
if exist "android\key.properties" set "apk_name=daguan-math-v1.1.6.apk"

where flutter.bat >nul 2>nul
if errorlevel 1 goto flutter_missing

where java.exe >nul 2>nul
if errorlevel 1 goto java_missing

where node.exe >nul 2>nul
if errorlevel 1 goto node_missing

echo [1/7] Preparing offline question images...
call node tool\prepare-question-images.mjs
if errorlevel 1 goto failed

echo [2/7] Verifying offline assets...
call node tool\verify_project.js
if errorlevel 1 goto failed

echo [3/7] Resolving packages...
call flutter pub get
if errorlevel 1 goto failed

echo [4/7] Analyzing source...
call flutter analyze
if errorlevel 1 goto failed

echo [5/7] Running tests...
call flutter test
if errorlevel 1 goto failed

echo [6/7] Building release APK...
call flutter build apk --release
if errorlevel 1 goto failed

if not exist "build\app\outputs\flutter-apk\app-release.apk" goto failed
echo [7/7] Copying release APK...
if not exist "%release_dir%" mkdir "%release_dir%"
if errorlevel 1 goto failed
copy /y "build\app\outputs\flutter-apk\app-release.apk" "%release_dir%\%apk_name%" >nul
if errorlevel 1 goto failed

echo.
echo Build complete:
echo %release_dir%\%apk_name%
echo.
pause
exit /b 0

:flutter_missing
echo.
echo Flutter was not found. Install Flutter 3.44.8 and add it to PATH.
echo.
pause
exit /b 1

:java_missing
echo.
echo Java was not found. Install JDK 17 and add it to PATH.
echo.
pause
exit /b 1

:node_missing
echo.
echo Node.js was not found. Install Node.js 24 and add it to PATH.
echo It is required to prepare the offline question images before building.
echo.
pause
exit /b 1

:failed
echo.
echo Build failed. Review the error output above.
echo.
pause
exit /b 1
