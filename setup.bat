@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title OpenClaw Portable Setup

set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%app"
set "CORE_DIR=%APP_DIR%\core"
set "RUNTIME_DIR=%APP_DIR%\runtime"
set "MIRROR=https://registry.npmmirror.com"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"
set "NODE_VERSION=v24.15.0"
set "ALL_PLATFORMS=false"
if "%~1"=="--all-platforms" set "ALL_PLATFORMS=true"

echo.
echo   ========================================
echo     OpenClaw Portable Setup
echo   ========================================
echo.

echo   系统: Windows x64
echo.

REM ---- 1. Download Node.js (Current Platform - Windows) ----
set "NODE_DIR_NAME=node-win-x64"
set "NODE_TARGET=%RUNTIME_DIR%\%NODE_DIR_NAME%"

if exist "%NODE_TARGET%\node.exe" goto skip_node_download

echo   [DOWNLOAD] Downloading Node.js %NODE_VERSION% (win-x64)...
if not exist "%NODE_TARGET%" mkdir "%NODE_TARGET%" 2>nul

set "NODE_URL=%NODE_MIRROR%/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip"
echo     URL: %NODE_URL%

set "TMP_ZIP=%TEMP%\node-win-x64-%RANDOM%.zip"
curl -fSL "%NODE_URL%" -o "%TMP_ZIP%"

set "DOWNLOAD_OK=0"
if %errorlevel% equ 0 set "DOWNLOAD_OK=1"

if "%DOWNLOAD_OK%"=="0" goto node_download_fail

echo     Extracting...
powershell -command "Expand-Archive -Path '%TMP_ZIP%' -DestinationPath '%TEMP%\node-extract' -Force" >nul 2>&1
xcopy /s /e /q /y "%TEMP%\node-extract\node-%NODE_VERSION%-win-x64\*" "%NODE_TARGET%\" >nul
rmdir /s /q "%TEMP%\node-extract" 2>nul
del /f /q "%TMP_ZIP%" 2>nul

if not exist "%NODE_TARGET%\node.exe" goto node_download_fail

echo   [OK] Node.js (win-x64) downloaded
goto node_download_done

:node_download_fail
echo   [ERROR] Node.js download failed
pause
exit /b 1

:skip_node_download
echo   [OK] Node.js (win-x64) exists, skipping
:node_download_done

REM ---- 1b. Download other platform runtimes (only with --all-platforms) ----
if not "%ALL_PLATFORMS%"=="true" goto skip_all_download

echo   --all-platforms: downloading all platform runtimes --
echo.

REM Helper label for downloading .tar.gz runtimes (Mac / Linux)
REM Usage: set PLAT=xxx & set DIR_NAME=yyy & call :download_tar
goto :skip_download_tar_func
:download_tar
    set "TAR_TARGET=%RUNTIME_DIR%\%DIR_NAME%"
    if exist "!TAR_TARGET!\bin\node" (
        echo   [OK] Node.js (%PLAT%) exists, skipping
        goto :eof
    )
    echo   [DOWNLOAD] Downloading Node.js %NODE_VERSION% (%PLAT%)...
    if not exist "!TAR_TARGET!" mkdir "!TAR_TARGET!" 2>nul
    set "TAR_URL=%NODE_MIRROR%/%NODE_VERSION%/node-%NODE_VERSION%-%PLAT%.tar.gz"
    echo     URL: !TAR_URL!
    set "TMP_TAR=%TEMP%\node-%PLAT%-%RANDOM%.tar.gz"
    curl -fSL "!TAR_URL!" -o "!TMP_TAR!"
    if !errorlevel! equ 0 (
        echo     Extracting...
        powershell -command "tar -xzf '!TMP_TAR!' -C '!TAR_TARGET!' --strip-components 1" >nul 2>&1
        del /f /q "!TMP_TAR!" 2>nul
        if exist "!TAR_TARGET!\bin\node" (
            echo   [OK] Node.js (%PLAT%) downloaded
        ) else (
            echo   [WARNING] %PLAT% runtime extraction failed
        )
    ) else (
        echo   [WARNING] %PLAT% runtime download failed (does not affect current platform)
    )
    goto :eof
:skip_download_tar_func

REM Mac (both archs)
set "PLAT=darwin-arm64" & set "DIR_NAME=node-mac-arm64" & call :download_tar
set "PLAT=darwin-x64" & set "DIR_NAME=node-mac-x64" & call :download_tar

REM Linux
set "PLAT=linux-x64" & set "DIR_NAME=node-linux-x64" & call :download_tar
set "PLAT=linux-arm64" & set "DIR_NAME=node-linux-arm64" & call :download_tar

:skip_all_download

set "NPM_BIN=%NODE_TARGET%\npm.cmd"

REM ---- 2. Install OpenClaw ----
REM ALWAYS regenerate package.json from OPENCLAW_VERSION first. This way
REM users who re-run setup.bat after a partial install (or to upgrade
REM OpenClaw) get the correct version even if node_modules\openclaw
REM already exists.

if not exist "%CORE_DIR%" mkdir "%CORE_DIR%" 2>nul

REM Read pinned OpenClaw version from repo root
set "OPENCLAW_VERSION_FILE=%~dp0OPENCLAW_VERSION"
set "OPENCLAW_VERSION=2026.5.18"
if exist "%OPENCLAW_VERSION_FILE%" (
    for /f "usebackq delims=" %%v in ("%OPENCLAW_VERSION_FILE%") do set "OPENCLAW_VERSION=%%v"
)
REM Strip UTF-8 BOM if present (CI sometimes writes OPENCLAW_VERSION with BOM)
if defined OPENCLAW_VERSION (
    if "!OPENCLAW_VERSION:~0,1!"=="ï" set "OPENCLAW_VERSION=!OPENCLAW_VERSION:~3!"
)
REM Always regenerate package.json so OPENCLAW_VERSION takes effect
REM even on re-run / upgrade. Include both deps so the file matches
REM the post-install state and avoids dropping qqbot.
set "_JS=%TEMP%\oc-pkg-%RANDOM%.js"
>"!_JS!" echo var fs=require('fs');var pkg={name:'openclaw-portable-core',version:'1.0.0',private:true,dependencies:{'@sliverp/qqbot':'^1.6.1','@zed-industries/codex-acp':'^0.14.0',acpx:'^0.8.0',openclaw:process.argv[1]}};fs.writeFileSync(process.argv[2],JSON.stringify(pkg,null,2));
"%NODE_TARGET%\node.exe" "!_JS!" "%OPENCLAW_VERSION%" "%CORE_DIR%\package.json"
del "!_JS!" 2>nul

REM Compare installed version vs target. Only skip npm install when they match.
set "NEED_INSTALL=1"
if exist "%CORE_DIR%\node_modules\openclaw\package.json" (
    set "_JS=%TEMP%\oc-ver-%RANDOM%.js"
    set "_OUT=%TEMP%\oc-ver-%RANDOM%.out"
    >"!_JS!" echo try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)}catch(e){console.log('')}
    "%NODE_TARGET%\node.exe" "!_JS!" "%CORE_DIR%\node_modules\openclaw\package.json" >"!_OUT!" 2>nul
    REM Clear before set /p — if _OUT is empty (node failed), set /p
    REM leaves INSTALLED_VER unchanged, which would make a stale value
    REM from a previous run silently compare equal.
    set "INSTALLED_VER="
    if exist "!_OUT!" set /p INSTALLED_VER=<"!_OUT!"
    del "!_JS!" 2>nul & del "!_OUT!" 2>nul
    if "!INSTALLED_VER!"=="!OPENCLAW_VERSION!" (
        echo   [OK] OpenClaw !OPENCLAW_VERSION! already installed, skipping
        set "NEED_INSTALL=0"
    ) else (
        echo   [UPGRADE] OpenClaw installed=!INSTALLED_VER!, target=!OPENCLAW_VERSION!, upgrading...
    )
)

if "!NEED_INSTALL!"=="1" (
    echo   [INSTALL] Installing OpenClaw !OPENCLAW_VERSION!...
    cd /d "%CORE_DIR%"
    call "%NPM_BIN%" install --prefix "%CORE_DIR%" --registry="%MIRROR%"
    echo   [OK] OpenClaw installed
)

REM ---- 3. Install QQ Plugin ----
if exist "%CORE_DIR%\node_modules\@sliverp\qqbot" goto skip_qq_install

echo   [INSTALL] Installing QQ Plugin...
set "NPM_BIN=%NODE_TARGET%\npm.cmd"
cd /d "%CORE_DIR%"
call "%NPM_BIN%" install @sliverp/qqbot@latest --prefix "%CORE_DIR%" --registry="%MIRROR%" >nul 2>&1
echo   [OK] QQ Plugin installed
goto qq_install_done

:skip_qq_install
echo   [OK] QQ Plugin exists, skipping
:qq_install_done

set "QQ_DIR=%CORE_DIR%\node_modules\@sliverp\qqbot"
if not exist "%QQ_DIR%" goto qq_build_done

if exist "%QQ_DIR%\dist\index.js" goto qq_build_cleanup

echo   [BUILD] Building QQ Plugin runtime files...
pushd "%QQ_DIR%"
call "%NPM_BIN%" install --include=dev --registry="%MIRROR%" >nul 2>&1
call "%NPM_BIN%" run build >nul 2>&1
call "%NPM_BIN%" prune --omit=dev >nul 2>&1
popd

:qq_build_cleanup
if exist "%QQ_DIR%\node_modules\openclaw" rmdir /s /q "%QQ_DIR%\node_modules\openclaw" 2>nul
if exist "%QQ_DIR%\dist\index.js" (
    echo   [OK] QQ Plugin runtime files ready
) else (
    echo   [WARNING] QQ Plugin dist\index.js is missing
)
:qq_build_done

REM ---- 3b. Install ACP harness (acpx + codex) ----
REM OpenClaw 5.x stopped auto-staging acpx and codex-acp at gateway
REM startup. Without these, Codex sessions fail with "harness 'codex'
REM is not registered". Install as core deps so the gateway picks them
REM up at startup. (B23-01)
set "NPM_BIN=%NODE_TARGET%\npm.cmd"
if not exist "%CORE_DIR%\node_modules\acpx" (
    echo   [INSTALL] Installing ACP launcher (acpx)...
    call "%NPM_BIN%" install acpx@latest --prefix "%CORE_DIR%" --registry="%MIRROR%" >nul 2>&1
)
if not exist "%CORE_DIR%\node_modules\@zed-industries\codex-acp" (
    echo   [INSTALL] Installing Codex harness...
    call "%NPM_BIN%" install @zed-industries/codex-acp@latest --prefix "%CORE_DIR%" --registry="%MIRROR%" >nul 2>&1
)
if exist "%CORE_DIR%\node_modules\acpx" if exist "%CORE_DIR%\node_modules\@zed-industries\codex-acp" (
    echo   [OK] ACP / Codex harness ready
)

REM ---- 4. Install China-optimized skills ----
set "SKILLS_CN=%SCRIPT_DIR%skills-cn"
set "SKILLS_TARGET=%CORE_DIR%\node_modules\openclaw\skills"

if not exist "%SKILLS_CN%" goto skip_skills_install
if not exist "%SKILLS_TARGET%" goto skip_skills_install

echo   [COPY] Installing China-optimized skills (skills-cn)...
set "SKILL_COUNT=0"
for /d %%s in ("%SKILLS_CN%\*") do (
    set "skill_name=%%~nxs"
    if not exist "%SKILLS_TARGET%\!skill_name!" (
        xcopy /s /e /q /y "%%s" "%SKILLS_TARGET%\!skill_name!\" >nul
        set /a SKILL_COUNT+=1
    )
)
echo   [OK] China skills installed (+%SKILL_COUNT% skills)

:skip_skills_install

REM ---- Done ----
echo.
echo   ========================================
echo     Setup Complete!
echo   ========================================
echo.
echo   To start:
echo     Mac:     bash Mac-Start.command
echo     Windows: Double-click Windows-Start.bat
echo.
echo   Directory structure:
echo     app\core\       - OpenClaw + dependencies
echo     app\runtime\    - Node.js %NODE_VERSION%
echo     data\           - Auto-generated after first run
echo.
if "%ALL_PLATFORMS%"=="true" (
    echo   Note: All platform runtimes downloaded, ready for cross-platform USB
) else (
    echo   Note: For cross-platform USB use setup.bat --all-platforms
)
echo.
pause
