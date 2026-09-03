#!/usr/bin/env node
/**
 * promote-official-providers.mjs
 *
 * 把预装的官方 provider 插件（node_modules/@openclaw/<id>-provider）
 * 提升为 openclaw 的 bundled 插件（node_modules/openclaw/dist/extensions/<id>）。
 *
 * 为什么要做这件事：
 *   openclaw 对「非 bundled」插件在启用前要求 capability consent。
 *   npm 装进 node_modules/@openclaw/ 的官方插件不会被自动登记为已安装，
 *   于是用户一旦在配置中心选用这些 provider，网关 doctor 就会抛
 *     Plugin "xxx" requires capability consent
 *   并 refusing to report the gateway ready —— 便携版在离线/exFAT 场景下无法完成
 *   在线安装与人工批准，等于启动即卡死。
 *
 *   而 openclaw 的 consent 判定是：
 *     if (!plugin || plugin.origin === "bundled") return;   // bundled 直接放行
 *   bundled 与否由 discovery 决定：插件目录物理位于
 *     <openclaw 包>/dist/extensions/  或  <openclaw 包>/dist-runtime/extensions/
 *   即被视为 origin="bundled"。
 *
 *   所以把这些插件放进 dist/extensions/ 即可永久免 consent，无需联网、
 *   无需逐个 plugins install、不受 exFAT 符号链接限制。
 *
 * 注意（踩过的坑）：
 *   npm 包的 package.json 里 openclaw.extensions 指向源码入口 "./index.ts"，
 *   该文件在发布产物中并不存在（真正的产物是 runtimeExtensions 的 ./dist/index.js）。
 *   bundled 扫描走 source-default 分支，找不到 index.ts 就会静默跳过该插件，
 *   且不产生任何错误诊断 —— 必须把 extensions 改写成真实存在的产物入口。
 *
 * 用法：
 *   node promote-official-providers.mjs [CORE_DIR]
 *   CORE_DIR 默认取脚本位置推导的 <portable>/app/core
 *
 * 幂等：重复执行会先移除再拷贝，可安全重跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 需要提升为 bundled 的官方 provider。
 * 必须与 setup.sh 里 package.json 的 @openclaw/<id>-provider 依赖清单一致。
 *
 * 前 14 个 = 原 PREINSTALLED_PROVIDER_IDS；
 * 后 5 个（byteplus/mistral/novita/tencent/xiaomi）同属 A 类官方 id，
 * 之前未预装，用户一旦在配置中心选用就会触发 consent 卡启动，故一并纳入。
 */
const PROVIDER_IDS = [
  'arcee', 'cerebras', 'cohere', 'deepinfra', 'deepseek', 'fireworks', 'gmi',
  'groq', 'kilocode', 'kimi', 'longcat', 'qwen', 'stepfun', 'zai',
  'byteplus', 'mistral', 'novita', 'tencent', 'xiaomi'
];

function resolveCoreDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  // lib/ 的上两级即 portable 根目录
  const portableRoot = path.resolve(__dirname, '..');
  return path.join(portableRoot, 'app', 'core');
}

const coreDir = resolveCoreDir();
const npmRoot = path.join(coreDir, 'node_modules', '@openclaw');
const openclawPkg = path.join(coreDir, 'node_modules', 'openclaw');
const bundledRoot = path.join(openclawPkg, 'dist', 'extensions');

if (!fs.existsSync(openclawPkg)) {
  console.error(`[skip] 未找到 openclaw 包: ${openclawPkg}`);
  process.exit(0);
}
if (!fs.existsSync(bundledRoot)) {
  console.error(`[skip] 未找到 bundled 插件目录: ${bundledRoot}`);
  process.exit(0);
}

const results = [];
for (const id of PROVIDER_IDS) {
  const src = path.join(npmRoot, `${id}-provider`);
  const dst = path.join(bundledRoot, id);

  if (!fs.existsSync(src)) {
    results.push({ id, status: 'SOURCE_MISSING', entry: '' });
    continue;
  }

  // 已存在则先移除，保证重跑干净（幂等）
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });

  // 修正入口：把指向源码(./index.ts)的 extensions 改写为真实产物入口
  const pkgPath = path.join(dst, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.openclaw = pkg.openclaw || {};

  const runtime = Array.isArray(pkg.openclaw.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : [];
  const declared = Array.isArray(pkg.openclaw.extensions) ? pkg.openclaw.extensions : [];

  let entry;
  if (runtime.length) {
    entry = runtime[0];
  } else {
    const existing = declared.find((e) => fs.existsSync(path.join(dst, e)));
    entry = existing || './dist/index.js';
  }
  pkg.openclaw.extensions = [entry];
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const entryOk = fs.existsSync(path.join(dst, entry.replace(/^\.\//, '')));
  results.push({ id, status: entryOk ? 'OK' : 'ENTRY_MISSING', entry });
}

const ok = results.filter((r) => r.status === 'OK');
const bad = results.filter((r) => r.status !== 'OK');

console.log(`官方 provider 插件 → bundled 提升：成功 ${ok.length}/${results.length}`);
for (const r of results) {
  if (r.status !== 'OK') console.log(`  ${r.status.padEnd(14)} ${r.id}`);
}

// ---- 关键第二步：把提升后的文件写进 openclaw 的发货清单 ----
// openclaw 包自带 postinstall 脚本（postinstall-bundled-plugins.mjs），其
// pruneInstalledPackageDist() 会拿 dist/postinstall-inventory.json（发货清单）
// 与磁盘实际文件比对，不在清单里的一律当作 stale 删除。
// 提升进 dist/extensions/<id>/ 的插件不在清单里 → 任何一次 npm 生命周期重跑
// （重装依赖、升级 openclaw、甚至网关启动时检测到 lifecycle-pending 标记）都会
// 把它们全部删光。必须把这些文件的相对路径合并进清单，postinstall 才会保留它们。
const INVENTORY_PATH = path.join(openclawPkg, 'dist', 'postinstall-inventory.json');

function collectFilesRecursively(rootDir) {
  const out = [];
  for (const e of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, e.name);
    if (e.isDirectory()) out.push(...collectFilesRecursively(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

let inventorySynced = false;
if (ok.length && fs.existsSync(INVENTORY_PATH)) {
  try {
    const inventory = new Set(JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8')));
    const before = inventory.size;
    for (const r of ok) {
      const dst = path.join(bundledRoot, r.id);
      for (const f of collectFilesRecursively(dst)) {
        inventory.add(path.relative(openclawPkg, f).replace(/\\/g, '/'));
      }
    }
    fs.writeFileSync(
      INVENTORY_PATH,
      `${JSON.stringify([...inventory].sort(), null, 2)}\n`
    );
    console.log(`发货清单已更新：${INVENTORY_PATH}（${before} → ${inventory.size} 条）`);
    inventorySynced = true;
  } catch (error) {
    console.warn(`[warn] 发货清单更新失败：${error.message}（postinstall 重跑时提升的插件会被删除）`);
  }
}

if (bad.length) {
  // 源缺失只是警告（可能该版本未发布此包）；入口缺失是真问题
  const fatal = bad.filter((r) => r.status === 'ENTRY_MISSING');
  if (fatal.length) {
    console.error(`[error] ${fatal.length} 个插件入口缺失，bundled 扫描会静默跳过它们`);
    process.exit(1);
  }
  console.warn(`[warn] ${bad.length} 个插件源缺失（未预装），跳过`);
}
process.exit(0);
