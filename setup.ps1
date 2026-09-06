param(
    [switch]$AllPlatforms
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $scriptDir "app"
$coreDir = Join-Path $appDir "core"
$runtimeDir = Join-Path $appDir "runtime"

# npm registry. Default: China mirror. CI overrides via NPM_REGISTRY env
# (npmmirror can lag upstream releases by hours and break npm install).
$mirror = if ($env:NPM_REGISTRY) { $env:NPM_REGISTRY } else { "https://registry.npmmirror.com" }
$nodeMirror = "https://npmmirror.com/mirrors/node"
$nodeVersion = "v24.15.0"

function Write-Step {
    param(
        [string]$Symbol,
        [string]$Message,
        [string]$Color = "Gray"
    )

    Write-Host ("  {0} {1}" -f $Symbol, $Message) -ForegroundColor $Color
}

function Ensure-Directory {
    param(
        [string]$Path
    )

    if (-not (Test-Path -Path $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Download-File {
    param(
        [string]$Url,
        [string]$Destination
    )

    Invoke-WebRequest -Uri $Url -OutFile $Destination
}

function Install-WindowsNode {
    param(
        [string]$TargetDir
    )

    $nodeExe = Join-Path $TargetDir "node.exe"
    if (Test-Path -Path $nodeExe -PathType Leaf) {
        Write-Step "OK" "Node.js (win-x64) already exists, skipping download." "Green"
        return
    }

    Write-Step "->" "Downloading Node.js $nodeVersion (win-x64)..." "Cyan"
    Ensure-Directory -Path $TargetDir

    $zipName = "node-$nodeVersion-win-x64.zip"
    $nodeUrl = "$nodeMirror/$nodeVersion/$zipName"
    $tempZip = Join-Path $env:TEMP $zipName
    $extractRoot = Join-Path $env:TEMP "openclaw-portable-node-win-x64"
    $extractDir = Join-Path $extractRoot "node-$nodeVersion-win-x64"

    Write-Host "    $nodeUrl"
    Download-File -Url $nodeUrl -Destination $tempZip

    if (Test-Path -Path $extractRoot) {
        Remove-Item -Path $extractRoot -Recurse -Force
    }

    Expand-Archive -Path $tempZip -DestinationPath $extractRoot -Force
    Copy-Item -Path (Join-Path $extractDir "*") -Destination $TargetDir -Recurse -Force

    Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -Path $nodeExe -PathType Leaf) {
        Write-Step "OK" "Node.js (win-x64) download completed." "Green"
    }
    else {
        Write-Step "ERR" "Node.js (win-x64) download failed." "Red"
        exit 1
    }
}

function Install-TarNodeRuntime {
    param(
        [string]$Platform,
        [string]$NodeDirName
    )

    $targetDir = Join-Path $runtimeDir $NodeDirName
    $nodeBinary = Join-Path $targetDir "bin/node"
    if (Test-Path -Path $nodeBinary -PathType Leaf) {
        Write-Step "OK" "Node.js ($Platform) already exists, skipping download." "Green"
        return
    }

    $tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tarExe) {
        Write-Step "WARN" "tar.exe was not found, skipping $Platform runtime." "Yellow"
        return
    }

    Write-Step "->" "Downloading Node.js $nodeVersion ($Platform)..." "Cyan"
    Ensure-Directory -Path $targetDir

    $archiveName = "node-$nodeVersion-$Platform.tar.gz"
    $nodeUrl = "$nodeMirror/$nodeVersion/$archiveName"
    $tempArchive = Join-Path $env:TEMP $archiveName
    $extractRoot = Join-Path $env:TEMP ("openclaw-portable-{0}" -f $NodeDirName)
    $extractDir = Join-Path $extractRoot "node-$nodeVersion-$Platform"

    Write-Host "    $nodeUrl"
    Download-File -Url $nodeUrl -Destination $tempArchive

    if (Test-Path -Path $extractRoot) {
        Remove-Item -Path $extractRoot -Recurse -Force
    }

    Ensure-Directory -Path $extractRoot
    & $tarExe.Path -xzf $tempArchive -C $extractRoot

    if ($LASTEXITCODE -ne 0) {
        Write-Step "WARN" "$Platform runtime extraction failed, skipping it." "Yellow"
        Remove-Item -Path $tempArchive -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
        return
    }

    Copy-Item -Path (Join-Path $extractDir "*") -Destination $targetDir -Recurse -Force
    Remove-Item -Path $tempArchive -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -Path $nodeBinary -PathType Leaf) {
        Write-Step "OK" "Node.js ($Platform) download completed." "Green"
    }
    else {
        Write-Step "WARN" "$Platform runtime download failed, but Windows setup can continue." "Yellow"
    }
}

function Ensure-QQPluginBuild {
    param(
        [string]$CoreDir,
        [string]$NpmCmd
    )

    $qqDir = Join-Path $CoreDir "node_modules\@sliverp\qqbot"
    if (-not (Test-Path -Path $qqDir -PathType Container)) {
        return
    }

    $distIndex = Join-Path $qqDir "dist\index.js"
    if (-not (Test-Path -Path $distIndex -PathType Leaf)) {
        Write-Step "->" "Building QQ plugin runtime files..." "Cyan"
        Push-Location $qqDir
        try {
            & $NpmCmd install --include=dev --registry=$mirror
            & $NpmCmd run build
            & $NpmCmd prune --omit=dev
        }
        catch {
            Write-Step "WARN" "QQ plugin build command failed; continuing setup." "Yellow"
        }
        finally {
            Pop-Location
        }
    }

    $nestedOpenClaw = Join-Path $qqDir "node_modules\openclaw"
    if (Test-Path -Path $nestedOpenClaw -PathType Container) {
        Remove-Item -Path $nestedOpenClaw -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path -Path $distIndex -PathType Leaf) {
        Write-Step "OK" "QQ plugin runtime files are ready." "Green"
    }
    else {
        Write-Step "WARN" "QQ plugin is installed but dist/index.js is missing." "Yellow"
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw Portable Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  System: {0}" -f [System.Runtime.InteropServices.RuntimeInformation]::OSDescription) -ForegroundColor Green
Write-Host ""

Ensure-Directory -Path $appDir
Ensure-Directory -Path $coreDir
Ensure-Directory -Path $runtimeDir

$windowsNodeTarget = Join-Path $runtimeDir "node-win-x64"
Install-WindowsNode -TargetDir $windowsNodeTarget

if ($AllPlatforms) {
    Install-TarNodeRuntime -Platform "darwin-arm64" -NodeDirName "node-mac-arm64"
    Install-TarNodeRuntime -Platform "darwin-x64" -NodeDirName "node-mac-x64"
    Install-TarNodeRuntime -Platform "linux-x64" -NodeDirName "node-linux-x64"
    Install-TarNodeRuntime -Platform "linux-arm64" -NodeDirName "node-linux-arm64"
}

$packageJsonPath = Join-Path $coreDir "package.json"
# Always regenerate package.json to ensure the version matches
# OPENCLAW_VERSION. Previously the file was git-tracked with a stale
# version and the "if not exists" guard meant changes never took effect.
$openclawVersionFile = Join-Path $PSScriptRoot "system\OPENCLAW_VERSION"
$openclawVersion = "2026.9.2"
if (Test-Path -Path $openclawVersionFile -PathType Leaf) {
    $openclawVersion = (Get-Content -Path $openclawVersionFile -Raw).Trim()
}
$packageJson = @"
{
  "name": "openclaw-portable-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@sliverp/qqbot": "^1.6.1",
    "@zed-industries/codex-acp": "^0.14.0",
    "acpx": "^0.8.0",
    "openclaw": "$openclawVersion",
    "@openclaw/arcee-provider": "$openclawVersion",
    "@openclaw/cerebras-provider": "$openclawVersion",
    "@openclaw/cohere-provider": "$openclawVersion",
    "@openclaw/deepinfra-provider": "$openclawVersion",
    "@openclaw/deepseek-provider": "$openclawVersion",
    "@openclaw/fireworks-provider": "$openclawVersion",
    "@openclaw/gmi-provider": "$openclawVersion",
    "@openclaw/groq-provider": "$openclawVersion",
    "@openclaw/kilocode-provider": "$openclawVersion",
    "@openclaw/kimi-provider": "$openclawVersion",
    "@openclaw/longcat-provider": "$openclawVersion",
    "@openclaw/qwen-provider": "$openclawVersion",
    "@openclaw/stepfun-provider": "$openclawVersion",
    "@openclaw/zai-provider": "$openclawVersion",
    "@openclaw/byteplus-provider": "$openclawVersion",
    "@openclaw/mistral-provider": "$openclawVersion",
    "@openclaw/novita-provider": "$openclawVersion",
    "@openclaw/tencent-provider": "$openclawVersion",
    "@openclaw/xiaomi-provider": "$openclawVersion"
  }
}
"@
$packageJson | Out-File -FilePath $packageJsonPath -Encoding utf8

$npmCmd = Join-Path $windowsNodeTarget "npm.cmd"

# Compare installed version vs target. Only skip npm install when they match.
$installedOpenclawJson = Join-Path $coreDir "node_modules\openclaw\package.json"
$needInstall = $true
if (Test-Path -Path $installedOpenclawJson -PathType Leaf) {
    $installedVer = ""
    try {
        $installedVer = ((Get-Content -Path $installedOpenclawJson -Raw | ConvertFrom-Json).version).ToString()
    } catch {}
    if ($installedVer -eq $openclawVersion) {
        Write-Step "OK" "OpenClaw $openclawVersion already installed, skipping." "Green"
        $needInstall = $false
    } else {
        Write-Step "->" "OpenClaw installed=$installedVer, target=$openclawVersion, upgrading..." "Cyan"
    }
}

if ($needInstall) {
    Write-Step "->" "Installing OpenClaw $openclawVersion..." "Cyan"
    Push-Location $coreDir
    try {
        & $npmCmd install --prefix $coreDir --registry=$mirror
    }
    finally {
        Pop-Location
    }

    if (Test-Path -Path (Join-Path $coreDir "node_modules\openclaw") -PathType Container) {
        Write-Step "OK" "OpenClaw installation completed." "Green"
    }
    else {
        Write-Step "ERR" "OpenClaw installation failed." "Red"
        exit 1
    }
}

# Promote official provider plugins to bundled (idempotent). Must run
# AFTER npm install: promoted files are merged into openclaw's postinstall
# inventory (dist/postinstall-inventory.json) so lifecycle re-runs never
# prune them; origin=bundled also skips capability consent entirely.
# 发布包里 lib/ 在 system\lib\，开发树在 .\lib\，两处都找
$promoteScript = Join-Path $PSScriptRoot "system\lib\promote-official-providers.mjs"
if (-not (Test-Path -Path $promoteScript -PathType Leaf)) {
    $promoteScript = Join-Path $PSScriptRoot "lib\promote-official-providers.mjs"
}
if ((Test-Path -Path $promoteScript -PathType Leaf) -and
    (Test-Path -Path (Join-Path $coreDir "node_modules\openclaw\dist\extensions") -PathType Container)) {
    Write-Step "->" "Promoting official provider plugins to bundled..." "Cyan"
    & (Join-Path $windowsNodeTarget "node.exe") $promoteScript $coreDir
}

if (Test-Path -Path (Join-Path $coreDir "node_modules\@sliverp\qqbot") -PathType Container) {
    Write-Step "OK" "QQ plugin is already installed, skipping." "Green"
}
else {
    Write-Step "->" "Installing QQ plugin..." "Cyan"
    Push-Location $coreDir
    try {
        & $npmCmd install "@sliverp/qqbot@latest" --prefix $coreDir --registry=$mirror 2>$null
    }
    catch {
    }
    finally {
        Pop-Location
    }
    Write-Step "OK" "QQ plugin installation finished." "Green"
}

Ensure-QQPluginBuild -CoreDir $coreDir -NpmCmd $npmCmd

# ACP harness (acpx + codex). OpenClaw 5.x stopped auto-staging these
# at startup. Without them, Codex sessions fail with "harness 'codex'
# is not registered". (B23-01)
if (-not (Test-Path -Path (Join-Path $coreDir "node_modules\acpx") -PathType Container)) {
    Write-Step "->" "Installing ACP launcher (acpx)..." "Cyan"
    Push-Location $coreDir
    try { & $npmCmd install "acpx@latest" --prefix $coreDir --registry=$mirror 2>$null } catch {}
    finally { Pop-Location }
}
if (-not (Test-Path -Path (Join-Path $coreDir "node_modules\@zed-industries\codex-acp") -PathType Container)) {
    Write-Step "->" "Installing Codex harness..." "Cyan"
    Push-Location $coreDir
    try { & $npmCmd install "@zed-industries/codex-acp@latest" --prefix $coreDir --registry=$mirror 2>$null } catch {}
    finally { Pop-Location }
}
if ((Test-Path -Path (Join-Path $coreDir "node_modules\acpx") -PathType Container) -and
    (Test-Path -Path (Join-Path $coreDir "node_modules\@zed-industries\codex-acp") -PathType Container)) {
    Write-Step "OK" "ACP / Codex harness ready." "Green"
}

# China-optimized skills (zero-copy): skills-zh\ is NOT copied into
# node_modules. The Start launchers inject OPENCLAW_BUNDLED_SKILLS_DIR,
# which OpenClaw resolves natively (env override in
# resolveBundledSkillsDir(), both 6.11 and 2.0). Zero-copy survives
# openclaw reinstalls and enables true hot-reload on 2.0.
if (Test-Path -Path (Join-Path $scriptDir "skills-zh") -PathType Container) {
    Write-Step "OK" "skills-zh ready (zero-copy, loaded via OPENCLAW_BUNDLED_SKILLS_DIR)." "Green"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch:"
Write-Host "    Mac:     bash Mac-Start.command" -ForegroundColor Cyan
Write-Host "    Windows: double-click Windows-Start.bat" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Structure:"
Write-Host "    app/core/       -> OpenClaw and dependencies"
Write-Host "    app/runtime/    -> Node.js $nodeVersion"
Write-Host "    data/           -> created automatically after launch"
Write-Host ""
Write-Host "  Tip: use .\setup.ps1 -AllPlatforms to prepare a cross-platform USB." -ForegroundColor Cyan
