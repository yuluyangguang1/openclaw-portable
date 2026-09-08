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
 * 修复（两种形态，均只影响 ino/值为 0n 的场景，NTFS/APFS 不受影响）：
 *   A) identityCheck：`if (platform === "win32" && value === 0n) complete = false;`
 *      → 反转为 complete = true —— 文件系统提供不了身份时跳过对比，而不是判死。
 *   B) supervisor/native 锚定检查：`if (typeof value !== "bigint" || value === 0n) throw lastError(...)`
 *      → 去掉 `|| value === 0n` 条件。
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

function findDistRoots() {
  const roots = [];
  // 1) 从脚本位置上溯（便携包布局：system/ 在包根，内核在 app/core/node_modules）
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    for (const rel of [
      path.join(dir, "app", "core", "node_modules", "openclaw", "dist"),
      path.join(dir, "node_modules", "openclaw", "dist"),
    ]) {
      if (fs.existsSync(rel)) roots.push(rel);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) 当前工作目录
  dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const rel of [
      path.join(dir, "app", "core", "node_modules", "openclaw", "dist"),
      path.join(dir, "node_modules", "openclaw", "dist"),
    ]) {
      if (fs.existsSync(rel) && !roots.includes(rel)) roots.push(rel);
    }
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
    if (!text.includes("value === 0n") && !/===0n/.test(text)) continue;
    scanned++;
    let changed = false;
    if (RE_A.test(text) || text.includes(OLD)) {
      text = text.replace(RE_A, SUB_A).split(OLD).join(NEW);
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
