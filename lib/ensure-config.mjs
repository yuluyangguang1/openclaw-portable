#!/usr/bin/env node
// Create the portable openclaw.json on first run, with the fixed gateway
// token "yuai" (owner's decision, 2026-09-10).
//
// Every launcher used to write `{"gateway":{"auth":{"token":"openclaw"}}}`
// inline (six shell scripts, three .bat files, maintain.sh and the config
// center all carried their own copy of that literal). Beta.12 (1.2.7)
// switched to a random token generated here, but the random token broke the
// owner's workflow: the Control UI / phone pairing flow kept hitting
// token_mismatch after every restart, because nothing surfaced the
// regenerated value reliably. Per the owner's explicit request the token is
// now the fixed value "yuai" again — note this trades away the LAN-hardening
// rationale recorded below: with the one-click "手机连接" switch the gateway
// can bind to the LAN, at which point anyone on the same WiFi who knows the
// published token can take over the agent. Accepted by the owner.
//
// Self-heal (beta.12 follow-up): configs that exist but are MISSING
// gateway.auth (seen in the wild — upstream openclaw can rewrite the config
// and drop the auth block, after which the gateway generates a runtime-only
// token on every start and nothing can log in) get the auth block written
// back in place, preserving every other key. A config that already carries a
// usable token is never touched.
//
// Usage: node ensure-config.mjs <openclaw.json> [template.json] [--force]
// Exit code is 0 unless the file could not be written.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [configPath, templatePath] = args.filter((a) => a !== "--force");

if (!configPath) {
  console.error("usage: ensure-config.mjs <openclaw.json> [template.json] [--force]");
  process.exit(2);
}

// Values that must never survive into a live credential: the template ships
// with a placeholder so a stray copy of the file can never become someone's
// real token.
const PLACEHOLDER_TOKENS = new Set(["", "openclaw", "__GENERATED_AT_FIRST_RUN__"]);
const FIXED_TOKEN = "yuai";

function applyFixedAuth(config) {
  const gateway = (config.gateway ??= {});
  gateway.mode ??= "local";
  const auth = (gateway.auth ??= {});
  auth.mode = "token";
  if (typeof auth.token !== "string" || PLACEHOLDER_TOKENS.has(auth.token)) {
    auth.token = FIXED_TOKEN;
  }
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.ensure.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
}

try {
  // Existing config: only heal a missing/placeholder gateway.auth, in place.
  if (fs.existsSync(configPath) && !force) {
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      console.error(`  [!] 现有配置无法解析，跳过网关口令自愈: ${error.message}`);
      process.exit(0); // not our job to repair arbitrary JSON breakage
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);

    const auth = config?.gateway?.auth;
    const usable =
      auth && typeof auth === "object" &&
      typeof auth.token === "string" && !PLACEHOLDER_TOKENS.has(auth.token);
    if (usable) process.exit(0);

    applyFixedAuth(config);
    writeConfig(configPath, config);
    console.log(`  [ok] 网关口令缺失，已补写固定值 "${FIXED_TOKEN}"`);
    process.exit(0);
  }

  // First run (or --force): build from template, then stamp the fixed token.
  let config = { gateway: { mode: "local", auth: {} } };
  if (templatePath && fs.existsSync(templatePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(templatePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
    } catch (error) {
      console.error(`  [!] 默认配置模板无法解析，改用内置默认值: ${error.message}`);
    }
  }

  applyFixedAuth(config);
  writeConfig(configPath, config);
  console.log(`  [ok] 已生成配置，网关口令为固定值 "${FIXED_TOKEN}"`);
} catch (error) {
  console.error(`  [!] 配置生成失败: ${error.message}`);
  process.exit(1);
}
