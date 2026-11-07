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
echo IP-Adresse der Box, bei "Debugging ueber WLAN" mit dem dort angezeigten Port (z.B. 192.168.86.74:41567).
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

rem ---------- koppeln (Debugging ueber WLAN, Android 11+) ----------
echo.
echo Zeigt die Box unter "Debugging ueber WLAN" eine Adresse mit langem Port (z.B. :41567),
echo muss sie einmal gekoppelt werden: dort "Geraet mit Kopplungscode koppeln" waehlen.
echo Bei schon gekoppelter Box oder klassischem Port 5555 einfach Enter druecken.
set PAIR=
set /p PAIR=Kopplungs-Adresse vom Fernseher (IP:Port, Enter = ueberspringen): 
if "%PAIR%"=="" goto connect
set CODE=
set /p CODE=6-stelliger Kopplungscode: 
"%ADB%" pair %PAIR% %CODE%
if errorlevel 1 (
  echo Koppeln hat nicht geklappt. Code und Port laufen schnell ab, bitte neu anzeigen lassen.
  pause
  exit /b 1
)

:connect
rem ---------- verbinden ----------
echo.
echo Verbinde mit %BOX% ...
echo Falls der Fernseher "Debugging zulassen?" fragt: bestaetigen (Haken bei "Immer zulassen").
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
rem Selbst-Updates (Freigabe im Admin unter Einstellungen -> TV-Box)
"%ADB%" -s %BOX% shell appops set %PKG% REQUEST_INSTALL_PACKAGES allow >nul 2>nul
rem Ruhe-Erkennung: nach 4 Stunden ohne Tastendruck zurueck zum Welcome-Screen (Bedienungshilfe)
"%ADB%" -s %BOX% shell pm grant %PKG% android.permission.WRITE_SECURE_SETTINGS >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure enabled_accessibility_services %PKG%/.KeyWatchService >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure accessibility_enabled 1 >nul 2>nul
"%ADB%" -s %BOX% shell cmd package set-home-activity %PKG%/.MainActivity >nul 2>nul
"%ADB%" -s %BOX% shell pm set-home-activity %PKG%/.MainActivity >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure screensaver_enabled 0 >nul 2>nul
"%ADB%" -s %BOX% shell settings put secure sleep_timeout 0 >nul 2>nul
"%ADB%" -s %BOX% shell settings put system screen_off_timeout 2147483647 >nul 2>nul
"%ADB%" -s %BOX% shell settings put global stay_on_while_plugged_in 7 >nul 2>nul
rem WLAN nie schlafen legen (Dauerbetrieb)
"%ADB%" -s %BOX% shell settings put global wifi_sleep_policy 2 >nul 2>nul
rem Fernseher aus = Box schlaeft mit (HDMI-CEC), danach zeigt die App wieder den Welcome-Screen
"%ADB%" -s %BOX% shell settings put global hdmi_control_enabled 1 >nul 2>nul
"%ADB%" -s %BOX% shell settings put global hdmi_control_auto_device_off_enabled 1 >nul 2>nul

rem ---------- PIN fuer die App-Einstellungen ----------
echo.
echo Die Einstellungen der Welcome-App (Zurueck-Taste 10 Sek. halten) sind mit einer PIN geschuetzt.
echo Dort gibt es auch WLAN-Einstellungen, Android-Einstellungen und "Kiosk beenden".
set PIN=
set /p PIN=PIN festlegen (nur Ziffern, Enter = bisherige behalten): 

rem ---------- Kiosk-Modus ----------
echo.
"%ADB%" -s %BOX% shell dpm list-owners 2>nul | find "%PKG%" >nul
if not errorlevel 1 goto owner_ok
echo Echter Kiosk-Modus: nur Welcome-Screen und Fernsehen lassen sich oeffnen,
echo Home fuehrt immer zum Welcome-Screen, der normale Startbildschirm bleibt erhalten.
echo (Klappt nur, wenn auf der Box KEIN Google-Konto angemeldet ist.)
set KIOSK=
set /p KIOSK=Echten Kiosk-Modus einschalten? (J/n): 
if /i "%KIOSK%"=="n" goto disable_launchers
"%ADB%" -s %BOX% shell dpm set-device-owner %PKG%/.AdminReceiver
"%ADB%" -s %BOX% shell dpm list-owners 2>nul | find "%PKG%" >nul
if not errorlevel 1 goto owner_ok
echo Kiosk-Modus hat nicht geklappt ^(meist wegen angemeldetem Google-Konto^).

:disable_launchers
rem Ohne Kiosk-Modus: bisherigen Startbildschirm abschalten, damit Home zum Welcome-Screen fuehrt
echo.
echo Schalte den bisherigen Startbildschirm ab, damit die Home-Taste
echo immer zum Welcome-Screen fuehrt (rueckgaengig mit TV-Box-zuruecksetzen.bat) ...
"%ADB%" -s %BOX% shell "for p in $(cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | grep / | cut -d/ -f1 | sort -u); do case $p in %PKG%|com.android.settings|com.android.tv.settings|com.google.android.tvsetup|com.android.provision) ;; *) pm disable-user --user 0 $p >/dev/null 2>&1 && echo $p;; esac; done" >"%TEMP%\bh_launcher.txt"
type "%TEMP%\bh_launcher.txt" >>"%~dp0deaktivierte-launcher.txt"
for /f "usebackq delims=" %%p in ("%TEMP%\bh_launcher.txt") do echo   abgeschaltet: %%p
goto start_app

:owner_ok
echo Kiosk-Modus ist aktiv.
rem Frueher abgeschaltete Startbildschirme wieder einschalten, der Kiosk-Modus braucht das nicht
if exist "%~dp0deaktivierte-launcher.txt" (
  for /f "usebackq delims=" %%p in ("%~dp0deaktivierte-launcher.txt") do "%ADB%" -s %BOX% shell pm enable %%p >nul 2>nul
  del "%~dp0deaktivierte-launcher.txt"
)

:start_app
echo.
echo Starte Welcome-Screen mit %SERVER% ...
set PINARG=
if not "%PIN%"=="" set PINARG=--es admin_pin %PIN%
"%ADB%" -s %BOX% shell am force-stop %PKG% >nul 2>nul
"%ADB%" -s %BOX% shell am start -n %PKG%/.MainActivity --es server_url %SERVER% %PINARG%

echo.
echo ============================================
echo Fertig. Die Box zeigt jetzt den Welcome-Screen und startet ihn nach dem Einschalten.
echo.
echo Einstellungen in der App: Zurueck-Taste 10 Sekunden halten, dann PIN.
echo Alles rueckgaengig machen: TV-Box-zuruecksetzen.bat
echo ============================================
pause
