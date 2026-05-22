#!/bin/bash
# ============================================================
# OpenClaw Portable - 手机连接模式 (macOS)
# 双击启动 / Double-click to start mobile mode
#
# 以 LAN 模式启动 Gateway，让同一 WiFi 下的手机连接。
# 退出后自动恢复原始配置，不影响正常使用。
# ============================================================

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
MOBILE_CONFIG="$STATE_DIR/.mobile-config.json"

# Migration shim
if [ -d "$APP_DIR/core-mac" ] && [ ! -d "$APP_DIR/core" ]; then
    mv "$APP_DIR/core-mac" "$APP_DIR/core"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

OPENCLAW_VER="unknown"
[ -f "$PORTABLE_DIR/OPENCLAW_VERSION" ] && OPENCLAW_VER="$(cat "$PORTABLE_DIR/OPENCLAW_VERSION" | tr -d '[:space:]')"

echo ""
echo -e "  ${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}║   OpenClaw Portable — 手机连接     ║${NC}"
echo -e "  ${CYAN}║     Mobile Connect Mode $OPENCLAW_VER  ║${NC}"
echo -e "  ${CYAN}╚══════════════════════════════════════╝${NC}"
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
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"
export PATH="$NODE_DIR/bin:$PATH"

# ---- 2. Remove macOS quarantine ----
if xattr -lr "$PORTABLE_DIR" 2>/dev/null | grep -qm1 "com.apple.quarantine"; then
    echo -e "  ${YELLOW}Removing macOS security restriction...${NC}"
    xattr -rd com.apple.quarantine "$PORTABLE_DIR" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"
fi

# ---- 3. Pre-flight ----
if [ -f "$_SCRIPT_DIR/lib/preflight.sh" ]; then
    source "$_SCRIPT_DIR/lib/preflight.sh"
    if ! preflight_run; then
        read -p "  按回车关闭..."
        exit 1
    fi
elif [ -f "$PORTABLE_DIR/lib/preflight.sh" ]; then
    source "$PORTABLE_DIR/lib/preflight.sh"
    if ! preflight_run; then
        read -p "  按回车关闭..."
        exit 1
    fi
fi

# ---- 4. Check runtime ----
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}Error: Node.js runtime not found${NC}"
    echo "  Please run: bash setup.sh"
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js: ${GREEN}${NODE_VER}${NC}"
echo ""

# ---- 5. Init data directories ----
mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# ---- 6. Ensure base config exists ----
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$DATA_DIR/config.json" ]; then
        cp "$DATA_DIR/config.json" "$CONFIG_FILE"
    else
        cat > "$CONFIG_FILE" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "openclaw" }
  }
}
CFGEOF
    fi
fi

# ---- 7. Load mobile module & create temp config ----
source "$PORTABLE_DIR/lib/mobile.sh"

echo -e "  ${CYAN}生成手机连接配置...${NC}"
create_mobile_config "$NODE_BIN" "$CONFIG_FILE" "$MOBILE_CONFIG"

# Use the mobile config (LAN mode) instead of user config
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$MOBILE_CONFIG"
# 不禁用 Bonjour — 让手机 App 通过 mDNS 自动发现 Gateway
# export OPENCLAW_DISABLE_BONJOUR=1
# USB sticks (exFAT/FAT32) report mode=777; skip plugin permission check.
export OPENCLAW_SKIP_PLUGIN_PERMISSION_CHECK=1

# ---- 8. Find available port ----
for stale_port in $(seq 18789 18799); do
    stale_pid=$(lsof -ti ":$stale_port" 2>/dev/null)
    if [ -n "$stale_pid" ]; then
        for pid in $stale_pid; do
            if ps -p "$pid" -o args= 2>/dev/null | grep -qi "openclaw"; then
                echo -e "  ${YELLOW}Killing stale OpenClaw on port $stale_port (PID $pid)...${NC}"
                kill "$pid" 2>/dev/null || true
            fi
        done
        sleep 1
    fi
done

PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    if [ $PORT -gt 18799 ]; then
        echo -e "  ${RED}No available port (18789-18799)${NC}"
        read -p "  Press Enter to exit..."
        exit 1
    fi
done

# ---- 9. Read token ----
TOKEN="openclaw"
if [ -f "$CONFIG_FILE" ]; then
    DETECTED_TOKEN=$("$NODE_BIN" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'openclaw')}catch(e){console.log('openclaw')}" "$CONFIG_FILE" 2>/dev/null)
    [ -n "$DETECTED_TOKEN" ] && TOKEN="$DETECTED_TOKEN"
fi

# ---- 10. Start Config Server ----
echo -e "  ${CYAN}Starting Config Center...${NC}"
CONFIG_SERVER="$PORTABLE_DIR/config-server"
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!
sleep 2

RUNTIME_JSON="$STATE_DIR/runtime.json"
CONFIG_PORT=18750
if [ -f "$RUNTIME_JSON" ]; then
    DETECTED_PORT=$("$NODE_BIN" -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).configServerPort||18750)}catch(e){console.log(18750)}" "$RUNTIME_JSON" 2>/dev/null)
    [ -n "$DETECTED_PORT" ] && CONFIG_PORT="$DETECTED_PORT"
fi

# ---- Cleanup on exit ----
on_exit_handler() {
    local code=$?
    [ -n "$GW_PID" ] && kill $GW_PID 2>/dev/null
    [ -n "$CONFIG_PID" ] && kill $CONFIG_PID 2>/dev/null
    cleanup_mobile_config "$MOBILE_CONFIG"
    echo ""
    echo -e "   手机连接模式已停止，配置已恢复。"
    if [ "$code" -ne 0 ] && [ "$code" -ne 130 ] && [ "$code" -ne 143 ]; then
        echo -e "  ${RED}异常退出 (code=$code)${NC}"
        read -p "  按回车关闭..."
    fi
    exit "$code"
}
trap on_exit_handler INT TERM EXIT

# ---- 11. Start Gateway (LAN mode) ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT (LAN mode)...${NC}"
echo ""

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"

"$NODE_BIN" -e "var fs=require('fs'),p=process.argv[1];try{var d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};d.gatewayPort=parseInt(process.argv[2]);d.gatewayUpdatedAt=new Date().toISOString();d.mobileMode=true;fs.writeFileSync(p,JSON.stringify(d,null,2));}catch(e){}" "$RUNTIME_JSON" "$PORT" 2>/dev/null || true

"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --bind lan --port $PORT &
GW_PID=$!

# ---- 12. Wait for gateway, print mobile info ----
GW_READY=false
for i in $(seq 1 60); do
    sleep 1
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        GW_READY=true
        break
    fi
done

if [ "$GW_READY" = "true" ]; then
    print_mobile_info "$PORT" "$TOKEN"
    echo -e "  ${GREEN}════════════════════════════════════════${NC}"
    echo -e "  ${GREEN} OpenClaw 手机连接模式已启动！${NC}"
    echo -e "  ${GREEN}   Dashboard:     http://127.0.0.1:$PORT/#token=$TOKEN${NC}"
    echo -e "  ${GREEN}   Config Center: http://127.0.0.1:$CONFIG_PORT/${NC}"
    echo ""
    echo -e "  ${YELLOW}按 Ctrl+C 停止（退出后自动恢复原始配置）${NC}"
    echo -e "  ${GREEN}════════════════════════════════════════${NC}"
else
    echo -e "  ${YELLOW}Gateway 启动中（首次启动可能需要 30-60 秒）...${NC}"
    echo ""
    print_mobile_info "$PORT" "$TOKEN"
    echo ""
    echo -e "  ${YELLOW}按 Ctrl+C 停止${NC}"
fi
echo ""

# ---- Gateway watchdog ----
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
        echo -e "  ${RED}Gateway 重启 $GW_MAX_RESTARTS 次仍失败，停止${NC}"
        exit $GW_EXIT
    fi
    echo -e "  ${YELLOW}Gateway 异常退出，2 秒后重启 ($GW_RESTARTS/$GW_MAX_RESTARTS)...${NC}"
    sleep 2
    "$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --bind lan --port $PORT &
    GW_PID=$!
done
