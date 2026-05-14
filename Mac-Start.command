#!/bin/bash
# ============================================================
# OpenClaw Portable - Portable AI Agent (macOS)
# Double-click to start / 双击启动
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
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
[ -f "$UCLAW_DIR/OPENCLAW_VERSION" ] && OPENCLAW_VER="$(cat "$UCLAW_DIR/OPENCLAW_VERSION" | tr -d '[:space:]')"

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
if xattr -l "$NODE_BIN" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo -e "  ${YELLOW}Removing macOS security restriction...${NC}"
    xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"
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

# ---- 8. Find available port ----
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
CONFIG_SERVER="$UCLAW_DIR/config-server"
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!
sleep 2

# Read the actual port config server bound to (it writes runtime.json)
RUNTIME_JSON="$STATE_DIR/runtime.json"
CONFIG_PORT=18788
if [ -f "$RUNTIME_JSON" ]; then
    DETECTED_PORT=$("$NODE_BIN" -e "try{console.log(JSON.parse(require('fs').readFileSync('$RUNTIME_JSON','utf8')).configServerPort||18788)}catch(e){console.log(18788)}" 2>/dev/null)
    [ -n "$DETECTED_PORT" ] && CONFIG_PORT="$DETECTED_PORT"
fi

# ---- 10. Start gateway ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT...${NC}"
echo ""

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
GW_PID=$!

# ---- 11. Wait for gateway, then open browser ----
for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        # Read gateway token from config (fallback: openclaw)
        TOKEN="openclaw"
        if [ -f "$CONFIG_FILE" ]; then
            TOKEN=$("$NODE_BIN" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'openclaw')}catch(e){console.log('openclaw')}" "$CONFIG_FILE" 2>/dev/null || echo "openclaw")
        fi
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

# ---- Cleanup on exit ----
cleanup() {
    kill $GW_PID 2>/dev/null
    kill $CONFIG_PID 2>/dev/null
    echo ""
    echo -e "  🦞 OpenClaw Portable stopped."
    exit 0
}
trap cleanup INT TERM EXIT

wait $GW_PID
