@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title OpenClaw Portable - Portable AI Agent

REM Enable ANSI escape codes (Windows 10 1909+). On older builds the
REM trick returns literal "$E" instead of the ESC char — detect and
REM fall back to no-color output so the banner doesn't look garbled.
set "ESC="
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
REM Validate: ESC should be exactly 1 byte (0x1B). If it's longer or
REM empty, the trick failed — clear it so %ESC%[93m becomes just [93m
REM which cmd prints harmlessly (no garbled $E[93m).
if not defined ESC set "ESC="
if defined ESC (
    REM Quick length check: real ESC is 1 char, "$E" is 2
    set "_t=!ESC!x"
    if "!_t:~2,1!" neq "" set "ESC="
)

REM Read version from OPENCLAW_VERSION file (fallback: unknown)
set "OPENCLAW_VER=unknown"
if exist "%~dp0OPENCLAW_VERSION" (
    for /f "usebackq tokens=* delims=" %%v in ("%~dp0OPENCLAW_VERSION") do set "OPENCLAW_VER=%%v"
)

echo.
if defined ESC (
    echo !ESC![93m  ██╗   ██╗██╗  ██╗   ██╗ ██████╗!ESC![0m
    echo !ESC![93m  ╚██╗ ██╔╝██║  ╚██╗ ██╔╝██╔════╝!ESC![0m
    echo !ESC![33m   ╚████╔╝ ██║   ╚████╔╝ ██║  ███╗!ESC![0m
    echo !ESC![33m    ╚██╔╝  ██║    ╚██╔╝  ██║   ██║!ESC![0m
    echo !ESC![33m     ██║   ███████╗██║   ╚██████╔╝!ESC![0m
    echo !ESC![33m     ╚═╝   ╚══════╝╚═╝    ╚═════╝ !ESC![0m
    echo.
    echo !ESC![96m         OpenClaw Portable !OPENCLAW_VER!!ESC![0m
) else (
    echo   OpenClaw Portable !OPENCLAW_VER!
)
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=!UCLAW_DIR!app"

REM Migration shim: rename old core-win to core for existing USB users
if exist "!APP_DIR!\core-win" if not exist "!APP_DIR!\core" ren "!APP_DIR!\core-win" core

set "CORE_DIR=!APP_DIR!\core"
set "DATA_DIR=!UCLAW_DIR!data"
set "STATE_DIR=!DATA_DIR!\.openclaw"
set "NODE_DIR=!APP_DIR!\runtime\node-win-x64"
set "NODE_BIN=!NODE_DIR!\node.exe"
set "NPM_BIN=!NODE_DIR!\npm.cmd"

set "OPENCLAW_HOME=!DATA_DIR!"
set "OPENCLAW_STATE_DIR=!STATE_DIR!"
set "OPENCLAW_CONFIG_PATH=!STATE_DIR!\openclaw.json"

REM Check runtime
if not exist "!NODE_BIN!" (
    echo   [ERROR] Node.js runtime not found
    echo   Please ensure app\runtime\node-win-x64 is complete
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"!NODE_BIN!" --version') do set NODE_VER=%%v
echo   Node.js: !NODE_VER!
echo.

set "PATH=!NODE_DIR!;!NODE_DIR!\node_modules\.bin;!PATH!"

REM Init data directories
if not exist "!DATA_DIR!" mkdir "!DATA_DIR!"
if not exist "!STATE_DIR!" mkdir "!STATE_DIR!"
if not exist "!DATA_DIR!\memory" mkdir "!DATA_DIR!\memory"
if not exist "!DATA_DIR!\backups" mkdir "!DATA_DIR!\backups"
if not exist "!DATA_DIR!\logs" mkdir "!DATA_DIR!\logs"

REM Default config (migrate legacy if present, otherwise create)
if not exist "!STATE_DIR!\openclaw.json" (
    if exist "!DATA_DIR!\config.json" (
        echo   Migrating legacy config...
        copy "!DATA_DIR!\config.json" "!STATE_DIR!\openclaw.json" >nul
        echo   Config migrated
    ) else (
        echo   First run - creating default config...
        (echo {"gateway":{"mode":"local","auth":{"token":"openclaw"}}})>"!STATE_DIR!\openclaw.json"
        echo   Config created
    )
    echo.
)

REM Check dependencies — fail if npm install fails (W4 fix)
if not exist "!CORE_DIR!\node_modules" (
    echo   ========================================
    echo   [WARN] node_modules not found
    echo   ========================================
    echo   This release should ship with deps pre-installed.
    echo   Falling back to npm install (USB drives may take 20+ minutes^).
    echo.
    echo   TIP: Re-download openclaw-portable-*.zip from GitHub releases,
    echo        which includes pre-installed deps (~200 MB^).
    echo.
    echo   File system: NTFS recommended. exFAT/FAT32 will be very slow.
    echo.
    cd /d "!CORE_DIR!"
    call "!NPM_BIN!" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev
    if !errorlevel! neq 0 (
        echo.
        echo   [ERROR] npm install failed. Check your network connection.
        echo   You can also re-download the full release zip which includes deps.
        pause
        exit /b 1
    )
    echo.
    echo   Dependencies installed!
    echo.
)

REM Auto-install WeChat plugin if available (keep inside portable data/)
set "WECHAT_PLUGIN_SRC=!APP_DIR!\extensions\openclaw-weixin"
set "WECHAT_PLUGIN_DST=!STATE_DIR!\extensions\openclaw-weixin"
if exist "!WECHAT_PLUGIN_SRC!\openclaw.plugin.json" (
    if not exist "!WECHAT_PLUGIN_DST!\openclaw.plugin.json" (
        echo   Installing WeChat plugin...
        mkdir "!STATE_DIR!\extensions" 2>nul
        xcopy /s /e /q /y "!WECHAT_PLUGIN_SRC!" "!WECHAT_PLUGIN_DST!\" >nul
        echo   WeChat plugin installed!
        echo.
    )
)

REM Find available port (kill stale gateway processes first)
REM If a previous session's gateway is still running (user closed the
REM terminal without waiting), kill it so we reuse port 18789.
for /l %%p in (18789,1,18799) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        if not "%%a"=="0" (
            echo   Killing stale process on port %%p (PID %%a^)...
            taskkill /PID %%a /F >nul 2>&1
        )
    )
)
timeout /t 1 /nobreak >nul

set PORT=18789
:check_port
netstat -an | findstr ":!PORT! " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    echo   Port !PORT! in use, trying next...
    set /a PORT+=1
    if !PORT! gtr 18799 (
        echo   No available port 18789-18799
        pause
        exit /b 1
    )
    goto :check_port
)

echo   Starting OpenClaw on port !PORT!...
echo.

REM Start Config Server in background and record its PID for cleanup
echo   Starting Config Center...
set "CONFIG_SERVER=!UCLAW_DIR!config-server"
start /B "" "!NODE_BIN!" "!CONFIG_SERVER!\server.js" >nul 2>&1

REM Wait for config server to write runtime.json (poll up to 15s for slow USB)
set "RUNTIME_JSON=!STATE_DIR!\runtime.json"
for /l %%i in (1,1,15) do (
    if exist "!RUNTIME_JSON!" goto :runtime_ready
    timeout /t 1 /nobreak >nul
)
:runtime_ready

REM Read actual config server port from runtime.json
REM NOTE: The for/f + node command MUST NOT be inside an if() block.
REM cmd's parser treats ) inside the JS code as the block-closing paren,
REM which chops the command and produces "is not recognized" errors.
REM The try/catch in the JS already handles missing files gracefully.
set "CONFIG_PORT=18788"
for /f "usebackq tokens=*" %%p in (`"!NODE_BIN!" -e "try{var d=require('fs').readFileSync('!RUNTIME_JSON!'.replace(/\\/g,'/'),'utf8');console.log(JSON.parse(d).configServerPort||18788)}catch(e){console.log(18788)}"`) do set "CONFIG_PORT=%%p"

REM Open both Dashboard and Config Center
echo   Opening Dashboard and Config Center...
timeout /t 1 /nobreak >nul

REM Read gateway token from config
REM Same rule: no if() wrapper around for/f with JS containing parens.
set "TOKEN=openclaw"
for /f "usebackq tokens=*" %%t in (`"!NODE_BIN!" -e "try{var d=require('fs').readFileSync('!STATE_DIR:\=!/openclaw.json','utf8');var t=JSON.parse(d);console.log(t.gateway&&t.gateway.auth&&t.gateway.auth.token||'openclaw')}catch(e){console.log('openclaw')}"`) do set "TOKEN=%%t"
start "" "http://127.0.0.1:!PORT!/#token=!TOKEN!"
start "" "http://127.0.0.1:!CONFIG_PORT!/"

echo   Browsers opened. Starting OpenClaw Gateway on port !PORT!...
echo   DO NOT close this window while using OpenClaw Portable!
echo.

cd /d "!CORE_DIR!"
set "OPENCLAW_MJS=!CORE_DIR!\node_modules\openclaw\openclaw.mjs"
"!NODE_BIN!" "!OPENCLAW_MJS!" gateway run --allow-unconfigured --force --port !PORT!

REM Gateway exited — clean up config-server (W6 fix)
echo.
echo   Stopping Config Center...
REM Kill node processes that are listening on the config port we detected
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":!CONFIG_PORT! " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo   OpenClaw stopped.
pause
endlocal & exit /b 0
