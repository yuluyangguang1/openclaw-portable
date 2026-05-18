#!/bin/bash
# ============================================================
# OpenClaw Portable - Portable AI Agent (macOS)
# Double-click to start / 双击启动
# ============================================================

# Resolve the portable root, tolerating placement either at the
# repo root (dev mode) or in a system/ subdirectory (release zip
# layout, where the user-facing root only contains launchers + docs).
_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(basename "$_SCRIPT_DIR")" = "system" ]; then
    PORTABLE_DIR="$(dirname "$_SCRIPT_DIR")"
else
    PORTABLE_DIR="$_SCRIPT_DIR"
fi
APP_DIR="$PORTABLE_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$PORTABLE_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
CONFIG_FILE="$STATE_DIR/openclaw.json"

# Migration shim: rename old core-mac to core for existing USB users
if [ -d "$APP_DIR/core-mac" ] && [ ! -d "$APP_DIR/core" ]; then
    mv "$APP_DIR/core-mac" "$APP_DIR/core"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GOLD='\033[38;5;220m'
AMBER='\033[38;5;214m'
BRONZE='\033[38;5;166m'
NC='\033[0m'

# Read version from file
OPENCLAW_VER="unknown"
[ -f "$PORTABLE_DIR/OPENCLAW_VERSION" ] && OPENCLAW_VER="$(cat "$PORTABLE_DIR/OPENCLAW_VERSION" | tr -d '[:space:]')"

echo ""
echo -e "${GOLD}  ██╗   ██╗██╗  ██╗   ██╗ ██████╗${NC}"
echo -e "${GOLD}  ╚██╗ ██╔╝██║  ╚██╗ ██╔╝██╔════╝${NC}"
echo -e "${AMBER}   ╚████╔╝ ██║   ╚████╔╝ ██║  ███╗${NC}"
echo -e "${AMBER}    ╚██╔╝  ██║    ╚██╔╝  ██║   ██║${NC}"
echo -e "${BRONZE}     ██║   ███████╗██║   ╚██████╔╝${NC}"
echo -e "${BRONZE}     ╚═╝   ╚══════╝╚═╝    ╚═════╝${NC}"
echo ""
echo -e "        OpenClaw Portable $OPENCLAW_VER"
echo ""

# ---- 1. Detect CPU & set runtime ----
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
    echo -e "  ${GREEN}Apple Silicon (M series)${NC}"
elif [ "$ARCH" = "x86_64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
    echo -e "  ${GREEN}Intel Mac (x64)${NC}"
else
    echo -e "  ${RED}Unsupported architecture: $ARCH${NC}"
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"
export PATH="$NODE_DIR/bin:$PATH"

# ---- 2. Remove macOS quarantine ----
# Must run BEFORE preflight: preflight invokes "$NODE_BIN" --version,
# which Gatekeeper will block on a quarantined USB stick. If we ran
# preflight first, every quarantined-USB user would see a misleading
# "Node 运行时无法启动" failure when the real problem is the xattr.
# Check any file in the bundle for quarantine (not just NODE_BIN —
# if the user re-downloaded a single launcher, NODE_BIN might be clean
# while other files still have the xattr). Recursive clear is cheap.
if xattr -lr "$PORTABLE_DIR" 2>/dev/null | grep -qm1 "com.apple.quarantine"; then
    echo -e "  ${YELLOW}Removing macOS security restriction...${NC}"
    xattr -rd com.apple.quarantine "$PORTABLE_DIR" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"
fi

# ---- 1b. Pre-flight self-check ────────────────────────────────────
# Runs all the cheap sanity checks (node binary, openclaw core,
# config-server present, data dir writable, free port, free space,
# config integrity) and exits with one consolidated diagnosis if
# anything is wrong. This catches ~80% of "打不开" support issues
# at the source.
# preflight lives next to the launcher (so when the launcher is in
# system/, preflight is in system/lib/). Fall back to root/lib/.
if [ -f "$_SCRIPT_DIR/lib/preflight.sh" ]; then
    # shellcheck disable=SC1091
    source "$_SCRIPT_DIR/lib/preflight.sh"
elif [ -f "$PORTABLE_DIR/lib/preflight.sh" ]; then
    # shellcheck disable=SC1091
    source "$PORTABLE_DIR/lib/preflight.sh"
    if ! preflight_run; then
        read -p "  按回车关闭..."
        exit 1
    fi
fi

# ---- 3. Check runtime ----
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}Error: Node.js runtime not found${NC}"
    echo "  Please run: bash setup.sh"
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js: ${GREEN}${NODE_VER}${NC}"
echo ""

# ---- 4. Init data directories ----
mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# ---- 5. Default config ----
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$DATA_DIR/config.json" ]; then
        echo -e "  ${YELLOW}Migrating legacy config...${NC}"
        cp "$DATA_DIR/config.json" "$CONFIG_FILE"
        echo -e "  ${GREEN}Config migrated${NC}"
    else
        echo -e "  ${YELLOW}First run - creating default config...${NC}"
        cat > "$CONFIG_FILE" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "openclaw" }
  }
}
CFGEOF
        echo -e "  ${GREEN}Config created${NC}"
    fi
    echo ""
fi

# ---- 6. Set environment (portable mode) ----
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
export OPENCLAW_DISABLE_BONJOUR=1

# ---- 7. Check dependencies ----
if [ ! -d "$CORE_DIR/node_modules" ]; then
    echo -e "  ${YELLOW}[WARN] node_modules not found${NC}"
    echo "  This release should ship with deps pre-installed."
    echo "  Falling back to npm install (USB drives may take 20+ min)."
    echo "  TIP: re-download openclaw-portable-*.zip with bundled deps."
    cd "$CORE_DIR"
    if ! "$NODE_BIN" "$NODE_DIR/bin/npm" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev 2>&1; then
        echo -e "  ${RED}npm install failed. Check your network connection.${NC}"
        echo "  You can also re-download the full release zip which includes deps."
        read -p "  Press Enter to exit..."
        exit 1
    fi
    echo -e "  ${GREEN}Dependencies installed${NC}"
    echo ""
fi

# ---- 8. Find available port (kill stale gateway first) ----
# If a previous session's gateway is still running (user closed the
# terminal without Ctrl+C, or the EXIT trap didn't fire), kill it
# so we can reuse port 18789 instead of bumping to 18790+.
for stale_port in $(seq 18789 18799); do
    stale_pid=$(lsof -ti ":$stale_port" 2>/dev/null)
    if [ -n "$stale_pid" ]; then
        echo -e "  ${YELLOW}Killing stale process on port $stale_port (PID $stale_pid)...${NC}"
        kill "$stale_pid" 2>/dev/null || true
        sleep 1
    fi
done

PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    echo -e "  ${YELLOW}Port $PORT in use, trying next...${NC}"
    PORT=$((PORT + 1))
    if [ $PORT -gt 18799 ]; then
        echo -e "  ${RED}No available port (18789-18799)${NC}"
        read -p "  Press Enter to exit..."
        exit 1
    fi
done

# ---- 9. Start Config Server in background ----
echo -e "  ${CYAN}Starting Config Center...${NC}"
CONFIG_SERVER="$PORTABLE_DIR/config-server"
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!
sleep 2

# Read the actual port config server bound to (it writes runtime.json).
# IMPORTANT: pass the path via process.argv[1] — interpolating $RUNTIME_JSON
# directly into the JS string literal breaks if the path contains a
# single quote (e.g. /Volumes/Daisy's USB/...). Same fix as Windows P7.
RUNTIME_JSON="$STATE_DIR/runtime.json"
CONFIG_PORT=18788
if [ -f "$RUNTIME_JSON" ]; then
    DETECTED_PORT=$("$NODE_BIN" -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).configServerPort||18788)}catch(e){console.log(18788)}" "$RUNTIME_JSON" 2>/dev/null)
    [ -n "$DETECTED_PORT" ] && CONFIG_PORT="$DETECTED_PORT"
fi

# ---- 10. Start gateway ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT...${NC}"
echo ""

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
# Persist the actual gateway port so the config-server's /api/restart
# endpoint can re-launch on the same port instead of the hardcoded default.
"$NODE_BIN" -e "var fs=require('fs'),p=process.argv[1];try{var d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d.gatewayPort=parseInt(process.argv[2]);d.gatewayUpdatedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(d,null,2));}catch(e){}" "$RUNTIME_JSON" "$PORT" 2>/dev/null || true
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
GW_PID=$!

# Read gateway token from config (fallback: openclaw). Reading it
# BEFORE the gateway-ready loop so the post-loop banner always prints
# the right URL — previously TOKEN was set inside the loop and stayed
# unset if the gateway never came up within 15s.
TOKEN="openclaw"
if [ -f "$CONFIG_FILE" ]; then
    DETECTED_TOKEN=$("$NODE_BIN" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'openclaw')}catch(e){console.log('openclaw')}" "$CONFIG_FILE" 2>/dev/null)
    [ -n "$DETECTED_TOKEN" ] && TOKEN="$DETECTED_TOKEN"
fi

# ---- 11. Wait for gateway, then open browser ----
for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        # Open Dashboard
        open "http://127.0.0.1:$PORT/#token=$TOKEN" 2>/dev/null || true
        # Open Config Center (use detected port)
        open "http://127.0.0.1:$CONFIG_PORT/" 2>/dev/null || true
        break
    fi
done

echo -e "  ${GREEN}════════════════════════════════${NC}"
echo -e "  ${GREEN}🦞 OpenClaw Portable is running!${NC}"
echo -e "  ${GREEN}   Dashboard:     http://127.0.0.1:$PORT/#token=$TOKEN${NC}"
echo -e "  ${GREEN}   Config Center: http://127.0.0.1:$CONFIG_PORT/${NC}"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop${NC}"
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo ""

# ---- Cleanup helper (called from on_exit_handler) ----
cleanup_children() {
    [ -n "$GW_PID" ] && kill $GW_PID 2>/dev/null
    [ -n "$CONFIG_PID" ] && kill $CONFIG_PID 2>/dev/null
    echo ""
    echo -e "  🦞 OpenClaw Portable stopped."
}
# Combined EXIT handler: kill child processes AND show diagnosis on
# abnormal exit. Two separate `trap ... EXIT` statements would have
# the second silently overriding the first, leaving zombie children.
on_exit_handler() {
    local code=$?
    cleanup_children
    if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ]; then
        echo ""
        echo -e "  ${RED}OpenClaw 异常退出 (code=$code)${NC}"
        echo -e "  ${YELLOW}请将上方错误信息复制给开发者，或参考 OpenClawPortable使用说明.html${NC}"
        echo ""
        read -p "  按回车关闭..."
    fi
    exit "$code"
}
trap on_exit_handler INT TERM EXIT

# ── Gateway watchdog: auto-restart on crash, up to 3 times ──────
# Exit codes that mean "don\'t restart":
#   0   — clean exit
#   130 — Ctrl+C (SIGINT)
#   143 — SIGTERM (cleanup_children sent it)
GW_MAX_RESTARTS=3
GW_RESTARTS=0
while [ -n "$GW_PID" ]; do
    wait $GW_PID
    GW_EXIT=$?
    if [ $GW_EXIT -eq 0 ] || [ $GW_EXIT -eq 130 ] || [ $GW_EXIT -eq 143 ]; then
        break
    fi
    GW_RESTARTS=$((GW_RESTARTS + 1))
    if [ $GW_RESTARTS -ge $GW_MAX_RESTARTS ]; then
        echo ""
        echo -e "  ${RED}Gateway 已重启 $GW_MAX_RESTARTS 次仍失败 (exit=$GW_EXIT)，停止自愈${NC}"
        echo -e "  ${YELLOW}请检查上方日志或运行诊断 (Mac-Diagnose / Linux-Diagnose)${NC}"
        exit $GW_EXIT
    fi
    echo ""
    echo -e "  ${YELLOW}Gateway 异常退出 (code=$GW_EXIT)，2 秒后第 $GW_RESTARTS 次自动重启...${NC}"
    sleep 2
    "$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
    GW_PID=$!
done

# After the gateway exited gracefully (143 = SIGTERM, often from
# /api/restart), the config-server may still be running and about
# to spawn a detached gateway in 2 seconds. If we exit now, the
# EXIT trap kills the config-server and the user is left with a
# dead UI even though they just clicked "Restart". Hand off to
# the config-server\'s lifetime instead.
if [ "$GW_EXIT" = "143" ] && [ -n "$CONFIG_PID" ] && kill -0 "$CONFIG_PID" 2>/dev/null; then
    echo ""
    echo -e "  ${CYAN}检测到 /api/restart，等待新 Gateway 上线...${NC}"
    for _ in $(seq 1 60); do
        if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
            echo -e "  ${GREEN}新 Gateway 已就绪${NC}"
            break
        fi
        sleep 0.5
    done
    # Stay alive for as long as the config-server is running. The user
    # closes the launcher window when they want to stop everything.
    wait "$CONFIG_PID"
fi

