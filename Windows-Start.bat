@echo off
@setlocal EnableDelayedExpansion
@chcp 65001 >nul 2>&1
@cls
@echo off
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


REM Resolve the portable root, tolerating placement either at the
REM repo root (dev mode) or in a system\ subdirectory (release zip
REM layout, where the user-facing root only contains launchers + docs).
REM %~dp0 ends with a trailing backslash; strip it to get the dirname.
set "_SCRIPT_DIR=%~dp0"
if "!_SCRIPT_DIR:~-1!"=="\" set "_SCRIPT_DIR=!_SCRIPT_DIR:~0,-1!"
for %%I in ("!_SCRIPT_DIR!") do set "_SCRIPT_PARENT=%%~nI"
if /I "!_SCRIPT_PARENT!"=="system" (
    for %%I in ("!_SCRIPT_DIR!\..") do set "PORTABLE_DIR=%%~fI\"
) else (
    set "PORTABLE_DIR=%~dp0"
)

REM Read version from OPENCLAW_VERSION in system\ (must run AFTER
REM PORTABLE_DIR is resolved — in both layouts the version file now
REM lives in system\ next to the .bat, at $PORTABLE_DIR\system\).
set "OPENCLAW_VER=unknown"
if exist "!PORTABLE_DIR!system\OPENCLAW_VERSION" (
    for /f "usebackq tokens=* delims=" %%v in ("!PORTABLE_DIR!system\OPENCLAW_VERSION") do set "OPENCLAW_VER=%%v"
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

set "APP_DIR=!PORTABLE_DIR!app"

REM Migration shim: rename old core-win to core for existing USB users
if exist "!APP_DIR!\core-win" if not exist "!APP_DIR!\core" ren "!APP_DIR!\core-win" core

set "CORE_DIR=!APP_DIR!\core"
set "DATA_DIR=!PORTABLE_DIR!data"
set "STATE_DIR=!DATA_DIR!\.openclaw"
set "NODE_DIR=!APP_DIR!\runtime\node-win-x64"
set "NODE_BIN=!NODE_DIR!\node.exe"
set "NPM_BIN=!NODE_DIR!\npm.cmd"

set "OPENCLAW_HOME=!DATA_DIR!"
set "OPENCLAW_STATE_DIR=!STATE_DIR!"
set "OPENCLAW_DISABLE_BONJOUR=1"
set "OPENCLAW_CONFIG_PATH=!STATE_DIR!\openclaw.json"
rem Zero-copy bundled skills dir (survives openclaw reinstalls; enables
rem true hot-reload on OpenClaw 2.0 - the watcher ignores node_modules).
set "OPENCLAW_BUNDLED_SKILLS_DIR=!_SCRIPT_DIR!\skills-zh"
rem OpenClaw 2.0: keep its native service supervisor out of the way -
rem the portable wrapper manages the gateway process itself.
set "OPENCLAW_SUPERVISOR_MODE=external"

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

REM ---- Pre-flight self-check (Windows-native) ────────────────────
REM Catches the same classes of "打不开" issues the macOS / Linux
REM preflight catches: missing core, unwritable data dir, no free port.
REM We collect failures into a counter and bail with a single dialog.
set /a PRECHECK_FAILS=0

if not exist "!CORE_DIR!\node_modules\openclaw\openclaw.mjs" (
    echo   [PRECHECK] OpenClaw 核心缺失: !CORE_DIR!\node_modules\openclaw\openclaw.mjs
    echo              重新下载发布包或运行 setup.bat
    set /a PRECHECK_FAILS+=1
)

if not exist "!PORTABLE_DIR!config-server\server.js" (
    echo   [PRECHECK] 配置中心缺失: !PORTABLE_DIR!config-server\server.js
    echo              重新下载发布包
    set /a PRECHECK_FAILS+=1
)

REM Test data dir is writable. Create it first if it doesn't exist —
REM on first launch DATA_DIR has never been created, so the touch test
REM would always fail and the user sees a misleading 'unwritable' error.
if not exist "!DATA_DIR!" mkdir "!DATA_DIR!" 2>nul
if not exist "!DATA_DIR!" (
    echo   [PRECHECK] 无法创建数据目录: !DATA_DIR!
    echo              检查 U 盘是否被锁定为只读，或权限不足
    set /a PRECHECK_FAILS+=1
) else (
    echo test > "!DATA_DIR!\.write_test" 2>nul
    if not exist "!DATA_DIR!\.write_test" (
        echo   [PRECHECK] 数据目录不可写: !DATA_DIR!
        echo              检查 U 盘是否被锁定为只读
        set /a PRECHECK_FAILS+=1
    ) else (
        del "!DATA_DIR!\.write_test" 2>nul
    )
)

if !PRECHECK_FAILS! gtr 0 (
    echo.
    echo   启动失败：发现 !PRECHECK_FAILS! 个问题，请按上方提示修复
    echo.
    pause
    exit /b 1
)

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
REM
REM Safety: only kill processes whose command line contains "openclaw"
REM (matching the Linux/Mac launcher behavior). Without this check,
REM any user process listening on 18789-18799 (IDE debugger, dev
REM server, etc) would be force-killed by /F.
for /l %%p in (18789,1,18799) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        if not "%%a"=="0" (
            REM Verify the PID is actually an OpenClaw process before killing.
            REM wmic returns CommandLine=... ; we grep for "openclaw" or "node"
            REM pointing at openclaw.mjs. Quote ProcessId to avoid wmic parse
            REM issues with PIDs that contain leading zeros.
            for /f "usebackq tokens=*" %%c in (`wmic process where "ProcessId=%%a" get CommandLine /value 2^>nul ^| findstr "CommandLine"`) do (
                echo %%c | findstr /i "openclaw" >nul 2>&1 && (
                    echo   Killing stale OpenClaw on port %%p ^(PID %%a^)...
                    REM /T = kill child processes too (taskkill's tree-kill).
                    REM Without /T, gateway worker processes survive as orphans.
                    taskkill /PID %%a /F /T >nul 2>&1
                )
            )
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

REM Start Config Server in background and record its PID for cleanup.
REM Redirect stdout/stderr to a log file (>nul previously hid all
REM startup errors; now users can find them in data\logs\).
echo   Starting Config Center...
set "CONFIG_SERVER=!PORTABLE_DIR!config-server"
set "CONFIG_LOG=!DATA_DIR!\logs\config-server.log"
if not exist "!DATA_DIR!\logs" mkdir "!DATA_DIR!\logs" 2>nul
start /B "" cmd /c ""!NODE_BIN!" "!CONFIG_SERVER!\server.js" > "!CONFIG_LOG!" 2>&1"

REM Wait for config server to write runtime.json (poll up to 15s for slow USB)
set "RUNTIME_JSON=!STATE_DIR!\runtime.json"
for /l %%i in (1,1,15) do (
    if exist "!RUNTIME_JSON!" goto :runtime_ready
    timeout /t 1 /nobreak >nul
)
:runtime_ready

REM Read actual config server port from runtime.json.
REM Two cmd quirks we deliberately work around here:
REM   1. `||` and `&` are command separators even inside >> redirection,
REM      so the embedded JS uses a ternary instead of x||fallback.
REM   2. for /F backtick commands fail on paths with non-ASCII chars +
REM      spaces (e.g. C:\Users\高\Desktop\...). The cmd subshell
REM      mangles UTF-8 multi-byte sequences. Write Node's stdout to a
REM      temp file and read it with set /p — this is encoding-invariant.
set "CONFIG_PORT=18750"
set "_JS=%TEMP%\oc-read-port-%RANDOM%.js"
set "_OUT=%TEMP%\oc-read-port-%RANDOM%.out"
>"!_JS!" echo try{var d=require('fs').readFileSync(process.argv[1],'utf8');var v=JSON.parse(d).configServerPort;console.log(v?v:18750)}catch(e){console.log(18750)}
"!NODE_BIN!" "!_JS!" "!RUNTIME_JSON!" >"!_OUT!" 2>nul
if exist "!_OUT!" (
    set /p CONFIG_PORT=<"!_OUT!"
)
del "!_JS!" 2>nul
del "!_OUT!" 2>nul

REM Open both Dashboard and Config Center
echo   Opening Dashboard and Config Center...
timeout /t 1 /nobreak >nul

REM Read gateway token from config (same encoding-safe pattern as above)
set "TOKEN=openclaw"
set "_JS=%TEMP%\oc-read-token-%RANDOM%.js"
set "_OUT=%TEMP%\oc-read-token-%RANDOM%.out"
>"!_JS!" echo try{var c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));var g=c.gateway?c.gateway:{};var a=g.auth?g.auth:{};console.log(a.token?a.token:'openclaw')}catch(e){console.log('openclaw')}
"!NODE_BIN!" "!_JS!" "!STATE_DIR!\openclaw.json" >"!_OUT!" 2>nul
if exist "!_OUT!" (
    set /p TOKEN=<"!_OUT!"
)
del "!_JS!" 2>nul
del "!_OUT!" 2>nul
start "" "http://127.0.0.1:!PORT!/#token=!TOKEN!"
start "" "http://127.0.0.1:!CONFIG_PORT!/"

echo   Browsers opened. Starting OpenClaw Gateway on port !PORT!...
echo   DO NOT close this window while using OpenClaw Portable!
echo.

cd /d "!CORE_DIR!"
set "OPENCLAW_MJS=!CORE_DIR!\node_modules\openclaw\openclaw.mjs"

REM Persist the actual gateway port so /api/restart re-launches on the
REM same port instead of the hardcoded default.
set "_JS=%TEMP%\oc-write-port-%RANDOM%.js"
>"!_JS!" echo var fs=require('fs'),p=process.argv[1];try{var d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d.gatewayPort=parseInt(process.argv[2]);d.gatewayUpdatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(d,null,2));}catch(e){}
"!NODE_BIN!" "!_JS!" "!RUNTIME_JSON!" !PORT! >nul 2>&1
del "!_JS!" 2>nul

REM Strip host provider credentials inherited from the host machine (雷5):
REM leftover DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / ... make
REM OpenClaw treat those providers as "configured" -> it tries a runtime plugin
REM install (exFAT: node_modules link fails -> gateway never ready) and silently
REM burns the host owner's API quota. Clear them before launching the gateway.
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
        echo.
    )
    set "OPENCLAW_STRIP_ENV="
)
set "_STRIP_MJS="

REM ── Gateway watchdog: auto-restart on crash, up to 3 times ──────
REM cmd has no `wait` equivalent; we run gateway in foreground and
REM check %errorlevel% afterwards. Stop conditions:
REM   0          — clean exit
REM   130, 143   — POSIX-style (rare on Windows, kept for safety)
REM   -1073741510 (0xC000013A) — STATUS_CONTROL_C_EXIT (Ctrl+C from console)
REM   1          — taskkill /F sets this; almost always means a deliberate
REM                kill (e.g. /api/restart asked a sibling Node to spawn a
REM                detached replacement). Restarting from here would race
REM                the replacement and crash on port 18789 already in use.
set /a GW_RESTARTS=0
:gw_loop
"!NODE_BIN!" "!OPENCLAW_MJS!" gateway run --allow-unconfigured --force --port !PORT!
set GW_EXIT=!errorlevel!
if !GW_EXIT! equ 0 goto gw_done
if !GW_EXIT! equ 130 goto gw_done
if !GW_EXIT! equ 143 goto gw_done
if !GW_EXIT! equ 1 goto gw_done
if !GW_EXIT! equ -1073741510 goto gw_done
REM Sanity: if our port is now busy (someone else is the gateway), don\'t fight
netstat -an 2>nul | findstr ":!PORT! " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    echo   Gateway 端口 !PORT! 已被其他进程占用，停止自愈（可能是 /api/restart 的副本^）
    goto gw_done
)
set /a GW_RESTARTS+=1
if !GW_RESTARTS! geq 3 (
    echo.
    echo   Gateway 已重启 3 次仍失败 ^(exit=!GW_EXIT!^)，停止自愈
    echo   请检查上方日志或运行 Windows-Diagnose.bat
    goto gw_done
)
echo.
echo   Gateway 异常退出 ^(code=!GW_EXIT!^), 2 秒后第 !GW_RESTARTS! 次自动重启...
timeout /t 2 /nobreak >nul
goto gw_loop
:gw_done

REM ── Restart hand-off ───────────────────────────────────────────
REM If the gateway exited because /api/restart asked it to (taskkill
REM produces exit code 1, Ctrl+C produces -1073741510), the
REM config-server is in the middle of spawning a detached replacement.
REM Killing config-server now would leave the user with a half-restart
REM and a dead UI. Wait up to 30s for the new gateway to come up.
if !GW_EXIT! equ 1 goto handoff
if !GW_EXIT! equ -1073741510 goto stopconfig
goto stopconfig

:handoff
echo.
echo   检测到 /api/restart，等待新 Gateway 上线...
set /a HANDOFF_TRIES=0
:handoff_wait
ping -n 1 -w 500 127.0.0.1 >nul
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:!PORT!/' -TimeoutSec 1 -UseBasicParsing).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if !errorlevel! equ 0 (
    echo   新 Gateway 已就绪，继续运行
    goto handoff_wait_config
)
set /a HANDOFF_TRIES+=1
if !HANDOFF_TRIES! geq 60 (
    echo   等待新 Gateway 超时（30s），停止
    goto stopconfig
)
goto handoff_wait

:handoff_wait_config
REM Stay alive while config-server is up. Loop checks if our
REM CONFIG_PORT is still LISTENING; when it stops, we exit cleanly.
ping -n 1 -w 1000 127.0.0.1 >nul
netstat -an 2>nul | findstr ":!CONFIG_PORT! " | findstr "LISTENING" >nul 2>&1
if !errorlevel! equ 0 goto handoff_wait_config

:stopconfig
REM Gateway exited — clean up config-server (W6 fix)
echo.
echo   Stopping Config Center...
REM Find PIDs listening on CONFIG_PORT, but verify each is actually
REM our config-server before killing. Without this filter, any user
REM process listening on 18750 would be force-killed.
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":!CONFIG_PORT! " ^| findstr "LISTENING"') do (
    for /f "usebackq tokens=*" %%c in (`wmic process where "ProcessId=%%a" get CommandLine /value 2^>nul ^| findstr "CommandLine"`) do (
        echo %%c | findstr /i "config-server\\server.js" >nul 2>&1 && taskkill /PID %%a /F /T >nul 2>&1
    )
)
echo   OpenClaw stopped.
pause
endlocal & exit /b 0
