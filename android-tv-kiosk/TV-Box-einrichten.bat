@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Beckhome TV-Box einrichten

set PKG=com.beckhome.tvwelcome
set SERVER=https://beckhome.cloud
set APK_URL=https://github.com/germanbeast/RentalInvoice/releases/download/tvbox/beckhome-tv.apk
set APK=%~dp0beckhome-tv.apk
set ADB=adb

echo ============================================
echo   Beckhome TV-Box: Welcome-Screen einrichten
echo ============================================
echo.
echo Vorher auf der Box: Entwickleroptionen an, USB-Debugging an
echo (und falls vorhanden "ADB ueber Netzwerk" / "Netzwerk-Debugging").
echo Box und PC muessen im selben WLAN sein.
echo.

rem ---------- adb suchen oder herunterladen ----------
where adb >nul 2>nul
if not errorlevel 1 goto adb_ok
if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
  set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
  goto adb_ok
)
if not exist "%~dp0platform-tools\adb.exe" (
  echo adb nicht gefunden, lade Google Platform-Tools herunter ...
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest https://dl.google.com/android/repository/platform-tools-latest-windows.zip -OutFile platform-tools.zip; Expand-Archive platform-tools.zip -DestinationPath . -Force"
)
set "ADB=%~dp0platform-tools\adb.exe"
:adb_ok
echo Verwende: %ADB%
echo.

rem ---------- IP-Adresse der Box ----------
set BOX=
if exist "%~dp0box-ip.txt" set /p BOX=<"%~dp0box-ip.txt"
set INPUT=
set /p INPUT=IP-Adresse der Box (Enter = %BOX%): 
if not "%INPUT%"=="" set BOX=%INPUT%
if "%BOX%"=="" (
  echo Keine IP-Adresse eingegeben.
  pause
  exit /b 1
)
echo %BOX%| find ":" >nul || set BOX=%BOX%:5555
>"%~dp0box-ip.txt" echo %BOX%

rem ---------- neueste App herunterladen ----------
echo.
echo Lade die neueste Welcome-App herunter ...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; try { Invoke-WebRequest '%APK_URL%' -OutFile '%APK%.neu' -UseBasicParsing; Move-Item -Force '%APK%.neu' '%APK%' } catch { Write-Host 'Download fehlgeschlagen:' $_.Exception.Message }"
if not exist "%APK%" (
  echo FEHLER: beckhome-tv.apk fehlt und konnte nicht geladen werden.
  pause
  exit /b 1
)

rem ---------- verbinden ----------
echo.
echo Verbinde mit %BOX% ...
echo Auf dem Fernseher "USB-Debugging zulassen?" bestaetigen (Haken bei "Immer zulassen").
"%ADB%" disconnect %BOX% >nul 2>nul
"%ADB%" connect %BOX%
set TRIES=0
:wait_device
set STATE=
"%ADB%" -s %BOX% get-state >"%TEMP%\bh_adb.txt" 2>nul
set /p STATE=<"%TEMP%\bh_adb.txt"
if "%STATE%"=="device" goto connected
set /a TRIES+=1
if %TRIES% GEQ 12 (
  echo.
  echo FEHLER: Keine Verbindung zur Box. Pruefe IP-Adresse, WLAN und ob USB-Debugging an ist.
  "%ADB%" devices
  pause
  exit /b 1
)
echo Warte auf Freigabe am Fernseher ...
timeout /t 5 >nul
"%ADB%" connect %BOX% >nul 2>nul
goto wait_device
:connected
echo Verbunden.
"%ADB%" -s %BOX% shell getprop ro.product.model >"%TEMP%\bh_adb.txt"
set /p MODEL=<"%TEMP%\bh_adb.txt"
"%ADB%" -s %BOX% shell getprop ro.build.version.release >"%TEMP%\bh_adb.txt"
set /p ANDROID=<"%TEMP%\bh_adb.txt"
echo Box: %MODEL%, Android %ANDROID%

rem ---------- installieren ----------
echo.
echo Installiere App ...
"%ADB%" -s %BOX% install -r "%APK%"
if errorlevel 1 (
  echo Alte Version mit anderer Signatur gefunden, installiere neu ...
  "%ADB%" -s %BOX% shell am start -n %PKG%/.MainActivity --ez exit_kiosk true >nul 2>nul
  timeout /t 2 >nul
  "%ADB%" -s %BOX% uninstall %PKG%
  "%ADB%" -s %BOX% install "%APK%"
  if errorlevel 1 (
    echo FEHLER: Installation fehlgeschlagen.
    pause
    exit /b 1
  )
)

rem ---------- Box als Welcome-Screen einstellen ----------
echo.
echo Stelle die Box ein ...
"%ADB%" -s %BOX% shell appops set %PKG% SYSTEM_ALERT_WINDOW allow >nul 2>nul
"%ADB%" -s %BOX% shell cmd package set-home-activity %PKG%/.MainActivity >nul 2>nul
"%ADB%" -s %BOX% shell pm set-home-activity %PKG%/.MainActivity >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure screensaver_enabled 0 >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure sleep_timeout 0 >nul 2>nul
"%ADB%" -s %BOX% shell settings put system screen_off_timeout 2147483647 >nul 2>nul
"%ADB%" -s %BOX% shell settings put global stay_on_while_plugged_in 7 >nul 2>nul

rem ---------- optional: echter Kiosk-Modus ----------
echo.
echo Echter Kiosk-Modus sperrt Home/Zurueck auf der Fernbedienung,
echo so dass Gaeste den Welcome-Screen nicht verlassen koennen.
echo (Klappt nur, wenn auf der Box KEIN Google-Konto angemeldet ist.)
set KIOSK=
set /p KIOSK=Echten Kiosk-Modus einschalten? (j/N): 
if /i not "%KIOSK%"=="j" goto start_app
"%ADB%" -s %BOX% shell dpm set-device-owner %PKG%/.AdminReceiver
if errorlevel 1 (
  echo Hat nicht geklappt, die App laeuft trotzdem als Startbildschirm.
)

:start_app
echo.
echo Starte Welcome-Screen mit %SERVER% ...
"%ADB%" -s %BOX% shell am force-stop %PKG% >nul 2>nul
"%ADB%" -s %BOX% shell am start -n %PKG%/.MainActivity --es server_url %SERVER%

echo.
echo ============================================
echo Fertig. Die Box zeigt jetzt den Welcome-Screen und startet ihn nach dem Einschalten.
echo.
echo Einstellungen in der App: Menue-Taste der Fernbedienung oder OK ca. 3 Sekunden halten.
echo Kiosk wieder beenden:
echo   "%ADB%" -s %BOX% shell am start -n %PKG%/.MainActivity --ez exit_kiosk true
echo ============================================
pause
