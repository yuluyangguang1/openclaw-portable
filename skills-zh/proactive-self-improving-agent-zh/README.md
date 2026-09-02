# Proactive Self-Improving Agent

自动捕获经验 · 安全进化 · 记录轨迹

专为 OpenClaw agent 设计的自改进技能，融合 proactive-agent 的行为准则与 self-improving-agent 的结构化学习系统。

## 特性

- **7 种触发条件**：错误、纠正、知识空白、更好做法、能力请求、任务完成回顾 + 学术场景扩展
- **结构化记录**：LEARNINGS / ERRORS / FEATURE_REQUESTS 三文件体系
- **经验进化**：晋升机制 + 递归检测（≥3 次自动晋升）+ 技能提取
- **安全护栏**：ADL 防漂移 + VFM 价值优先评分
- **操作日志**：JSONL 格式 CHANGELOG，机器可读
- **行为准则**：坚韧不放弃、验证后报完成、安全加固

## 安装

```bash
# OpenClaw
openclaw add https://github.com/yanhongxi-openclaw/proactive-self-improving-agent

# 或手动
git clone https://github.com/yanhongxi-openclaw/proactive-self-improving-agent.git ~/.openclaw/skills/proactive-self-improving-agent
```

## 使用

安装后 agent 自动加载 SKILL.md。确保 workspace 下有 `.learnings/` 目录：

```bash
mkdir -p .learnings
```

详见 [SKILL.md](SKILL.md)。

## License

MIT
