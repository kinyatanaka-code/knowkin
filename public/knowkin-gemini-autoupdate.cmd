@echo off
chcp 65001 >nul
rem knowkin for Gemini: install + auto update from GitHub (every 15 min)
set D=%LOCALAPPDATA%\knowkin-gemini-updater
mkdir "%D%" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/kinyatanaka-code/knowkin/main/ext/gemini-updater.ps1' -OutFile '%D%\update.ps1'"
powershell -NoProfile -ExecutionPolicy Bypass -File "%D%\update.ps1"
schtasks /Create /F /SC MINUTE /MO 15 /TN "knowkin-gemini-update" /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%D%\update.ps1\""
echo.
echo knowkin for Gemini: %LOCALAPPDATA%\knowkin-gemini
echo Chrome: chrome://extensions / Developer mode ON / Load unpacked / choose this folder (first time only)
explorer "%LOCALAPPDATA%\knowkin-gemini"
pause
