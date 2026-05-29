#!/bin/bash
# ============================================================
# OpenClaw Portable — 开发环境搭建脚本
# 用法: bash setup.sh
# 作用: 下载 Node.js 运行时 + 安装 OpenClaw 到 app/ 目录
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
CORE_DIR="$APP_DIR/core"
RUNTIME_DIR="$APP_DIR/runtime"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
# Node 24 LTS (active LTS until 2026-10, maintenance until 2028-04).
# Upgraded from v22.22.1 to match hermes-portable and get full
# hermes-web-ui v0.5.x compatibility if users share the same USB.
NODE_VERSION="v24.15.0"
ALL_PLATFORMS=false
[ "$1" = "--all-platforms" ] && ALL_PLATFORMS=true

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   OpenClaw Portable Setup           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ---- Detect OS & Arch ----
OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
        PLATFORM="darwin-arm64"
        NODE_DIR_NAME="node-mac-arm64"
    else
        PLATFORM="darwin-x64"
        NODE_DIR_NAME="node-mac-x64"
    fi
elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        PLATFORM="linux-arm64"
        NODE_DIR_NAME="node-linux-arm64"
    else
        PLATFORM="linux-x64"
        NODE_DIR_NAME="node-linux-x64"
    fi
else
    echo -e "${RED}Unsupported OS: $OS. Use setup.bat on Windows.${NC}"
    exit 1
fi

echo -e "  系统: ${GREEN}$OS $ARCH${NC}"
echo ""

# ---- 1. Download Node.js (Current Platform) ----
NODE_TARGET="$RUNTIME_DIR/$NODE_DIR_NAME"

if [ -f "$NODE_TARGET/bin/node" ]; then
    echo -e "  ${GREEN}[ok]${NC} Node.js ($PLATFORM) 已存在，跳过下载"
else
    echo -e "  ${CYAN}[v]${NC} 下载 Node.js $NODE_VERSION ($PLATFORM)..."
    mkdir -p "$NODE_TARGET"

    NODE_URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$PLATFORM.tar.gz"
    echo "    $NODE_URL"

    curl -fSL "$NODE_URL" | tar xz -C "$NODE_TARGET" --strip-components=1

    if [ -f "$NODE_TARGET/bin/node" ]; then
        echo -e "  ${GREEN}[ok]${NC} Node.js ($PLATFORM) 下载完成"
    else
        echo -e "  ${RED}[x] Node.js 下载失败${NC}"
        exit 1
    fi
fi

# ---- 1b. Download other platform runtimes (only with --all-platforms) ----
if [ "$ALL_PLATFORMS" = "true" ]; then
    echo ""
    echo -e "  ${CYAN}--all-platforms: 下载全部平台运行时--${NC}"
    echo ""

    # Helper: download a .tar.gz Node.js runtime
    download_tar_runtime() {
        local PLAT="$1" DIR_NAME="$2"
        local TARGET="$RUNTIME_DIR/$DIR_NAME"
        if [ -f "$TARGET/bin/node" ]; then
            echo -e "  ${GREEN}[ok]${NC} Node.js ($PLAT) 已存在，跳过"
            return
        fi
        echo -e "  ${CYAN}[v]${NC} 下载 Node.js $NODE_VERSION ($PLAT)..."
        mkdir -p "$TARGET"
        local URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$PLAT.tar.gz"
        echo "    $URL"
        if curl -fSL "$URL" | tar xz -C "$TARGET" --strip-components=1; then
            echo -e "  ${GREEN}[ok]${NC} Node.js ($PLAT) 下载完成"
        else
            echo -e "  ${CYAN}[!]${NC}  $PLAT runtime 下载失败 (不影响当前平台)"
        fi
    }

    # Helper: download a .zip Node.js runtime (Windows)
    download_zip_runtime() {
        local PLAT="$1" DIR_NAME="$2"
        local TARGET="$RUNTIME_DIR/$DIR_NAME"
        if [ -f "$TARGET/node.exe" ]; then
            echo -e "  ${GREEN}[ok]${NC} Node.js ($PLAT) 已存在，跳过"
            return
        fi
        echo -e "  ${CYAN}[v]${NC} 下载 Node.js $NODE_VERSION ($PLAT)..."
        mkdir -p "$TARGET"
        local URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$PLAT.zip"
        echo "    $URL"
        # Use mktemp instead of $$ in /tmp so an attacker can't pre-create
        # a symlink (e.g. /tmp/node-win-x64-12345.zip → /etc/passwd) and
        # have curl -o follow it. mktemp creates the file with O_EXCL and
        # mode 0600 atomically. Use absolute-path form for cross-platform
        # consistency (GNU and BSD/macOS mktemp differ on the -t flag).
        local TMPDIR_BASE="${TMPDIR:-/tmp}"
        TMPDIR_BASE="${TMPDIR_BASE%/}"
        local TMP_ZIP TMP_EXTRACT
        TMP_ZIP=$(mktemp "${TMPDIR_BASE}/node-${PLAT}-XXXXXX") || TMP_ZIP="${TMPDIR_BASE}/node-${PLAT}-$$-$RANDOM"
        TMP_EXTRACT=$(mktemp -d "${TMPDIR_BASE}/node-extract-${PLAT}-XXXXXX") || TMP_EXTRACT="${TMPDIR_BASE}/node-extract-${PLAT}-$$-$RANDOM"
        curl -fSL "$URL" -o "$TMP_ZIP"
        if command -v unzip >/dev/null 2>&1; then
            unzip -q "$TMP_ZIP" -d "$TMP_EXTRACT"
            cp -r "$TMP_EXTRACT"/node-$NODE_VERSION-$PLAT/* "$TARGET/"
            rm -rf "$TMP_EXTRACT"
        else
            echo -e "    ${RED}[x] unzip not found, skipping${NC}"
            rm -rf "$TMP_EXTRACT"
        fi
        rm -f "$TMP_ZIP"
        if [ -f "$TARGET/node.exe" ]; then
            echo -e "  ${GREEN}[ok]${NC} Node.js ($PLAT) 下载完成"
        else
            echo -e "  ${CYAN}[!]${NC}  $PLAT runtime 下载失败"
        fi
    }

    # Mac: download the other arch
    if [ "$ARCH" = "arm64" ]; then
        download_tar_runtime "darwin-x64" "node-mac-x64"
    else
        download_tar_runtime "darwin-arm64" "node-mac-arm64"
    fi

    # Windows
    download_zip_runtime "win-x64" "node-win-x64"

    # Linux (both archs)
    download_tar_runtime "linux-x64" "node-linux-x64"
    download_tar_runtime "linux-arm64" "node-linux-arm64"
fi

# ---- 2. Install OpenClaw ----
# ALWAYS regenerate package.json from OPENCLAW_VERSION first. This way
# users who re-run setup.sh after a partial install (or to upgrade
# OpenClaw) get the correct version even if node_modules/openclaw
# already exists. The actual npm install is still skipped when
# already-installed AND the version matches.
mkdir -p "$CORE_DIR"
OPENCLAW_VERSION_FILE="$(dirname "$0")/OPENCLAW_VERSION"
OPENCLAW_VERSION="2026.5.12"
if [ -f "$OPENCLAW_VERSION_FILE" ]; then
    OPENCLAW_VERSION="$(tr -d '[:space:]' < "$OPENCLAW_VERSION_FILE")"
fi
cat > "$CORE_DIR/package.json" << PKGJSON
{
  "name": "openclaw-portable-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@sliverp/qqbot": "^1.6.1",
    "@tencent-weixin/openclaw-weixin": "^2.4.4",
    "@zed-industries/codex-acp": "^0.14.0",
    "acpx": "^0.8.0",
    "openclaw": "$OPENCLAW_VERSION"
  }
}
PKGJSON

# Check if installed version matches what we want
NEED_INSTALL=true
if [ -d "$CORE_DIR/node_modules/openclaw" ]; then
    INSTALLED_VER=""
    if [ -f "$CORE_DIR/node_modules/openclaw/package.json" ]; then
        INSTALLED_VER=$("$NODE_TARGET/bin/node" -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)}catch(e){}" "$CORE_DIR/node_modules/openclaw/package.json" 2>/dev/null)
    fi
    if [ "$INSTALLED_VER" = "$OPENCLAW_VERSION" ]; then
        echo -e "  ${GREEN}[ok]${NC} OpenClaw $OPENCLAW_VERSION 已安装，跳过"
        NEED_INSTALL=false
    else
        echo -e "  ${CYAN}↑${NC} OpenClaw 已安装 ($INSTALLED_VER)，升级到 $OPENCLAW_VERSION..."
    fi
fi

if [ "$NEED_INSTALL" = "true" ]; then
    echo -e "  ${CYAN}[v]${NC} 安装 OpenClaw $OPENCLAW_VERSION..."

    # Install with China mirror
    NODE_BIN="$NODE_TARGET/bin/node"
    NPM_BIN="$NODE_TARGET/bin/npm"
    "$NODE_BIN" "$NPM_BIN" install --prefix "$CORE_DIR" --registry="$MIRROR"

    echo -e "  ${GREEN}[ok]${NC} OpenClaw 安装完成"
fi

# ---- 3. Verify core deps ----
# QQ plugin, WeChat plugin, acpx, and codex-acp are declared in package.json
# and installed by the npm install above. Just verify + build if needed.
if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ] && [ ! -d "$CORE_DIR/node_modules/@sliverp/qqbot/dist" ]; then
    echo -e "  ${CYAN}[v]${NC} 构建 QQ 插件..."
    (cd "$CORE_DIR/node_modules/@sliverp/qqbot" && "$NODE_TARGET/bin/npm" run build 2>/dev/null || true)
    echo -e "  ${GREEN}[ok]${NC} QQ 插件构建完成"
fi
if [ -d "$CORE_DIR/node_modules/@tencent-weixin/openclaw-weixin" ]; then
    if [ -f "$CORE_DIR/node_modules/@tencent-weixin/openclaw-weixin/dist/index.js" ]; then
        echo -e "  ${GREEN}[ok]${NC} 微信插件就绪 (prebuilt)"
    else
        echo -e "  ${CYAN}[v]${NC} 构建微信插件..."
        (cd "$CORE_DIR/node_modules/@tencent-weixin/openclaw-weixin" && "$NODE_TARGET/bin/npm" run build 2>/dev/null || true)
        echo -e "  ${GREEN}[ok]${NC} 微信插件构建完成"
    fi
fi
[ -d "$CORE_DIR/node_modules/acpx" ] && [ -d "$CORE_DIR/node_modules/@zed-industries/codex-acp" ] && echo -e "  ${GREEN}[ok]${NC} ACP / Codex harness 就绪"

# ---- 4. Install China-optimized skills ----
SKILLS_CN="$SCRIPT_DIR/skills-cn"
SKILLS_TARGET="$CORE_DIR/node_modules/openclaw/skills"

if [ -d "$SKILLS_CN" ] && [ -d "$SKILLS_TARGET" ]; then
    echo -e "  ${CYAN}[v]${NC} 安装中国优化技能 (skills-cn)..."
    SKILL_COUNT=0
    for skill_dir in "$SKILLS_CN"/*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$SKILLS_TARGET/$skill_name" ]; then
            cp -R "$skill_dir" "$SKILLS_TARGET/$skill_name"
            SKILL_COUNT=$((SKILL_COUNT + 1))
        fi
    done
    echo -e "  ${GREEN}[ok]${NC} 中国技能安装完成 (+$SKILL_COUNT 个)"
fi

# ---- Done ----
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 搭建完成！${NC}"
echo ""
echo -e "  启动方式:"
echo -e "    Mac:     bash Mac-Start.command"
echo -e "    Windows: 双击 Windows-Start.bat"
echo -e "    Linux:   bash Linux-Start.sh"
echo ""
echo -e "  目录结构:"
echo -e "    app/core/       ← OpenClaw + 依赖"
echo -e "    app/runtime/    ← Node.js $NODE_VERSION"
echo -e "    data/           ← 运行后自动生成"
echo ""
echo -e "  ${CYAN}提示: 制作跨平台 U 盘请用 bash setup.sh --all-platforms${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
