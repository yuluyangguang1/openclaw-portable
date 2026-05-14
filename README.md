# 🦞 OpenClaw Portable

> **OpenClaw AI 助手 — 离线 U 盘版 / Offline USB Edition**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 这是什么

OpenClaw Portable 是一个可制作成 U 盘版本的 AI 助手。将 OpenClaw（开源 AI 助手）打包成「插上就能用」的便携形态，在任意 Windows / Mac / Linux 电脑上运行，无需安装。

## 支持的 AI 模型

| 类型 | 模型 |
|------|------|
| 国产 | 通义千问 · 智谱 GLM · 豆包 · MiniMax · DeepSeek · Kimi |
| 国际 | Claude · GPT · Gemini |
| 本地 | LM Studio · Ollama（离线运行） |

## 支持的聊天平台

Telegram · Discord · Slack · QQ · 飞书 · 企业微信 · WhatsApp

## 支持平台

| 平台 | 状态 |
|------|------|
| Mac (Apple Silicon) | ✅ |
| Mac (Intel) | ✅ |
| Windows x64 | 🚧 |
| Linux x64 | ✅ |

## 启动方式

| 平台 | 命令 |
|------|------|
| Mac | `open Mac-Start.command` |
| Windows | 双击 `Windows-Start.bat` |
| Linux | `bash Linux-Start.sh` |

## 快速开始

```bash
# 克隆
git clone https://github.com/yuluyangguang1/openclaw-portable.git

# 补齐依赖（开发者用，国内镜像）
cd openclaw-portable && bash setup.sh
```

## 文件结构

```
openclaw-portable/
├── Mac-Start.command           Mac 启动
├── Mac-Menu.command            Mac 菜单
├── Windows-Start.bat           Windows 启动
├── Linux-Start.sh              Linux 启动
├── Linux-Menu.sh               Linux 菜单
├── Linux-Diagnose.sh           Linux 诊断
├── config-server/              配置中心服务
│   ├── server.js               后端 API
│   └── public/index.html       配置页面
├── app/core/                   OpenClaw 核心
└── data/                       用户数据
```
