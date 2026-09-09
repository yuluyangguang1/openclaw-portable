#!/usr/bin/env node
/**
 * patch-exfat-identity.js — exFAT/FAT32 U 盘首启修复
 *
 * 症状：
 *   [gateway] failed to write stability bundle: FsSafeError:
 *   file identity changed or could not be verified
 *   Gateway failed to start: ...
 *
 * 根因：
 *   @openclaw/fs-safe 的 strict-file-identity 用 fs.stat 的 dev/ino
 *   (bigint) 做「文件身份」验证，win32 下要求 ino != 0n。
 *   exFAT/FAT32 没有 NTFS 式的 file identity，Windows 返回的
 *   file index 为 0（或每次打开都变）→ 验证必然失败 → 网关启动中断。
 *   NTFS/APFS 不受影响（ino 永不为 0，走正常对比逻辑）。
 *
 * 修复（A~J 按作用域分平台，POSIX 不受影响；K~M 是 POSIX 侧的
 * exFAT/FAT 修复，只在「chmod 被文件系统静默忽略」时放行，
 * ext4/APFS 上 chmod 生效因此行为完全不变）：
 *   A) identityCheck（捆绑 chunk 单行形态）：`if (platform === "win32" && value === 0n) complete = false;`
 *      → complete = true。
 *   A2) identityCheck（@openclaw/fs-safe 包内 tsc 多行形态）：同上翻转。
 *   B) supervisor/native 锚定（非压缩）：去掉 `|| value === 0n` 判死条件。
 *   C) identityCheck（minified，变量名不定）：if(X===`win32`&&Y===0n)Z=!1; → Z=!0;
 *   D) assertPath / 临时目录身份（minified）：`process.platform===`win32`&&(Y.dev===0n||Y.ino===0n)` → !1
 *   E) 跨调用身份对比抛点（known[field] !== value → throw）：
 *      exFAT/FAT32 的 file index 在 rename 后会变（index 源自目录项位置），
 *      「fstat(旧句柄) vs lstat(rename 后路径)」必然失配。win32 上改为
 *      仅记录新值、不判死（POSIX 保持严格）；真实内容一致性由原子写的
 *      哈希校验兜底。实测堆栈：replaceFileAtomicSync → assertPublished →
 *      assertCurrent → identityCheck（beta.8 U 盘现场，探针复现）。
 *   F) setup 检测超时（SETUP_INFERENCE_DETECTION_TIMEOUT_MS 3e4 → 18e4）：
 *      Control UI「连接已验证的 AI 模型」检测跑在独立 Worker 线程
 *      （不共享主线程 ESM 模块缓存，需从磁盘重载整图），慢盘（exFAT U 盘）
 *      上仅模块加载即 67s（冷）/热缓存全程仍 ~54s → 30s 必超时，重试同败。
 *      提到 180s 后实测热缓存 ~54s 成功返回（beta.9 现场，探针复现）。
 *   G) plugin-skills 符号链接 → 递归复制兜底：
 *      exFAT 卷不支持任何 reparse point（symlink/junction 均报 EISDIR，
 *      真机探针复现）→ publishPluginSkills 全部失败，插件技能对 agent
 *      不可见。symlink 失败即 fs.cpSync 递归复制；上游
 *      isGeneratedPluginSkillEntry 已把 win32 真目录视为托管条目，兼容。
 *   H) 模型目录 Worker 超时（PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS
 *      18e4 → 3e5）：models.list 同样走独立 Worker 重载模块图，exFAT 上
 *      与 setup.detect 并发时曾超 180s；预热后 80ms。
 *   I) Control UI 前端 setup.detect 请求上限（model-setup-page bundle
 *      4e4 → 2e5）：UI 侧 40s 即放弃并报 "gateway request timed out
 *      after 40000ms"，服务端 Worker 180s 能完成但 UI 等不到。提到 200s
 *      盖住服务端 180s + 余量（NTFS 毫秒级完成，此值无所谓）。
 *   J) Control UI 资产清单重签（详见 fixControlUiManifest 注释）。
 *   K) 目录模式强制（fs-safe directoryModeOwner.apply）：
 *      "Gateway failed to start: directory final mode could not be verified"。
 *   L) SQLite 状态协调器目录：
 *      "... directory permissions are not private"。
 *   M) 插件发现 path_world_writable：静默 0 插件（无任何日志）。
 *      K/L/M 是 mac/Linux 挂载 exFAT/FAT 时的三道 win32 豁免门（Windows
 *      因为整段跳过所以从来没暴露）。三处都改成「chmod 探针」语义：只有
 *      在权限位完全没被 chmod 改动（= 文件系统不支持权限位）时才放行，
 *      真 POSIX 卷上 chmod 生效，判死逻辑一字不变。详见各 applyK/L/M 注释。
 *
 * 覆盖范围：openclaw/dist 捆绑副本 + node_modules/@openclaw/fs-safe 包本体
 * （运行时真正的 atomic 写路径走包本体，beta.8 只补了捆绑副本所以仍翻车）。
 *
 * 用法（在便携包根目录，或任意位置——脚本会自动上溯找 node_modules）：
 *   runtime\node-win-x64\node.exe system\patch-exfat-identity.js
 *   （Linux/macOS: runtime 下的 bin/node 同理）
 */
"use strict";
const fs = require("fs");
const path = require("path");

const OLD = 'if (platform === "win32" && value === 0n) complete = false;';
const NEW = 'if (platform === "win32" && value === 0n) complete = true;';
// 形态 A：identityCheck（非压缩 chunk）—— ino===0n 时由「判死」改为「跳过对比」
const RE_A = /if\s*\(\s*platform\s*===?\s*"win32"\s*&&\s*value\s*===?\s*0n\s*\)\s*complete\s*=\s*false\s*;/;
const SUB_A = 'if (platform === "win32" && value === 0n) complete = true;';
// 形态 B：supervisor/native 锚定（非压缩）—— 去掉 `|| value === 0n` 判死条件
const RE_B = /if\s*\(\s*typeof\s+value\s*!==?\s*"bigint"\s*\|\|\s*value\s*===?\s*0n\s*\)\s*throw\s+lastError\(/;
const SUB_B = 'if (typeof value !== "bigint") throw lastError(';
// 形态 C：identityCheck（minified，变量名不定）—— if(X===`win32`&&Y===0n)Z=!1; → Z=!0;
const RE_C = /if\((\w+)===`win32`&&(\w+)===0n\)(\w+)=!1;/g;
// 形态 D：assertPath / 临时目录身份（minified）——
//   X||=process.platform===`win32`&&(Y.dev===0n||Y.ino===0n)   → 右侧置 !1
//   ...||process.platform===`win32`&&(Y.dev===0n||Y.ino===0n))throw → 条件恒 false
const RE_D = /process\.platform===`win32`&&\((\w+)\.dev===0n\|\|\1\.ino===0n\)/g;
const SUB_D = '!1';
// 形态 A2：identityCheck（@openclaw/fs-safe 包内 tsc 多行形态）——0n 时跳过对比
const RE_A2 = /if\s*\(\s*platform\s*===?\s*"win32"\s*&&\s*value\s*===?\s*0n\s*\)\s*\{\s*complete\s*=\s*false\s*;\s*\}/;
const SUB_A2 = 'if (platform === "win32" && value === 0n) {\n                complete = true;\n            }';
// 形态 E：跨调用身份对比抛点（known[field] !== value → throw identityMismatch()）。
//   exFAT/FAT32 的 file index 跨 rename 必变，fstat(旧句柄) vs lstat(新路径) 必失配。
//   win32 上改为仅记录新值不判死（platform 参数就在 identityCheck 作用域内）；
//   POSIX 保持严格。兼容 formatted（undefined）与捆绑 chunk（void 0）两种写法。
const RE_E = /if\s*\(\s*known\[field\]\s*!==?\s*(?:undefined|void 0)\s*&&\s*known\[field\]\s*!==?\s*value\s*\)\s*throw\s+identityMismatch\s*\(\s*\)\s*;/;
const SUB_E = 'if (platform !== "win32" && known[field] !== undefined && known[field] !== value) throw identityMismatch();';
// 形态 E2：同上（minified，变量名不定）—— if(X[Y]!==void 0&&X[Y]!==Z)throw identityMismatch();
const RE_E2 = /if\((\w+)\[(\w+)\]!==void 0&&\1\[\2\]!==(\w+)\)throw identityMismatch\(\);/g;
const SUB_E2 = 'if($1[$2]!==void 0&&$1[$2]!==$3&&process.platform!=="win32")throw identityMismatch();';
// 形态 F：setup 推断检测超时 30s → 180s（慢盘 Worker 线程需重载 ESM 全图，30s 必超时）
const RE_F = /const\s+SETUP_INFERENCE_DETECTION_TIMEOUT_MS\s*=\s*3e4\s*;/;
const SUB_F = "const SETUP_INFERENCE_DETECTION_TIMEOUT_MS = 18e4;";
// 形态 G：plugin-skills 符号链接 → 复制兜底（exFAT 不支持 reparse point，EISDIR）。
//   限定文件名 plugin-skills-*.mjs；调用点改为带兜底的 helper，helper 追加到文件尾。
const G_FILE = /^plugin-skills-[\w-]*\.mjs$/;
const RE_G = /fs\.symlinkSync\((\w+)\s*,\s*(\w+)\s*,\s*resolvePluginSkillLinkType\(\)\)/g;
const G_HELPER = `
function __ocPluginSkillLink(target, linkPath, type) {
	try {
		fs.symlinkSync(target, linkPath, type);
		return;
	} catch (e) {}
	fs.cpSync(target, linkPath, { recursive: true });
}
`;
// 形态 H：模型目录 Worker 超时 180s → 300s（exFAT 冷盘并发 Worker 场景 180s 不够）
const H_FILE = /^prepared-model-catalog-worker-[\w-]*\.mjs$/;
const RE_H = /const\s+PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS\s*=\s*18e4\s*;/;
const SUB_H = "const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 3e5;";
// 形态 I：Control UI 前端 setup.detect 请求上限 40s → 200s。
//   限定文件名 model-setup-page-*.js；timing 常量四连组 Xe=4e4,Ze=15e4,Qe=48e4（变量名不定）。
const I_FILE = /^model-setup-page-[\w-]*\.js$/;
const RE_I = /(\w+)=4e4,(\w+)=15e4,(\w+)=48e4/;
const SUB_I = "$1=2e5,$2=15e4,$3=48e4";
// 形态 K：目录权限位强制 —— "directory final mode could not be verified"。
//   @openclaw/fs-safe 的 directoryModeOwner.apply()：inspect 取 currentMode →
//   chmod(0700) → 再 inspect 取 finalMode，finalMode !== mode 即抛。win32 靠
//   ignoreChmodError 豁免，Linux/macOS 不豁免；而 exFAT/FAT 的 chmod 是 no-op
//   （返回成功、模式一动不动，实测 want=700 got=777）→ 网关必然启动失败。
//   修法：只有「chmod 确实改动过模式」才判死（finalMode !== currentMode）；
//   模式完全没动说明该文件系统不支持权限位，容忍。真 POSIX 卷上 chmod 生效
//   ⇒ finalMode === mode ⇒ 根本不进这个条件，行为完全不变。
const RE_K1 = /if \(!(\w+)\.ignoreChmodError && (\w+) !== (\w+)\) \{\s*throw new FsSafeError\("path-mismatch", "directory final mode could not be verified"\);/;
const RE_K2 = /if\((\w+)\.check\?\.\(\),!(\w+)\.ignoreChmodError&&(\w+)!==(\w+)\)throw new FsSafeError\(`path-mismatch`,`directory final mode could not be verified`\)/g;
// 形态 L：SQLite 状态协调器目录 —— "directory permissions are not private"。
//   ensurePrivateSqliteCoordinatorDirectory 在非 win32 上 chmod 到 0700 后要求
//   (mode & 0o077) === 0，exFAT 上同样必败（0777）。修法同形态 K：模式与 chmod
//   之前完全一致（(secured.mode & 4095) === (stats.mode & 4095)）时容忍。
const RE_L1 = /if \(\((\w+)\.mode & 4095\) !== 448\) applyPrivateModeSync\((\w+), 448\);\s*const (\w+) = ([\w$]+)\.lstatSync\(\2\);\s*if \(\3\.isSymbolicLink\(\) \|\| !\3\.isDirectory\(\) \|\| \(\3\.mode & 63\) !== 0\)/g;
const RE_L2 = /\((\w+)\.mode&4095\)!=448&&applyPrivateModeSync\((\w+),448\);let (\w+)=fs\.lstatSync\(\2\);if\(\3\.isSymbolicLink\(\)\|\|!\3\.isDirectory\(\)\|\|\3\.mode&63\)/g;
const SUB_L2 =
  "($1.mode&4095)!=448&&applyPrivateModeSync($2,448);let $3=fs.lstatSync($2);" +
  "if($3.isSymbolicLink()||!$3.isDirectory()||$3.mode&63&&($3.mode&4095)!==($1.mode&4095))";
const RE_L_DONE = /\(\w+\.mode ?& ?4095\) ?!== ?\(\w+\.mode ?& ?4095\)/;
// 形态 M：插件发现 path_world_writable —— 静默 0 插件（无任何错误日志）。
//   checkPathStatAndPermissions 对 win32 直接 return null；POSIX 下只要
//   modeBits & 0o002 就把候选插件丢掉，exFAT 的 0777 目录全部命中，实测
//   "http server listening (0 plugins)"，且不打印一行原因。
//   修法：判死前跑一次 chmod 探针确认文件系统是否忽略权限位——收紧组/其他
//   写位再 lstat，模式没动即容忍；模式动了立刻还原并维持判死（真 POSIX 卷
//   上的世界可写目录照旧被拦）。探针不留下持久修改。
const RE_M1 = /if \(\((\w+) & 2\) !== 0\) return \{\s*reason: "path_world_writable",/;
const RE_M2 = /if\((\w+)&2\)return\{reason:`path_world_writable`,sourcePath:(\w+)\.source,rootPath:\2\.rootDir,targetPath:(\w+),modeBits:\1\}/g;
const SUB_M2 =
  "if($1&2&&!__ocChmodIgnored($3,$1))return{reason:`path_world_writable`," +
  "sourcePath:$2.source,rootPath:$2.rootDir,targetPath:$3,modeBits:$1}";
const M_HELPER = `
function __ocChmodIgnored(targetPath, modeBits) {
	try {
		const want = modeBits & -19;
		if (want === modeBits) return false;
		fs.chmodSync(targetPath, want);
		const after = fs.lstatSync(targetPath).mode & 511;
		if (after === modeBits) return true;
		try {
			fs.chmodSync(targetPath, modeBits);
		} catch {}
		return false;
	} catch {
		return false;
	}
}
`;

// 形态 K：两种形态都要先拿到 currentMode 的变量名（压缩后名字不定），
//   用「apply() 开头那次 inspect + 紧随的 currentMode === mode 判断」定位。
function applyK(text) {
  let changed = false;
  const m1 = text.match(RE_K1);
  if (m1) {
    const [, params, finalMode, mode] = m1;
    const cur = text.match(
      new RegExp(`const (\\w+) = await ${params}\\.inspect\\(\\);[\\s\\S]{0,200}?\\1 === ${mode}`)
    );
    if (cur) {
      text = text.replace(
        m1[0],
        m1[0].replace(
          `!${params}.ignoreChmodError && ${finalMode} !== ${mode})`,
          `!${params}.ignoreChmodError && ${finalMode} !== ${mode} && ${finalMode} !== ${cur[1]})`
        )
      );
      changed = true;
    } else {
      console.warn("[patch] K1: 命中抛点但未定位 currentMode，跳过");
    }
  }
  RE_K2.lastIndex = 0;
  if (RE_K2.test(text)) {
    RE_K2.lastIndex = 0;
    text = text.replace(RE_K2, (match, checks, params, finalMode, mode, offset, whole) => {
      const window = whole.slice(Math.max(0, offset - 3000), offset);
      const cur = window.match(
        new RegExp(
          `let (\\w+)=await ${params}\\.inspect\\(\\);if\\(${checks}\\.check\\?\\.\\(\\),\\1===${mode}&&`
        )
      );
      if (!cur) {
        console.warn("[patch] K2: 命中抛点但未定位 currentMode，跳过");
        return match;
      }
      changed = true;
      return match.replace(`${finalMode}!==${mode})`, `${finalMode}!==${mode}&&${finalMode}!==${cur[1]})`);
    });
  }
  return { text, changed };
}

function applyL(text) {
  let changed = false;
  if (RE_L_DONE.test(text)) return { text, changed };
  RE_L1.lastIndex = 0;
  if (RE_L1.test(text)) {
    RE_L1.lastIndex = 0;
    text = text.replace(
      RE_L1,
      (match, stats, dirPath, secured, fsns) =>
        `if ((${stats}.mode & 4095) !== 448) applyPrivateModeSync(${dirPath}, 448);\n` +
        `\t\tconst ${secured} = ${fsns}.lstatSync(${dirPath});\n` +
        `\t\tif (${secured}.isSymbolicLink() || !${secured}.isDirectory() || ` +
        `((${secured}.mode & 63) !== 0 && (${secured}.mode & 4095) !== (${stats}.mode & 4095)))`
    );
    changed = true;
  }
  RE_L2.lastIndex = 0;
  if (RE_L2.test(text)) {
    RE_L2.lastIndex = 0;
    text = text.replace(RE_L2, SUB_L2);
    changed = true;
  }
  return { text, changed };
}

function applyM(text) {
  let changed = false;
  if (text.includes("__ocChmodIgnored(")) return { text, changed };
  const m1 = text.match(RE_M1);
  if (m1) {
    const modeBits = m1[1];
    const anchor = text.match(new RegExp(`fs\\.chmodSync\\((\\w+), ${modeBits} & -19\\)`));
    if (anchor) {
      text = text.replace(
        m1[0],
        m1[0].replace(
          `((${modeBits} & 2) !== 0)`,
          `((${modeBits} & 2) !== 0 && !__ocChmodIgnored(${anchor[1]}, ${modeBits}))`
        )
      );
      changed = true;
    } else {
      console.warn("[patch] M1: 命中判死点但未定位 targetPath，跳过");
    }
  }
  RE_M2.lastIndex = 0;
  if (RE_M2.test(text)) {
    RE_M2.lastIndex = 0;
    text = text.replace(RE_M2, SUB_M2);
    changed = true;
  }
  if (changed && !text.includes("function __ocChmodIgnored(")) text += M_HELPER;
  return { text, changed };
}

function findDistRoots() {
  const roots = [];
  const addRoot = (dir) => {
    for (const rel of [
      path.join(dir, "app", "core", "node_modules", "openclaw", "dist"),
      path.join(dir, "node_modules", "openclaw", "dist"),
    ]) {
      if (fs.existsSync(rel) && !roots.includes(rel)) {
        roots.push(rel);
        // 运行时的 atomic 写路径走 @openclaw/fs-safe 包本体（beta.8 教训：
        // 只补 openclaw/dist 捆绑副本，包本体不补照样翻车）。
        const fsSafe = path.join(path.dirname(path.dirname(rel)), "@openclaw", "fs-safe", "dist");
        if (fs.existsSync(fsSafe) && !roots.includes(fsSafe)) roots.push(fsSafe);
      }
    }
  };
  // 1) 从脚本位置上溯（便携包布局：system/ 在包根，内核在 app/core/node_modules）
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    addRoot(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) 当前工作目录
  dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    addRoot(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(roots)];
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
  }
}

const roots = findDistRoots();
if (!roots.length) {
  console.error("[patch] 未找到 openclaw dist（请确认在便携包目录内运行）");
  process.exit(1);
}

let patched = 0, scanned = 0;
for (const root of roots) {
  const files = [];
  walk(root, files);
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const base = path.basename(f);
    const isG = G_FILE.test(base) && text.includes("failed to create plugin skill symlink");
    const isH = H_FILE.test(base) && text.includes("PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS");
    const isI = I_FILE.test(base) && /=4e4,/.test(text);
    const isK = text.includes("directory final mode could not be verified");
    const isL = text.includes("directory permissions are not private");
    const isM = text.includes("path_world_writable");
    if (!text.includes("value === 0n") && !/===0n/.test(text) && !RE_E.test(text) && !text.includes("SETUP_INFERENCE_DETECTION_TIMEOUT_MS") && !isG && !isH && !isI && !isK && !isL && !isM) continue;
    scanned++;
    let changed = false;
    if (isK) {
      const r = applyK(text);
      if (r.changed) {
        text = r.text;
        changed = true;
      }
    }
    if (isL) {
      const r = applyL(text);
      if (r.changed) {
        text = r.text;
        changed = true;
      }
    }
    if (isM) {
      const r = applyM(text);
      if (r.changed) {
        text = r.text;
        changed = true;
      }
    }
    if (RE_F.test(text)) {
      text = text.replace(RE_F, SUB_F);
      changed = true;
    }
    if (isI && RE_I.test(text)) {
      text = text.replace(RE_I, SUB_I);
      changed = true;
    }
    if (isG && RE_G.test(text)) {
      RE_G.lastIndex = 0;
      text = text.replace(RE_G, "__ocPluginSkillLink($1, $2, resolvePluginSkillLinkType())");
      if (!text.includes("__ocPluginSkillLink(target, linkPath, type)")) text += G_HELPER;
      changed = true;
    }
    if (isH && RE_H.test(text)) {
      text = text.replace(RE_H, SUB_H);
      changed = true;
    }
    if (RE_A.test(text) || text.includes(OLD)) {
      text = text.replace(RE_A, SUB_A).split(OLD).join(NEW);
      changed = true;
    }
    if (RE_A2.test(text)) {
      text = text.replace(RE_A2, SUB_A2);
      changed = true;
    }
    if (RE_E.test(text)) {
      text = text.replace(RE_E, SUB_E);
      changed = true;
    }
    if (RE_E2.test(text)) {
      RE_E2.lastIndex = 0;
      text = text.replace(RE_E2, SUB_E2);
      changed = true;
    }
    if (RE_B.test(text)) {
      text = text.replace(RE_B, SUB_B);
      changed = true;
    }
    if (RE_C.test(text)) {
      RE_C.lastIndex = 0;
      text = text.replace(RE_C, "$3=!0;");
      changed = true;
    }
    if (RE_D.test(text)) {
      RE_D.lastIndex = 0;
      text = text.replace(RE_D, SUB_D);
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(f, text);
      patched++;
      console.log("[patch] fixed: " + f);
    }
  }
  // 形态 J：Control UI 资产清单重签（每 root 一次）
  patched += fixControlUiManifest(root);
}

// 形态 J：形态 I 改了 control-ui/assets/model-setup-page-*.js 的内容（等长 4e4→2e5），
//   但 asset-manifest.json 里的 sha256 与 .br/.gz 预压缩变体未同步，导致两个问题：
//   ① 网关启动留存校验报 "Control UI asset changed while being retained"（warn，
//      server-start-BB-IxTAg.mjs 的校验复制按清单 sha256 逐字节核对）；
//   ② 浏览器可能加载未更新的 .br/..gz 变体——里面仍是旧的 40s 请求上限，
//      形态 I 等于白打。此处重压缩两变体 + 重签三 entry 的 sha256/size + 重算
//      generation（算法：sha256(path\0size\0sha256\n) 逐条拼接）。幂等。
function fixControlUiManifest(root) {
  const crypto = require("crypto");
  const zlib = require("zlib");
  const manifestPath = path.join(root, "control-ui", "asset-manifest.json");
  const assetsDir = path.join(root, "control-ui", "assets");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(assetsDir)) return 0;
  const JS_RE = /(\w+)=4e4,(\w+)=15e4,(\w+)=48e4/;
  let targetBase = null;
  for (const f of fs.readdirSync(assetsDir)) {
    if (!/^model-setup-page-.*\.js$/.test(f)) continue;
    const txt = fs.readFileSync(path.join(assetsDir, f), "utf8");
    if (JS_RE.test(txt) || (/=2e5,/.test(txt) && /=15e4,/.test(txt))) { targetBase = f; break; }
  }
  if (!targetBase) return 0;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rawPath = path.join(assetsDir, targetBase);
  let raw = fs.readFileSync(rawPath);
  let touched = 0;
  if (JS_RE.test(raw.toString("utf8"))) {
    raw = Buffer.from(raw.toString("utf8").replace(JS_RE, "$1=2e5,$2=15e4,$3=48e4"), "utf8");
    fs.writeFileSync(rawPath, raw);
    console.log("[patch] J: patched raw js: " + targetBase);
    touched++;
  }
  const gz = zlib.gzipSync(raw, { level: 9 });
  const br = zlib.brotliCompressSync(raw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  fs.writeFileSync(rawPath + ".gz", gz);
  fs.writeFileSync(rawPath + ".br", br);
  const variants = {
    ["assets/" + targetBase]: raw,
    ["assets/" + targetBase + ".gz"]: gz,
    ["assets/" + targetBase + ".br"]: br,
  };
  for (const entry of manifest.assets) {
    const buf = variants[entry.path];
    if (!buf) continue;
    entry.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    entry.size = buf.length;
    touched++;
  }
  const h = crypto.createHash("sha256");
  for (const entry of manifest.assets) {
    h.update(entry.path); h.update("\0");
    h.update(String(entry.size)); h.update("\0");
    h.update(entry.sha256); h.update("\n");
  }
  manifest.generation = h.digest("hex");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log("[patch] J: control-ui manifest re-signed (" + targetBase + " raw/gz/br + generation)");
  return touched;
}

console.log(
  `[patch] done: ${patched} patched, scanned ${scanned} candidate file(s) in ${roots.length} dist root(s)`
);
if (patched > 0) {
  console.log("[patch] OK — 现在可以重新启动 OpenClaw Portable。");
} else if (scanned > 0) {
  console.log("[patch] 候选文件存在但未命中补丁模式：可能已打过补丁，或上游形态已变化。");
} else {
  console.log("[patch] 未发现含身份检查的文件：内核可能不含 fs-safe 严格身份检查。");
}
