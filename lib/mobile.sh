#!/bin/bash
# ============================================================
# OpenClaw Portable — 手机连接模块 (Mobile Connect)
# 被 Mac-Mobile.command / Linux-Mobile.sh 调用
# 也可被 Menu 的 [16] 选项调用
#
# 功能：以 LAN 模式启动 Gateway，让同一 WiFi 下的手机
#       （Android / iOS）通过浏览器或官方 App 连接。
#
# 设计：
#   - 不修改用户的 openclaw.json
#   - 生成临时配置 data/.openclaw/.mobile-config.json
#   - 退出时自动清理临时配置
#   - 开启 Bonjour/mDNS 让手机 App 自动发现
#   - 私有网段自动配对（无需终端手动 approve）
# ============================================================

# 获取局域网 IP（所有非 loopback 的 IPv4）
get_lan_ips() {
    if [ "$(uname -s)" = "Darwin" ]; then
        ifconfig 2>/dev/null | grep "inet " | grep -v "127.0.0.1" | awk '{print $2}'
    else
        # Linux: ip 优先，hostname -I 兜底
        if command -v ip >/dev/null 2>&1; then
            ip -4 addr show 2>/dev/null | grep "inet " | grep -v "127.0.0.1" | awk '{print $2}' | cut -d/ -f1
        elif command -v hostname >/dev/null 2>&1; then
            hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$'
        fi
    fi
}

# 生成临时 LAN 配置（基于用户配置，注入 LAN 模式）
# 参数: $1=NODE_BIN, $2=源配置路径, $3=目标临时配置路径
create_mobile_config() {
    local NODE_BIN="$1"
    local SRC_CONFIG="$2"
    local DEST_CONFIG="$3"

    "$NODE_BIN" -e "
        const fs = require('fs');
        const src = process.argv[1];
        const dest = process.argv[2];
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(src, 'utf8')); } catch(e) {}

        // 注入 LAN 绑定
        if (!cfg.gateway) cfg.gateway = {};
        cfg.gateway.bind = 'lan';

        // 自动配对 RFC 1918 私有网段
        if (!cfg.gateway.nodes) cfg.gateway.nodes = {};
        if (!cfg.gateway.nodes.pairing) cfg.gateway.nodes.pairing = {};
        cfg.gateway.nodes.pairing.autoApproveCidrs = [
            '192.168.0.0/16',
            '10.0.0.0/8',
            '172.16.0.0/12'
        ];

        fs.mkdirSync(require('path').dirname(dest), { recursive: true });
        fs.writeFileSync(dest, JSON.stringify(cfg, null, 2));
    " "$SRC_CONFIG" "$DEST_CONFIG"
}

# 打印手机连接信息
# 参数: $1=PORT, $2=TOKEN
print_mobile_info() {
    local PORT="$1"
    local TOKEN="$2"
    local IPS=$(get_lan_ips)

    echo ""
    echo -e "  ${GREEN}┌─────────────────────────────────────────────────┐${NC}"
    echo -e "  ${GREEN}│         📱 手机连接信息                          │${NC}"
    echo -e "  ${GREEN}├─────────────────────────────────────────────────┤${NC}"
    echo -e "  ${GREEN}│${NC}                                                 ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  ${WHITE}方式一：手机浏览器（推荐，零安装）${NC}             ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  Android / iOS 均可，打开以下任一地址：         ${GREEN}│${NC}"
    for IP in $IPS; do
        echo -e "  ${GREEN}│${NC}    ${CYAN}http://$IP:$PORT/#token=$TOKEN${NC}"
    done
    echo -e "  ${GREEN}│${NC}                                                 ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  ${WHITE}方式二：官方 App（获得摄像头/语音能力）${NC}       ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  Android: 编译 openclaw/openclaw/apps/android    ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  iOS:     编译 openclaw/openclaw/apps/ios         ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  连接地址: 自动发现 或手动输入:                   ${GREEN}│${NC}"
    for IP in $IPS; do
        echo -e "  ${GREEN}│${NC}    ${CYAN}$IP:$PORT${NC}"
    done
    echo -e "  ${GREEN}│${NC}  配对: 同一 WiFi 下自动批准                      ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}                                                 ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  ${WHITE}方式三：第三方 App${NC}                             ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  andClaw / AnyClaw / FlutterClaw (Google Play)   ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  手动输入 Gateway:                               ${GREEN}│${NC}"
    for IP in $IPS; do
        echo -e "  ${GREEN}│${NC}    ${CYAN}ws://$IP:$PORT${NC}"
    done
    echo -e "  ${GREEN}│${NC}  Token: ${YELLOW}$TOKEN${NC}"
    echo -e "  ${GREEN}│${NC}                                                 ${GREEN}│${NC}"
    echo -e "  ${GREEN}│${NC}  ${DIM}⚠ 请确保手机和电脑在同一 WiFi 网络${NC}             ${GREEN}│${NC}"
    echo -e "  ${GREEN}└─────────────────────────────────────────────────┘${NC}"
    echo ""
}

# 清理临时配置
cleanup_mobile_config() {
    local MOBILE_CONFIG="$1"
    if [ -f "$MOBILE_CONFIG" ]; then
        rm -f "$MOBILE_CONFIG"
    fi
}
