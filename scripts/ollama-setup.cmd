@echo off
setlocal enabledelayedexpansion
REM ===========================================================================
REM  Ollama setup for the Job Assistant -- run this ON THE AI MACHINE.
REM
REM  It installs Ollama, makes it listen on the network (not just localhost),
REM  opens the firewall to your LAN only, pulls a model sized to the machine's
REM  RAM, and prints the OLLAMA_BASE_URL to paste into the app's .env.
REM
REM  Run it as Administrator (right-click -> Run as administrator). Setting a
REM  machine-wide environment variable and adding a firewall rule both need it.
REM
REM  Usage:   ollama-setup.cmd  [model]
REM  Example: ollama-setup.cmd  qwen2.5:14b
REM ===========================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: this must run as Administrator.
  echo   Right-click ollama-setup.cmd and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo.
echo ==== Job Assistant :: Ollama setup ========================================
echo.

REM --- 1. Install Ollama, unless it is already here --------------------------
where ollama >nul 2>&1
if %errorlevel%==0 (
  echo [1/6] Ollama is already installed -- skipping the download.
) else (
  echo [1/6] Downloading Ollama for Windows ^(about 700 MB^)...
  set "INSTALLER=%TEMP%\OllamaSetup.exe"
  curl -L --fail --progress-bar -o "!INSTALLER!" https://ollama.com/download/OllamaSetup.exe
  if errorlevel 1 (
    echo       Download failed. Check the connection, or download it by hand from
    echo       https://ollama.com/download/windows and run it, then re-run this script.
    pause
    exit /b 1
  )
  echo       Installing silently...
  "!INSTALLER!" /VERYSILENT /NORESTART
  if errorlevel 1 (
    echo       The installer returned an error. Run "!INSTALLER!" by hand.
    pause
    exit /b 1
  )
  del /q "!INSTALLER!" 2>nul
  REM This shell's PATH predates the install, so add the usual locations. Both
  REM are listed because the installer is per-user, and "Run as administrator"
  REM can mean a different profile than the one that will use the app.
  set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama;%ProgramFiles%\Ollama"
)

REM Find ollama.exe for the restart below -- "where" now that PATH is fixed.
set "OLLAMA_EXE="
for /f "delims=" %%e in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%e"

REM --- 2. Listen on the LAN, not only on loopback ----------------------------
REM  Ollama binds 127.0.0.1 by default, which is correct for a single machine
REM  and useless for this one: the app runs somewhere else. OLLAMA_HOST is set
REM  machine-wide so the background service picks it up on every boot, not just
REM  in this window.
echo [2/6] Binding Ollama to 0.0.0.0:11434 so the other machine can reach it...
setx /M OLLAMA_HOST "0.0.0.0:11434" >nul
set "OLLAMA_HOST=0.0.0.0:11434"

REM  Models stay loaded for 5 minutes by default, so the second request of a
REM  session pays the load cost again. This app fires several in a row.
setx /M OLLAMA_KEEP_ALIVE "30m" >nul
set "OLLAMA_KEEP_ALIVE=30m"

REM --- 3. Firewall: this subnet only, never the whole internet ---------------
REM  The Ollama API has NO authentication. Anyone who can reach port 11434 can
REM  use the model and read every prompt sent to it. LocalSubnet keeps that to
REM  your own network; do not widen it, and do not port-forward 11434.
echo [3/6] Opening TCP 11434 to the local subnet only...
netsh advfirewall firewall delete rule name="Ollama API (Job Assistant)" >nul 2>&1
netsh advfirewall firewall add rule name="Ollama API (Job Assistant)" ^
  dir=in action=allow protocol=TCP localport=11434 remoteip=LocalSubnet profile=private >nul
if errorlevel 1 echo       WARNING: could not add the firewall rule -- add it by hand if the app cannot connect.

REM --- 4. Restart the service so it re-reads OLLAMA_HOST ---------------------
echo [4/6] Restarting Ollama...
taskkill /f /im ollama.exe >nul 2>&1
taskkill /f /im "ollama app.exe" >nul 2>&1
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
  start "" /b "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else if defined OLLAMA_EXE (
  REM No tray app on this install; run the server directly in its own window.
  start "Ollama" /min "!OLLAMA_EXE!" serve
)
REM  The server needs a moment before it will answer.
for /l %%i in (1,1,15) do (
  curl -s --max-time 2 http://127.0.0.1:11434/api/version >nul 2>&1 && goto :up
  timeout /t 1 /nobreak >nul
)
echo       WARNING: Ollama did not answer on 11434. Start it from the Start menu, then re-run.
:up

REM --- 5. Pull a model that fits this machine's RAM --------------------------
set "MODEL=%~1"
if not "%MODEL%"=="" goto :pull

REM  PowerShell rather than wmic: wmic is deprecated and is absent from current
REM  Windows 11 builds, where it would fail silently and pick the smallest model.
set "RAMGB="
for /f "delims=" %%m in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)" 2^>nul') do set "RAMGB=%%m"
if not defined RAMGB set "RAMGB=8"
echo       Detected roughly !RAMGB! GB of RAM.
if !RAMGB! GEQ 32 (
  set "MODEL=qwen2.5:14b"
) else if !RAMGB! GEQ 16 (
  set "MODEL=qwen2.5:7b"
) else (
  set "MODEL=llama3.2:3b"
)

:pull
echo [5/6] Pulling !MODEL! -- this is the long step.
ollama pull !MODEL!
if errorlevel 1 (
  echo       That pull failed. Pick another from https://ollama.com/library and run:
  echo         ollama pull ^<model^>
  pause
  exit /b 1
)

REM --- 6. Report the address to put in the app's .env ------------------------
echo [6/6] Verifying...
ollama list
REM  PowerShell rather than parsing ipconfig: "IPv4 Address" is translated on a
REM  non-English Windows, and findstr would match nothing there at all.
set "LANIP="
REM  No pipe in the PowerShell: a caret inside the quoted command is passed to
REM  PowerShell literally rather than unescaped, so "^|" reaches it as an argument
REM  and the whole lookup silently returns nothing. .Where() does the same job.
REM  Filtering on a default gateway skips WSL, Hyper-V and VPN adapters, which
REM  have an address but do not reach the machine running the app.
for /f "delims=" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetIPConfiguration).Where({$_.IPv4DefaultGateway -ne $null})[0].IPv4Address.IPAddress" 2^>nul') do if not defined LANIP set "LANIP=%%a"
if not defined LANIP set "LANIP=<this machine's IP>"

echo.
echo ==== Done =================================================================
echo.
echo   On the machine that runs the Job Assistant, put this in its .env:
echo.
echo     AI_PROVIDER=ollama
echo     OLLAMA_BASE_URL=http://!LANIP!:11434
echo     OLLAMA_MODEL=!MODEL!
echo.
echo   Check it from that machine first:
echo     curl http://!LANIP!:11434/api/version
echo.
echo   Note: this port has no password. The firewall rule above limits it to
echo   your local network. Do not forward it through your router.
echo.
pause
endlocal
