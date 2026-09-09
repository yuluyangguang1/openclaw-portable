#!/usr/bin/env node
// Point OpenClaw at the portable Chinese skill packs.
//
// Historically the launchers exported OPENCLAW_BUNDLED_SKILLS_DIR. That env
// var short-circuits resolveBundledSkillsDir() and *replaces* the kernel's own
// bundled skills directory, so the ~51 upstream skills disappeared from the
// portable build (measured: 57 skills without the override, 18 with it).
// skills.load.extraDirs is additive instead, and it is one of the directories
// the kernel's skills watcher actually monitors.
//
// The absolute path changes whenever the package moves (new drive letter, new
// mount point), so the launchers re-sync it on every start. Stale skills-zh
// entries from previous locations are dropped; unrelated user entries are kept.
//
// Usage: node sync-skill-dirs.mjs <openclaw.json> <skills-zh dir>
// Never fails the caller: any problem is reported and exits 0.

import fs from "node:fs";
import path from "node:path";

const [configPath, skillsDir] = process.argv.slice(2);
if (!configPath || !skillsDir) {
  console.error("usage: sync-skill-dirs.mjs <config.json> <skills dir>");
  process.exit(0);
}

const isSkillsZh = (p) => path.basename(String(p).replace(/[\\/]+$/, "")).toLowerCase() === "skills-zh";

try {
  if (!fs.existsSync(skillsDir)) process.exit(0);
  // Never create the config: the launcher owns first-run creation, and a
  // skills-only file would be missing the gateway auth block.
  if (!fs.existsSync(configPath)) process.exit(0);

  let config = {};
  {
    const raw = fs.readFileSync(configPath, "utf8");
    if (raw.trim()) config = JSON.parse(raw);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);

  const target = path.resolve(skillsDir);
  const load = (config.skills ??= {}).load ??= {};
  const previous = Array.isArray(load.extraDirs) ? load.extraDirs : [];
  const kept = previous.filter((d) => typeof d === "string" && d && !isSkillsZh(d) && path.resolve(d) !== target);
  const next = [target, ...kept];

  if (previous.length === next.length && previous.every((d, i) => d === next[i])) process.exit(0);

  load.extraDirs = next;
  const tmp = `${configPath}.skilldirs.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  console.log(`  [ok] skills-zh 已注册到 skills.load.extraDirs`);
} catch (error) {
  console.error(`  [!] skills-zh 目录注册失败（不影响启动）: ${error.message}`);
}
