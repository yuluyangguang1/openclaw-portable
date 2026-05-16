// OpenClaw Desktop — Electron main process.
//
// Architecture: this is a thin shell around the existing portable
// config-server. We fork the same `config-server/server.js` that the
// portable launchers use, spawn `openclaw.mjs gateway run` exactly the
// way Mac-Start.command does, then point a BrowserWindow at the
// config-server's HTTP UI. All the existing config-center HTML/JS
// runs unmodified inside Electron.
//
// Two child processes:
//   - configServer  (Node child)  fork()  port 18788+
//   - gateway       (Node child)  spawn() port 18789+
//
// Both are killed on app quit. No data lives in the Electron app
// itself — everything goes through the config-server's existing
// REST API (which writes to ~/.openclaw/openclaw.json or the
// USB-side data directory, whichever the launcher would have used).

const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain } = require('electron');
const { fork, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── Paths ───────────────────────────────────────────────────────────
// In dev: __dirname = .../desktop. In production: process.resourcesPath
// holds the extraResources copied by electron-builder.
const isDev = !app.isPackaged;
const rootDir = isDev
  ? path.join(__dirname, '..')
  : process.resourcesPath;
const SERVER_PATH = path.join(rootDir, 'config-server', 'server.js');
const GATEWAY_MJS = path.join(rootDir, 'app', 'core', 'node_modules', 'openclaw', 'openclaw.mjs');
const CORE_DIR = path.join(rootDir, 'app', 'core');

// User data lives in Electron's userData (~/Library/Application Support/OpenClaw on macOS,
// %APPDATA%/OpenClaw on Windows, ~/.config/OpenClaw on Linux). We tell the
// portable code to use this directory via the same env vars the launcher sets.
const USER_DATA = app.getPath('userData');
const STATE_DIR = path.join(USER_DATA, '.openclaw');
const CONFIG_FILE = path.join(STATE_DIR, 'openclaw.json');

let configServerProc = null;
let gatewayProc = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let configServerPort = 18788;
let gatewayPort = 18789;

// ── Single instance lock ────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Filesystem prep ─────────────────────────────────────────────────
function ensureUserData() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ gateway: { mode: 'local', auth: { mode: 'token', token: 'openclaw' } } }, null, 2)
    );
  }
}

// ── Wait for HTTP port to come up ───────────────────────────────────
function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/heartbeat', timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error(`Port ${port} not ready in ${timeoutMs}ms`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

// ── Start config-server (the same Node script the portable launchers use) ──
function startConfigServer() {
  if (!fs.existsSync(SERVER_PATH)) {
    dialog.showErrorBox('OpenClaw', `config-server not found at ${SERVER_PATH}`);
    app.quit();
    return;
  }
  configServerProc = fork(SERVER_PATH, [], {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      OPENCLAW_HOME: USER_DATA,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_CONFIG_PATH: CONFIG_FILE,
      OPENCLAW_DISABLE_BONJOUR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  configServerProc.stdout?.on('data', (d) => console.log('[config-server]', d.toString().trimEnd()));
  configServerProc.stderr?.on('data', (d) => console.error('[config-server]', d.toString().trimEnd()));
  configServerProc.on('exit', (code) => {
    console.log(`[config-server] exited with code ${code}`);
    configServerProc = null;
    if (!isQuitting && mainWindow) {
      // Server crashed mid-session: warn user and offer to restart
      dialog.showErrorBox('OpenClaw', 'Config server crashed unexpectedly. Restart the app.');
    }
  });
}

// ── Start OpenClaw gateway (only if it's installed) ─────────────────
function startGateway() {
  if (!fs.existsSync(GATEWAY_MJS)) {
    console.warn('[gateway] openclaw.mjs not found — skipping. Users can install via setup.sh.');
    return;
  }
  gatewayProc = spawn(
    process.execPath, // Electron itself includes a Node interpreter; works in dev. In prod use bundled node.
    [GATEWAY_MJS, 'gateway', 'run', '--allow-unconfigured', '--force', '--port', String(gatewayPort)],
    {
      cwd: CORE_DIR,
      env: {
        ...process.env,
        OPENCLAW_HOME: USER_DATA,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_CONFIG_PATH: CONFIG_FILE,
        OPENCLAW_DISABLE_BONJOUR: '1',
        ELECTRON_RUN_AS_NODE: '1', // tell Electron to behave like plain node
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  gatewayProc.stdout?.on('data', (d) => console.log('[gateway]', d.toString().trimEnd()));
  gatewayProc.stderr?.on('data', (d) => console.error('[gateway]', d.toString().trimEnd()));
  gatewayProc.on('exit', (code) => {
    console.log(`[gateway] exited with code ${code}`);
    gatewayProc = null;
  });
}

// ── Main window ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#041c1c',
    title: 'OpenClaw',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${configServerPort}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links open in the system browser, not in another Electron window
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Tray ────────────────────────────────────────────────────────────
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'build', 'tray.png');
    if (!fs.existsSync(iconPath)) return; // skip if icon not provided yet
    tray = new Tray(iconPath);
    tray.setToolTip('OpenClaw');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
  } catch (e) {
    console.warn('Tray init failed:', e.message);
  }
}

// ── App menu ────────────────────────────────────────────────────────
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'OpenClaw',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit OpenClaw', accelerator: 'Cmd+Q', click: () => { isQuitting = true; app.quit(); } },
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Config Folder', click: () => shell.openPath(STATE_DIR) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'GitHub Repository', click: () => shell.openExternal('https://github.com/yuluyangguang1/openclaw-portable') },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/yuluyangguang1/openclaw-portable/issues') },
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Boot sequence ───────────────────────────────────────────────────
app.whenReady().then(async () => {
  ensureUserData();
  buildAppMenu();
  startConfigServer();

  try {
    await waitForPort(configServerPort);
  } catch (err) {
    dialog.showErrorBox('OpenClaw', `Config server did not start within 30s.\n${err.message}\n\nLog output is in the system console.`);
    app.quit();
    return;
  }

  // Read the actual port the server bound to (may have bumped from 18788)
  try {
    const runtimePath = path.join(STATE_DIR, 'runtime.json');
    if (fs.existsSync(runtimePath)) {
      const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      if (rt.configServerPort) configServerPort = rt.configServerPort;
    }
  } catch (_) {}

  createWindow();
  createTray();
  startGateway(); // non-blocking; UI handles "gateway not yet ready"

  // Auto-update (only in production builds)
  if (!isDev) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('Update check failed:', e.message));
    } catch (e) {
      console.warn('electron-updater not available:', e.message);
    }
  }
});

app.on('activate', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (gatewayProc && !gatewayProc.killed) {
    try { gatewayProc.kill(); } catch (_) {}
  }
  if (configServerProc && !configServerProc.killed) {
    try { configServerProc.kill(); } catch (_) {}
  }
});

// Defensive: never crash the main process on an unexpected error.
process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[main] unhandledRejection:', reason));
