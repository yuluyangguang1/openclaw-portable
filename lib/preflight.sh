#!/bin/bash
# OpenClaw Portable pre-flight self-check (sourced by Mac-Start / Linux-Start).
#
# Purpose: catch known-bad startup states *before* we spawn anything,
# so the user sees a single clear diagnosis instead of a cascade of
# half-broken errors. Each check is non-fatal individually; we collect
# all failures and present them together.
#
# Caller must export before sourcing:
#   PORTABLE_DIR, APP_DIR, CORE_DIR, DATA_DIR, STATE_DIR, NODE_BIN
# And the color vars: RED GREEN YELLOW CYAN NC

preflight_run() {
    local FAILS=()
    local WARNS=()

    # ── 1. Node binary present + executable + runs ─────────────────
    if [ ! -f "$NODE_BIN" ]; then
        FAILS+=("Node 运行时缺失: $NODE_BIN")
        FAILS+=("  → 重新下载发布包，或运行 setup.sh 安装本平台运行时")
    elif [ ! -x "$NODE_BIN" ]; then
        FAILS+=("Node 运行时不可执行: $NODE_BIN")
        FAILS+=("  → 运行: chmod +x \"$NODE_BIN\"")
    else
        local NODE_VER
        NODE_VER=$("$NODE_BIN" --version 2>&1 || true)
        if [ -z "$NODE_VER" ] || [[ "$NODE_VER" != v* ]]; then
            FAILS+=("Node 运行时无法启动: $NODE_BIN")
            FAILS+=("  返回: $NODE_VER")
            FAILS+=("  → U 盘文件可能损坏，重新下载发布包")
        fi
    fi

    # ── 2. OpenClaw core present ──────────────────────────────────
    local OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
    if [ ! -f "$OPENCLAW_MJS" ]; then
        FAILS+=("OpenClaw 核心缺失: $OPENCLAW_MJS")
        FAILS+=("  → 运行 setup.sh 安装核心，或重新下载完整发布包")
    fi

    # ── 3. Config-server present ─────────────────────────────────
    local CONFIG_SERVER_JS="$PORTABLE_DIR/config-server/server.js"
    if [ ! -f "$CONFIG_SERVER_JS" ]; then
        FAILS+=("配置中心缺失: $CONFIG_SERVER_JS")
        FAILS+=("  → 重新下载发布包")
    fi

    # ── 4. Data dir writable ─────────────────────────────────────
    if ! mkdir -p "$DATA_DIR" 2>/dev/null; then
        FAILS+=("数据目录无法创建: $DATA_DIR")
        FAILS+=("  → 检查 U 盘是否被锁定为只读，或权限不足")
    elif ! touch "$DATA_DIR/.write_test" 2>/dev/null; then
        FAILS+=("数据目录不可写: $DATA_DIR")
        FAILS+=("  → 检查 U 盘是否被锁定为只读")
    else
        rm -f "$DATA_DIR/.write_test" 2>/dev/null
    fi

    # ── 5. Disk free space (warn if <500 MB on the data partition) ─
    local FREE_MB
    if command -v df >/dev/null 2>&1; then
        FREE_MB=$(df -m "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
        if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt 500 ]; then
            WARNS+=("磁盘可用空间不足 500MB ($FREE_MB MB)，对话历史和缓存可能写入失败")
        fi
    fi

    # ── 6. Port range availability (info only — we'll bump if busy) ─
    local FREE_PORT=""
    if command -v lsof >/dev/null 2>&1; then
        for p in $(seq 18789 18799); do
            if ! lsof -i ":$p" -sTCP:LISTEN >/dev/null 2>&1; then
                FREE_PORT="$p"
                break
            fi
        done
        if [ -z "$FREE_PORT" ]; then
            FAILS+=("端口段 18789-18799 全部被占用")
            FAILS+=("  → 关闭其他 OpenClaw 实例，或重启电脑")
        fi
    fi

    # ── 7. Detect previously-corrupt config and offer recovery ────
    local CONFIG_FILE="$STATE_DIR/openclaw.json"
    if [ -f "$CONFIG_FILE" ]; then
        if ! "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG_FILE" 2>/dev/null; then
            WARNS+=("配置文件 $CONFIG_FILE 解析失败")
            WARNS+=("  → 启动时配置中心会自动从备份恢复 (data/.openclaw/backups/)")
        fi
    fi

    # ── 8. node_modules integrity (USB sticks corrupt files silently) ──
    # Cheapest synchronous test: parse openclaw's package.json. If a
    # USB FAT32 volume truncated the file, JSON.parse throws and Node
    # exits non-zero with a stderr message we capture. We deliberately
    # use require/readFileSync (sync) rather than dynamic import() —
    # import() returns a promise and would always succeed silently.
    if [ -f "$NODE_BIN" ] && [ -f "$CORE_DIR/node_modules/openclaw/package.json" ]; then
        local NM_TEST
        NM_TEST=$("$NODE_BIN" -e "
            try {
              const pkg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
              if (!pkg.name || !pkg.version) throw new Error('package.json missing name/version');
              const mainEntry = require('path').join(require('path').dirname(process.argv[1]), pkg.main || 'openclaw.mjs');
              if (!require('fs').existsSync(mainEntry)) {
                throw new Error('main entry missing: ' + (pkg.main || 'openclaw.mjs'));
              }
            } catch (e) {
              process.stdout.write('FAIL:' + (e.message || String(e)));
            }
        " "$CORE_DIR/node_modules/openclaw/package.json" 2>/dev/null || true)
        if [[ "$NM_TEST" == FAIL:* ]]; then
            FAILS+=("OpenClaw 模块完整性检查失败: ${NM_TEST#FAIL:}")
            FAILS+=("  → U 盘文件可能损坏，请重新下载发布包")
            FAILS+=("     如果是从旧 U 盘升级，运行 setup.sh 重装核心依赖")
        fi
    fi

    # ── Output ───────────────────────────────────────────────────
    if [ ${#WARNS[@]} -gt 0 ]; then
        echo ""
        echo -e "  ${YELLOW}┌─ 启动警告 ─────────────────────${NC}"
        for line in "${WARNS[@]}"; do
            echo -e "  ${YELLOW}│${NC} $line"
        done
        echo -e "  ${YELLOW}└────────────────────────────────${NC}"
    fi

    if [ ${#FAILS[@]} -gt 0 ]; then
        echo ""
        echo -e "  ${RED}┌─ 启动失败：发现 ${#FAILS[@]} 个问题 ─────────${NC}"
        for line in "${FAILS[@]}"; do
            echo -e "  ${RED}│${NC} $line"
        done
        echo -e "  ${RED}└────────────────────────────────${NC}"
        echo ""
        echo -e "  ${CYAN}诊断信息已收集完毕。修复上述问题后重新双击启动器。${NC}"
        echo ""
        return 1
    fi

    echo -e "  ${GREEN}启动自检通过${NC}"
    return 0
}
