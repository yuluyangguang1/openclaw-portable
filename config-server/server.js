#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');
const crypto = require('crypto');

const PORT_RANGE_START = 18788;
const PORT_RANGE_END = 18798;
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
    try { fs.fsyncSync(fd); } catch (_) { /* fsync may fail on some FS */ }
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

// Resolve ~/.openclaw/ directory
const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || require('os').homedir(), '.openclaw');
const WECHAT_STATE_DIR = path.join(OPENCLAW_DIR, 'openclaw-weixin');
const WECHAT_ACCOUNTS_DIR = path.join(WECHAT_STATE_DIR, 'accounts');
const WECHAT_ACCOUNT_INDEX_FILE = path.join(WECHAT_STATE_DIR, 'accounts.json');

// Plugin source on USB
const USB_PLUGIN_DIR = path.join(__dirname, '../app/extensions/openclaw-weixin');
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
  const scale = 6, margin = 4;
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
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
    const body = await response.text().catch(() => '');
    throw new Error('Failed to fetch QR: ' + response.status + ' ' + body);
  }
  return await readJsonBounded(response);
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
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) throw new Error('Poll failed: ' + response.status + ' ' + text);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

function normalizeAccountId(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
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
    try { fs.fsyncSync(fd); } catch (_) {}
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
  fs.renameSync(tmp, filePath);
}

async function saveWeChatAccount(rawAccountId, payload) {
  const accountId = normalizeAccountId(rawAccountId);
  fs.mkdirSync(WECHAT_ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(WECHAT_ACCOUNTS_DIR, accountId + '.json');
  const data = {
    token: payload.token.trim(),
    savedAt: new Date().toISOString(),
  };
  if (payload.baseUrl) data.baseUrl = payload.baseUrl.trim();
  if (payload.userId) data.userId = payload.userId.trim();
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
  if (fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json'))) {
    return { installed: true };
  }
  // Copy from USB to ~/.openclaw/extensions/
  const extDir = path.join(OPENCLAW_DIR, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  copyDirSync(USB_PLUGIN_DIR, INSTALLED_PLUGIN_DIR);
  return { installed: fs.existsSync(path.join(INSTALLED_PLUGIN_DIR, 'openclaw.plugin.json')) };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── WeChat login session management ─────────────────────────────────────────

async function handleWeChatStart() {
  const sessionKey = crypto.randomUUID();
  const apiBaseUrl = DEFAULT_WECHAT_BASE_URL;
  const qrResponse = await fetchWeChatQrCode(apiBaseUrl);
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

  if (result.status === 'expired') {
    // Try to refresh QR code
  login.refreshCount = (login.refreshCount || 0) + 1;
  if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
      activeLogins.delete(sessionKey);
      return { status: 'expired', message: 'QR expired too many times' };
    }
    const refreshed = await fetchWeChatQrCode(login.apiBaseUrl);
    const newQr = renderQrPngDataUrl(refreshed.qrcode_img_content);
    login.qrcode = refreshed.qrcode;
    login.qrcodeUrl = newQr;
    login.startedAt = Date.now();
    return { status: 'refreshed', qrcodeUrl: newQr };
  }

  if (result.status === 'confirmed') {
    activeLogins.delete(sessionKey);
    if (!result.ilink_bot_id || !result.bot_token) {
      return { status: 'error', message: 'Server did not return credentials' };
    }

    // 1. Install plugin
    const pluginResult = ensureWeChatPluginInstalled();

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
    const provided = req.headers['x-openclaw-token'] || '';
    // Constant-time compare to avoid timing leaks. Pad to equal length
    // first so timingSafeEqual doesn't throw on mismatched sizes.
    const expected = SERVER_TOKEN;
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
    const urlObj = new URL(req.url, 'http://localhost');
    const session = urlObj.searchParams.get('session');
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session parameter' }));
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
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        handleWeChatCancel(data.session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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
    let body = '';
    const MAX_BODY = 1_000_000; // 1 MB — config files are tiny
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) { req.destroy(); return; }
    });
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        atomicWriteConfig(config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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
    if (global._updateInProgress) {
      res.writeHead(409, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'Update already in progress' }));
      return;
    }
    global._updateInProgress = true;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, message: 'Update started. The process will restart when complete.' }));

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
        await new Promise((resolve, reject) => {
          // Per-request timeout: if the download stalls (slow USB, flaky
          // network), abort instead of hanging forever. 5 minutes is a
          // generous upper bound for a ~200 MB zip on a slow link.
          const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
          const doRequest = (u) => {
            const req = https.get(u, { headers: { 'User-Agent': 'OpenClawPortable' } }, (res) => {
              if (res.statusCode === 301 || res.statusCode === 302) {
                req.destroy();
                return doRequest(res.headers.location);
              }
              if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
              const file = fs.createWriteStream(tmpZip);
              res.pipe(file);
              file.on('finish', () => file.close(resolve));
              file.on('error', reject);
              res.on('error', reject);
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
          // execFileSync with arg array — paths can't break out into
          // PowerShell command injection territory. The Expand-Archive
          // cmdlet receives -Path / -DestinationPath as bound params,
          // not as substrings of the command string.
          execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Expand-Archive', '-Force',
            '-Path', tmpZip,
            '-DestinationPath', extractDir
          ], { timeout: 60000 });
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
        const newFiles = [];  // files added by the update; rollback removes these

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

        // 8. Restart self by spawning new node process and exiting
        setTimeout(() => {
          try {
            const { spawn } = require('child_process');
            const child = spawn(process.execPath, [__filename], {
              detached: true,
              stdio: 'ignore',
              cwd: __dirname,
              env: process.env,
            });
            child.unref();
          } catch(e) { console.error('Failed to respawn:', e.message); }
          setTimeout(() => process.exit(0), 500);
        }, 1000);
      } catch (err) {
        console.error('Update failed:', err.message);
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
            console.error('Update: rollback failed:', rbErr.message);
          }
          try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch(e) {}
        }
        global._updateInProgress = false;
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
              try { execSync(`taskkill /PID ${pid} /F`, {timeout:5000}); } catch(e) {}
            }
          }
        } else {
          // lsof or ss
          try {
            const pids = execSync(`lsof -ti :${p} 2>/dev/null || ss -tlnp 2>/dev/null | grep ":${p} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`, {encoding:'utf8', timeout:5000}).trim();
            for (const pid of pids.split('\n').filter(Boolean)) {
              // 先确认是 openclaw/node 相关进程，避免误杀
              try {
                const cmd = execSync(`ps -p ${pid} -o command= 2>/dev/null`, {encoding:'utf8', timeout:2000});
                if (cmd && (cmd.includes('openclaw') || cmd.includes('node'))) {
                  process.kill(parseInt(pid), 'SIGTERM');
                }
              } catch(e) {
                // ps 失败时不冒险杀进程
              }
            }
          } catch(e) {}
        }
      }
    } catch(e) { /* best effort */ }

    // Re-launch gateway after a short delay (let ports release)
    setTimeout(() => {
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
        child.unref();
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
          clearTimeout(t);
          if (!r.ok) return { id: p.id, name: p.name, port: p.port, running: false };
          const j = await r.json();
          let models;
          try { models = p.extract(j); } catch (_) { models = []; }
          return { id: p.id, name: p.name, port: p.port, running: true, models: models.slice(0, 50) };
        } catch (e) {
          clearTimeout(t);
          return { id: p.id, name: p.name, port: p.port, running: false };
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
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, baseUrl, apiKey } = JSON.parse(body);
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
          let data = '';
          resp.on('data', c => { data += c; if (data.length > 50000) resp.destroy(); });
          resp.on('end', () => {
            if (resp.statusCode >= 200 && resp.statusCode < 300) {
              let modelCount = 0;
              try { modelCount = JSON.parse(data).data ? JSON.parse(data).data.length : 0; } catch(e) {}
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
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) { req.destroy(); return; }
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const {type, config} = data;
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
          else {const t=await r.text();result={error:t.slice(0,120)};}
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
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(err) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:'Network error: '+err.message.slice(0,80)}));
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

  // Serve static files
  const publicDir = path.join(__dirname, 'public');
  const filePath = req.url === '/'
    ? path.join(publicDir, 'index.html')
    : path.join(publicDir, req.url);

  // Path traversal defence: resolved path must stay inside public/
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const ext = path.extname(resolved);
    const contentType = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    }[ext] || 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(resolved).pipe(res);
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
    console.log(`\n🦞 OpenClaw Portable Config Center`);
    console.log(`   http://127.0.0.1:${port}`);
    console.log(`   Config file: ${CONFIG_PATH}\n`);
    try {
      fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
      const existing = fs.existsSync(RUNTIME_PATH) ? JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')) : {};
      existing.configServerPort = port;
      existing.configServerToken = SERVER_TOKEN;
      existing.configServerUpdatedAt = new Date().toISOString();
      fs.writeFileSync(RUNTIME_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
      // Ensure permissions even if file already existed with wider perms
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
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[config-server] unhandledRejection:', reason);
  } catch (_) {}
});

listenWithFallback(PORT_RANGE_START);
