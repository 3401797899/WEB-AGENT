# AI Relay

Mobile-friendly web UI for forwarding messages to **Codex CLI** or **Windsurf CLI**, with real-time streaming output via xterm.js.

## Features
- 🔀 Multi-session support – each session is an independent PTY process
- 📱 Mobile-first UI – large touch targets, quick-key bar (Ctrl+C, arrows…)
- 🌊 Streaming output – xterm.js renders ANSI colors & cursor movements
- 📂 Directory browser – pick the working directory before starting
- 🔄 Auto-reconnect – WebSocket reconnects silently after network drops

## Requirements
- Node.js 18+
- `codex` and/or `windsurf` CLI installed and on `$PATH`
  - Codex: `npm install -g @openai/codex`
  - Windsurf: install from https://codeium.com/windsurf

## Quick Start

### 1. Install dependencies
```bash
npm run install:all
```

### 2. Start backend
```bash
npm run dev:backend
# Runs on http://localhost:3001
```

### 3. Start frontend (dev)
```bash
npm run dev:frontend
# Runs on http://localhost:5173
```

Open `http://<your-local-ip>:5173` on your phone (same network).

## Production (serve frontend from backend)
```bash
npm run build        # builds frontend → frontend/dist/
npm start            # backend serves frontend at http://0.0.0.0:3001
```

## Configuration

Override provider commands via environment variables:

| Variable        | Default    | Example                        |
|-----------------|------------|--------------------------------|
| `CODEX_CMD`     | `codex`    | `/usr/local/bin/codex`        |
| `CODEX_ARGS`    | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox danger-full-access` |
| `WINDSURF_CMD`  | `windsurf` | `/Applications/Windsurf.app/Contents/MacOS/windsurf` |
| `WINDSURF_ARGS` | *(empty)*  | `--cli`                       |
| `PORT`          | `3001`     | `8080`                        |

Example:
```bash
CODEX_ARGS="--sandbox danger-full-access" npm run dev:backend
```

By default Codex sessions are started without sandboxing or approval prompts so
the web UI can operate with full local permissions. To use a safer mode, override
`CODEX_ARGS` or edit Provider Settings in the UI.
