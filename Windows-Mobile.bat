@echo off
@setlocal EnableDelayedExpansion
@chcp 65001 >nul 2>&1
@cls
title OpenClaw Portable - Mobile Connect

REM ============================================================
REM OpenClaw Portable - 手机连接模式 (Windows)
REM 双击启动，以 LAN 模式运行 Gateway，让手机连接。
REM 退出后自动恢复原始配置。
REM ============================================================

REM Enable ANSI
set "ESC="
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
if not defined ESC set "ESC="
if defined ESC (
    set "_t=!ESC!x"
    if "!_t:~2,1!" neq "" set "ESC="
)

REM Resolve portable root
set "_SCRIPT_DIR=%~dp0"
if "!_SCRIPT_DIR:~-1!"=="\" set "_SCRIPT_DIR=!_SCRIPT_DIR:~0,-1!"
for %%I in ("!_SCRIPT_DIR!") do set "_SCRIPT_PARENT=%%~nI"
if /I "!_SCRIPT_PARENT!"=="system" (
    for %%I in ("!_SCRIPT_DIR!\..") do set "PORTABLE_DIR=%%~fI\"
) else (
    set "PORTABLE_DIR=%~dp0"
)

set "APP_DIR=!PORTABLE_DIR!app"
if exist "!APP_DIR!\core-win" if not exist "!APP_DIR!\core" ren "!APP_DIR!\core-win" core
set "CORE_DIR=!APP_DIR!\core"
set "DATA_DIR=!PORTABLE_DIR!data"
set "STATE_DIR=!DATA_DIR!\.openclaw"
set "CONFIG_FILE=!STATE_DIR!\openclaw.json"
set "MOBILE_CONFIG=!STATE_DIR!\.mobile-config.json"
set "NODE_DIR=!APP_DIR!\runtime\node-win-x64"
set "NODE_BIN=!NODE_DIR!\node.exe"
set "RUNTIME_JSON=!STATE_DIR!\runtime.json"

set "OPENCLAW_HOME=!DATA_DIR!"
set "OPENCLAW_STATE_DIR=!STATE_DIR!"
REM 不设 OPENCLAW_DISABLE_BONJOUR — 让手机 App 自动发现

REM Read version
set "OPENCLAW_VER=unknown"
if exist "!PORTABLE_DIR!OPENCLAW_VERSION" (
    for /f "usebackq tokens=* delims=" %%v in ("!PORTABLE_DIR!OPENCLAW_VERSION") do set "OPENCLAW_VER=%%v"
)

echo.
if defined ESC (
    echo !ESC![96m  ╔══════════════════════════════════════╗!ESC![0m
    echo !ESC![96m  ║  📱 OpenClaw Portable — 手机连接     ║!ESC![0m
    echo !ESC![96m  ║     Mobile Connect Mode !OPENCLAW_VER!  ║!ESC![0m
    echo !ESC![96m  ╚══════════════════════════════════════╝!ESC![0m
) else (
    echo   OpenClaw Portable - Mobile Connect !OPENCLAW_VER!
)
echo.

REM Check runtime
if not exist "!NODE_BIN!" (
    echo   [ERROR] Node.js runtime not found
    echo   Please run setup.bat first.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"!NODE_BIN!" --version') do set "NODE_VER=%%v"
echo   Node.js: !NODE_VER!
echo.

REM Init directories
if not exist "!STATE_DIR!" mkdir "!STATE_DIR!"
if not exist "!DATA_DIR!\memory" mkdir "!DATA_DIR!\memory"
if not exist "!DATA_DIR!\logs" mkdir "!DATA_DIR!\logs"

REM Ensure base config
if not exist "!CONFIG_FILE!" (
    echo {"gateway":{"mode":"local","auth":{"token":"openclaw"}}} > "!CONFIG_FILE!"
)

REM Generate mobile config (inject LAN mode + autoApprove)
echo   Generating mobile config...
"!NODE_BIN!" -e "const fs=require('fs');let cfg={};try{cfg=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch(e){}if(!cfg.gateway)cfg.gateway={};cfg.gateway.bind='lan';if(!cfg.gateway.nodes)cfg.gateway.nodes={};if(!cfg.gateway.nodes.pairing)cfg.gateway.nodes.pairing={};cfg.gateway.nodes.pairing.autoApproveCidrs=['192.168.0.0/16','10.0.0.0/8','172.16.0.0/12'];fs.mkdirSync(require('path').dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],JSON.stringify(cfg,null,2))" "!CONFIG_FILE!" "!MOBILE_CONFIG!"

set "OPENCLAW_CONFIG_PATH=!MOBILE_CONFIG!"

REM Find available port
set "PORT=18789"
:find_port
netstat -an 2>nul | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel! equ 0 (
    set /a PORT+=1
    if !PORT! gtr 18799 (
        echo   [ERROR] No available port 18789-18799
        pause
        exit /b 1
    )
    goto :find_port
)

REM Read token
set "TOKEN=openclaw"
for /f "tokens=*" %%t in ('"!NODE_BIN!" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'openclaw')}catch(e){console.log('openclaw')}" "!CONFIG_FILE!"') do set "TOKEN=%%t"

REM Get LAN IP
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    for /f "tokens=*" %%b in ("%%a") do (
        if not defined LAN_IP set "LAN_IP=%%b"
    )
)

REM Start config server in background
echo   Starting Config Center...
set "CONFIG_SERVER=!PORTABLE_DIR!config-server"
start /b "" "!NODE_BIN!" "!CONFIG_SERVER!\server.js"
timeout /t 2 /nobreak >nul

REM Start Gateway (LAN mode)
echo   Starting OpenClaw on port !PORT! (LAN mode)...
echo.

set "OPENCLAW_MJS=!CORE_DIR!\node_modules\openclaw\openclaw.mjs"

REM Write runtime info
"!NODE_BIN!" -e "var fs=require('fs'),p=process.argv[1];try{var d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d.gatewayPort=parseInt(process.argv[2]);d.mobileMode=true;fs.writeFileSync(p,JSON.stringify(d,null,2));}catch(e){}" "!RUNTIME_JSON!" "!PORT!" 2>nul

echo.
echo   ┌─────────────────────────────────────────────────┐
echo   │         📱 手机连接信息                          │
echo   ├─────────────────────────────────────────────────┤
echo   │                                                 │
echo   │  方式一：手机浏览器（推荐，零安装）             │
echo   │  Android / iOS 均可，打开以下地址：             │
if defined LAN_IP (
    echo   │    http://!LAN_IP!:!PORT!/#token=!TOKEN!
)
echo   │    （确保手机和电脑在同一 WiFi）                │
echo   │                                                 │
echo   │  方式二：官方 App                               │
echo   │  Gateway 地址: !LAN_IP!:!PORT!
echo   │  Token: !TOKEN!
echo   │  配对: 同一 WiFi 下自动批准                     │
echo   │                                                 │
echo   │  方式三：第三方 App (andClaw / AnyClaw)         │
echo   │  手动输入: ws://!LAN_IP!:!PORT!
echo   │                                                 │
echo   └─────────────────────────────────────────────────┘
echo.

echo   Starting gateway...
"!NODE_BIN!" "!OPENCLAW_MJS!" gateway run --allow-unconfigured --force --bind lan --port !PORT!

REM Cleanup on exit
echo.
echo   Cleaning up mobile config...
if exist "!MOBILE_CONFIG!" del /f /q "!MOBILE_CONFIG!" 2>nul
echo   手机连接模式已停止，配置已恢复。
pause
