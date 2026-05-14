#!/bin/bash
# ============================================================
# OpenClaw Portable Diagnostic Tool - Linux
# bash Linux-Diagnose.sh
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$UCLAW_DIR/diagnostic-log.txt"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

clear
echo ""
echo "  ========================================"
echo "    OpenClaw Portable Diagnostic Tool (Linux)"
echo "  ========================================"
echo ""

# Clear old log
OPENCLAW_VER="unknown"
[ -f "$UCLAW_DIR/OPENCLAW_VERSION" ] && OPENCLAW_VER="$(cat "$UCLAW_DIR/OPENCLAW_VERSION" | tr -d '[:space:]')"
cat > "$LOG_FILE" << EOF
OpenClaw Portable Diagnostic Report (Linux)
Version: $OPENCLAW_VER
Generated: $(date)
========================================

EOF

ERROR_COUNT=0

# 1. Check Node.js
echo "[1/6] Checking Node.js runtime..."
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    NODE_BIN="$UCLAW_DIR/app/runtime/node-linux-x64/bin/node"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$UCLAW_DIR/app/runtime/node-linux-arm64/bin/node"
else
    NODE_BIN=""
fi

if [ -f "$NODE_BIN" ]; then
    echo "  [OK] Node.js found" >> "$LOG_FILE"
    echo "      Version: $($NODE_BIN --version)" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} Node.js: $($NODE_BIN --version)"
else
    echo "  [ERROR] Node.js not found ($ARCH)" >> "$LOG_FILE"
    echo "      Path: ${NODE_BIN:-none}" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} Node.js: NOT FOUND ($ARCH)"
    ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# 2. Check core directory
echo "[2/6] Checking core directory..."
CORE_DIR="$UCLAW_DIR/app/core"
if [ -d "$CORE_DIR" ]; then
    echo "  [OK] core directory exists" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} core: Found"
else
    echo "  [ERROR] core directory not found" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} core: NOT FOUND"
    ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# 3. Check node_modules
echo "[3/6] Checking dependencies..."
if [ -d "$CORE_DIR/node_modules" ]; then
    echo "  [OK] node_modules exists" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} Dependencies: Found"
else
    echo "  [ERROR] node_modules not found" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} Dependencies: NOT FOUND"
    ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# 4. Check OpenClaw
echo "[4/6] Checking OpenClaw..."
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
if [ -f "$OPENCLAW_MJS" ]; then
    echo "  [OK] openclaw.mjs found" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} OpenClaw: Found"
else
    echo "  [ERROR] openclaw.mjs not found" >> "$LOG_FILE"
    echo "      Path: $OPENCLAW_MJS" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} OpenClaw: NOT FOUND"
    ERROR_COUNT=$((ERROR_COUNT + 1))
fi

# 5. Check port availability
echo "[5/6] Checking port 18789..."
if command -v lsof >/dev/null 2>&1; then
    if lsof -i:18789 >/dev/null 2>&1; then
        echo "  [WARNING] Port 18789 is in use" >> "$LOG_FILE"
        lsof -i:18789 >> "$LOG_FILE" 2>&1
        echo -e "  ${YELLOW}⚠${NC} Port 18789: IN USE"
    else
        echo "  [OK] Port 18789 is available" >> "$LOG_FILE"
        echo -e "  ${GREEN}✓${NC} Port 18789: Available"
    fi
elif command -v ss >/dev/null 2>&1; then
    if ss -tlnp | grep -q ":18789 " 2>/dev/null; then
        echo "  [WARNING] Port 18789 is in use" >> "$LOG_FILE"
        ss -tlnp | grep ":18789 " >> "$LOG_FILE" 2>&1
        echo -e "  ${YELLOW}⚠${NC} Port 18789: IN USE"
    else
        echo "  [OK] Port 18789 is available" >> "$LOG_FILE"
        echo -e "  ${GREEN}✓${NC} Port 18789: Available"
    fi
elif command -v netstat >/dev/null 2>&1; then
    if netstat -tln 2>/dev/null | grep -q ":18789 "; then
        echo "  [WARNING] Port 18789 is in use" >> "$LOG_FILE"
        echo -e "  ${YELLOW}⚠${NC} Port 18789: IN USE"
    else
        echo "  [OK] Port 18789 is available" >> "$LOG_FILE"
        echo -e "  ${GREEN}✓${NC} Port 18789: Available"
    fi
else
    echo "  [SKIP] No port-check tool (lsof/ss/netstat)" >> "$LOG_FILE"
    echo -e "  ${YELLOW}⚠${NC} Port 18789: Cannot check (no lsof/ss/netstat)"
fi

# 6. Test OpenClaw startup
echo "[6/6] Testing OpenClaw startup..."
echo "" >> "$LOG_FILE"
echo "Testing OpenClaw startup:" >> "$LOG_FILE"
echo "----------------------------------------" >> "$LOG_FILE"

export OPENCLAW_HOME="$UCLAW_DIR/data"
export OPENCLAW_STATE_DIR="$UCLAW_DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"

if [ -f "$NODE_BIN" ] && [ -f "$OPENCLAW_MJS" ]; then
    cd "$CORE_DIR"
    "$NODE_BIN" "$OPENCLAW_MJS" --version >> "$LOG_FILE" 2>&1
    if [ $? -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} OpenClaw: Can run"
    else
        echo -e "  ${RED}✗${NC} OpenClaw: Failed to run"
        echo "  [ERROR] OpenClaw failed to start" >> "$LOG_FILE"
        ERROR_COUNT=$((ERROR_COUNT + 1))
    fi
else
    echo -e "  ${RED}✗${NC} Cannot test - files missing"
    echo "  [SKIP] Cannot test - required files missing" >> "$LOG_FILE"
fi

echo ""
echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "Diagnostic complete." >> "$LOG_FILE"

echo "  ========================================"
echo "    Diagnostic Complete"
echo "  ========================================"
echo ""

if [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
    echo "  All components are ready."
    echo ""
    echo "  Next: bash Linux-Start.sh"
else
    echo -e "  ${RED}Found $ERROR_COUNT issue(s)${NC}"
    echo ""
    echo "  Solutions:"
    echo "  1. Check diagnostic-log.txt for details"
    echo "  2. Run: bash setup.sh --all-platforms"
fi
echo ""
echo "  Log saved to: diagnostic-log.txt"
echo ""
read -p "  Press Enter to exit..."
