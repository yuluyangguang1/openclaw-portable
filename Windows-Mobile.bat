@echo off
@setlocal EnableDelayedExpansion
@chcp 936 >nul 2>&1
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
REM OpenClaw 2.0: keep its native service supervisor out of the way -
REM the portable wrapper manages the gateway process itself.
set "OPENCLAW_SUPERVISOR_MODE=external"

REM Read version
set "OPENCLAW_VER=unknown"
if exist "!PORTABLE_DIR!system\OPENCLAW_VERSION" (
    for /f "usebackq tokens=* delims=" %%v in ("!PORTABLE_DIR!system\OPENCLAW_VERSION") do set "OPENCLAW_VER=%%v"
)

echo.
if defined ESC (
    echo !ESC![96m  ╔══════════════════════════════════════╗!ESC![0m
    echo !ESC![96m  ║   OpenClaw Portable — 手机连接     ║!ESC![0m
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

REM 网关口令为固定值 "yuai"（2026-09-10 所有者决定：随机 token 导致
REM Control UI/手机连接反复 token_mismatch 无法登录）。见 lib\ensure-config.mjs。
REM 注意：一键局域网模式下，固定口令等于同 WiFi 内知道该值的人可接管代理。
REM
REM 这一步必须【每次启动】都跑，不能只放在上面的"首次运行"分支里。
REM ensure-config.mjs 是幂等的：只在缺 gateway.auth（或值是占位符）时补写，
REM 已有可用 token 的配置一个字节都不动。而它唯一要修的场景恰恰是"配置已存在但
REM 丢了 gateway.auth"——放进"文件不存在"分支等于让自愈永远不可达。配置一旦丢了
REM gateway.auth，网关就会每次启动现铸一个 runtime token，Control UI 永久
REM token_mismatch；而启动器那边只会印出一个兜底口令，用户怎么试都进不去。
set "_ENSURECFG_MJS="
if exist "!_SCRIPT_DIR!\lib\ensure-config.mjs" set "_ENSURECFG_MJS=!_SCRIPT_DIR!\lib\ensure-config.mjs"
if not defined _ENSURECFG_MJS (
    if exist "!PORTABLE_DIR!lib\ensure-config.mjs" set "_ENSURECFG_MJS=!PORTABLE_DIR!lib\ensure-config.mjs"
)
if not defined _ENSURECFG_MJS (
    if exist "!PORTABLE_DIR!system\lib\ensure-config.mjs" set "_ENSURECFG_MJS=!PORTABLE_DIR!system\lib\ensure-config.mjs"
)
if defined _ENSURECFG_MJS (
    "!NODE_BIN!" "!_ENSURECFG_MJS!" "!CONFIG_FILE!" "!PORTABLE_DIR!system\default-config.json"
)
set "_ENSURECFG_MJS="
REM 兜底：helper 缺失或 node 异常时也要有一个能用的配置
if not exist "!CONFIG_FILE!" (echo {"gateway":{"mode":"local","auth":{"token":"yuai"}}})>"!CONFIG_FILE!"
if not exist "!CONFIG_FILE!" (
    echo.
    echo   [WARN] 配置文件创建失败，请运行 Windows-Diagnose.bat
    echo.
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
set "TOKEN=yuai"
for /f "tokens=*" %%t in ('"!NODE_BIN!" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'yuai')}catch(e){console.log('yuai')}" "!CONFIG_FILE!"') do set "TOKEN=%%t"

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
echo   │          手机连接信息                          │
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

REM Strip host provider credentials inherited from the host machine (雷5):
REM leftover DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / ... make
REM OpenClaw treat those providers as configured -> runtime plugin install
REM (exFAT brick) + silently burns the host owner's quota.
REM Resolve the helper next to this script first (release zip puts scripts +
REM lib/ under system/), then fall back to the portable-root layout.
set "_STRIP_MJS="
if exist "!_SCRIPT_DIR!\lib\strip-provider-env.mjs" (
    set "_STRIP_MJS=!_SCRIPT_DIR!\lib\strip-provider-env.mjs"
) else (
    if exist "!PORTABLE_DIR!lib\strip-provider-env.mjs" set "_STRIP_MJS=!PORTABLE_DIR!lib\strip-provider-env.mjs"
)
if defined _STRIP_MJS (
    set "OPENCLAW_STRIP_ENV="
    for /f "usebackq tokens=1,* delims==" %%a in (`""!NODE_BIN!" "!_STRIP_MJS!" 2^>nul"`) do if "%%a"=="OPENCLAW_STRIP_ENV" set "OPENCLAW_STRIP_ENV=%%b"
    if defined OPENCLAW_STRIP_ENV (
        for %%v in (!OPENCLAW_STRIP_ENV!) do set "%%v="
        echo   Stripped host provider env vars: !OPENCLAW_STRIP_ENV!
    )
    set "OPENCLAW_STRIP_ENV="
)
set "_STRIP_MJS="

echo   Starting gateway...
REM 上次非正常退出（关窗口 / 任务管理器结束 / 直接拔 U 盘）会留下网关锁，
REM 于是下次启动就报 "Gateway failed to start: gateway already running (pid N);
REM lock timeout"。`openclaw gateway stop` 管不了它（那只停受监督的服务，不是
REM 前台 gateway run），启动器的重试也只是重复同一个必然失败的启动。
REM 该助手只在「网关口没人应答 且 锁里的 pid 已死」时才清锁；网关在跑时什么都不做。
set "_LOCKFIX_MJS="
if exist "!_SCRIPT_DIR!\lib\fix-stale-gateway-lock.mjs" (
    set "_LOCKFIX_MJS=!_SCRIPT_DIR!\lib\fix-stale-gateway-lock.mjs"
) else (
    if exist "!PORTABLE_DIR!lib\fix-stale-gateway-lock.mjs" set "_LOCKFIX_MJS=!PORTABLE_DIR!lib\fix-stale-gateway-lock.mjs"
)
if not defined _LOCKFIX_MJS (
    if exist "!PORTABLE_DIR!system\lib\fix-stale-gateway-lock.mjs" set "_LOCKFIX_MJS=!PORTABLE_DIR!system\lib\fix-stale-gateway-lock.mjs"
)
if defined _LOCKFIX_MJS (
    "!NODE_BIN!" --disable-warning=ExperimentalWarning "!_LOCKFIX_MJS!" "!STATE_DIR!" !PORT!
)
set "_LOCKFIX_MJS="
"!NODE_BIN!" "!OPENCLAW_MJS!" gateway run --allow-unconfigured --force --bind lan --port !PORT!

REM Cleanup on exit
echo.
echo   Cleaning up mobile config...
if exist "!MOBILE_CONFIG!" del /f /q "!MOBILE_CONFIG!" 2>nul
echo   手机连接模式已停止，配置已恢复。
pause
