#!/usr/bin/env node
// Create the portable openclaw.json on first run, with a random gateway token.
//
// Every launcher used to write `{"gateway":{"auth":{"token":"openclaw"}}}`
// inline (six shell scripts, three .bat files, maintain.sh and the config
// center all carried their own copy of that literal). A fixed, published
// token is only harmless as long as the gateway stays on 127.0.0.1 — but the
// config center has a one-click "手机连接" switch that binds it to the LAN and
// auto-approves pairing for 10/8, 172.16/12 and 192.168/16, at which point
// anyone on the same WiFi can take over the agent with a URL they already
// know. Generating the token once, here, keeps all the callers in sync.
//
// Existing configs are never touched (an installed package keeps working, and
// paired phones keep their URL); only --force rewrites, for factory reset.
//
// Usage: node ensure-config.mjs <openclaw.json> [template.json] [--force]
// Exit code is 0 unless the file could not be written.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [configPath, templatePath] = args.filter((a) => a !== "--force");

if (!configPath) {
  console.error("usage: ensure-config.mjs <openclaw.json> [template.json] [--force]");
  process.exit(2);
}

// The template ships with a placeholder so a stray copy of the file can never
// become someone's real credential.
const PLACEHOLDER_TOKENS = new Set(["", "openclaw", "__GENERATED_AT_FIRST_RUN__"]);

try {
  if (fs.existsSync(configPath) && !force) process.exit(0);

  let config = { gateway: { mode: "local", auth: {} } };
  if (templatePath && fs.existsSync(templatePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(templatePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
    } catch (error) {
      console.error(`  [!] 默认配置模板无法解析，改用内置默认值: ${error.message}`);
    }
  }

  const gateway = (config.gateway ??= {});
  gateway.mode ??= "local";
  const auth = (gateway.auth ??= {});
  auth.mode = "token";
  if (typeof auth.token !== "string" || PLACEHOLDER_TOKENS.has(auth.token)) {
    auth.token = crypto.randomBytes(24).toString("base64url");
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.ensure.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  console.log("  [ok] 已生成配置，网关口令为随机值");
} catch (error) {
  console.error(`  [!] 配置生成失败: ${error.message}`);
  process.exit(1);
}
