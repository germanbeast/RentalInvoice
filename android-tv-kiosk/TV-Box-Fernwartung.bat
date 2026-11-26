@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Beckhome TV-Box: Fernwartung einschalten

set ADB=adb

echo ============================================
echo   Beckhome TV-Box: ADB ueber Netzwerk einschalten
echo ============================================
echo.
echo Damit klappt die Fernwartung im Admin (Live-Bild + Steuerung im Browser).
echo Noetig einmal nach der Einrichtung und nach einem Neustart der Box,
echo falls die Box die Einstellung nicht dauerhaft speichert.
echo PC und Box muessen im selben Netz sein.
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
  echo FEHLER: Keine Verbindung zur Box. Pruefe IP-Adresse, Netz und ob USB-Debugging an ist.
  echo Nach einem Neustart der Box ist oft nur "Debugging ueber WLAN" mit neuem Port an:
  echo dann die dort angezeigte Adresse mit Port eingeben.
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
"%ADB%" -s %BOX% shell setprop persist.adb.tcp.port 5555 >nul 2>nul
"%ADB%" -s %BOX% shell getprop persist.adb.tcp.port >"%TEMP%\bh_adb.txt" 2>nul
set PERSIST=
set /p PERSIST=<"%TEMP%\bh_adb.txt"
"%ADB%" -s %BOX% tcpip 5555
echo.
echo ============================================
if "%PERSIST%"=="5555" (
  echo Fertig. ADB ueber Netzwerk ist an und bleibt auch nach einem Neustart an.
) else (
  echo Fertig. ADB ueber Netzwerk ist an, bis die Box neu startet.
)
echo.
echo Im Admin: Einstellungen - TV-Box - Fernwartung.
echo Innerhalb einer Minute steht dort "ADB ueber Netzwerk auf der Box: an".
echo Beim ersten Mal fragt der Fernseher "USB-Debugging zulassen?":
echo Haken bei "Immer von diesem Computer zulassen" setzen und OK druecken.
echo ============================================
pause
