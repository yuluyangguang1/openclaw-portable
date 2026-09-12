#!/usr/bin/env node
// Self-heal a gateway lock left behind by an unclean shutdown.
//
// Why this exists: `gateway run` is a FOREGROUND process started by the
// launcher. Closing the console window, killing it from Task Manager, or
// yanking the USB drive all skip the gateway's own shutdown path, which is what
// normally releases the lock in
//
//   data/.openclaw/tmp/openclaw/gateway.<hash>.lock        (JSON: {"pid": N, ...})
//   data/.openclaw/tmp/openclaw/gateway.state.lock
//
// and what normally closes the matching `gateway_boot_lifecycle` row
// (completed_at_ms / outcome). The next start then fails with
//
//   Gateway failed to start: gateway already running (pid N); lock timeout after 5000ms
//
// where pid N is usually long dead. `openclaw gateway stop` does NOT help — it
// targets the supervised service, not this process ("This stops the operator's
// running gateway service"), and the launcher's own retry loop just retries the
// same doomed start.
//
// What this does, conservatively — it only ever touches lock state that provably
// has no owner:
//   1. Probe the gateway port. If something answers, a live gateway owns the
//      lock; exit without touching anything.
//   2. Read the pid recorded in each gateway.*.lock. If any is still alive, exit.
//   3. Otherwise the locks are orphans: remove gateway.* lock files and close
//      the open gateway_boot_lifecycle rows.
//
// Never fails the caller: every problem is reported and exits 0.
//
// Usage: node fix-stale-gateway-lock.mjs <stateDir> [gatewayPort]

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const [stateDir, portArg] = process.argv.slice(2);
if (!stateDir) {
  console.error("usage: fix-stale-gateway-lock.mjs <stateDir> [gatewayPort]");
  process.exit(0);
}

const lockDir = path.join(stateDir, "tmp", "openclaw");
const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
const port = Number.parseInt(portArg || "", 10) || 18789;

const log = (m) => console.log(`  [lock] ${m}`);

function probePort(p, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try {
      sock.connect(p, "127.0.0.1");
    } catch {
      finish(false);
    }
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists but not ours
  }
}

function gatewayLockFiles() {
  try {
    return fs
      .readdirSync(lockDir)
      .filter((f) => f.startsWith("gateway."))
      .map((f) => path.join(lockDir, f));
  } catch {
    return [];
  }
}

async function closeOrphanBootRows() {
  let DatabaseSync;
  try {
    // node:sqlite, built into Node >= 22.5. Imported dynamically so a runtime
    // without it still cleans the lock files.
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    log(`node:sqlite 不可用，跳过 boot lifecycle 清理（锁文件已清）: ${e.message}`);
    return 0;
  }
  if (!fs.existsSync(dbPath)) return 0;
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const res = db
      .prepare(
        "UPDATE gateway_boot_lifecycle SET completed_at_ms=?, outcome='orphaned-cleaned' WHERE completed_at_ms IS NULL"
      )
      .run(Date.now());
    return Number(res?.changes || 0);
  } catch (e) {
    log(`boot lifecycle 清理失败（不影响启动）: ${e.message}`);
    return 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

try {
  // 1. A live gateway owns the lock — do nothing at all.
  if (await probePort(port)) {
    log(`端口 ${port} 有响应，网关在运行，无需清理`);
    process.exit(0);
  }

  const files = gatewayLockFiles();
  if (!files.length) {
    // No lock files. Still worth closing rows orphaned by an earlier crash.
    const n = await closeOrphanBootRows();
    if (n) log(`无锁文件；关闭了 ${n} 条未收尾的 boot lifecycle 行`);
    process.exit(0);
  }

  // 2. Refuse to touch anything whose owner is still alive.
  const alive = [];
  for (const f of files) {
    if (!f.endsWith(".lock")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(f, "utf8"));
      if (pidAlive(Number(info?.pid))) alive.push(`${path.basename(f)} → pid ${info.pid}`);
    } catch {
      // unreadable/truncated lock is treated as stale (port probe already said
      // nothing is listening)
    }
  }
  if (alive.length) {
    log(`锁的持有进程仍存活，保留锁: ${alive.join(", ")}`);
    process.exit(0);
  }

  // 3. Orphans: clear locks, then close the rows that go with them.
  const removed = [];
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
      removed.push(path.basename(f));
    } catch (e) {
      log(`删除失败 ${path.basename(f)}: ${e.message}`);
    }
  }
  const closed = await closeOrphanBootRows();
  log(`清理了上一次非正常退出的网关锁：删除 ${removed.length} 个文件（${removed.join(", ")}），关闭 ${closed} 条 boot lifecycle 行`);
} catch (e) {
  log(`跳过（不影响启动）: ${e.message}`);
}
process.exit(0);
