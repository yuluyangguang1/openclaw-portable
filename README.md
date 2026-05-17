# OpenClaw Portable

把 [OpenClaw](https://github.com/openclaw/openclaw)（开源 AI 助手）打包成便携版，插上 U 盘就能在任意电脑上运行，无需安装任何依赖。

## 特性

- **零安装** — 自带 Node.js 运行时，双击启动
- **跨平台** — macOS (ARM/Intel)、Linux x64、Windows x64
- **可视化配置中心** — 两步流程：选模型填 Key → 启动
- **32 个模型平台** — 国产 15 + 国际 8 + 聚合 5 + 加速 1 + 自定义中转 1 + 本地 2（Ollama / LM Studio）。LM Studio / Ollama 自动检测；其他本地 runtime（vLLM / GPT4All / Jan / KoboldCpp / Text Gen WebUI / XInference / MLX / llama.cpp / LocalAI）按 OpenAI-compatible 接口接入即可
- **12 个聊天渠道** — Telegram/QQ/飞书/企微/Discord/Slack/WhatsApp/Signal/LINE/Google Chat/MS Teams/微信
- **自动更新** — 从 GitHub Releases 一键下载更新（带备份回滚）
- **运行日志** — 配置中心可查看 Gateway 实时日志
- **配置导入导出** — JSON 格式备份/恢复
- **中文技能包** — 内置搜索、翻译、天气、小红书/知乎/微博/B站等写作助手
- **数据本地** — API Key 和聊天记录只存在 U 盘上，不上传
- **yu.ai 风格 UI** — 深绿色调，衬线大标题 + mono 终端，与 [yu.ai](https://yu.ai/) 全站一致

## 快速开始

### 使用发布包（推荐）

从 [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases) 下载对应平台的 zip，解压到 U 盘或任意目录。

启动：

| 平台 | 启动方式 |
|------|------|
| macOS | 双击 `OpenClaw.app` |
| Windows | 双击 `OpenClaw.vbs` |
| Linux | 双击 `OpenClaw.desktop` |

发布包根目录只保留这三个启动器和使用说明，方便用户。底层的 launcher 脚本、菜单、诊断工具等放在 `system/` 子目录里，避免误操作。

所有数据（API Key、对话历史、配置）都跟随 U 盘走，不污染主机。

启动后自动打开浏览器配置页面，选择模型平台 → 填写 API Key → 保存 → 打开聊天。

### 从源码构建

```bash
git clone https://github.com/yuluyangguang1/openclaw-portable.git
cd openclaw-portable

# 下载运行时 + 安装 OpenClaw（当前平台）
bash setup.sh

# 制作全平台 U 盘（下载所有平台的 Node.js）
bash setup.sh --all-platforms
```

Windows 用户用 `setup.bat` 或 `setup.ps1`。

## 目录结构

发布包解压后看到的根目录（用户视角，干净）：

```
OpenClawPortable/
├── OpenClaw.app             # macOS 启动器（带图标）
├── OpenClaw.vbs             # Windows 启动器
├── OpenClaw.desktop         # Linux 启动器
├── 使用说明.html             # 用户手册
├── README.md
├── OPENCLAW_VERSION         # 上游版本号
├── PORTABLE_VERSION         # Portable 版本号
├── data/                    # 用户数据（API Key、对话历史等）
├── app/                     # Node.js 运行时 + OpenClaw 核心
├── config-server/           # 配置中心 Web UI + API
├── skills-cn/               # 中文技能包
└── system/                  # 底层脚本（用户通常不需要碰）
    ├── Mac-Start.command    # 启动脚本（双击 OpenClaw.app 时调用）
    ├── Mac-Menu.command     # 菜单（更新/诊断/重置）
    ├── Mac-Diagnose.command
    ├── Linux-Start.sh
    ├── Linux-Menu.sh
    ├── Linux-Diagnose.sh
    ├── Windows-Start.bat
    ├── Windows-Menu.bat
    ├── Windows-Diagnose.bat
    ├── default-config.json
    └── lib/                 # preflight / maintain 帮助库
```

源码仓库的根目录则把 `system/` 里的文件放在最外层（dev 模式），CI 在打包时移到 `system/` 下。

## 配置中心

启动后会在 `http://127.0.0.1:18788` 打开配置页面：

### 步骤一：配置模型

- 点击模型平台卡片展开
- 选择具体模型（下拉菜单）
- 填写 API Key（密码框，可显示）
- 自定义中转站：Base URL + 模型名 + Key 一步到位
- 本地模型：LM Studio (1234) / Ollama (11434) 自动检测

### 步骤二：启动

- **大按钮：打开聊天界面** — 直接进入 Gateway
- **命令面板**：
  - 更新：从 GitHub Releases 下载新版（带回滚）
  - 诊断：openclaw doctor
  - 引导：openclaw onboard
  - 重启：重启 Gateway
- **配置管理**：导出 / 导入 / 查看 JSON / 重新配置 / 查看日志
- **渠道接入**：12 个聊天平台一站式配置

### 顶部状态栏

- Gateway 运行状态（绿点 + 端口）
- 一键打开聊天

### 后台机制

- 心跳检测：5 秒一次，3 次失败显示断连提示
- 自动版本号：从 PORTABLE_VERSION 文件实时读取

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

## 常用命令

通过配置中心的命令面板或终端执行：

```bash
openclaw update      # 更新到最新版
openclaw doctor      # 诊断运行环境
openclaw onboard     # 引导初始化
```

## 上游项目

本项目基于 [OpenClaw](https://github.com/nicepkg/openclaw) 构建。OpenClaw 是一个开源的 AI 助手框架，支持多模型、多渠道、插件扩展。

Portable 版本的工作：
- 打包 Node.js 运行时实现零安装
- 提供可视化配置中心替代命令行配置
- 内置中文优化技能包
- 适配 U 盘便携场景（相对路径、数据隔离）

## 平台支持

| 平台 | 架构 | 状态 |
|------|------|------|
| macOS | Apple Silicon (M1/M2/M3/M4) | ✅ |
| macOS | Intel x64 | ✅ |
| Linux | x64 | ✅ |
| Windows | x64 | ✅ |

## License

MIT
