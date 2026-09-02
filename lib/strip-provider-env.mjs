// strip-provider-env.mjs — 启动 gateway 前，把宿主机残留的第三方 provider 凭证
// 环境变量剥掉，输出 OPENCLAW_STRIP_ENV=<逗号名单> 给各平台启动脚本逐项清空。
//
// 背景（openclaw-portable 8.2 避雷清单 雷5）：
//   宿主机上残留 DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 等变量时，
//   OpenClaw 会把该外部 provider 判定为「已配置」→ 启动阶段尝试装对应官方插件
//   （命中官方 catalog 的 id → @openclaw/<id>-provider 运行时安装）→ exFAT 上建
//   不出 node_modules 链接 → gateway 永不 ready；NTFS 上可能弹 capability consent。
//   附带风险：继承这些变量还会静默烧掉宿主机主的 API 额度。
//   因此 gateway 启动前必须剥离这类变量，让 OpenClaw 只认我们 data/ 里的显式配置。
//
// 设计约束：
//   - 本文件被 9 个启动脚本（3 平台 × Start/Menu/Mobile）在启动路径上调用，早于任何
//     OpenClaw 模块加载 → 清单必须是字面量，禁止从上游运行时动态推导（会静默漂移）。
//   - 只报变量「名字」不报值（值是第三方凭证，不能进命令行 / 日志）。
//   - 不剥离我们自己的 OPENCLAW_* 控制变量（前缀 OPENCLAW_ 的一律跳过）。
//
// 清单来源：
//   1) u-claw `strip-provider-env.mjs`（移植自商业版 ClawX 的
//      OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS，2026-08-24 与 OpenClaw 同步）27 项；
//   2) 8.2 避雷清单 雷5 明确点名的知名 host 家族补充项
//      （OPENAI/ANTHROPIC/GEMINI/GOOGLE/MINIMAX 等，它们让 OpenClaw 原生 provider
//      也被判「已配置」而烧 host 额度）。

const OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS = [
  // —— OpenClaw 官方外部 provider（u-claw/ClawX 同步清单）——
  'AI_GATEWAY_API_KEY',
  'ARCEEAI_API_KEY',
  'CEREBRAS_API_KEY',
  'CHUTES_API_KEY',
  'CHUTES_OAUTH_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEATHERLESS_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'KIMICODE_API_KEY',
  'LONGCAT_API_KEY',
  'MODEL_API_KEY',
  'MODELSTUDIO_API_KEY',
  'MOONSHOT_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'STEPFUN_API_KEY',
  'TOKENHUB_API_KEY',
  'TOKENPLAN_API_KEY',
  'VENICE_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  // —— 知名原生/聚合 host 变量（雷5 点名，防偷烧 host 额度）——
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MINIMAX_API_KEY',
  'ZHIPU_API_KEY',
  'GLM_API_KEY',
  'BAIDU_API_KEY',
  'QIANFAN_ACCESS_KEY',
  'QIANFAN_SECRET_KEY',
];

/** 供测试注入；返回宿主环境里确实有值、需被剥离的变量名列表（只报名字）。 */
export function strippedVarNames(env = process.env) {
  return OPENCLAW_EXTERNAL_PROVIDER_ENV_VARS.filter((name) => {
    const v = env[name];
    return typeof v === 'string' && v.trim() !== '';
  });
}

// 启动脚本消费格式：输出一行 OPENCLAW_STRIP_ENV=<name1,name2>，脚本按名单清空；
// 不把任何凭证值带进命令行。无残留则零输出（脚本静默跳过）。
const stripped = strippedVarNames();
if (stripped.length > 0) {
  console.log(`OPENCLAW_STRIP_ENV=${stripped.join(',')}`);
}
