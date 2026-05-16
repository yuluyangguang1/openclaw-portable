# OpenClaw Desktop

Electron shell around the existing `config-server` and `openclaw.mjs`
gateway. The web UI (`config-server/public/index.html`) is loaded
unmodified inside a `BrowserWindow` so all 28 model providers, 12
channels, skills list, update flow and key-test endpoints work
exactly the same as in portable mode.

## Architecture

```
Electron main process (main.js)
├── fork()  → config-server/server.js     (HTTP API on :18788+)
├── spawn() → app/core/.../openclaw.mjs   (Gateway on :18789+)
└── BrowserWindow loadURL http://127.0.0.1:18788/
```

User data lives under Electron's `app.getPath('userData')`:

| OS       | Path                                            |
|----------|-------------------------------------------------|
| macOS    | `~/Library/Application Support/OpenClaw`        |
| Windows  | `%APPDATA%\OpenClaw`                            |
| Linux    | `~/.config/OpenClaw`                            |

The `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` env
vars are passed to both child processes so the existing portable code
treats this directory exactly like the launcher's `data/` folder.

## Develop

```bash
# from repo root
cd app/core && npm install --omit=dev   # one-time: install OpenClaw
cd ../../desktop
npm install
npm start                                # launches Electron in dev mode
```

DevTools open with `Cmd/Ctrl+Option+I`.

## Build installers

```bash
# from desktop/
npm run build:mac      # → dist/OpenClaw-0.7.0-arm64.dmg, OpenClaw-0.7.0.dmg
npm run build:win      # → dist/OpenClaw Setup 0.7.0.exe
npm run build:linux    # → dist/OpenClaw-0.7.0.AppImage, .deb
```

CI (`.github/workflows/desktop.yml`) builds + publishes to GitHub
Releases on every `v*` tag, alongside the existing `OpenClawPortable.zip`.

## Auto-update

`electron-updater` checks GitHub Releases on launch (production only,
skipped in dev). When a newer `v*` tag exists, it downloads the
`-mac.zip` / `.exe` / `.AppImage` for the current platform and
prompts the user.

## Why not …

- **Tauri**: Linux WebKitGTK doesn't render `mix-blend-mode: plus-lighter`
  + `oklch()` correctly, both used by our HermesAgent-style UI.
- **Wails / Neutralino**: same WebView issue.
- **Native (SwiftUI / WPF / GTK)**: 4-6 months of work to rewrite the
  28-provider config flow three times. No.
