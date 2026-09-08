# OpenClaw Portable

[English](README.md) | **简体中文**

把 [OpenClaw](https://github.com/openclaw/openclaw)——开源 AI 助手 / 网关——打包成完全自包含的便携版。插上 U 盘即可在任意电脑上运行，零安装、不污染主机。

![配置中心总览](docs/screenshots/config-center-main.png)

## 特性

- **零安装** — 自带 Node.js 运行时，双击启动
- **跨平台** — Windows x64、macOS（Apple Silicon / Intel）、Linux（x64 / ARM64）
- **可视化配置中心** — 选平台、粘 Key、保存、打开聊天，两步完成，无需命令行
- **32 个模型平台** — 国产 15 + 国际 8 + 聚合 5 + 加速 1 + 自定义中转 1 + 本地 2（Ollama / LM Studio 自动检测）
- **12 个聊天渠道** — Telegram / QQ / 飞书 / 企微 / Discord / Slack / WhatsApp / Signal / LINE / Google Chat / MS Teams / 微信
- **技能管理面板** — 支持从 zip 直链或 GitHub 仓库安装技能，在配置中心直接启停/删除；OpenClaw 2026.9.2+ 自动热加载
- **高级设置** — Swarm 子代理并发、会话可见性、配置热加载模式，保存即生效、无需重启网关
- **手机连接** — 同一 WiFi 下手机浏览器零安装访问，也支持官方 App 和第三方 App
- **自动更新** — 从 GitHub Releases 一键下载更新，带备份回滚
- **数据本地** — API Key 和聊天记录只存在 U 盘上，不上传
- **中文技能包** — 内置搜索、翻译、天气、小红书/知乎/微博/B站等写作助手

## 截图

| 模型平台（内置 41 个） | 技能管理 & 高级设置 |
|---|---|
| ![模型平台](docs/screenshots/config-center-platforms.png) | ![技能管理与高级设置](docs/screenshots/config-center-advanced.png) |

## 快速开始

### 使用发布包（推荐）

从 [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases) 下载 zip，解压到 U 盘或任意目录。

| 平台 | 启动方式 |
|------|----------|
| Windows | 双击 `OpenClaw.vbs` |
| macOS | 双击 `OpenClaw.app` |
| Linux | 双击 `OpenClaw.desktop` |

浏览器自动打开配置中心。选平台 → 粘 API Key → 保存 → 打开聊天。

所有数据跟随 U 盘走，不污染主机。

> **升级**：下载新 zip 解压覆盖旧目录即可——`data/` 目录（Key、历史、已装技能）在升级时保留。

### macOS 首次启动

macOS 可能提示"无法验证开发者"。解决方法（任选其一）：

1. 右键点击 `OpenClaw.app` → 选择"打开" → 弹窗中点"打开"
2. 终端执行：`xattr -cr /path/to/OpenClawPortable`
3. 系统设置 → 隐私与安全性 → 底部点"仍要打开"

### 从源码构建

```bash
git clone https://github.com/yuluyangguang1/openclaw-portable.git
cd openclaw-portable
bash setup.sh                 # 当前平台
bash setup.sh --all-platforms # 全平台 U 盘
```

Windows 用户用 `setup.bat` 或 `setup.ps1`。

## 配置中心

启动后在 `http://127.0.0.1:18750` 打开。

**步骤一 — 配置模型**
- 点击平台卡片展开
- 选择具体模型
- 粘贴 API Key
- 本地运行时：LM Studio（1234）/ Ollama（11434）自动检测

**步骤二 — 启动**
- 点击"打开聊天界面"进入网关 Web UI

其他功能：更新（带回滚）、`openclaw doctor` 诊断、网关重启、配置导出/导入/重置、12 渠道一站式接入、手机连接开关、网关日志实时查看。

### 模型目录热更新

平台/模型列表无需等整包升级，用户可自行拉取最新目录：

- **用户侧**："选择模型平台"页顶部有目录工具栏（`更新目录 / 导入 / 导出 / 恢复内置`）。"更新目录"即从本仓库拉最新列表；缓存超 7 天会在打开页面时自动后台刷新。离线用户可先在其他设备下载 `models-catalog.json`，再点"导入"。
- **缓存位置**：`data/.openclaw/models-catalog.json`（data/ 目录整包升级时保留）。
- **维护者侧**：只需修改仓库 [`system/models-catalog.json`](system/models-catalog.json)（`version` 建议用日期如 `2026.08.22`），提交后用户即可拉到。拉取源依次为 jsDelivr → raw.githubusercontent → ghproxy 镜像，国内可达。
- **自定义源**：高级用户可在 `data/.openclaw/catalog-sources.json` 写入 URL 数组覆盖默认源。
- 已保存的模型配置不受目录更新影响——目录只影响下拉选项。

### 技能管理

![技能管理](docs/screenshots/config-center-skills.png)

三类技能来源，全部在配置中心管理：

| 来源 | 位置 | 行为 |
|------|------|------|
| 预置（随包） | `system/skills-zh/` | 只读，启动时自动加载 |
| 备选库 | `system/skills-zh-optional/` | 一键启用 → 复制进安装区 |
| 已安装 | `data/.openclaw/skills/` | 安装 / 停用 / 删除；升级保留 |

- **安装**：粘贴 zip 直链或 GitHub `owner/repo` 回车——服务端下载、解压、校验 `SKILL.md`、原子安装（单批 50 MB / 20 个技能上限）。
- **热加载**：OpenClaw 2026.9.2+ 监视这些目录——安装、启用、删除即刻生效，无需重启网关。

### 高级设置

OpenClaw 2026.9.2+ 专属开关，保存即生效（无需重启网关）：

- **Swarm 子代理** — 启用 / 并发上限（默认 8）
- **会话可见性** — `all`（9.2 默认）/ `agent` / `self`
- **配置热加载** — `hybrid`（默认）/ `off`

## 手机连接

让同一 WiFi 下的手机无需安装任何东西即可连接网关。

| 平台 | 启动器 |
|------|--------|
| macOS | `system/Mac-Mobile.command` |
| Linux | `system/Linux-Mobile.sh` |
| Windows | `system/Windows-Mobile.bat` |

双击以临时 LAN 模式启动网关，退出后自动恢复原始配置。

- **手机浏览器**：打开 `http://<电脑局域网IP>:<端口>`，Android / iOS 均可
- **官方 App**：编译 openclaw 仓库的 `apps/android` / `apps/ios`
- **第三方 App**：andClaw / AnyClaw / FlutterClaw 等，手动输入 WebSocket 地址和 Token

也可以在配置中心 Web UI 直接开关手机连接模式。

安全性：仅私有网段自动批准配对，公网 IP 不会自动配对。临时配置退出后自动删除。

## 目录结构

发布包解压后（用户视角）：

```
OpenClawPortable/
 OpenClaw.vbs                    Windows 启动器
 OpenClaw.app                    macOS 启动器
 OpenClawPortable使用说明.html    用户手册
 data/                           用户数据（API Key、历史、已装技能）
 app/                            Node.js 运行时 + OpenClaw 核心
 config-server/                  配置中心 Web UI + API
 system/                         脚本 + 配置 + 技能包：
  ├─ OPENCLAW_VERSION            上游版本号
  ├─ PORTABLE_VERSION            Portable 版本号
  ├─ default-config.json         默认配置
  ├─ models-catalog.json         模型目录（维护者单源）
  ├─ skills-zh-manifest.json     中文技能清单
  ├─ verify-skills-zh.py         清单校验脚本
  ├─ skills-zh/                  中文技能包（内置）
  ├─ skills-zh-optional/         中文技能包（可选）
  ├─ OpenClaw.desktop            Linux 启动器
  ├─ README.md                   离线文档
  ├─ Mac-Start/Menu/Mobile/Diagnose.command
  ├─ Linux-Start/Menu/Mobile/Diagnose.sh
  ├─ Windows-Start/Menu/Mobile/Diagnose.bat
  └─ lib/                        preflight / maintain / mobile 帮助库
```

源码仓库与发布包布局一致：除双击入口和 `app/` / `config-server/` / `data/` 外全部在 `system/`（CI 打包时把启动器从仓库根移入 `system/`）。

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

技能在 `system/skills-zh/` 目录下，启动时自动加载。更多在 `system/skills-zh-optional/`——在配置中心技能面板一键启用。

## 平台支持

| 平台 | 架构 | 状态 |
|------|------|------|
| Windows | x64 | 支持 |
| macOS | Apple Silicon (M1–M4) | 支持 |
| macOS | Intel x64 | 支持 |
| Linux | x64 | 支持 |
| Linux | ARM64 | 支持 |
| Android / iOS | 通过 Mobile Connect | 支持 |

macOS 说明：Node.js 24 官方最低 macOS 13.5（Ventura），实测 macOS 12+ 可正常运行。启动失败请升级 macOS。

## 维护者须知

- **升级上游内核**：优先走 `maintain.sh` 的升级入口——`npm install openclaw@latest` 后会自动重跑 `lib/promote-official-providers.mjs`（全新安装会抹掉已提升的官方 provider 插件；promote 幂等）。手动升级的话，事后必须执行 `node lib/promote-official-providers.mjs <core目录>`。
- **发版**：推 tag（如 `v2.0.0-beta.6`），CI（Build & Release）自动全平台出包并挂 GitHub Release；tag 含 `alpha`/`beta`/`rc` 会标记为 prerelease。
- **Windows 启动器是 GBK 编码**：所有含中文的 `.bat` 必须保持 **GBK + CRLF、无 BOM**（中文 Windows 的 cmd 解析 UTF-8 会崩坏）。CI 打包时强制——不要把编码"改回"UTF-8。

## 上游项目

基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建。OpenClaw 是开源 AI 助手框架，支持多模型、多渠道、插件扩展。

Portable 版本的工作：
- 打包 Node.js 运行时实现零安装
- 提供可视化配置中心替代命令行配置
- 内置中文优化技能包
- 适配 U 盘便携场景（相对路径、数据隔离、exFAT 兼容）

## License

MIT
