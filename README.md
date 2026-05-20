# OpenClaw Portable

把 [OpenClaw](https://github.com/openclaw/openclaw)（开源 AI 助手）打包成便携版。插上 U 盘即可在任意电脑上运行，无需安装任何依赖。

Pack [OpenClaw](https://github.com/openclaw/openclaw) into a portable edition. Plug in a USB drive and run on any computer with zero dependencies.

---

## 特性

- 零安装 — 自带 Node.js 运行时，双击启动
- 跨平台 — macOS (ARM/Intel)、Linux (x64/ARM64)、Windows x64
- 可视化配置中心 — 选模型、填 Key、保存、打开聊天，两步完成
- 32 个模型平台 — 国产 15 + 国际 8 + 聚合 5 + 加速 1 + 自定义中转 1 + 本地 2（Ollama / LM Studio 自动检测）
- 12 个聊天渠道 — Telegram / QQ / 飞书 / 企微 / Discord / Slack / WhatsApp / Signal / LINE / Google Chat / MS Teams / 微信
- 手机连接 — 同一 WiFi 下手机浏览器零安装访问，也支持官方 App 和第三方 App
- 自动更新 — 从 GitHub Releases 一键下载更新，带备份回滚
- 数据本地 — API Key 和聊天记录只存在 U 盘上，不上传
- 中文技能包 — 内置搜索、翻译、天气、小红书/知乎/微博/B站等写作助手

## Features

- Zero install — bundled Node.js runtime, double-click to start
- Cross-platform — macOS (ARM/Intel), Linux (x64/ARM64), Windows x64
- Visual Config Center — pick a model, enter Key, save, open chat
- 32 model platforms — 15 domestic + 8 international + 5 aggregators + 1 accelerator + 1 custom relay + 2 local (Ollama / LM Studio auto-detected)
- 12 chat channels — Telegram / QQ / Feishu / WeCom / Discord / Slack / WhatsApp / Signal / LINE / Google Chat / MS Teams / WeChat
- Mobile Connect — phones on the same WiFi access via browser (zero install), official app, or third-party apps
- Auto update — one-click update from GitHub Releases with backup and rollback
- Data stays local — API keys and chat history live only on the USB drive, never uploaded
- Chinese skill pack — built-in search, translate, weather, Xiaohongshu/Zhihu/Weibo/Bilibili writing assistants

---

## 快速开始

### 使用发布包（推荐）

从 [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases) 下载 zip，解压到 U 盘或任意目录。

| 平台 | 启动方式 |
|------|----------|
| macOS | 双击 `OpenClaw.app` |
| Windows | 双击 `OpenClaw.vbs` |
| Linux | 双击 `OpenClaw.desktop` |

启动后浏览器自动打开配置页面。选择模型平台 → 填写 API Key → 保存 → 打开聊天。

所有数据跟随 U 盘走，不污染主机。

### macOS 首次启动

macOS 可能提示"无法验证开发者"。解决方法（任选其一）：

1. 右键点击 `OpenClaw.app` → 选择"打开" → 弹窗中点"打开"
2. 终端执行：`xattr -cr /path/to/OpenClawPortable`
3. 系统设置 → 隐私与安全性 → 底部点"仍要打开"

### 从源码构建

```bash
git clone https://github.com/yuluyangguang1/openclaw-portable.git
cd openclaw-portable

# 当前平台
bash setup.sh

# 全平台 U 盘
bash setup.sh --all-platforms
```

Windows 用户用 `setup.bat` 或 `setup.ps1`。

---

## Quick Start

### Use Release Package (Recommended)

Download the zip from [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases), extract to a USB drive or any directory.

| Platform | How to Launch |
|----------|---------------|
| macOS | Double-click `OpenClaw.app` |
| Windows | Double-click `OpenClaw.vbs` |
| Linux | Double-click `OpenClaw.desktop` |

After launch, the browser opens the config page automatically. Pick a model platform, enter API Key, save, open chat.

All data travels with the USB drive — nothing pollutes the host machine.

### macOS First Launch

macOS may show "cannot verify developer". Fix (pick one):

1. Right-click `OpenClaw.app` → choose "Open" → click "Open" in the dialog
2. Run in Terminal: `xattr -cr /path/to/OpenClawPortable`
3. System Settings → Privacy & Security → click "Open Anyway" at the bottom

### Build from Source

```bash
git clone https://github.com/yuluyangguang1/openclaw-portable.git
cd openclaw-portable
bash setup.sh              # current platform
bash setup.sh --all-platforms  # all platforms for USB
```

Windows: use `setup.bat` or `setup.ps1`.

---

## 手机连接 / Mobile Connect

让同一 WiFi 下的手机连接到 OpenClaw Gateway，无需在手机上安装任何东西。

| 平台 | 启动器 |
|------|--------|
| macOS | `system/Mac-Mobile.command` |
| Linux | `system/Linux-Mobile.sh` |
| Windows | `system/Windows-Mobile.bat` |

双击启动器，以 LAN 模式临时启动 Gateway。退出后自动恢复原始配置。

连接方式：

- 手机浏览器：打开 `http://<电脑局域网IP>:<端口>`，Android / iOS 均可
- 官方 App：编译 openclaw 仓库的 `apps/android` 或 `apps/ios`
- 第三方 App：andClaw / AnyClaw / FlutterClaw 等，手动输入 WebSocket 地址和 Token

也可以在配置中心 Web UI 中直接开启手机连接模式，无需使用独立启动器。

安全性：仅私有网段自动批准配对，公网 IP 不会被自动配对。临时配置退出后自动删除。

---

## 目录结构

发布包解压后（用户视角）：

```
OpenClawPortable/
  OpenClaw.app              macOS 启动器
  OpenClaw.vbs              Windows 启动器
  OpenClaw.desktop          Linux 启动器
  OpenClawPortable使用说明.html   用户手册
  README.md
  OPENCLAW_VERSION          上游版本号
  PORTABLE_VERSION          Portable 版本号
  data/                     用户数据（API Key、对话历史等）
  app/                      Node.js 运行时 + OpenClaw 核心
  config-server/            配置中心 Web UI + API
  default-config.json       默认配置
  system/                   底层脚本
    Mac-Start.command
    Mac-Menu.command
    Mac-Mobile.command      手机连接
    Mac-Diagnose.command
    Linux-Start.sh
    Linux-Menu.sh
    Linux-Mobile.sh         手机连接
    Linux-Diagnose.sh
    Windows-Start.bat
    Windows-Menu.bat
    Windows-Mobile.bat      手机连接
    Windows-Diagnose.bat
    lib/                    preflight / maintain / mobile 帮助库
```

源码仓库中 `system/` 里的文件放在根目录（dev 模式），CI 打包时移入 `system/`。

---

## 配置中心

启动后在 `http://127.0.0.1:18750` 打开。

步骤一 — 配置模型：
- 点击模型平台卡片展开
- 选择具体模型
- 填写 API Key
- 本地模型：LM Studio (1234) / Ollama (11434) 自动检测

步骤二 — 启动：
- 点击"打开聊天界面"进入 Gateway

其他功能：
- 更新：从 GitHub Releases 下载新版（带回滚）
- 诊断：openclaw doctor
- 重启：重启 Gateway
- 配置管理：导出 / 导入 / 查看 JSON / 重置
- 渠道接入：12 个聊天平台一站式配置
- 手机连接：开启/关闭 LAN 模式
- 运行日志：实时查看 Gateway 日志

---

## 内置技能

| 技能 | 说明 |
|------|------|
| china-search | 国内搜索引擎 |
| china-translate | 中英翻译 |
| china-weather | 天气查询 |
| xiaohongshu-writer | 小红书文案 |
| zhihu-writer | 知乎回答 |
| weibo-poster | 微博文案 |
| wechat-article | 公众号文章 |
| bilibili-helper | B站内容 |
| douyin-script | 抖音脚本 |
| deepseek-helper | DeepSeek 增强 |

技能在 `skills-cn/` 目录下，启动时自动加载。

---

## 平台支持

| 平台 | 架构 | 状态 |
|------|------|------|
| macOS | Apple Silicon (M1-M4) | 支持 |
| macOS | Intel x64 | 支持 |
| Linux | x64 | 支持 |
| Linux | ARM64 | 支持 |
| Windows | x64 | 支持 |
| Android / iOS | 通过 Mobile Connect | 支持 |

macOS 版本说明：Node.js 24 官方标注最低 macOS 13.5（Ventura），实测 macOS 12+ 可正常运行。如遇启动失败请升级 macOS。

---

## 上游项目

基于 [OpenClaw](https://github.com/nicepkg/openclaw) 构建。OpenClaw 是开源 AI 助手框架，支持多模型、多渠道、插件扩展。

Portable 版本的工作：
- 打包 Node.js 运行时实现零安装
- 提供可视化配置中心替代命令行配置
- 内置中文优化技能包
- 适配 U 盘便携场景（相对路径、数据隔离、exFAT 兼容）

---

## License

MIT
