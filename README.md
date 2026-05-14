# OpenClaw Portable

把 [OpenClaw](https://github.com/nicepkg/openclaw)（开源 AI 助手）打包成便携版，插上 U 盘就能在任意电脑上运行，无需安装任何依赖。

## 特性

- **零安装** — 自带 Node.js 运行时，双击启动
- **跨平台** — macOS (ARM/Intel)、Linux x64、Windows x64
- **可视化配置** — 浏览器内选模型、填 Key、一键启动
- **多模型支持** — 国产（千问/GLM/DeepSeek/Kimi/MiniMax/豆包等）、国际（OpenAI/Claude/Gemini/Groq 等）、本地（LM Studio/Ollama）
- **中文技能包** — 内置搜索、翻译、天气、小红书/知乎/微博/B站等写作助手
- **数据本地** — API Key 和聊天记录只存在 U 盘上，不上传

## 快速开始

### 使用发布包（推荐）

从 [Releases](https://github.com/yuluyangguang1/openclaw-portable/releases) 下载对应平台的 zip，解压到 U 盘或任意目录。

启动：

| 平台 | 操作 |
|------|------|
| macOS | 双击 `Mac-Start.command` |
| Windows | 双击 `Windows-Start.bat` |
| Linux | `bash Linux-Start.sh` |

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

```
openclaw-portable/
├── Mac-Start.command        # macOS 启动器
├── Mac-Menu.command         # macOS 菜单（更新/诊断）
├── Windows-Start.bat        # Windows 启动器
├── Windows-Menu.bat         # Windows 菜单
├── Linux-Start.sh           # Linux 启动器
├── Linux-Menu.sh            # Linux 菜单
├── config-server/           # 配置中心（Web UI + API）
│   ├── server.js
│   └── public/index.html
├── app/
│   ├── core/                # OpenClaw 核心 + node_modules
│   └── runtime/             # Node.js 运行时（各平台）
├── skills-cn/               # 中文技能包
├── data/                    # 运行时数据（启动后生成）
│   └── .openclaw/
│       └── openclaw.json    # 用户配置
├── setup.sh                 # 构建脚本（macOS/Linux）
├── setup.bat                # 构建脚本（Windows）
└── OPENCLAW_VERSION         # 锁定的上游版本号
```

## 配置中心

启动后会在 `http://127.0.0.1:18788` 打开配置页面：

1. **配置**（第一步）— 点击模型平台卡片展开，选择具体模型，填写 API Key
2. **启动**（第二步）— 打开聊天界面，或执行更新/诊断/重启等命令

支持自定义中转站（任意 OpenAI 兼容 API）和本地模型（LM Studio / Ollama）。

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
