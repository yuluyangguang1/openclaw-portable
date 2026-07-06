#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');
const crypto = require('crypto');

// Config server uses a port range that does NOT overlap with the
// gateway range (18789-18799). Earlier versions used 18788-18798
// which overlapped at 18789-18798 — when 18788 was occupied the
// config-server could fall through into 18789 and steal the port
// the launcher had reserved for the gateway. The launcher writes
// the actual bound port back to runtime.json so this range is
// fully encapsulated. (B22-06)
const PORT_RANGE_START = 18750;
const PORT_RANGE_END = 18760;
const CONFIG_PATH = path.join(__dirname, '../data/.openclaw/openclaw.json');
const RUNTIME_PATH = path.join(__dirname, '../data/.openclaw/runtime.json');

// Server-side auth token. Random 32 bytes, generated once per process
// and persisted in runtime.json (chmod 0600). Required by all write
// endpoints via the X-OpenClaw-Token header — see the middleware in
// the http server below for the full rationale.
const SERVER_TOKEN = crypto.randomBytes(32).toString('hex');
const CONFIG_BACKUP_DIR = path.join(path.dirname(CONFIG_PATH), 'backups');
const CONFIG_BACKUP_KEEP = 5;

// ── Network safety helpers ──────────────────────────────────────────────────
//
// Every outbound fetch needs a timeout: the config-server ships in a
// portable USB context where users may be behind captive portals,
// corporate proxies, or simply offline. A bare `await fetch(...)`
// will hang the request forever, and worse, can deadlock state
// machines like _updateInProgress.
//
// fetchWithTimeout wraps fetch with an AbortController. Default 15s
// is long enough for slow GitHub responses but short enough that
// the user notices and can retry.
//
// MAX_RESPONSE_BYTES caps how much we'll read from a third-party JSON
// body. Without this, a hijacked DNS could feed us infinite JSON.
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB; release JSON is normally <100 KB

async function fetchWithTimeout(url, opts) {
  opts = opts || {};
  const ms = opts.timeout || DEFAULT_FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBounded(response, max) {
  // Read response body in chunks; abort if we exceed `max` bytes.
  // Using response.body (web stream) keeps memory bounded — calling
  // response.json() on a 1 GB stream would buffer the whole thing.
  const limit = max || MAX_RESPONSE_BYTES;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      try { reader.cancel(); } catch (_) {}
      throw new Error('Response exceeds max size (' + limit + ' bytes)');
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  return JSON.parse(buf.toString('utf8'));
}

// ── Request body collection helper ──────────────────────────────────────────
//
// Centralizes the "collect POST body up to N bytes, parse JSON, send 413
// on overflow" pattern. Replaces ad-hoc req.on('data'/'end') handlers
// scattered across endpoints. Benefits:
//   - One place to fix bugs (e.g. body-too-large path used to leak
//     into 'end' handler and double-respond)
//   - Consistent error responses across endpoints
//   - Auto-rejects non-JSON content-type before reading
function readBoundedJsonBody(req, res, max) {
  return new Promise((resolve) => {
    const limit = max || 100_000;
    // Accumulate as Buffer chunks rather than concatenated strings.
    // String concat with `body += chunk` calls chunk.toString('utf8')
    // per chunk — if a multi-byte character (e.g. Chinese) is split
    // across TCP packet boundaries, the partial bytes get replaced by
    // U+FFFD and JSON.parse fails. Buffer accumulation defers decoding
    // to the end when all bytes are present.
    const chunks = [];
    let total = 0;
    let exceeded = false;
    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    req.on('data', (chunk) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > limit) {
        exceeded = true;
        // Send 413 once, then drain — destroying the req sometimes
        // races the 'end' handler so we use the `exceeded` guard.
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large (max ' + limit + ' bytes)' }));
        }
        try { req.destroy(); } catch (_) {}
        settle(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return settle(null);
      if (chunks.length === 0) return settle({});
      let body;
      try {
        body = Buffer.concat(chunks).toString('utf8');
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to decode body' }));
        }
        return settle(null);
      }
      try {
        settle(JSON.parse(body));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
        }
        settle(null);
      }
    });
    req.on('error', () => settle(null));
  });
}

// ── Config persistence: atomic write + auto-recovery ────────────────────────
//
// USB-stick reality: the user can yank the drive at any moment, the file
// system may be exFAT/FAT32 (no journaling), and OS-level write buffering
// can lose the last MB on a hard eject. So:
//   - safeReadConfig: parse main file; if broken, walk backups newest-to-oldest
//   - atomicWriteConfig: tmp file → fsync → rename (POSIX-atomic) + rolling backup
//   - keep the last CONFIG_BACKUP_KEEP saves, prune older

function safeReadConfig() {
  // Fast path: main file parses cleanly
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { config: JSON.parse(raw), source: 'main' };
    }
  } catch (e) {
    console.warn('[config] main file unreadable:', e.message, '— trying backups');
  }
  // Recovery: scan backups newest first
  try {
    if (fs.existsSync(CONFIG_BACKUP_DIR)) {
      const files = fs.readdirSync(CONFIG_BACKUP_DIR)
        .filter(f => f.startsWith('openclaw-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files) {
        const p = path.join(CONFIG_BACKUP_DIR, f);
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const cfg = JSON.parse(raw);
          console.warn(`[config] recovered from backup: ${f}`);
          return { config: cfg, source: 'backup:' + f };
        } catch (e) { /* try next */ }
      }
    }
  } catch (e) { /* fallthrough */ }
  return { config: {}, source: 'empty' };
}

function atomicWriteConfig(config) {
  // Strip deprecated top-level keys before persisting. The `agent`
  // field was renamed to `agents` in newer OpenClaw — keeping the
  // old shape causes "agent.* was moved" errors. We log when we
  // strip so users can see what happened (a backup also exists in
  // /backups/ for full recovery).
  if (config && typeof config === 'object' && config.agent !== undefined) {
    console.warn('[config] stripping deprecated top-level "agent" key (renamed to "agents" in OpenClaw 2025+). Original value preserved in pre-write backup.');
    delete config.agent;
  }

  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Backup current file (if any) BEFORE we overwrite, so the most-recent
  // good config is always retrievable.
  //
  // Critical: only back up files that PARSE. If safeReadConfig had to
  // recover from an older backup because the main file was corrupt,
  // that corrupt file is still on disk. Backing it up would push a
  // good backup out of the rolling 5-version window. Validate parse
  // before copying.
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let mainParsesOk = false;
      try {
        JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        mainParsesOk = true;
      } catch (_) {
        console.warn('[config] skipping pre-write backup: main file is corrupt');
      }
      if (mainParsesOk) {
        fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(CONFIG_BACKUP_DIR, `openclaw-${ts}.json`);
        fs.copyFileSync(CONFIG_PATH, backupPath);
        // Prune old backups beyond CONFIG_BACKUP_KEEP
        const old = fs.readdirSync(CONFIG_BACKUP_DIR)
          .filter(f => f.startsWith('openclaw-') && f.endsWith('.json'))
          .sort();
        while (old.length > CONFIG_BACKUP_KEEP) {
          try { fs.unlinkSync(path.join(CONFIG_BACKUP_DIR, old.shift())); } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.warn('[config] backup before write failed (continuing):', e.message);
  }

  // Atomic write: .tmp → fsync → rename
  const tmp = CONFIG_PATH + '.tmp';
  const json = JSON.stringify(config, null, 2);
  const wasFirstWrite = !fs.existsSync(CONFIG_PATH);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, json);
    try {
      fs.fsyncSync(fd);
    } catch (fsyncErr) {
      // fsync isn't supported on FAT32/exFAT in some environments.
      // The write is still buffered to disk eventually but a hard
      // USB yank could lose it. Log so users have a paper trail.
      console.warn('[config] fsync failed (data still buffered, eject safely):', fsyncErr.code || fsyncErr.message);
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
  fs.renameSync(tmp, CONFIG_PATH);

  // Seed backup on first ever save: backups/ would otherwise stay empty
  // (we only back up before *overwriting* an existing file). Without a
  // seed, a USB yank right after the first save leaves recovery with
  // nothing to roll back to.
  if (wasFirstWrite) {
    try {
      fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(CONFIG_PATH, path.join(CONFIG_BACKUP_DIR, `openclaw-${ts}.json`));
    } catch (e) {
      console.warn('[config] seed backup failed (non-fatal):', e.message);
    }
  }
}

// ── WeChat Login State ──────────────────────────────────────────────────────
const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_BOT_TYPE = '3';
const ACTIVE_LOGIN_TTL_MS = 5 * 60000;
const QR_POLL_TIMEOUT_MS = 35000;
const MAX_QR_REFRESH_COUNT = 3;

// Resolve state directory. In portable mode the launcher sets
// OPENCLAW_STATE_DIR to data/.openclaw on the USB. Fall back to the
// portable-relative path (consistent with CONFIG_PATH) rather than
// ~/.openclaw so a bare `node server.js` still works without env vars.
const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR ||
  path.join(__dirname, '../data/.openclaw');
const WECHAT_STATE_DIR = path.join(OPENCLAW_DIR, 'openclaw-weixin');
const WECHAT_ACCOUNTS_DIR = path.join(WECHAT_STATE_DIR, 'accounts');
const WECHAT_ACCOUNT_INDEX_FILE = path.join(WECHAT_STATE_DIR, 'accounts.json');

// Plugin source — installed as an npm dependency in app/core/package.json
// (consistent with how @sliverp/qqbot is bundled). The fallback path
// app/extensions/openclaw-weixin/ exists for legacy installs / manual setup.
const PLUGIN_NPM_DIR = path.join(__dirname, '../app/core/node_modules/@tencent-weixin/openclaw-weixin');
const PLUGIN_LEGACY_DIR = path.join(__dirname, '../app/extensions/openclaw-weixin');
const USB_PLUGIN_DIR = fs.existsSync(path.join(PLUGIN_NPM_DIR, 'openclaw.plugin.json'))
  ? PLUGIN_NPM_DIR
  : PLUGIN_LEGACY_DIR;
const INSTALLED_PLUGIN_DIR = path.join(OPENCLAW_DIR, 'extensions', 'openclaw-weixin');

const activeLogins = new Map();

// Periodic cleanup of expired login sessions to prevent memory leaks.
// Without this, a user who starts a WeChat login but never completes it
// (closes the browser tab) would leave the session in memory forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, login] of activeLogins) {
    if (now - login.startedAt > ACTIVE_LOGIN_TTL_MS) {
      activeLogins.delete(key);
    }
  }
}, 60_000);

// ── QR Code PNG Renderer (pure Node.js, no external deps) ───────────────────

function getQrRenderDeps() {
  // Try to load QR lib from openclaw's bundled qrcode-terminal
  const corePath = path.join(__dirname, '../app/core/node_modules');
  const candidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/index.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/index.js'),
  ];
  const errCandidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return { QRCode: require(candidates[i]), QRErrorCorrectLevel: require(errCandidates[i]) };
    }
  }
  // Fallback: try WeChat plugin's own node_modules
  const pluginQr = path.join(USB_PLUGIN_DIR, 'node_modules/qrcode-terminal/vendor/QRCode/index.js');
  const pluginQrErr = path.join(USB_PLUGIN_DIR, 'node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
  if (fs.existsSync(pluginQr)) {
    return { QRCode: require(pluginQr), QRErrorCorrectLevel: require(pluginQrErr) };
  }
  throw new Error('QR code library not found');
}

function createQrMatrix(input) {
  const { QRCode, QRErrorCorrectLevel } = getQrRenderDeps();
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

function fillPixel(buf, x, y, width, r, g, b, a) {
  const idx = (y * width + x) * 4;
  buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = (a === undefined ? 255 : a);
}

const CRC_TABLE = (function() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const offset = row * (stride + 1);
    raw[offset] = 0;
    buffer.copy(raw, offset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function renderQrPngDataUrl(input) {
  // Bounded input size: legitimate iLinkAI QR strings are <500 chars.
  // Reject longer inputs to prevent attacker-controlled QR generation
  // from exploding the pixel buffer (modules count grows non-linearly
  // with content length).
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) {
    throw new Error('Invalid QR input: must be non-empty string under 4096 chars');
  }
  const scale = 6, margin = 4;
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
  // Defensive cap: a Version 40 QR has 177 modules. Anything larger
  // means the library miscounted or the input was malformed.
  if (modules > 200) {
    throw new Error('QR module count out of bounds: ' + modules);
  }
  const size = (modules + margin * 2) * scale;
  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      const sx = (col + margin) * scale, sy = (row + margin) * scale;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++)
        fillPixel(buf, sx + x, sy + y, size, 0, 0, 0, 255);
    }
  }
  return 'data:image/png;base64,' + encodePngRgba(buf, size, size).toString('base64');
}

// ── WeChat API helpers ──────────────────────────────────────────────────────

async function fetchWeChatQrCode(apiBaseUrl) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(DEFAULT_ILINK_BOT_TYPE);
  // Timeout prevents the WeChat login UI from hanging forever when
  // ilinkai.weixin.qq.com is unreachable (firewall, DNS, captive portal).
  const response = await fetchWithTimeout(url, { timeout: 15000 });
  if (!response.ok) {
    // Bounded error text read (avoid buffering attacker-controlled MBs).
    let errBody = '';
    try {
      const reader = response.body.getReader();
      const buf = [];
      let total = 0;
      while (total < 4096) {
        const { value, done } = await reader.read();
        if (done) break;
        buf.push(value);
        total += value.length;
      }
      try { reader.cancel(); } catch (_) {}
      errBody = Buffer.concat(buf.map(c => Buffer.from(c))).toString('utf8').slice(0, 4096);
    } catch (_) {}
    throw new Error('Failed to fetch QR: ' + response.status + ' ' + errBody);
  }
  // QR response is a small JSON with a base64 image — cap at 1MB
  // (typical real responses are <30KB).
  return await readJsonBounded(response, 1 * 1024 * 1024);
}

async function pollWeChatQrStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal
    });
    // Don't clear the timer until BOTH headers and body are read.
    // Clearing right after fetch() returns leaves response.text()
    // (the body stream) unprotected — if the upstream stalls mid-body
    // we'd hang forever.
    if (!response.ok) {
      // Read up to 4KB of error text for the message; bounded to avoid
      // buffering attacker-controlled MB-sized error pages.
      let errText = '';
      try {
        const reader = response.body.getReader();
        const buf = [];
        let total = 0;
        while (total < 4096) {
          const { value, done } = await reader.read();
          if (done) break;
          buf.push(value);
          total += value.length;
        }
        try { reader.cancel(); } catch (_) {}
        errText = Buffer.concat(buf.map(c => Buffer.from(c))).toString('utf8').slice(0, 4096);
      } catch (_) {}
      throw new Error('Poll failed: ' + response.status + ' ' + errText);
    }
    // Bounded JSON read prevents memory exhaustion if upstream returns
    // a malicious/corrupt response with gigabytes of body.
    return await readJsonBounded(response, 256 * 1024); // 256KB cap; status responses are <1KB
  } catch (err) {
    if (err.name === 'AbortError') return { status: 'wait' };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAccountId(raw) {
  // Must match OpenClaw SDK's canonicalizeAccountId exactly:
  //   lowercase → replace invalid chars with '-' → strip leading/trailing dashes → max 64 chars
  // Valid chars: [a-z0-9_-] (NO dots!)
  return String(raw).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64) || 'default';
}

// Generic atomic JSON write helper. Used for both the main openclaw.json
// (via atomicWriteConfig) and WeChat account credentials. Same pattern:
// .tmp file, fsync, POSIX rename. Never leaves a half-written JSON
// behind even if the user yanks the USB stick mid-write.
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, json);
    try {
      fs.fsyncSync(fd);
    } catch (fsyncErr) {
      // FAT32/exFAT may not support fsync — write is still committed
      // to OS cache, so on a clean shutdown it persists. Hard USB yank
      // can lose the latest save. Log for diagnostics.
      console.warn('[atomicWriteJson] fsync failed for', path.basename(filePath), '-', fsyncErr.code || fsyncErr.message);
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
  fs.renameSync(tmp, filePath);
}

async function saveWeChatAccount(rawAccountId, payload) {
  const accountId = normalizeAccountId(rawAccountId);
  fs.mkdirSync(WECHAT_ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(WECHAT_ACCOUNTS_DIR, accountId + '.json');

  // Migration: if an old-format file exists (with dots in name), remove it.
  // Old normalizeAccountId preserved dots: "id@im.bot" → "id-im.bot"
  // New one replaces dots: "id@im.bot" → "id-im-bot"
  const legacyId = String(rawAccountId).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (legacyId !== accountId) {
    const legacyPath = path.join(WECHAT_ACCOUNTS_DIR, legacyId + '.json');
    if (fs.existsSync(legacyPath)) {
      try { fs.unlinkSync(legacyPath); } catch {}
    }
    // Also clean up accounts.json index
    try {
      let idx = JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8'));
      if (Array.isArray(idx) && idx.includes(legacyId)) {
        idx = idx.filter(id => id !== legacyId);
        atomicWriteJson(WECHAT_ACCOUNT_INDEX_FILE, idx);
      }
    } catch {}
  }

  // Coerce to string before .trim() — defends against the upstream
  // returning a non-string (e.g. number) which would throw TypeError.
  const data = {
    token: String(payload.token || '').trim(),
    savedAt: new Date().toISOString(),
  };
  if (payload.baseUrl) data.baseUrl = String(payload.baseUrl).trim();
  if (payload.userId) data.userId = String(payload.userId).trim();
  atomicWriteJson(filePath, data);

  // Update account index (also atomic)
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8')); } catch {}
  if (!Array.isArray(accounts)) accounts = [];
  if (!accounts.includes(accountId)) {
    accounts.push(accountId);
    fs.mkdirSync(WECHAT_STATE_DIR, { recursive: true });
    atomicWriteJson(WECHAT_ACCOUNT_INDEX_FILE, accounts);
  }
  return accountId;
}

function ensureWeChatPluginInstalled() {
  if (!fs.existsSync(USB_PLUGIN_DIR) || !fs.existsSync(path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'))) {
    return { installed: false, warning: 'WeChat plugin not found on USB' };
  }

  const alreadyInstalled = fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'));

  // Check if installed version is outdated compared to USB source
  let needsUpdate = false;
  if (alreadyInstalled) {
    try {
      const srcManifest = JSON.parse(fs.readFileSync(path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'), 'utf-8'));
      const dstManifest = JSON.parse(fs.readFileSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'), 'utf-8'));
      if (srcManifest.version && dstManifest.version && srcManifest.version !== dstManifest.version) {
        needsUpdate = true;
      }
    } catch { /* ignore parse errors, proceed with existing */ }
  }

  if (!alreadyInstalled || needsUpdate) {
    // Copy from USB to ~/.openclaw/extensions/
    // Only copy runtime-essential files. When the plugin source is an
    // installed npm package, the source directory contains many files
    // we don't need at runtime (src/, *.ts, README.md, CHANGELOG.md,
    // tests, etc.). Copying everything wastes disk and exposes source.
    const extDir = path.join(OPENCLAW_DIR, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(INSTALLED_PLUGIN_DIR, { recursive: true });

    // Required files: manifest + dist/ (compiled JS)
    fs.copyFileSync(
      path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'),
      path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'),
    );
    const distSrc = path.join(USB_PLUGIN_DIR, 'dist');
    if (fs.existsSync(distSrc)) {
      copyDirSync(distSrc, path.join(INSTALLED_PLUGIN_DIR, 'dist'));
    }
    // package.json is needed for Node module resolution (main field)
    const pkgSrc = path.join(USB_PLUGIN_DIR, 'package.json');
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, path.join(INSTALLED_PLUGIN_DIR, 'package.json'));
    }
  }

  // Always ensure node_modules link exists. The plugin depends on
  // qrcode-terminal and zod. When loaded from
  // OPENCLAW_DIR/extensions/openclaw-weixin/, Node's resolution walks
  // up looking for node_modules but never reaches app/core/node_modules
  // where those deps live (different filesystem branches).
  //
  // We seed a node_modules symlink (or copy fallback for filesystems
  // without symlink support, e.g. exFAT/FAT32 USB sticks) pointing to
  // app/core/node_modules so the plugin can resolve its deps.
  //
  // Run this even when alreadyInstalled=true to recover from earlier
  // failed setups (e.g. user yanked USB mid-install).
  try {
    const coreNodeModules = path.join(__dirname, '../app/core/node_modules');
    const targetNodeModules = path.join(INSTALLED_PLUGIN_DIR, 'node_modules');
    if (fs.existsSync(coreNodeModules) && !fs.existsSync(targetNodeModules)) {
      try {
        // Use relative symlink so it survives USB drive letter / mount point changes.
        const relPath = path.relative(INSTALLED_PLUGIN_DIR, coreNodeModules);
        fs.symlinkSync(relPath, targetNodeModules, 'dir');
      } catch (symlinkErr) {
        // exFAT/FAT32 don't support symlinks; copy the two deps the
        // plugin actually uses (full copy of core/node_modules would
        // be 200MB+ which is unacceptable).
        fs.mkdirSync(targetNodeModules, { recursive: true });
        for (const dep of ['qrcode-terminal', 'zod']) {
          const src = path.join(coreNodeModules, dep);
          const dst = path.join(targetNodeModules, dep);
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            copyDirSync(src, dst);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[wechat-plugin] could not link node_modules:', e.message);
  }

  return { installed: fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json')) };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      // Preserve symlinks as-is (re-create relative target)
      try {
        const target = fs.readlinkSync(s);
        fs.symlinkSync(target, d);
      } catch { /* skip broken symlinks */ }
    } else if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ── WeChat login session management ─────────────────────────────────────────

async function handleWeChatStart() {
  // Defensive cap: prevent unbounded memory growth if someone (or a
  // buggy frontend) starts dozens of login sessions without finishing.
  // Real flow only ever needs 1 active session; 32 leaves headroom.
  if (activeLogins.size >= 32) {
    // Drop the oldest expired one if any; if all still fresh, refuse.
    const now = Date.now();
    for (const [k, v] of activeLogins) {
      if (now - v.startedAt > ACTIVE_LOGIN_TTL_MS) {
        activeLogins.delete(k);
        break;
      }
    }
    if (activeLogins.size >= 32) {
      throw new Error('Too many active login sessions; please retry shortly');
    }
  }

  const sessionKey = crypto.randomUUID();
  const apiBaseUrl = DEFAULT_WECHAT_BASE_URL;
  const qrResponse = await fetchWeChatQrCode(apiBaseUrl);
  // Validate upstream response shape before passing to QR renderer.
  if (!qrResponse || typeof qrResponse.qrcode_img_content !== 'string' ||
      typeof qrResponse.qrcode !== 'string') {
    throw new Error('Upstream WeChat API returned malformed QR response');
  }
  const qrDataUrl = renderQrPngDataUrl(qrResponse.qrcode_img_content);

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrDataUrl,
    startedAt: Date.now(),
    apiBaseUrl,
  });

  return { sessionKey, qrcodeUrl: qrDataUrl };
}

async function handleWeChatStatus(sessionKey) {
  const login = activeLogins.get(sessionKey);
  if (!login) return { status: 'expired', message: 'No active session' };
  if (Date.now() - login.startedAt > ACTIVE_LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey);
    return { status: 'expired', message: 'Session expired' };
  }

  const result = await pollWeChatQrStatus(login.apiBaseUrl, login.qrcode);

  // Defensive: result might be null/undefined or non-object if upstream
  // misbehaves. Treat anything malformed as a transient wait.
  if (!result || typeof result !== 'object') {
    return { status: 'wait' };
  }

  if (result.status === 'expired') {
    // Try to refresh QR code
  login.refreshCount = (login.refreshCount || 0) + 1;
  if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
      activeLogins.delete(sessionKey);
      return { status: 'expired', message: 'QR expired too many times' };
    }
    const refreshed = await fetchWeChatQrCode(login.apiBaseUrl);
    if (!refreshed || typeof refreshed.qrcode_img_content !== 'string' ||
        typeof refreshed.qrcode !== 'string') {
      activeLogins.delete(sessionKey);
      return { status: 'expired', message: 'QR refresh upstream malformed' };
    }
    const newQr = renderQrPngDataUrl(refreshed.qrcode_img_content);
    login.qrcode = refreshed.qrcode;
    login.qrcodeUrl = newQr;
    login.startedAt = Date.now();
    return { status: 'refreshed', qrcodeUrl: newQr };
  }

  if (result.status === 'confirmed') {
    activeLogins.delete(sessionKey);
    // Validate credential types — defends against upstream returning
    // numbers, objects, or arrays for what should be strings.
    if (!result.ilink_bot_id || !result.bot_token ||
        typeof result.ilink_bot_id !== 'string' ||
        typeof result.bot_token !== 'string') {
      return { status: 'error', message: 'Server did not return valid credentials' };
    }

    // 1. Install plugin
    let pluginResult;
    try {
      pluginResult = ensureWeChatPluginInstalled();
    } catch (pluginErr) {
      pluginResult = { installed: false, warning: 'Plugin install failed: ' + pluginErr.message };
      console.error('[wechat] plugin install error:', pluginErr.message);
    }

    // 2. Save account
    const accountId = await saveWeChatAccount(result.ilink_bot_id, {
      token: result.bot_token,
      baseUrl: result.baseurl,
      userId: result.ilink_user_id,
    });

    // 3. Update openclaw.json to enable the plugin (atomic + auto-recovery)
    try {
      const { config } = safeReadConfig();
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      config.plugins.entries['openclaw-weixin'] = { enabled: true };
      atomicWriteConfig(config);
    } catch (e) {
      console.error('Failed to update config:', e.message);
    }

    return {
      status: 'confirmed',
      accountId,
      pluginInstalled: pluginResult.installed,
      message: 'WeChat connected! Restart Gateway to activate.',
    };
  }

  return { status: result.status };
}

function handleWeChatCancel(sessionKey) {
  if (sessionKey) activeLogins.delete(sessionKey);
  else activeLogins.clear();
}

const server = http.createServer((req, res) => {
  // ── Security: defense in depth against CSRF / DNS-rebinding / local
  // process abuse. Three layers below; see SECURITY.md or commit msg
  // for full attack scenarios.
  //
  //   Layer 1 (Host header): rebinding attacks make the browser send
  //     requests to 127.0.0.1 with Origin = attacker.com. The Host
  //     header still reflects what the script *thinks* it's talking
  //     to (a.attacker.com:18788), so requiring Host = 127.0.0.1:port
  //     blocks them.
  //   Layer 2 (Token): every write endpoint requires X-OpenClaw-Token
  //     matching the one stored in runtime.json (mode 0600). This
  //     blocks both classic CSRF (attacker can't read our token) and
  //     local non-browser processes that don't run as our user.
  //   Layer 3 (Content-Type): writes also require application/json.
  //     This forces a CORS preflight, so even if the attacker has the
  //     token they need a permissive Origin to pass — defense in depth.

  const hostHeader = req.headers.host || '';
  const boundPort = (server.address() && server.address().port) || PORT_RANGE_START;
  const expectedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
  if (!expectedHosts.includes(hostHeader)) {
    res.writeHead(421, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Misdirected request: Host header mismatch' }));
    return;
  }

  // CORS: only echo Origin back when it's a localhost origin. We also
  // allow X-OpenClaw-Token in CORS request headers so the preflight
  // succeeds for our own UI.
  const origin = req.headers.origin || '';
  const isLocalOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OpenClaw-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Endpoints that are safe to expose without a token (read-only or
  // bootstrap). Everything else goes through requireAuth().
  const PUBLIC_ENDPOINTS = new Set([
    'GET /api/heartbeat',
    'GET /api/port',
    'GET /api/version',
    'GET /api/bootstrap',
    'GET /api/config',            // Read-only; no secrets exposed (API keys are in the config the user already has)
    'GET /api/logs',              // Read-only log tail
    'GET /api/local/scan',        // Read-only local model scan
    'GET /api/update/check',      // Read-only version check
    'GET /api/mobile/info',       // Read-only LAN IPs for mobile connect
    'GET /api/wechat/plugin-status',
    'POST /api/wechat/cancel',    // Only clears in-memory login state; no file writes
  ]);

  const urlPath = (req.url || '').split('?')[0];
  const route = `${req.method} ${urlPath}`;
  const isApiRequest = urlPath.startsWith('/api/');

  // Prefix-based public routes (e.g. /api/logs?lines=50, /api/wechat/status?session=x)
  const PUBLIC_PREFIXES = [
    'GET /api/logs',
    'GET /api/wechat/status',
  ];

  // Static assets (anything not /api/*) are public — they never expose
  // sensitive data and the index.html itself needs to load before the
  // bootstrap call can happen.
  const isPublic = PUBLIC_ENDPOINTS.has(route) ||
    PUBLIC_PREFIXES.some(prefix => route.startsWith(prefix));

  if (isApiRequest && !isPublic) {
    // Node coerces duplicate headers to a comma-joined string for most
    // headers, but defensively ensure provided is always a plain string.
    // Arrays (some proxies) or non-string values would otherwise reach
    // Buffer.from() which silently coerces, and length comparison
    // could land on a value that mimics expected length. (B22-02)
    let provided = req.headers['x-openclaw-token'];
    if (Array.isArray(provided)) provided = provided[0] || '';
    if (typeof provided !== 'string') provided = '';
    const expected = SERVER_TOKEN;
    // Constant-time compare to avoid timing leaks. Pad to equal length
    // first so timingSafeEqual doesn't throw on mismatched sizes.
    const okToken = provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!okToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid X-OpenClaw-Token' }));
      return;
    }
    // Writes (POST/PUT/DELETE/PATCH) additionally require JSON
    // Content-Type. This forces the browser to do a CORS preflight,
    // which our isLocalOrigin check already gates.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && ct !== 'application/json') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }));
        return;
      }
    }
  }

  // Bootstrap endpoint: returns the server token to the page so it can
  // include it in subsequent API calls. Only served to same-origin
  // requests (Origin missing OR Origin matches our bound address).
  if (route === 'GET /api/bootstrap') {
    const ok = !origin || isLocalOrigin;
    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ token: SERVER_TOKEN, port: boundPort }));
    return;
  }

  // API: WeChat start login
  if (req.url === '/api/wechat/start' && req.method === 'POST') {
    handleWeChatStart()
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat poll status
  if (req.url && req.url.startsWith('/api/wechat/status') && req.method === 'GET') {
    let session;
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      session = urlObj.searchParams.get('session');
    } catch (urlErr) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Malformed URL' }));
      return;
    }
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session parameter' }));
      return;
    }
    // Validate format: UUID v4 hex with dashes, max 64 chars defensively.
    if (typeof session !== 'string' || session.length > 64 || !/^[a-zA-Z0-9-]+$/.test(session)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid session format' }));
      return;
    }
    handleWeChatStatus(session)
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat cancel
  if (req.url === '/api/wechat/cancel' && req.method === 'POST') {
    readBoundedJsonBody(req, res, 10_000).then((data) => {
      if (data === null) return;  // already responded (413/400)
      try {
        handleWeChatCancel(data && data.session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // API: WeChat plugin status
  if (req.url === '/api/wechat/plugin-status' && req.method === 'GET') {
    const hasPlugin = fs.existsSync(path.join(USB_PLUGIN_DIR, 'openclaw.plugin.json'));
    const installed = fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasPlugin, installed }));
    return;
  }

  // API: Get config (auto-recovers from backup if main file is corrupt)
  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const { config, source } = safeReadConfig();
      // Surface the recovery hint via a header so the UI can show a banner
      // without changing the body shape (avoids breaking existing parsers).
      // Must be set before writeHead, which flushes headers immediately.
      const headers = { 'Content-Type': 'application/json' };
      if (source && source !== 'main' && source !== 'empty') {
        headers['X-OpenClaw-Recovery'] = source;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(config));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Save config
  if (req.url === '/api/config' && req.method === 'POST') {
    readBoundedJsonBody(req, res, 1_000_000).then((config) => {
      if (config === null) return;  // already responded with 413/400
      try {
        atomicWriteConfig(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // API: Config server port info (for runtime.js)
  if (req.url === '/api/port' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({port: server.address() ? server.address().port : PORT_RANGE_START}));
    return;
  }

  // API: Get current portable version (cached, only re-read every 60s)
  if (req.url === '/api/version' && req.method === 'GET') {
    if (!global._versionCache || Date.now() - global._versionCache.t > 60000) {
      let portable = 'unknown', openclaw = 'unknown';
      try {
        const pf = path.join(__dirname, '../PORTABLE_VERSION');
        if (fs.existsSync(pf)) portable = fs.readFileSync(pf, 'utf8').trim();
      } catch(e) {}
      try {
        const of = path.join(__dirname, '../OPENCLAW_VERSION');
        if (fs.existsSync(of)) openclaw = fs.readFileSync(of, 'utf8').trim();
      } catch(e) {}
      global._versionCache = {portable, openclaw, t: Date.now()};
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({portable: global._versionCache.portable, openclaw: global._versionCache.openclaw}));
    return;
  }

    // API: Heartbeat — frontend polls this to detect backend disconnect
  if (req.url === '/api/heartbeat' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({alive: true, ts: Date.now()}));
    return;
  }

  // API: Mobile connect info — returns LAN IPs, gateway port, and token
  // so the frontend can display connection instructions for phones.
  if (req.url === '/api/mobile/info' && req.method === 'GET') {
    const os = require('os');
    const lanIps = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIps.push(iface.address);
        }
      }
    }
    // Read gateway port from runtime.json
    let gwPort = 18789;
    try {
      if (fs.existsSync(RUNTIME_PATH)) {
        const rt = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
        if (rt && rt.gatewayPort) gwPort = rt.gatewayPort;
      }
    } catch (_) {}
    // Read token from config
    let token = 'openclaw';
    try {
      const { config } = safeReadConfig();
      if (config && config.gateway && config.gateway.auth && config.gateway.auth.token) {
        token = config.gateway.auth.token;
      }
    } catch (_) {}
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ lanIps, port: gwPort, token }));
    return;
  }


  // === Update concurrency lock ===
  // 防止用户连续点击触发多个并发更新（修改文件时互相破坏）

  // API: Update — check for new release from GitHub
  if (req.url === '/api/update/check' && req.method === 'GET') {
    (async () => {
      try {
        // 15s timeout + 5 MB cap protects us from network hangs and
        // hostile DNS rerouting api.github.com to a slow-loris peer.
        const r = await fetchWithTimeout('https://api.github.com/repos/yuluyangguang1/openclaw-portable/releases/latest', {
          headers: { 'User-Agent': 'OpenClawPortable' },
          timeout: 15000
        });
        if (!r.ok) throw new Error('GitHub API error: ' + r.status);
        const release = await readJsonBounded(r);
        const latestTag = release.tag_name || '';
        const currentVer = fs.existsSync(path.join(__dirname, '../PORTABLE_VERSION'))
          ? fs.readFileSync(path.join(__dirname, '../PORTABLE_VERSION'), 'utf8').trim()
          : 'unknown';
        // Semver-aware compare. Old impl was string equality, which
        // returned true even when latest < current (e.g. user has dev
        // build v0.9.0 but latest tag is v0.7.0 → would prompt downgrade).
        const cmpSemver = (a, b) => {
          const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
          const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] || 0, y = pb[i] || 0;
            if (x !== y) return x > y ? 1 : -1;
          }
          return 0;
        };
        const cleanLatest = latestTag.replace(/^v/, '');
        const isNewer = cmpSemver(cleanLatest, currentVer) > 0;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({
          ok: true,
          current: currentVer,
          latest: latestTag,
          isNewer,
          downloadUrl: release.assets && release.assets[0] ? release.assets[0].browser_download_url : null,
          releaseUrl: release.html_url,
          body: (release.body || '').slice(0, 500)
        }));
      } catch (err) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: Update — download and apply update
  if (req.url === '/api/update/apply' && req.method === 'POST') {
    // File lock — survives across processes (in case port fallback
    // started a second config-server). Memory flag alone wouldn't
    // protect against two processes running update simultaneously.
    const lockPath = path.join(path.dirname(CONFIG_PATH), 'update.lock');
    let lockFd = null;
    try {
      // O_EXCL fails if file exists — atomic across processes
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, String(process.pid));
    } catch (e) {
      // Another process holds the lock, OR a stale lock from a crashed
      // process. Check if the holder is alive.
      try {
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (lockPid && lockPid !== process.pid) {
          try {
            process.kill(lockPid, 0); // signal 0 = check existence
            // Process alive, real conflict
            res.writeHead(409, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ ok: false, error: 'Update already in progress (pid '+lockPid+')' }));
            return;
          } catch (_) {
            // Stale lock — process dead, remove and retry once
            fs.unlinkSync(lockPath);
            lockFd = fs.openSync(lockPath, 'wx');
            fs.writeSync(lockFd, String(process.pid));
          }
        }
      } catch (_) {
        res.writeHead(409, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: false, error: 'Update already in progress' }));
        return;
      }
    } finally {
      if (lockFd !== null) try { fs.closeSync(lockFd); } catch (_) {}
    }
    if (global._updateInProgress) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
      res.writeHead(409, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'Update already in progress' }));
      return;
    }
    global._updateInProgress = true;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, message: 'Update started. The process will restart when complete.' }));

    // newFiles tracks files created by the update so rollback can
    // remove them on failure. MUST be declared OUTSIDE the try block
    // (and outside setTimeout) — the catch block reads it via closure
    // (~line 1104). If declared inside try and the failure happens
    // before line 998 (download/extract phase), the catch would hit
    // ReferenceError, rollback would bail out silently, and
    // global._updateInProgress would stay true forever — locking the
    // update path until config-server restarts. (B22-01)
    let newFiles = [];

    // Run update in background
    setTimeout(async () => {
      // execFile (not execSync) to pass args as array → no shell
      // interpolation, no command injection from os.tmpdir() returning
      // paths with special chars (rare on Linux, common on Windows
      // where the username can contain quotes / spaces / unicode).
      const { execFile, execFileSync } = require('child_process');
      // Unique tmp paths per attempt — concurrent updates from
      // separate processes (or rapid double-clicks bypassing the
      // global lock after restart) would otherwise overwrite each
      // other's zip. Date.now() makes the path unguessable to
      // anything not running in the same process.
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const tmpZip = path.join(require('os').tmpdir(), 'openclaw-portable-update-' + stamp + '.zip');
      const extractDir = path.join(require('os').tmpdir(), 'openclaw-portable-extract-' + stamp);
      const baseDir = path.join(__dirname, '..');
      const backupDir = path.join(require('os').tmpdir(), 'openclaw-update-backup-' + stamp);

      const cleanupTmp = () => {
        try { fs.rmSync(tmpZip, { force: true }); } catch(e) {}
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch(e) {}
      };

      try {

        // 1. Get latest release download URL
        const r = await fetchWithTimeout('https://api.github.com/repos/yuluyangguang1/openclaw-portable/releases/latest', {
          headers: { 'User-Agent': 'OpenClawPortable' },
          timeout: 15000
        });
        const release = await readJsonBounded(r);
        const downloadUrl = release.assets && release.assets[0] ? release.assets[0].browser_download_url : null;
        if (!downloadUrl) { console.error('Update: no download URL found'); return; }

        // 2. Download zip via Node https (no curl dependency)
        console.log('Update: downloading from ' + downloadUrl);
        const https = require('https');
        const { pipeline } = require('stream/promises');
        await new Promise((resolve, reject) => {
          // Per-request timeout: if the download stalls (slow USB, flaky
          // network), abort instead of hanging forever. 5 minutes is a
          // generous upper bound for a ~200 MB zip on a slow link.
          const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
          const MAX_REDIRECTS = 5;
          let redirectCount = 0;
          const doRequest = (u) => {
            const req = https.get(u, { headers: { 'User-Agent': 'OpenClawPortable' } }, (res) => {
              if (res.statusCode === 301 || res.statusCode === 302) {
                req.destroy();
                if (++redirectCount > MAX_REDIRECTS) {
                  return reject(new Error('Too many redirects (' + MAX_REDIRECTS + ')'));
                }
                return doRequest(res.headers.location);
              }
              if (res.statusCode !== 200) {
                res.resume(); // drain so socket can be released
                return reject(new Error('HTTP ' + res.statusCode));
              }
              // Use stream/promises pipeline so any error on either
              // side properly closes BOTH streams. Plain `res.pipe(file)`
              // leaks the file descriptor when the source aborts (slow
              // USB / network drop / timeout) — the file stays open
              // until GC, and on Windows that even prevents cleanupTmp
              // from deleting the partial download. (B23-04)
              const file = fs.createWriteStream(tmpZip);
              pipeline(res, file).then(resolve).catch(reject);
            });
            req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
              req.destroy(new Error('Download timeout (' + DOWNLOAD_TIMEOUT_MS + 'ms)'));
            });
            req.on('error', reject);
          };
          doRequest(downloadUrl);
        });

        // 3. Extract (skip data/ and app/runtime/ to preserve user data and node runtime)
        console.log('Update: extracting...');
        // Use Node's fs API instead of shell (rm -rf / mkdir -p don't exist on Windows cmd.exe)
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch(e) {}
        fs.mkdirSync(extractDir, { recursive: true });

        if (process.platform === 'win32') {
          // execFileSync arg array — but PowerShell -Command joins
          // the remaining argv with spaces, so paths with spaces
          // would still split incorrectly. Pass a single -Command
          // string that uses environment variables we set; the env
          // values are PowerShell-string-safe even with spaces or
          // unicode. Avoids both shell injection AND the space-split
          // problem.
          execFileSync('powershell', [
            '-NoProfile', '-NonInteractive',
            '-Command',
            'Expand-Archive -Force -Path $env:_OC_ZIP -DestinationPath $env:_OC_DST'
          ], {
            timeout: 60000,
            env: { ...process.env, _OC_ZIP: tmpZip, _OC_DST: extractDir }
          });
        } else {
          // Try unzip first, fallback to python -m zipfile if not installed.
          // Both via execFileSync — args as array → no shell.
          try {
            execFileSync('unzip', ['-qo', tmpZip, '-d', extractDir], { timeout: 60000 });
          } catch (e) {
            execFileSync('python3', ['-m', 'zipfile', '-e', tmpZip, extractDir], { timeout: 60000 });
          }
        }

        // Find the root dir inside the zip (might be nested)
        const entries = fs.readdirSync(extractDir);
        let srcDir = extractDir;
        if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
          srcDir = path.join(extractDir, entries[0]);
        }

        // 4. Backup current files for rollback
        // We snapshot every file we're about to overwrite. This lets
        // rollback restore the exact pre-update state. Note: we do NOT
        // (and cannot reliably) detect "files added by the new version"
        // and remove them on rollback — the staged copy below only
        // overwrites files that exist in srcDir, so anything NEW from
        // the update will remain after rollback. Track newly-copied
        // paths in `newFiles` so rollback can delete them too.
        console.log('Update: backing up...');
        fs.mkdirSync(backupDir, { recursive: true });
        const skipDirs = ['data', '.git'];
        // newFiles is declared in the outer scope (closure target for catch).
        // Reset for this run in case the variable was retained across
        // a hot-restart attempt.
        newFiles.length = 0;

        const shouldSkip = (relPath) => {
          if (skipDirs.some(d => relPath === d || relPath.startsWith(d + path.sep))) return true;
          if (relPath.startsWith('app' + path.sep + 'runtime')) return true;
          return false;
        };

        const backupRecursive = (src, dst) => {
          if (!fs.existsSync(src)) return;
          fs.mkdirSync(dst, { recursive: true });
          for (const item of fs.readdirSync(src, { withFileTypes: true })) {
            const rel = path.relative(baseDir, path.join(src, item.name));
            if (shouldSkip(rel)) continue;
            if (item.isDirectory()) backupRecursive(path.join(src, item.name), path.join(dst, item.name));
            else fs.copyFileSync(path.join(src, item.name), path.join(dst, item.name));
          }
        };
        backupRecursive(baseDir, backupDir);

        // 5. Copy files (skip data/, app/runtime/, .git/)
        const copyRecursive = (src, dest) => {
          const items = fs.readdirSync(src, { withFileTypes: true });
          for (const item of items) {
            const srcPath = path.join(src, item.name);
            const destPath = path.join(dest, item.name);
            const relPath = path.relative(srcDir, srcPath);

            if (shouldSkip(relPath)) continue;

            if (item.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true });
              copyRecursive(srcPath, destPath);
            } else {
              // Track files that didn't exist before — rollback will remove these
              if (!fs.existsSync(destPath)) {
                newFiles.push(destPath);
              }
              fs.copyFileSync(srcPath, destPath);
            }
          }
        };

        copyRecursive(srcDir, baseDir);
        console.log('Update: files copied (' + newFiles.length + ' new)');

        // 5. Cleanup
        fs.rmSync(tmpZip, { force: true });
        fs.rmSync(extractDir, { recursive: true, force: true });

        // 6. Update OPENCLAW_VERSION if present in new release
        const newVerFile = path.join(baseDir, 'PORTABLE_VERSION');
        if (fs.existsSync(newVerFile)) {
          console.log('Update: new version = ' + fs.readFileSync(newVerFile, 'utf8').trim());
        }

        console.log('Update: complete! Restarting config server...');

        // 7. Cleanup temp files
        cleanupTmp();
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch(e) {}

        // 8. Restart self by spawning new node process and exiting.
        // Critical: only exit if the spawn actually succeeded. If spawn
        // throws (fork limit, missing binary, USB write still flushing),
        // we must STAY ALIVE so the user keeps a working config-server.
        // Otherwise they see "update success" and a dead UI.
        setTimeout(() => {
          let spawned = false;
          try {
            const { spawn } = require('child_process');
            const child = spawn(process.execPath, [__filename], {
              detached: true,
              stdio: 'ignore',
              cwd: __dirname,
              env: process.env,
            });
            // spawn() resolves async — wait briefly for the child to
            // either confirm or error out. unref() lets parent exit
            // independently, but we still need to know spawn worked.
            child.on('error', (e) => {
              console.error('Update: respawn failed:', e.message);
            });
            child.unref();
            spawned = true;
          } catch (e) {
            console.error('Update: failed to spawn replacement:', e.message);
          }
          if (spawned) {
            // Give the child 500ms to bind 18750 (it'll bump within
            // PORT_RANGE_START..END if we're still listening), then exit.
            setTimeout(() => process.exit(0), 500);
          } else {
            // Spawn failed — keep running so the user has SOMETHING.
            console.error('Update: keeping current process alive (spawn failed). Restart launcher manually.');
            try { fs.unlinkSync(path.join(path.dirname(CONFIG_PATH), 'update.lock')); } catch(_) {}
            global._updateInProgress = false;
          }
        }, 1000);
      } catch (err) {
        // Defensive: catch block itself may throw if `err` lacks .message
        // or if rollback's filesystem ops fail in unexpected ways.
        // Wrapping the whole catch body ensures we always release the
        // lock + flag — otherwise update path stays locked until next
        // config-server restart. (B23-03)
        try {
          console.error('Update failed:', err && err.message ? err.message : err);
          cleanupTmp();
          // Rollback: restore from backup if it exists
          if (fs.existsSync(backupDir)) {
            console.error('Update: rolling back from backup...');
            try {
              // Step 1: remove files added by the failed update.
              // newFiles is in scope from the try block (closure).
              for (const f of newFiles) {
                try { fs.rmSync(f, { force: true }); } catch (_) {}
              }
              // Step 2: restore overwritten files from backup
              const restoreRecursive = (src, dst) => {
                for (const item of fs.readdirSync(src, { withFileTypes: true })) {
                  const srcP = path.join(src, item.name);
                  const dstP = path.join(dst, item.name);
                  if (item.isDirectory()) {
                    fs.mkdirSync(dstP, { recursive: true });
                    restoreRecursive(srcP, dstP);
                  } else {
                    fs.copyFileSync(srcP, dstP);
                  }
                }
              };
              restoreRecursive(backupDir, baseDir);
              console.error('Update: rollback complete (' + newFiles.length + ' new files removed)');
            } catch (rbErr) {
              console.error('Update: rollback failed:', rbErr && rbErr.message);
            }
            try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch(e) {}
          }
        } catch (innerErr) {
          console.error('Update: error in cleanup path:', innerErr && innerErr.message);
        } finally {
          // ALWAYS release the lock + flag, even if cleanup itself crashed.
          global._updateInProgress = false;
          try { fs.unlinkSync(path.join(path.dirname(CONFIG_PATH), 'update.lock')); } catch(_) {}
        }
      }
    }, 500);
    return;
  }


  // API: Restart gateway — kills the gateway process and re-launches it.
  // The config-server itself stays alive; only the gateway (openclaw.mjs)
  // is restarted so the new config takes effect without the user having
  // to close the terminal and double-click again.
  if (req.url === '/api/restart' && req.method === 'POST') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok: true, message: 'Restarting gateway...'}));

    // Find and kill gateway processes on ports 18789-18799
    const { execSync } = require('child_process');
    const isWin = process.platform === 'win32';
    try {
      for (let p = 18789; p <= 18799; p++) {
        if (isWin) {
          // netstat + taskkill
          const out = execSync(`netstat -ano | findstr ":${p} " | findstr "LISTENING"`, {encoding:'utf8', timeout:5000}).trim();
          const lines = out.split('\n').filter(Boolean);
          for (const line of lines) {
            const pid = line.trim().split(/\s+/).pop();
            if (pid && /^\d+$/.test(pid) && pid !== '0') {
              // Verify the process is actually OpenClaw before killing.
              // Without this check, any process listening on 18789-18799
              // gets force-killed (e.g., user's other Node services on
              // these ports). Use wmic to inspect CommandLine.
              try {
                const cmdLine = execSync(`wmic process where "ProcessId=${pid}" get CommandLine /value`, {encoding:'utf8', timeout:3000}).trim();
                if (cmdLine && cmdLine.includes('openclaw.mjs')) {
                  try { execSync(`taskkill /PID ${pid} /F`, {timeout:5000}); } catch(e) {}
                }
              } catch(e) {
                // wmic failed — don't risk killing anything
              }
            }
          }
        } else {
          // lsof or ss
          try {
            const pids = execSync(`lsof -ti :${p} 2>/dev/null || ss -tlnp 2>/dev/null | grep ":${p} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`, {encoding:'utf8', timeout:5000}).trim();
            for (const pid of pids.split('\n').filter(Boolean)) {
              // Defense in depth: even though lsof -ti and our sed only
              // emit digits, refuse to interpolate anything non-numeric
              // into the next shell call. Future regression in upstream
              // tools (or a hypothetical bypass) would otherwise reach
              // `ps -p ${pid}` with attacker-controlled text. (B23-01)
              if (!/^\d+$/.test(pid)) continue;
              // Only kill processes whose command contains 'openclaw.mjs'.
              // Plain 'node' or 'openclaw' is too lax — would also kill
              // unrelated Node services or even our own config-server
              // if it ever bound to one of these ports.
              try {
                const cmd = execSync(`ps -p ${pid} -o command= 2>/dev/null`, {encoding:'utf8', timeout:2000});
                if (cmd && cmd.includes('openclaw.mjs')) {
                  process.kill(parseInt(pid), 'SIGTERM');
                }
              } catch(e) {
                // ps failed — don't risk killing anything
              }
            }
          } catch(e) {}
        }
      }
    } catch(e) { /* best effort */ }

    // Re-launch gateway after a short delay (let ports release).
    // Wrap the entire spawn path in try/catch — a thrown exception
    // from setTimeout would otherwise hit the global uncaughtException
    // handler (which only logs), leaving the user stuck at "Restarting..."
    // with no gateway. Better to log and at least keep config-server
    // responsive so they can hit the button again. (B23-02)
    setTimeout(() => {
      try {
        const { spawn } = require('child_process');
      const coreDir = path.join(__dirname, '../app/core');
      const openclawMjs = path.join(coreDir, 'node_modules/openclaw/openclaw.mjs');
      const nodeBin = process.execPath; // same node that's running us

      // Detect the actual gateway port the launcher chose. Falls back
      // to 18789 only when runtime.json is missing or unreadable.
      // Hardcoding 18789 broke restart whenever the launcher had to
      // bump to 18790+ because port 18789 was taken.
      let gwPort = '18789';
      try {
        if (fs.existsSync(RUNTIME_PATH)) {
          const rt = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
          if (rt && rt.gatewayPort && /^\d+$/.test(String(rt.gatewayPort))) {
            gwPort = String(rt.gatewayPort);
          }
        }
      } catch (e) { /* fall back to default */ }

        if (fs.existsSync(openclawMjs)) {
        // Inherit launcher-set env (OPENCLAW_HOME, OPENCLAW_STATE_DIR,
        // OPENCLAW_DISABLE_BONJOUR, etc.) and only fill in values that
        // are missing. Previously OPENCLAW_HOME was unconditionally
        // overwritten with __dirname/../data which is wrong when the
        // user runs from /Volumes (USB) or ~/.openclaw-portable.
        const env = { ...process.env };
        if (!env.OPENCLAW_HOME) env.OPENCLAW_HOME = path.join(__dirname, '../data');
        if (!env.OPENCLAW_STATE_DIR) env.OPENCLAW_STATE_DIR = OPENCLAW_DIR;
        if (!env.OPENCLAW_CONFIG_PATH) env.OPENCLAW_CONFIG_PATH = CONFIG_PATH;
        if (!env.OPENCLAW_DISABLE_BONJOUR) env.OPENCLAW_DISABLE_BONJOUR = '1';
        const child = spawn(nodeBin, [openclawMjs, 'gateway', 'run', '--allow-unconfigured', '--force', '--port', gwPort], {
          cwd: coreDir,
          env,
          detached: true,
          stdio: 'ignore',
        });
        // spawn() can fail asynchronously (e.g. ENOENT for nodeBin on
        // a corrupted USB). Without an 'error' listener Node would
        // emit unhandledError → process crash.
        child.on('error', (e) => {
          console.error('[restart] gateway spawn error:', e.message);
        });
        child.unref();
      }
      } catch (spawnErr) {
        console.error('[restart] failed to relaunch gateway:', spawnErr && spawnErr.message);
      }
    }, 2000);
    return;
  }

  // API: Scan localhost for known local model runtimes.
  // Probes 5 well-known ports in parallel with a short timeout each
  // so the UI gets a fast 'auto-discovery' of locally-running models.
  if (req.url === '/api/local/scan' && req.method === 'GET') {
    (async () => {
      // Probes are run in parallel (Promise.all) so the order here is
      // only the order they appear in the response — the user's UI
      // shows whichever runtimes are actually running.
      // Port 8080 is shared between llama.cpp and LocalAI; we keep
      // a single probe and report whichever responded.
      const probes = [
        { id: 'ollama',    name: 'Ollama',          port: 11434, path: '/api/tags',  extract: (j) => (j.models || []).map(m => m.name) },
        { id: 'lmstudio',  name: 'LM Studio',       port: 1234,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'vllm',      name: 'vLLM',            port: 8000,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'jan',       name: 'Jan.ai',          port: 1337,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'llamacpp',  name: 'llama.cpp/LocalAI', port: 8080, path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'gpt4all',   name: 'GPT4All',         port: 4891,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'tgwebui',   name: 'Text Gen WebUI',  port: 5000,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'kobold',    name: 'KoboldCpp',       port: 5001,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'xinf',      name: 'XInference',      port: 9997,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
        { id: 'mlx',       name: 'MLX Server',      port: 8081,  path: '/v1/models', extract: (j) => (j.data || []).map(m => m.id) },
      ];
      const probe = async (p) => {
        const url = 'http://127.0.0.1:' + p.port + p.path;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          if (!r.ok) return { id: p.id, name: p.name, port: p.port, running: false };
          // Don't clear the timer until BOTH headers and body are read.
          // readJsonBounded is the body-reading half; if the upstream
          // stalls between sending headers and body, we want to abort.
          // Bound the response — a misbehaving local server could
          // stream gigabytes of JSON and OOM us.
          const j = await readJsonBounded(r, 512 * 1024);
          let models;
          try { models = p.extract(j); } catch (_) { models = []; }
          // Only report as "running" if we actually got a valid model
          // list response. A random HTTP service on the same port that
          // returns 200 + valid JSON (e.g. a dev server, dashboard, or
          // health-check endpoint) would otherwise be misidentified as
          // a local AI runtime. We require either:
          //   - at least one model in the list, OR
          //   - the response has the expected shape (data array or
          //     models array) even if empty — this means the runtime
          //     is running but the user hasn't pulled any models yet.
          const hasExpectedShape = (
            (Array.isArray(j.data)) ||   // OpenAI-compatible /v1/models
            (Array.isArray(j.models))     // Ollama /api/tags
          );
          if (!hasExpectedShape) {
            return { id: p.id, name: p.name, port: p.port, running: false };
          }
          return { id: p.id, name: p.name, port: p.port, running: true, models: models.slice(0, 50) };
        } catch (e) {
          return { id: p.id, name: p.name, port: p.port, running: false };
        } finally {
          clearTimeout(t);
        }
      };
      try {
        const results = await Promise.all(probes.map(probe));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runtimes: results }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, runtimes: [] }));
      }
    })();
    return;
  }

  // API: Test API Key validity (lightweight model list request)
  if (req.url === '/api/key/test' && req.method === 'POST') {
    readBoundedJsonBody(req, res, 10_000).then(async (parsed) => {
      if (parsed === null) return;
      try {
        const { provider, baseUrl, apiKey } = parsed;
        if (!baseUrl || !apiKey) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: 'Missing baseUrl or apiKey'}));
          return;
        }
        // Validate scheme — must be http(s). Blocks file://, ftp://,
        // gopher:// SSRF gadgets and the like.
        let parsedUrl;
        try {
          parsedUrl = new URL(baseUrl.replace(/\/+$/, '') + '/models');
        } catch (_) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: 'Invalid baseUrl'}));
          return;
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: 'Only http(s) URLs are supported'}));
          return;
        }
        // SSRF defence: refuse hostnames that resolve to private/loopback/
        // link-local IPv4 ranges or IPv6 equivalents. Real LLM providers
        // are public; "test my key against http://169.254.169.254/" is
        // either a typo or someone trying to probe AWS metadata.
        // Hostname-based check (not DNS-resolved) — we don't want to
        // call dns.lookup before the request because that's an extra
        // round-trip and the hostname IS the addressable target. (B23-02)
        const isBlockedHost = (() => {
          const h = parsedUrl.hostname.toLowerCase();
          if (!h) return true;
          // Bracket-stripped IPv6
          const ipv6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
          // IPv4 literals
          const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
          if (m4) {
            const [a, b] = [parseInt(m4[1]), parseInt(m4[2])];
            if (a === 10) return true;                              // 10/8
            if (a === 127) return true;                             // loopback
            if (a === 169 && b === 254) return true;                // link-local + cloud metadata
            if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16/12
            if (a === 192 && b === 168) return true;                // 192.168/16
            if (a === 0) return true;                               // 0.0.0.0/8
            if (a >= 224) return true;                              // multicast / reserved
          }
          // IPv6 loopback / link-local / unique-local / mapped IPv4
          if (ipv6 === '::1' || ipv6 === '::') return true;
          if (ipv6.startsWith('fe80:')) return true;
          if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true;
          if (ipv6.startsWith('::ffff:')) return true;              // IPv4-mapped — would need re-check
          // Common hostnames pointing to private space
          if (h === 'localhost' || h === 'localhost.localdomain') return true;
          // Cloud metadata service well-known hostnames
          if (h === 'metadata.google.internal') return true;
          return false;
        })();
        if (isBlockedHost) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: '拒绝连接到本地/内网地址（防止 SSRF）'}));
          return;
        }
        const url = parsedUrl.toString();
        const https = require('https');
        const http = require('http');
        const mod = parsedUrl.protocol === 'https:' ? https : http;
        const headers = { 'Authorization': 'Bearer ' + apiKey, 'User-Agent': 'OpenClawPortable' };
        // Special case: zhipu uses different auth
        if (provider === 'zai') {
          headers['Authorization'] = 'Bearer ' + apiKey;
        }
        // Single-write guard: timeout / error / end can race in failure
        // modes (e.g. resp.destroy() from the size cap fires both
        // 'aborted' and 'end'). Without this we double-write headers
        // and crash with ERR_HTTP_HEADERS_SENT.
        let responded = false;
        const respond = (payload) => {
          if (responded) return;
          responded = true;
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify(payload));
        };
        const testReq = mod.get({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: headers,
          timeout: 10000,
        }, (resp) => {
          // Buffer accumulation: avoid string concat which breaks
          // multi-byte UTF-8 chars at chunk boundaries and uses
          // UTF-16 char count for the size limit (Chinese chars are
          // 1 char but 3 bytes — would let 150KB through a 50K limit).
          const chunks = [];
          let total = 0;
          resp.on('data', c => {
            total += c.length;
            if (total > 50000) {
              resp.destroy();
              return;
            }
            chunks.push(c);
          });
          resp.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            if (resp.statusCode >= 200 && resp.statusCode < 300) {
              let modelCount = 0;
              try {
                const parsed = JSON.parse(data);
                modelCount = parsed && parsed.data ? parsed.data.length : 0;
              } catch (_) {}
              respond({ok: true, models: modelCount, status: resp.statusCode});
            } else if (resp.statusCode === 401 || resp.statusCode === 403) {
              respond({ok: false, error: 'Key 无效或已过期 (HTTP ' + resp.statusCode + ')'});
            } else {
              respond({ok: false, error: 'HTTP ' + resp.statusCode});
            }
          });
          resp.on('error', () => respond({ok: false, error: '响应中断'}));
        });
        testReq.on('error', (err) => {
          respond({ok: false, error: '连接失败: ' + err.message});
        });
        testReq.on('timeout', () => {
          testReq.destroy();
          respond({ok: false, error: '连接超时 (10s)'});
        });
      } catch(err) {
        if (!res.headersSent) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: err.message}));
        }
      }
    });
    return;
  }

    // API: Channel connectivity test (lightweight fetch-based)
  if (req.url === '/api/channel/test' && req.method === 'POST') {
    readBoundedJsonBody(req, res, 100_000).then(async (data) => {
      if (data === null) return;
      try {
        const {type} = data;
        // Defensive: malformed POST body might have type but no config
        // object. Without this guard, accessing config.token throws
        // TypeError and the user sees a misleading "Network error".
        const config = data.config || {};
        let result = {ok:false, error:'Unsupported channel'};

        if (type === 'telegram' && config.token) {
          // Validate token format before using in URL — Telegram bot
          // tokens are <number>:<base64ish>. Reject anything with
          // path-breaking chars to avoid surprising URL injection
          // (api.telegram.org/bot<TOKEN>/getMe → if TOKEN has '/'
          // we'd hit an unintended endpoint).
          if (!/^\d+:[A-Za-z0-9_-]+$/.test(String(config.token))) {
            result = { error: 'Invalid Telegram token format' };
          } else {
            const r = await fetchWithTimeout('https://api.telegram.org/bot'+config.token+'/getMe', { timeout: 10000 });
            const j = await readJsonBounded(r);
            if (j.ok) result = {ok:true, info:'@'+j.result.username};
            else result = {error:j.description||'Telegram API error'};
          }
        } else if (type === 'discord' && config.token) {
          const r = await fetchWithTimeout('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bot '+config.token}, timeout: 10000});
          if (r.ok) {const j=await readJsonBounded(r);result={ok:true,info:'@'+(j.username||'bot')};}
          else {
            // Bounded read: error responses can be large HTML pages
            // when the API endpoint is misrouted; we only show the
            // first 120 chars anyway.
            let errText = '';
            try {
              const reader = r.body.getReader();
              const buf = [];
              let total = 0;
              while (total < 4096) {
                const { value, done } = await reader.read();
                if (done) break;
                buf.push(value);
                total += value.length;
              }
              try { reader.cancel(); } catch (_) {}
              errText = Buffer.concat(buf.map(c => Buffer.from(c))).toString('utf8');
            } catch (_) {}
            result = {error: errText.slice(0, 120)};
          }
        } else if (type === 'slack' && config.token) {
          const r = await fetchWithTimeout('https://slack.com/api/auth.test',{headers:{Authorization:'Bearer '+config.token}, timeout: 10000});
          const j = await readJsonBounded(r);
          if (j.ok) result = {ok:true,info:'@'+(j.user||'bot')};
          else result = {error:j.error||'Slack auth failed'};
        } else if (type === 'feishu' && config.appId && config.appSecret) {
          const r = await fetchWithTimeout('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({app_id: config.appId, app_secret: config.appSecret}),
            timeout: 10000
          });
          const j = await readJsonBounded(r);
          if (j.code === 0) result = {ok:true, info:'App ID ' + config.appId.slice(0,12) + '…'};
          else result = {error: j.msg || 'Feishu auth failed'};
        } else if (!config || Object.keys(config).length === 0) {
          result = {error:'Missing credentials for '+type};
        } else {
          // QQ, Wecom — no simple test API
          result = {ok:false, error:'Saved — test on restart'};
        }
        if (!res.headersSent) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(result));
        }
      } catch(err) {
        if (!res.headersSent) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'Network error: '+(err.message||'').slice(0,80)}));
        }
      }
    });
    return;
  }

  // API: Gateway runtime logs (tail)
  if (req.url && req.url.startsWith('/api/logs') && req.method === 'GET') {
    // Bounded-memory tail: read at most LOG_TAIL_BYTES from the end
    // of the file. fs.readFileSync would buffer GB-sized logs into
    // memory and freeze the event loop for seconds — long enough that
    // the heartbeat poll trips the disconnect overlay even though the
    // server is fine.
    const LOG_TAIL_BYTES = 256 * 1024;  // 256 KB → ~1000-3000 log lines
    const tailLog = (logPath, lines) => {
      let stat;
      try { stat = fs.statSync(logPath); } catch (_) { return []; }
      if (!stat.isFile() || stat.size === 0) return [];
      const readSize = Math.min(stat.size, LOG_TAIL_BYTES);
      const start = stat.size - readSize;
      let fd;
      try {
        fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, start);
        let text = buf.toString('utf8');
        // If we sliced into the middle of a line, drop the partial first line
        if (start > 0) {
          const nl = text.indexOf('\n');
          if (nl >= 0) text = text.slice(nl + 1);
        }
        const all = text.split('\n').filter(Boolean);
        return all.slice(-(lines || 100));
      } catch (_) {
        return [];
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      }
    };
    // Probe common log locations
    const logFiles = [
      path.join(__dirname, '../data/logs/gateway.log'),
      path.join(__dirname, '../data/.openclaw/logs/openclaw.log'),
      path.join(OPENCLAW_DIR, 'openclaw.log'),
      path.join(__dirname, '../app/core/gateway.log'),
      path.join(__dirname, '../data/openclaw.log'),
    ];
    for (const lf of logFiles) {
      const entries = tailLog(lf, 80);
      if (entries.length > 0) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({source:lf, lines:entries}));
        return;
      }
    }
    // No logs found — return status
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({lines:['Gateway log file not found. Start the Gateway to see logs here.'], status:'idle'}));
    return;
  }

  
// ═══════════════════════════════════════════════════════════
// Feature 1: Cost Tracking - /api/usage
// ═══════════════════════════════════════════════════════════
if (req.url === '/api/usage' && req.method === 'GET') {
  try {
    const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
    const usagePath = path.join(dataDir, 'usage.json');
    const usage = fs.existsSync(usagePath) ? JSON.parse(fs.readFileSync(usagePath, 'utf8')) : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: {} }));
  }
  return;
}

// ═══════════════════════════════════════════════════════════
// Feature 2: Real-time Monitoring - /api/status
// ═══════════════════════════════════════════════════════════
if (req.url === '/api/status' && req.method === 'GET') {
  try {
    const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
    const configPath = path.join(dataDir, 'openclaw.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const gatewayPort = config.gateway?.port || 18789;
    
    // Check gateway status
    const http = require('http');
    const checkGateway = () => new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${gatewayPort}/`, { timeout: 2000 }, (res) => {
        resolve({ online: true, port: gatewayPort, status: res.statusCode });
      });
      req.on('error', () => resolve({ online: false, port: gatewayPort }));
      req.on('timeout', () => { req.destroy(); resolve({ online: false, port: gatewayPort }); });
    });
    
    checkGateway().then(status => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, gateway: status, config: { providers: Object.keys(config.models?.providers || {}).length } }));
    });
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: { online: false }, config: { providers: 0 } }));
  }
  return;
}

// ═══════════════════════════════════════════════════════════
// Feature 3: Memory Browser - /api/memory
// ═══════════════════════════════════════════════════════════
if (req.url === '/api/memory' && req.method === 'GET') {
  try {
    const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
    const memoryDir = path.join(dataDir, 'memory');
    const files = fs.existsSync(memoryDir) ? fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') || f.endsWith('.json')) : [];
    const memories = files.map(f => {
      const content = fs.readFileSync(path.join(memoryDir, f), 'utf8');
      return { name: f, content: content.slice(0, 500), size: content.length };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memories }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memories: [] }));
  }
  return;
}

if (req.url === '/api/memory' && req.method === 'POST') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { name, content } = JSON.parse(body);
      const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
      const memoryDir = path.join(dataDir, 'memory');
      if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, name), content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  return;
}

// ═══════════════════════════════════════════════════════════
// Feature 4: Session Management - /api/sessions
// ═══════════════════════════════════════════════════════════
if (req.url === '/api/sessions' && req.method === 'GET') {
  try {
    const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
    const sessionsDir = path.join(dataDir, 'sessions');
    const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')) : [];
    const sessions = files.slice(0, 50).map(f => {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        return { 
          id: f.replace('.json', ''), 
          created: content.created || content.createdAt,
          model: content.model || content.agentModel,
          messages: content.messages?.length || 0
        };
      } catch { return { id: f.replace('.json', ''), error: 'parse failed' }; }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: [] }));
  }
  return;
}

// ═══════════════════════════════════════════════════════════
// Feature 5: Skills Management - /api/skills
// ═══════════════════════════════════════════════════════════
if (req.url === '/api/skills' && req.method === 'GET') {
  try {
    const dataDir = process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '../data/.openclaw');
    const skillsDir = path.join(dataDir, 'skills');
    const dirs = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
    const skills = dirs.map(d => {
      const skillPath = path.join(skillsDir, d.name, 'SKILL.md');
      const hasSkill = fs.existsSync(skillPath);
      return { name: d.name, hasSkill, path: skillPath };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, skills }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, skills: [] }));
  }
  return;
}

// Serve static files. Strip query string and fragment first;
  // fs treats them as part of the filename which leads to confusing
  // 404s. Also reject URL bytes that could canonicalize differently
  // on Windows (backslash) before we hit path.join.
  const rawUrl = req.url || '/';
  // Reject backslash entirely — Windows treats / and \ interchangeably
  // for path separators; an attacker could try '..\..\server.js' and
  // path.join might honor the backslash.
  if (rawUrl.includes('\\')) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const cleanUrl = rawUrl.split('?')[0].split('#')[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(cleanUrl);
  } catch (_) {
    // Malformed percent-encoding (e.g. '%ZZ')
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  // Re-check after decoding — '%2e%2e%2fserver.js' decodes to '../server.js'
  // which path.join will collapse, but the check below still catches it.
  // Also re-reject backslash that was percent-encoded.
  if (decodedPath.includes('\\') || decodedPath.includes('\0')) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const publicDir = path.join(__dirname, 'public');
  const filePath = decodedPath === '/'
    ? path.join(publicDir, 'index.html')
    : path.join(publicDir, decodedPath);

  // Path traversal defence: resolved path must stay inside public/
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Stat once with try/catch — using existsSync + statSync separately
  // is a TOCTOU race (file may vanish between the two calls when the
  // USB stick is pulled mid-request). One stat call, one error path.
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (_) { /* ENOENT, EACCES, etc. — fall through to 404 */ }

  if (stat && stat.isFile()) {
    const ext = path.extname(resolved);
    const contentType = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    }[ext] || 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    // Bind error handler before pipe — without it, USB yank or
    // mid-stream file deletion emits an unhandled 'error' event,
    // crashing the process via uncaughtException. Also set autoClose
    // (default true) and ensure res ends if the stream errors out.
    const stream = fs.createReadStream(resolved);
    stream.on('error', (e) => {
      console.warn('[static] read error for', resolved, ':', e.message);
      try { if (!res.headersSent) res.writeHead(500); } catch (_) {}
      try { res.end(); } catch (_) {}
    });
    stream.pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function listenWithFallback(port) {
  const onError = (err) => {
    if (err && err.code === 'EADDRINUSE' && port < PORT_RANGE_END) {
      console.log(`   Port ${port} busy, trying ${port + 1}…`);
      server.removeListener('error', onError);
      setImmediate(() => listenWithFallback(port + 1));
      return;
    }
    console.error(`Config server failed to bind: ${err && err.message ? err.message : err}`);
    process.exit(1);
  };
  server.on('error', onError);
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', onError);
    console.log(`\n[OpenClaw] Portable Config Center`);
    console.log(`   http://127.0.0.1:${port}`);
    console.log(`   Config file: ${CONFIG_PATH}\n`);
    try {
      fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
      // Read-modify-write requires care: gateway may also be writing
      // its own keys (gatewayPort, gatewayToken). Use atomic write
      // (.tmp + rename) so a crash mid-write doesn't corrupt the file.
      // We accept the small race where two processes both read the
      // same baseline and one's update gets lost — runtime.json is
      // best-effort coordination, not a transactional store.
      let existing = {};
      try {
        if (fs.existsSync(RUNTIME_PATH)) {
          existing = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
          if (!existing || typeof existing !== 'object') existing = {};
        }
      } catch (parseErr) {
        // Corrupt runtime.json — start fresh rather than crash startup
        console.warn(`[config-server] runtime.json corrupt, recreating: ${parseErr.message}`);
        existing = {};
      }
      existing.configServerPort = port;
      existing.configServerToken = SERVER_TOKEN;
      existing.configServerUpdatedAt = new Date().toISOString();
      // Atomic via .tmp + rename
      const tmp = RUNTIME_PATH + '.tmp';
      let fd = null;
      try {
        fd = fs.openSync(tmp, 'w', 0o600);
        fs.writeSync(fd, JSON.stringify(existing, null, 2));
        try {
          fs.fsyncSync(fd);
        } catch (fsyncErr) {
          // FAT32/exFAT may not support fsync — see atomicWriteJson.
          console.warn(`[config-server] runtime.json fsync failed: ${fsyncErr.code || fsyncErr.message}`);
        }
      } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      }
      fs.renameSync(tmp, RUNTIME_PATH);
      // Ensure 0600 even if rename inherited wider perms
      try { fs.chmodSync(RUNTIME_PATH, 0o600); } catch (_) {}
    } catch (err) {
      console.warn(`   Warning: could not write ${RUNTIME_PATH}: ${err.message}`);
    }
  });
}

// Crash-safety: log instead of dying on unexpected errors so the
// config server stays responsive (the main launcher cannot recover from a crash).
process.on('uncaughtException', (err) => {
  try {
    console.error('[config-server] uncaughtException:', err && err.stack ? err.stack : err);
  } catch (_) {}
});

// Clean up orphaned update tmp files from prior crashes. Without this,
// every aborted update leaves ~100 MB in os.tmpdir() forever — eventually
// fills the user's drive. Match only our prefix; never touch the OS's
// own tmp files. Run on next tick so server boot isn't delayed.
setImmediate(() => {
  try {
    const tmpdir = require('os').tmpdir();
    const cutoff = Date.now() - 24 * 3600_000; // older than 24h
    for (const name of fs.readdirSync(tmpdir)) {
      if (!name.startsWith('openclaw-portable-update-') &&
          !name.startsWith('openclaw-portable-extract-') &&
          !name.startsWith('openclaw-update-backup-')) continue;
      const p = path.join(tmpdir, name);
      try {
        // Use lstat (not stat) so we don't follow symlinks. If a malicious
        // process planted a symlink with our prefix pointing at /home/user/Documents,
        // stat() would report it as a directory and rmSync(recursive) would
        // wipe the user's docs. lstat reports the symlink itself.
        const st = fs.lstatSync(p);
        if (st.mtimeMs < cutoff) {
          if (st.isSymbolicLink()) {
            // Just unlink the symlink, never follow.
            fs.unlinkSync(p);
          } else if (st.isDirectory()) {
            fs.rmSync(p, { recursive: true, force: true });
          } else {
            fs.rmSync(p, { force: true });
          }
        }
      } catch (_) {}
    }
  } catch (_) { /* tmpdir may be unreadable on some setups */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[config-server] unhandledRejection:', reason);
  } catch (_) {}
});

listenWithFallback(PORT_RANGE_START);
