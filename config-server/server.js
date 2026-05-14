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
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Failed to fetch QR: ' + response.status + ' ' + body);
  }
  return await response.json();
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // Update account index
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8')); } catch {}
  if (!Array.isArray(accounts)) accounts = [];
  if (!accounts.includes(accountId)) {
    accounts.push(accountId);
    fs.mkdirSync(WECHAT_STATE_DIR, { recursive: true });
    fs.writeFileSync(WECHAT_ACCOUNT_INDEX_FILE, JSON.stringify(accounts, null, 2));
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

    // 3. Update openclaw.json to enable the plugin
    try {
      const configRaw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : '{}';
      const config = JSON.parse(configRaw);
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      config.plugins.entries['openclaw-weixin'] = { enabled: true };
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
  // CORS: only allow localhost origins. Wildcard '*' would let any
  // webpage (including via DNS rebinding) call our config API and
  // overwrite the user's openclaw.json — e.g. swap their API key
  // for an attacker's proxy to intercept conversations.
  const origin = req.headers.origin || '';
  const isLocalOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (isLocalOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
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

  // API: Get config
  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const config = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
        // 清除旧版废弃键，防止 OpenClaw 报 "agent.* was moved" 错误
        delete config.agent;
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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

  // API: Heartbeat — frontend polls this to detect backend disconnect
  if (req.url === '/api/heartbeat' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({alive: true, ts: Date.now()}));
    return;
  }


  // API: Update — check for new release from GitHub
  if (req.url === '/api/update/check' && req.method === 'GET') {
    (async () => {
      try {
        const r = await fetch('https://api.github.com/repos/yuluyangguang1/openclaw-portable/releases/latest', {
          headers: { 'User-Agent': 'OpenClawPortable' }
        });
        if (!r.ok) throw new Error('GitHub API error: ' + r.status);
        const release = await r.json();
        const latestTag = release.tag_name || '';
        const currentVer = fs.existsSync(path.join(__dirname, '../PORTABLE_VERSION'))
          ? fs.readFileSync(path.join(__dirname, '../PORTABLE_VERSION'), 'utf8').trim()
          : 'unknown';
        const isNewer = latestTag.replace(/^v/, '') !== currentVer;
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
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, message: 'Update started. The process will restart when complete.' }));

    // Run update in background
    setTimeout(async () => {
      try {
        const { execSync } = require('child_process');
        const tmpZip = path.join(require('os').tmpdir(), 'openclaw-portable-update.zip');
        const baseDir = path.join(__dirname, '..');

        // 1. Get latest release download URL
        const r = await fetch('https://api.github.com/repos/yuluyangguang1/openclaw-portable/releases/latest', {
          headers: { 'User-Agent': 'OpenClawPortable' }
        });
        const release = await r.json();
        const downloadUrl = release.assets && release.assets[0] ? release.assets[0].browser_download_url : null;
        if (!downloadUrl) { console.error('Update: no download URL found'); return; }

        // 2. Download zip
        console.log('Update: downloading from ' + downloadUrl);
        execSync(`curl -fSL -o "${tmpZip}" "${downloadUrl}"`, { timeout: 300000 });

        // 3. Extract (skip data/ and app/runtime/ to preserve user data and node runtime)
        console.log('Update: extracting...');
        const extractDir = path.join(require('os').tmpdir(), 'openclaw-portable-extract');
        execSync(`rm -rf "${extractDir}" && mkdir -p "${extractDir}"`);

        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Force '${tmpZip}' '${extractDir}'"`, { timeout: 60000 });
        } else {
          execSync(`unzip -qo "${tmpZip}" -d "${extractDir}"`, { timeout: 60000 });
        }

        // Find the root dir inside the zip (might be nested)
        const entries = fs.readdirSync(extractDir);
        let srcDir = extractDir;
        if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
          srcDir = path.join(extractDir, entries[0]);
        }

        // 4. Copy files (skip data/, app/runtime/, .git/)
        const skipDirs = ['data', '.git'];
        const skipFiles = [];
        const copyRecursive = (src, dest) => {
          const items = fs.readdirSync(src, { withFileTypes: true });
          for (const item of items) {
            const srcPath = path.join(src, item.name);
            const destPath = path.join(dest, item.name);
            const relPath = path.relative(srcDir, srcPath);

            // Skip protected directories
            if (skipDirs.some(d => relPath === d || relPath.startsWith(d + path.sep))) continue;
            // Skip runtime (preserve existing node binary)
            if (relPath.startsWith('app' + path.sep + 'runtime')) continue;

            if (item.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true });
              copyRecursive(srcPath, destPath);
            } else {
              fs.copyFileSync(srcPath, destPath);
            }
          }
        };

        copyRecursive(srcDir, baseDir);
        console.log('Update: files copied');

        // 5. Cleanup
        fs.rmSync(tmpZip, { force: true });
        fs.rmSync(extractDir, { recursive: true, force: true });

        // 6. Update OPENCLAW_VERSION if present in new release
        const newVerFile = path.join(baseDir, 'PORTABLE_VERSION');
        if (fs.existsSync(newVerFile)) {
          console.log('Update: new version = ' + fs.readFileSync(newVerFile, 'utf8').trim());
        }

        console.log('Update: complete! Restarting config server...');

        // 7. Restart self
        setTimeout(() => { process.exit(0); }, 1000);
      } catch (err) {
        console.error('Update failed:', err.message);
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
              try { process.kill(parseInt(pid), 'SIGTERM'); } catch(e) {}
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
      if (fs.existsSync(openclawMjs)) {
        const child = spawn(nodeBin, [openclawMjs, 'gateway', 'run', '--allow-unconfigured', '--force', '--port', '18789'], {
          cwd: coreDir,
          env: { ...process.env, OPENCLAW_HOME: path.join(__dirname, '../data'), OPENCLAW_STATE_DIR: OPENCLAW_DIR, OPENCLAW_CONFIG_PATH: CONFIG_PATH },
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
    }, 2000);
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
          const r = await fetch('https://api.telegram.org/bot'+config.token+'/getMe');
          const j = await r.json();
          if (j.ok) result = {ok:true, info:'@'+j.result.username};
          else result = {error:j.description||'Telegram API error'};
        } else if (type === 'discord' && config.token) {
          const r = await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bot '+config.token}});
          if (r.ok) {const j=await r.json();result={ok:true,info:'@'+(j.username||'bot')};}
          else {const t=await r.text();result={error:t.slice(0,120)};}
        } else if (type === 'slack' && config.token) {
          const r = await fetch('https://slack.com/api/auth.test',{headers:{Authorization:'Bearer '+config.token}});
          const j = await r.json();
          if (j.ok) result = {ok:true,info:'@'+(j.user||'bot')};
          else result = {error:j.error||'Slack auth failed'};
        } else if (type === 'feishu' && config.appId && config.appSecret) {
          const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({app_id: config.appId, app_secret: config.appSecret})
          });
          const j = await r.json();
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
    const tailLog = (logPath, lines) => {
      if (!fs.existsSync(logPath)) return [];
      try {
        const content = fs.readFileSync(logPath, 'utf8');
        const all = content.split('\n').filter(Boolean);
        return lines ? all.slice(-lines) : all.slice(-100);
      } catch(e) { return []; }
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
      existing.configServerUpdatedAt = new Date().toISOString();
      fs.writeFileSync(RUNTIME_PATH, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.warn(`   Warning: could not write ${RUNTIME_PATH}: ${err.message}`);
    }
  });
}

listenWithFallback(PORT_RANGE_START);
