# OpenClaw Portable

把 [OpenClaw](https://github.com/openclaw/openclaw)（开源 AI 助手）打包成便携版，插上 U 盘就能在任意电脑上运行，无需安装任何依赖。

Pack [OpenClaw](https://github.com/openclaw/openclaw) (open-source AI assistant) into a portable edition — plug in a USB drive and run on any computer with zero dependencies.

## 特性 / Features

- **零安装** — 自带 Node.js 运行时，双击启动
- **Zero Install** — Bundled Node.js runtime, double-click to start
- **跨平台** — macOS (ARM/Intel)、Linux x64、Windows x64，手机通过 Mobile Connect 连接
- **Cross-platform** — macOS (ARM/Intel), Linux x64, Windows x64; phones connect via Mobile Connect
- **可视化配置中心** — 两步流程：选模型填 Key → 启动
- **Visual Config Center** — Two-step flow: pick a model, enter Key → launch
- **32 个模型平台** — 国产 15 + 国际 8 + 聚合 5 + 加速 1 + 自定义中转 1 + 本地 2（Ollama / LM Studio）。LM Studio / Ollama 自动检测；其他本地 runtime（vLLM / GPT4All / Jan / KoboldCpp / Text Gen WebUI / XInference / MLX / llama.cpp / LocalAI）按 OpenAI-compatible 接口接入即可
- **32 Model Platforms** — 15 domestic + 8 international + 5 aggregators + 1 accelerator + 1 custom relay + 2 local (Ollama / LM Studio). LM Studio / Ollama auto-detected; other local runtimes connect via OpenAI-compatible API
- **12 个聊天渠道** — Telegram/QQ/飞书/企微/Discord/Slack/WhatsApp/Signal/LINE/Google Chat/MS Teams/微信
- **12 Chat Channels** — Telegram/QQ/Feishu/WeCom/Discord/Slack/WhatsApp/Signal/LINE/Google Chat/MS Teams/WeChat
- **📱 手机连接** — 同一 WiFi 下手机浏览器零安装访问，也支持官方 App 和第三方 App
- **📱 Mobile Connect** — Phones on the same WiFi can access via browser (zero install), official app, or third-party apps
- **自动更新** — 从 GitHub Releases 一键下载更新（带备份回滚）
- **Auto Update** — One-click update from GitHub Releases (with backup & rollback)
- **运行日志** — 配置中心可查看 Gateway 实时日志
- **Live Logs** — View real-time Gateway logs in the Config Center
- **配置导入导出** — JSON 格式备份/恢复
- **Config Import/Export** — Backup and restore in JSON format
- **中文技能包** — 内置搜索、翻译、天气、小红书/知乎/微博/B站等写作助手
- **Chinese Skill Pack** — Built-in search, translate, weather, Xiaohongshu/Zhihu/Weibo/Bilibili writing assistants
- **数据本地** — API Key 和聊天记录只存在 U 盘上，不上传
- **Data Stays Local** — API keys and chat history live only on the USB drive, never uploaded
- **yu.ai 风格 UI** — 深绿色调，衬线大标题 + mono 终端，与 [yu.ai](https://yu.ai/) 全站一致
- **yu.ai-style UI** — Deep green palette, serif headings + mono terminal, consistent with [yu.ai](https://yu.ai/)

## 快速开始 / Quick Start

### 使用发布包（推荐） / Use Release Package (Recommended)

从 [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases) 下载对应平台的 zip，解压到 U 盘或任意目录。

Download the zip for your platform from [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases), extract to a USB drive or any directory.

启动 / Launch:

| 平台 Platform | 启动方式 How to Launch |
|------|------|
| macOS | 双击 `OpenClaw.app` / Double-click `OpenClaw.app` |
| Windows | 双击 `OpenClaw.vbs` / Double-click `OpenClaw.vbs` |
| Linux | 双击 `OpenClaw.desktop` / Double-click `OpenClaw.desktop` |

发布包根目录只保留这三个启动器和使用说明，方便用户。底层的 launcher 脚本、菜单、诊断工具等放在 `system/` 子目录里，避免误操作。

The release root keeps only the three launchers and user manual for simplicity. Underlying launcher scripts, menus, and diagnostic tools live in `system/` to prevent accidental edits.

所有数据（API Key、对话历史、配置）都跟随 U 盘走，不污染主机。

All data (API keys, chat history, config) travels with the USB drive — nothing pollutes the host machine.

启动后自动打开浏览器配置页面，选择模型平台 → 填写 API Key → 保存 → 打开聊天。

After launch, the browser opens the config page automatically. Pick a model platform → enter API Key → save → open chat.

### 从源码构建 / Build from Source

```bash
git clone https://github.com/yuluyangguang1/openclaw-portable.git
cd openclaw-portable

# 下载运行时 + 安装 OpenClaw（当前平台）
# Download runtime + install OpenClaw (current platform)
bash setup.sh

# 制作全平台 U 盘（下载所有平台的 Node.js）
# Build for all platforms (downloads Node.js for every platform)
bash setup.sh --all-platforms
```

Windows 用户用 `setup.bat` 或 `setup.ps1`。

Windows users: use `setup.bat` or `setup.ps1`.

## 📱 手机连接 / Mobile Connect

让同一 WiFi 下的手机（Android / iOS）连接到 OpenClaw Gateway，无需在手机上安装任何东西。

Let phones (Android / iOS) on the same WiFi connect to the OpenClaw Gateway — no installation needed on the phone.

### 启动方式 / Launchers

| 平台 Platform | 启动器 Launcher |
|------|------|
| macOS | `system/Mac-Mobile.command` |
| Linux | `system/Linux-Mobile.sh` |
| Windows | `system/Windows-Mobile.bat` |

双击对应启动器即可。它会以 LAN 模式临时启动 Gateway，退出后自动恢复原始配置。

Double-click the launcher for your platform. It starts the Gateway in LAN mode temporarily; the original config is restored on exit.

### 工作原理 / How It Works

1. 生成临时配置，将 Gateway 绑定到局域网 IP（而非 127.0.0.1）
2. 私有网段（192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12）自动批准配对，无需手动确认
3. 退出时自动删除临时配置，不影响正常使用

1. Generates a temporary config binding the Gateway to the LAN IP (instead of 127.0.0.1)
2. Private network CIDRs (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12) are auto-approved — no manual confirmation needed
3. Temporary config is deleted on exit, leaving normal usage unaffected

### 连接方式 / Connection Methods

**方式一：手机浏览器（推荐，零安装）**
**Method 1: Phone Browser (recommended, zero install)**

打开手机浏览器访问 `http://<电脑局域网IP>:<端口>` 即可使用，Android / iOS 均可。

Open the phone browser and visit `http://<computer-LAN-IP>:<port>` — works on both Android and iOS.

**方式二：官方 App（获得摄像头/语音能力）**
**Method 2: Official App (camera/voice capabilities)**

编译 openclaw 仓库的 `apps/android` 或 `apps/ios`，连接时输入局域网地址或使用自动发现。

Build from the openclaw repo's `apps/android` or `apps/ios`; enter the LAN address or use auto-discovery to connect.

**方式三：第三方 App**
**Method 3: Third-party Apps**

Google Play 上的 andClaw / AnyClaw / FlutterClaw 等，手动输入 Gateway 的 WebSocket 地址和 Token。

Apps like andClaw / AnyClaw / FlutterClaw on Google Play — manually enter the Gateway's WebSocket address and token.

### 配置中心开关 / Config Center Toggle

也可以在配置中心 Web UI 中启用手机连接模式，无需使用独立启动器。

You can also enable Mobile Connect mode from the Config Center Web UI without using the standalone launcher.

### 安全性 / Security

- 仅私有网段 CIDR 自动批准，公网 IP 不会被自动配对
- 临时配置退出后自动删除
- 不修改用户的主配置文件

- Only private network CIDRs are auto-approved; public IPs are never auto-paired
- Temporary config is deleted on exit
- The user's main config file is never modified

## 目录结构 / Directory Structure

发布包解压后看到的根目录（用户视角，干净）：

Root directory after extracting the release package (user-facing, clean):

```
OpenClawPortable/
├── OpenClaw.app             # macOS 启动器（带图标） / macOS launcher (with icon)
├── OpenClaw.vbs             # Windows 启动器 / Windows launcher
├── OpenClaw.desktop         # Linux 启动器 / Linux launcher
├── 使用说明.html             # 用户手册 / User manual
├── README.md
├── OPENCLAW_VERSION         # 上游版本号 / Upstream version
├── PORTABLE_VERSION         # Portable 版本号 / Portable version
├── data/                    # 用户数据（API Key、对话历史等） / User data
├── app/                     # Node.js 运行时 + OpenClaw 核心 / Runtime + core
├── config-server/           # 配置中心 Web UI + API / Config Center
├── skills-cn/               # 中文技能包 / Chinese skill pack
└── system/                  # 底层脚本 / Internal scripts
    ├── Mac-Start.command
    ├── Mac-Menu.command
    ├── Mac-Mobile.command   # 📱 手机连接 / Mobile Connect
    ├── Mac-Diagnose.command
    ├── Linux-Start.sh
    ├── Linux-Menu.sh
    ├── Linux-Mobile.sh      # 📱 手机连接 / Mobile Connect
    ├── Linux-Diagnose.sh
    ├── Windows-Start.bat
    ├── Windows-Menu.bat
    ├── Windows-Mobile.bat   # 📱 手机连接 / Mobile Connect
    ├── Windows-Diagnose.bat
    ├── default-config.json
    └── lib/                 # preflight / maintain / mobile 帮助库 / helper libs
```

源码仓库的根目录则把 `system/` 里的文件放在最外层（dev 模式），CI 在打包时移到 `system/` 下。

In the source repo, `system/` files live at the root (dev mode); CI moves them into `system/` during packaging.

## 配置中心 / Config Center

启动后会在 `http://127.0.0.1:18750` 打开配置页面：

After launch, the config page opens at `http://127.0.0.1:18750`:

### 步骤一：配置模型 / Step 1: Configure Model

- 点击模型平台卡片展开 / Click a model platform card to expand
- 选择具体模型（下拉菜单） / Pick a model from the dropdown
- 填写 API Key（密码框，可显示） / Enter API Key (password field, toggleable)
- 自定义中转站：Base URL + 模型名 + Key 一步到位 / Custom relay: Base URL + model name + Key in one step
- 本地模型：LM Studio (1234) / Ollama (11434) 自动检测 / Local models: LM Studio (1234) / Ollama (11434) auto-detected

### 步骤二：启动 / Step 2: Launch

- **大按钮：打开聊天界面** — 直接进入 Gateway
- **Big button: Open Chat** — goes straight to Gateway
- **命令面板 / Command Panel**：
  - 更新 Update：从 GitHub Releases 下载新版（带回滚） / Download new version from GitHub Releases (with rollback)
  - 诊断 Diagnose：openclaw doctor
  - 引导 Onboard：openclaw onboard
  - 重启 Restart：重启 Gateway / Restart Gateway
- **配置管理 / Config Management**：导出 / 导入 / 查看 JSON / 重新配置 / 查看日志 / Export / Import / View JSON / Reconfigure / View Logs
- **渠道接入 / Channel Setup**：12 个聊天平台一站式配置 / One-stop config for 12 chat platforms
- **📱 手机连接 / Mobile Connect**：开启/关闭 LAN 模式 / Toggle LAN mode on/off

### 顶部状态栏 / Top Status Bar

- Gateway 运行状态（绿点 + 端口） / Gateway status (green dot + port)
- 一键打开聊天 / One-click open chat

### 后台机制 / Background Mechanisms

- 心跳检测：5 秒一次，3 次失败显示断连提示 / Heartbeat: every 5s, shows disconnect warning after 3 failures
- 自动版本号：从 PORTABLE_VERSION 文件实时读取 / Auto version: reads from PORTABLE_VERSION file in real time

## 内置技能 / Built-in Skills

| 技能 Skill | 说明 Description |
|------|------|
| china-search | 国内搜索引擎 / Domestic search engine |
| china-translate | 中英翻译 / CN-EN translation |
| china-weather | 天气查询 / Weather lookup |
| xiaohongshu-writer | 小红书文案 / Xiaohongshu copywriting |
| zhihu-writer | 知乎回答 / Zhihu answers |
| weibo-poster | 微博文案 / Weibo posts |
| wechat-article | 公众号文章 / WeChat articles |
| bilibili-helper | B站内容 / Bilibili content |
| douyin-script | 抖音脚本 / Douyin scripts |
| deepseek-helper | DeepSeek 增强 / DeepSeek enhancement |

技能在 `skills-cn/` 目录下，启动时自动加载。

Skills live in `skills-cn/` and are loaded automatically on startup.

## 常用命令 / Common Commands

通过配置中心的命令面板或终端执行：

Run via the Config Center command panel or terminal:

```bash
openclaw update      # 更新到最新版 / Update to latest
openclaw doctor      # 诊断运行环境 / Diagnose environment
openclaw onboard     # 引导初始化 / Guided initialization
```

## 上游项目 / Upstream Project

本项目基于 [OpenClaw](https://github.com/nicepkg/openclaw) 构建。OpenClaw 是一个开源的 AI 助手框架，支持多模型、多渠道、插件扩展。

This project is built on [OpenClaw](https://github.com/nicepkg/openclaw). OpenClaw is an open-source AI assistant framework supporting multiple models, channels, and plugin extensions.

Portable 版本的工作 / What Portable adds:
- 打包 Node.js 运行时实现零安装 / Bundles Node.js runtime for zero-install
- 提供可视化配置中心替代命令行配置 / Visual Config Center replaces CLI configuration
- 内置中文优化技能包 / Built-in Chinese-optimized skill pack
- 适配 U 盘便携场景（相对路径、数据隔离） / Adapted for USB portability (relative paths, data isolation)

## 平台支持 / Platform Support

| 平台 Platform | 架构 Architecture | 状态 Status |
|------|------|------|
| macOS | Apple Silicon (M1/M2/M3/M4) | ✅ |
| macOS | Intel x64 | ✅ |
| Linux | x64 | ✅ |
| Linux | ARM64 | ✅ |
| Windows | x64 | ✅ |
| Android / iOS | 📱 通过 Mobile Connect 连接 / via Mobile Connect | ✅ |

> **macOS 版本说明**：Node.js 24 官方标注最低 macOS 13.5（Ventura），但实测 macOS 12+ 可正常运行。如遇启动失败请升级 macOS。
>
> **macOS version note**: Node.js 24 officially requires macOS 13.5 (Ventura) minimum, but works on macOS 12+ in practice. Upgrade macOS if launch fails.

## License

MIT
