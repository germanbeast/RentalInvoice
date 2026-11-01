@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Beckhome TV-Box zuruecksetzen

set PKG=com.beckhome.tvwelcome
set ADB=adb
where adb >nul 2>nul
if errorlevel 1 set "ADB=%~dp0platform-tools\adb.exe"
if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"

set BOX=
if exist "%~dp0box-ip.txt" set /p BOX=<"%~dp0box-ip.txt"
set INPUT=
set /p INPUT=IP-Adresse der Box (Enter = %BOX%): 
if not "%INPUT%"=="" set BOX=%INPUT%
echo %BOX%| find ":" >nul || set BOX=%BOX%:5555

"%ADB%" connect %BOX%
echo Beende Kiosk-Modus ...
"%ADB%" -s %BOX% shell am start -n %PKG%/.MainActivity --ez exit_kiosk true
timeout /t 3 >nul

echo Schalte den urspruenglichen Startbildschirm wieder ein ...
if exist "%~dp0deaktivierte-launcher.txt" (
  for /f "usebackq delims=" %%p in ("%~dp0deaktivierte-launcher.txt") do (
    echo   %%p
    "%ADB%" -s %BOX% shell pm enable %%p
  )
)
"%ADB%" -s %BOX% shell cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME

set DEL=
set /p DEL=Welcome-App auch deinstallieren? (j/N): 
if /i "%DEL%"=="j" "%ADB%" -s %BOX% uninstall %PKG%

echo.
echo Fertig. Die Box nutzt wieder ihren normalen Startbildschirm.
pause
