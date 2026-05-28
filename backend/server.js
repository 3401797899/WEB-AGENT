const express = require('express');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./sessions');
const windsurf = require('./windsurfClient');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(helmet({
  contentSecurityPolicy: false, // CSP is complex for SPAs; configure separately if needed
}));
app.use(express.json({ limit: '2mb' }));

// ─── Authentication ───────────────────────────────────────────────────────
// When AUTH_TOKEN is set, all HTTP requests must include
// `Authorization: Bearer <token>` and WebSocket upgrades must pass
// `?token=<token>`. This prevents unauthorized network access.
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

function checkHttpAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization || '';
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function checkWsAuth(req) {
  if (!AUTH_TOKEN) return true;
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') === AUTH_TOKEN;
}

// Upload directory for attachments
const UPLOAD_DIR = path.join(os.homedir(), '.ai-relay', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// CORS – restrict to known origins in production.
// Set ALLOWED_ORIGINS env var to a comma-separated list (e.g. "http://localhost:5173,https://myapp.example.com").
// Falls back to permissive mode only during development when unset.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : null;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
  } else {
    // Dev fallback – allow any origin
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve uploaded files (auth-gated)
app.use('/uploads', checkHttpAuth, express.static(UPLOAD_DIR));

// Active runs: sessionId → { proc, clients: Set<ws>, buffer: events[] }
const activeRuns = new Map();

// Provider configurations
const PROVIDERS = {
  codex: {
    type: 'codex-exec',
    command: process.env.CODEX_CMD || 'codex',
    args: process.env.CODEX_ARGS || '--dangerously-bypass-approvals-and-sandbox',
  },
  windsurf: {
    type: 'cascade-ls', // talks to running Windsurf IDE's language server
    args: process.env.WINDSURF_ARGS || '',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function broadcast(sessionId, message) {
  const run = activeRuns.get(sessionId);
  if (!run) return;
  const json = JSON.stringify(message);
  // Buffer streamable events so late-joining / reconnecting clients can catch up
  if (message.type === 'event' || message.type === 'stderr') {
    if (!run.buffer) run.buffer = [];
    run.buffer.push(json);
    if (run.buffer.length > 2000) run.buffer.shift();
  }
  for (const c of run.clients) if (c.readyState === 1) c.send(json);
}

function broadcastAll(message) {
  const json = JSON.stringify(message);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(json); });
}

// Resolve a command, following symlinks; if it's a .js file, return [node, file]
function resolveExecutable(cmd) {
  try {
    let realCmd = cmd;
    if (path.isAbsolute(cmd)) realCmd = fs.realpathSync(cmd);
    if (realCmd.endsWith('.js')) {
      return { cmd: process.execPath, prefixArgs: [realCmd] };
    }
  } catch (_) {}
  return { cmd, prefixArgs: [] };
}

// Build PATH that includes the dir of node (so #!/usr/bin/env node works in spawned shells)
function enrichedEnv() {
  const nodeBin = path.dirname(process.execPath);
  return {
    ...process.env,
    PATH: [nodeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    NO_COLOR: '1', // we don't want ANSI in JSON events
  };
}

function splitArgs(value) {
  if (!value || !String(value).trim()) return [];

  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const ch of String(value)) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}

// ─── Run a chat turn (codex exec) ─────────────────────────────────────────

function runCodexTurn(session, userMessage, ws, attachments = []) {
  const config = PROVIDERS[session.provider];
  if (!config) {
    ws.send(JSON.stringify({ type: 'error', message: `Unknown provider: ${session.provider}` }));
    return;
  }

  // Build args for codex exec.
  // `--cd` / `--sandbox` are only valid at the parent `exec` level.
  // Model overrides for resumed conversations must be passed to `resume`,
  // otherwise Codex keeps using the model from the existing thread.
  // We pass `-` so prompt is read from stdin (avoids quoting issues with long messages).
  const modelArgs = session.modelUid ? ['--model', session.modelUid] : [];
  const effortArgs = session.reasoningEffort ? ['-c', `reasoning_effort="${session.reasoningEffort}"`] : [];
  const providerArgs = splitArgs(config.args);
  let baseArgs;
  if (session.threadId) {
    baseArgs = ['exec', ...providerArgs, '--cd', session.cwd, 'resume',
                ...modelArgs, ...effortArgs, '--json', '--skip-git-repo-check',
                session.threadId, '-'];
  } else {
    baseArgs = ['exec', ...modelArgs, ...effortArgs, ...providerArgs,
                '--json', '--skip-git-repo-check', '--cd', session.cwd, '-'];
  }

  const { cmd, prefixArgs } = resolveExecutable(config.command);
  const allArgs = [...prefixArgs, ...baseArgs];

  console.log(`[run] ${session.id.slice(0, 8)} ${cmd} ${allArgs.join(' ')}`);

  let proc;
  try {
    proc = spawn(cmd, allArgs, {
      cwd: session.cwd,
      env: enrichedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn ${cmd}: ${e.message}` }));
    return;
  }

  // Build message with attachment references for the AI
  let aiMessage = userMessage;
  if (attachments.length > 0) {
    const refs = attachments.map(a => `[附件: ${a.path} (${a.name}, ${a.type})]`).join('\n');
    aiMessage = `${userMessage}\n\n${refs}`;
  }

  proc.stdin.write(aiMessage);
  proc.stdin.end();

  const run = activeRuns.get(session.id) || { clients: new Set(), buffer: [] };
  run.proc = proc;
  run.buffer = []; // reset buffer for new turn
  run.clients.add(ws);
  activeRuns.set(session.id, run);

  // Persist user message (with attachment metadata for UI display)
  const attachMeta = attachments.map(a => ({ name: a.name, url: a.url, type: a.type, size: a.size }));
  store.appendMessage(session.id, { role: 'user', content: userMessage, ...(attachMeta.length ? { attachments: attachMeta } : {}) });
  broadcastAll({ type: 'session_updated', session: store.get(session.id) });

  // Track final assistant content + items for the turn
  let assistantText = '';
  const items = []; // { type, summary, raw }

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // keep partial

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); }
      catch {
        // Not JSON – pass through as a generic chunk
        broadcast(session.id, { type: 'chunk', sessionId: session.id, data: line });
        continue;
      }

      // Capture thread_id on the first turn
      if (evt.type === 'thread.started' && evt.thread_id && !session.threadId) {
        store.update(session.id, { threadId: evt.thread_id });
      }

      // Forward the event to client(s)
      broadcast(session.id, { type: 'event', sessionId: session.id, event: evt });

      // Aggregate the assistant's final message text
      if (evt.type === 'item.completed' && evt.item) {
        const item = evt.item;
        if (item.type === 'agent_message' && item.text) {
          assistantText = item.text; // final agent message
        } else {
          items.push(item);
        }
      }
    }
  });

  let stderrText = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrText += text;
    broadcast(session.id, { type: 'stderr', sessionId: session.id, data: text });
  });

  proc.on('error', (err) => {
    broadcast(session.id, { type: 'error', message: `spawn error: ${err.message}` });
  });

  proc.on('close', (code) => {
    if (code === 0 && assistantText) {
      store.appendMessage(session.id, {
        role: 'assistant',
        content: assistantText,
        items,
      });
    } else if (code !== 0) {
      const errMsg = stderrText.trim() || `Process exited with code ${code}`;
      store.appendMessage(session.id, {
        role: 'assistant',
        content: '',
        error: errMsg,
        items,
      });
    }
    broadcast(session.id, {
      type: 'turn_done',
      sessionId: session.id,
      exitCode: code,
    });
    broadcastAll({ type: 'session_updated', session: store.get(session.id) });
    const r = activeRuns.get(session.id);
    if (r) r.proc = null;
  });
}

// Sessions confirmed idle recently: sessionId → timestamp. Skip re-checking within 30s.
const recentlyIdle = new Map();
const IDLE_CACHE_TTL = 30_000;

// ─── Catch-up poll for externally-running Windsurf cascades ──────────────
// Called when load_session finds a Windsurf session with threadId but no active run.
// Checks if the cascade is still RUNNING and, if so, starts a live polling loop.
async function startCatchUpPoll(session) {
  try {
    const servers = await windsurf.detectLanguageServersWithPath();
    if (!servers.length) return;
    const server =
      servers.find((s) => s.workspacePath && session.cwd.startsWith(s.workspacePath)) ||
      servers[0];

    const cascadeId = session.threadId;

    // Skip if we recently confirmed this session was idle
    const lastIdle = recentlyIdle.get(session.id);
    if (lastIdle && Date.now() - lastIdle < IDLE_CACHE_TTL) return;

    const status = await windsurf.getTrajectoryStatus(server, cascadeId);
    const isRunning = String(status?.status || '').includes('RUNNING');
    if (!isRunning) {
      recentlyIdle.set(session.id, Date.now());
      return;
    }

    // Claim the run slot
    const run = activeRuns.get(session.id);
    if (!run || run.cascadeId) return; // another turn already claimed it
    run.cascadeId = cascadeId;
    run.buffer = [];
    run.cancelled = false;
    run.serverInfo = server;

    broadcast(session.id, { type: 'turn_running', sessionId: session.id });

    // Start slightly behind current tip so we catch in-progress steps
    const startOffset = Math.max(0, (status.numTotalSteps || 0) - 20);
    let nextFetchFrom = startOffset;
    let highWaterMark = startOffset;
    const seenDoneIdx = new Set();
    let lastAssistantText = '';
    const items = [];

    const maxIterations = 600;
    for (let i = 0; i < maxIterations; i++) {
      if (run.cancelled || run.cascadeId !== cascadeId) break;
      await new Promise((r) => setTimeout(r, 700));

      let steps;
      try { steps = await windsurf.getTrajectorySteps(server, cascadeId, nextFetchFrom); }
      catch { continue; }

      let firstStillRunning = -1;
      for (let si = 0; si < steps.length; si++) {
        const st = steps[si];
        const absIdx = nextFetchFrom + si;
        highWaterMark = Math.max(highWaterMark, absIdx + 1);

        // Handle requestedInteraction (same as in runWindsurfTurn)
        if (st.requestedInteraction && st.status !== 'CORTEX_STEP_STATUS_DONE') {
          const ri = st.requestedInteraction;
          const intId = ri?.interactionId || ri?.id || absIdx;
          if (!seenDoneIdx.has(`approve:${intId}`)) {
            seenDoneIdx.add(`approve:${intId}`);
            // The empty `requestedInteraction.askUserQuestion` lacks trajectoryId/stepIndex;
            // pull them from the step's toolCall metadata so the answer handler can
            // correctly target this step on HandleCascadeUserInteraction.
            const sti = st.metadata?.sourceTrajectoryStepInfo
                     || st.metadata?.source_trajectory_step_info
                     || st.metadata?.toolCall?.sourceTrajectoryStepInfo
                     || {};
            run.pendingInteraction = {
              ...ri,
              trajectoryId: ri.trajectoryId || ri.trajectory_id || sti.trajectoryId || sti.trajectory_id,
              stepIndex: ri.stepIndex ?? ri.step_index ?? sti.stepIndex ?? sti.step_index ?? absIdx,
            };
            // askUserQuestion data lives on the step (sibling of requestedInteraction),
            // not nested inside requestedInteraction (which only carries an empty marker).
            const askQ = st.askUserQuestion || st.ask_user_question
                      || ri.askUserQuestion || ri.ask_user_question;
            if (askQ && (askQ.request || askQ.question)) {
              const qData = askQ.request || askQ;
              const payload = {
                type: 'user_question_asked',
                sessionId: session.id,
                interactionId: String(intId),
                question: qData.question || '',
                options: (qData.options || []).map(o => ({ label: o.label || '', description: o.description || '' })),
                allowMultiple: !!qData.allowMultiple,
                cascadeId,
              };
              console.log(`[windsurf][catchup] broadcasting user_question_asked:`, JSON.stringify(payload).slice(0, 800));
              run.lastPendingPayload = payload;
              broadcast(session.id, payload);
            } else {
              const rc = ri.runCommand || ri.run_command || {};
              const cmdLine = rc.proposedCommandLine || rc.proposed_command_line
                           || rc.commandLine || rc.command_line || rc.command || '';
              const CMD_MAX_LEN = 500;
              if (cmdLine.length > CMD_MAX_LEN) {
                console.log(`[windsurf][catchup] auto-rejecting command (${cmdLine.length} chars): ${cmdLine.slice(0, 80)}...`);
                windsurf.cancelCascadeSteps(run.serverInfo, cascadeId, [absIdx])
                  .then(() => {
                    broadcast(session.id, { type: 'command_done', sessionId: session.id });
                    const hint = `上一条命令被自动拒绝：命令行长度 ${cmdLine.length} 字符，超过终端安全限制（${CMD_MAX_LEN}）。请将代码写入临时文件再执行。继续完成任务。`;
                    windsurf.sendMessage(run.serverInfo, cascadeId, hint, session.modelUid || 'claude-sonnet-4-6-thinking').catch(() => {});
                  })
                  .catch(() => {
                    broadcast(session.id, { type: 'command_approval_needed', sessionId: session.id, interactionId: String(intId), commandLine: cmdLine, cascadeId });
                  });
              } else {
                broadcast(session.id, {
                  type: 'command_approval_needed',
                  sessionId: session.id,
                  interactionId: String(intId),
                  commandLine: cmdLine,
                  cascadeId,
                });
              }
            }
          }
        }

        const ev = windsurf.translateStep(st);
        if (!ev) {
          if (st.status !== 'CORTEX_STEP_STATUS_DONE' && firstStillRunning < 0)
            firstStillRunning = absIdx;
          continue;
        }

        if (ev.kind === 'assistant_message') {
          lastAssistantText = ev.text;
          broadcast(session.id, { type: 'event', sessionId: session.id, event: { type: 'cascade.step', step: ev } });
          if (st.status !== 'CORTEX_STEP_STATUS_DONE' && firstStillRunning < 0)
            firstStillRunning = absIdx;
        } else if ((ev.kind === 'tool' || ev.kind === 'error') && st.status === 'CORTEX_STEP_STATUS_DONE' && !seenDoneIdx.has(absIdx)) {
          seenDoneIdx.add(absIdx);
          if (ev.kind === 'error') {
            items.push({ type: 'error', summary: ev.text || '', text: ev.text });
          } else {
            items.push({ type: ev.tool, summary: ev.summary });
          }
          broadcast(session.id, { type: 'event', sessionId: session.id, event: { type: 'cascade.step', step: ev } });
        }
      }

      if (firstStillRunning >= 0) {
        nextFetchFrom = firstStillRunning;
      } else {
        nextFetchFrom = highWaterMark;
        // All fetched steps are DONE — check if trajectory itself finished
        try {
          const cur = await windsurf.getTrajectoryStatus(server, cascadeId);
          if (!String(cur?.status || '').includes('RUNNING')) {
            // Save response if not already persisted
            if (lastAssistantText) {
              const s = store.get(session.id);
              const last = s?.messages?.[s.messages.length - 1];
              if (!last || last.role !== 'assistant' || last.content !== lastAssistantText) {
                store.appendMessage(session.id, { role: 'assistant', content: lastAssistantText, items });
                broadcastAll({ type: 'session_updated', session: store.get(session.id) });
              }
            }
            break;
          }
        } catch { break; }
      }
    }

    broadcast(session.id, { type: 'turn_done', sessionId: session.id, exitCode: 0 });
    recentlyIdle.set(session.id, Date.now());
  } catch (e) {
    console.error('[catch-up poll] error:', e.message);
  } finally {
    const run = activeRuns.get(session.id);
    if (run) { run.cascadeId = null; run.cancelled = false; }
  }
}

// ─── Run a chat turn (Windsurf Cascade LS) ────────────────────────────────

async function runWindsurfTurn(session, userMessage, ws, attachments = []) {
  // Pick the language server matching the session's cwd if possible
  const servers = await windsurf.detectLanguageServersWithPath();
  if (!servers.length) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'No running Windsurf language server detected. Open the workspace in Windsurf IDE first.',
    }));
    return;
  }
  // Prefer one whose workspacePath matches session.cwd
  let server = servers.find((s) => s.workspacePath && session.cwd.startsWith(s.workspacePath));
  if (!server) server = servers[0];

  console.log(`[windsurf] ${session.id.slice(0, 8)} server=${server.port} workspace=${server.workspacePath || '?'}`);

  const run = activeRuns.get(session.id) || { clients: new Set() };
  run.clients.add(ws);
  run.buffer = []; // reset buffer for new turn
  run.cancelled = false;
  run.serverInfo = server;
  activeRuns.set(session.id, run);

  let cascadeId = session.threadId;
  try {
    if (!cascadeId) {
      cascadeId = await windsurf.startCascade(server);
      store.update(session.id, { threadId: cascadeId });
      console.log(`[windsurf] new cascade ${cascadeId.slice(0, 8)}`);
    }
    run.cascadeId = cascadeId;

    // Determine step offset to start polling from (so resumed sessions don't re-replay)
    const initialStatus = await windsurf.getTrajectoryStatus(server, cascadeId);

    // If cascade is already running (e.g. backend restarted mid-turn), reattach instead of sending
    if (String(initialStatus.status || '').includes('RUNNING')) {
      console.log(`[windsurf] cascade already RUNNING — reattaching catch-up poll`);
      broadcast(session.id, { type: 'turn_running', sessionId: session.id });
      ws.send(JSON.stringify({ type: 'error', message: 'Cascade is already running — reconnecting to existing turn.' }));
      // Delegate to the catch-up poller which handles in-progress cascades
      startCatchUpPoll(session).catch(() => {});
      return;
    }

    const messageStartOffset = initialStatus.numTotalSteps || 0;

    // Persist user message (with attachment metadata for UI display)
    const attachMeta = attachments.map(a => ({ name: a.name, url: a.url, type: a.type, size: a.size }));
    store.appendMessage(session.id, { role: 'user', content: userMessage, ...(attachMeta.length ? { attachments: attachMeta } : {}) });
    broadcastAll({ type: 'session_updated', session: store.get(session.id) });

    const modelUid = session.modelUid || 'claude-sonnet-4-6-thinking';
    let messageToSend = userMessage;
    // Append file references so the AI knows about attached files
    if (attachments.length > 0) {
      const refs = attachments.map(a => `[附件: ${a.path} (${a.name}, ${a.type})]`).join('\n');
      messageToSend = `${userMessage}\n\n${refs}`;
    }

    // On the first message of a new cascade, inject context + rules as a clean block
    // (Windsurf LS has no API-level CWD override, so we embed it in the message)
    if (messageStartOffset === 0) {
      const ctx = [];
      const serverWorkspace = server.workspacePath || '';
      if (session.cwd && session.cwd !== serverWorkspace) {
        ctx.push(`工作目录: ${session.cwd}（所有文件操作和命令执行都必须在此目录下进行）`);
      }
      ctx.push('执行规则: (1) 超过200字符的代码必须写入临时文件执行，禁止node -e/python -c传超长代码 (2) 禁止打开vim/nano/less等交互式程序，git加--no-edit --no-pager');
      messageToSend = `[${ctx.join(' | ')}]\n\n${userMessage}`;
    }
    await windsurf.sendMessage(server, cascadeId, messageToSend, modelUid);

    broadcast(session.id, { type: 'event', sessionId: session.id, event: { type: 'cascade.started', cascadeId } });

    // Quick check: if any of the early steps is a quota / rate-limit /
    // internal error, clear API key cache and retry once (handles IDE
    // auto-account-switching mid-session via account-pool tools). Errors
    // typically appear at step 2-3, after system/user_input prefix steps,
    // so we scan all early steps rather than just the first.
    await new Promise((r) => setTimeout(r, 2500));
    const earlySteps = await windsurf.getTrajectorySteps(server, cascadeId, messageStartOffset).catch(() => []);
    const errEv = earlySteps
      .map((s) => windsurf.translateStep(s))
      .find((ev) => ev?.kind === 'error' &&
        /quota|exhausted|rate limit|internal error/i.test(ev.text || ''));
    if (errEv) {
      console.log(`[windsurf] account-level error ("${(errEv.text||'').slice(0,80)}"), clearing API key cache and retrying`);
      windsurf.clearApiKeyCache();
      // Start a fresh cascade with the (hopefully) new account key
      const newCid = await windsurf.startCascade(server);
      run.cascadeId = newCid;
      cascadeId = newCid;
      await windsurf.sendMessage(server, cascadeId, messageToSend, modelUid);
      broadcast(session.id, { type: 'event', sessionId: session.id, event: { type: 'cascade.started', cascadeId } });
    }

    console.log(`[windsurf] ${session.id.slice(0, 8)} message sent, polling from offset=${messageStartOffset}`);

    // Poll for steps until status is IDLE again.
    // IMPORTANT: Cascade streams a step's text/output while status=RUNNING and
    // updates the step in place. Only advance our "read pointer" past steps
    // that have status=DONE; keep re-fetching RUNNING steps so we don't lock
    // in partial text.
    let lastAssistantText = '';
    const items = [];
    const seenDoneIdx = new Set();
    let nextFetchFrom = messageStartOffset; // re-fetch from here each poll
    let highWaterMark = messageStartOffset;
    const maxIterations = 1800; // ~6 minutes at 200ms
    // cmdOutputLen: stepIndex → bytes already broadcast (for incremental streaming)
    const cmdOutputLen = {};
    let hasRunningCmd = false; // whether a command step is actively executing
    let consecutiveIdle = 0; // safety: break if IDLE for many consecutive polls
    for (let i = 0; i < maxIterations; i++) {
      if (run.cancelled) break;
      await new Promise((r) => setTimeout(r, hasRunningCmd ? 200 : 700));

      let steps;
      try {
        steps = await windsurf.getTrajectorySteps(server, cascadeId, nextFetchFrom);
      } catch (e) {
        broadcast(session.id, { type: 'stderr', sessionId: session.id, data: `[poll] ${e.message}\n` });
        continue;
      }
      if (steps.length) {
        let firstStillRunning = -1;
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const absIdx = nextFetchFrom + si;
          highWaterMark = Math.max(highWaterMark, absIdx + 1);

          // Handle requestedInteraction (e.g. command needs manual approval in IDE)
          if (st.requestedInteraction && st.status !== 'CORTEX_STEP_STATUS_DONE') {
            const ri = st.requestedInteraction;
            const intId = ri?.interactionId || ri?.id || absIdx;
            if (!seenDoneIdx.has(`approve:${intId}`)) {
              seenDoneIdx.add(`approve:${intId}`);
              console.log(`[windsurf] requestedInteraction at step ${absIdx}:`, JSON.stringify(ri).slice(0, 2000));
              const sti = st.metadata?.sourceTrajectoryStepInfo
                       || st.metadata?.source_trajectory_step_info
                       || st.metadata?.toolCall?.sourceTrajectoryStepInfo
                       || {};
              run.pendingInteraction = {
                ...ri,
                trajectoryId: ri.trajectoryId || ri.trajectory_id || sti.trajectoryId || sti.trajectory_id,
                stepIndex: ri.stepIndex ?? ri.step_index ?? sti.stepIndex ?? sti.step_index ?? absIdx,
              };
              // askUserQuestion data lives on the step (sibling of requestedInteraction),
              // not nested inside requestedInteraction (which only carries an empty marker).
              const askQ = st.askUserQuestion || st.ask_user_question
                        || ri.askUserQuestion || ri.ask_user_question;
              if (askQ && (askQ.request || askQ.question)) {
                const qData = askQ.request || askQ;
                const payload = {
                  type: 'user_question_asked',
                  sessionId: session.id,
                  interactionId: String(intId),
                  question: qData.question || '',
                  options: (qData.options || []).map(o => ({ label: o.label || '', description: o.description || '' })),
                  allowMultiple: !!qData.allowMultiple,
                  cascadeId,
                };
                run.lastPendingPayload = payload;
                broadcast(session.id, payload);
              } else {
                const rc = ri.runCommand || ri.run_command || {};
                const cmdLine = rc.proposedCommandLine || rc.proposed_command_line
                             || rc.commandLine || rc.command_line
                             || rc.command || '';
                const CMD_MAX_LEN = 500;
                if (cmdLine.length > CMD_MAX_LEN) {
                  console.log(`[windsurf] auto-rejecting command (${cmdLine.length} chars > ${CMD_MAX_LEN}): ${cmdLine.slice(0, 80)}...`);
                  windsurf.cancelCascadeSteps(run.serverInfo, cascadeId, [absIdx])
                    .then(() => {
                      broadcast(session.id, { type: 'command_done', sessionId: session.id });
                      const hint = `上一条命令被自动拒绝：命令行长度 ${cmdLine.length} 字符，超过终端安全限制（${CMD_MAX_LEN}）。请将代码写入临时文件（如 /tmp/script.js）再执行，不要使用 node -e / python -c 传递超长inline代码。继续完成任务。`;
                      windsurf.sendMessage(run.serverInfo, cascadeId, hint, session.modelUid || 'claude-sonnet-4-6-thinking')
                        .then(() => console.log(`[windsurf] sent rewrite hint after auto-reject`))
                        .catch((e2) => console.warn(`[windsurf] failed to send rewrite hint: ${e2.message}`));
                    })
                    .catch((e) => {
                      console.warn(`[windsurf] auto-reject cancel failed: ${e.message}`);
                      broadcast(session.id, {
                        type: 'command_approval_needed',
                        sessionId: session.id,
                        interactionId: String(intId),
                        commandLine: cmdLine,
                        cascadeId,
                      });
                    });
                } else {
                  broadcast(session.id, {
                    type: 'command_approval_needed',
                    sessionId: session.id,
                    interactionId: String(intId),
                    commandLine: cmdLine,
                    cascadeId,
                  });
                }
              }
            }
          }

          const ev = windsurf.translateStep(st);
          if (!ev) {
            if (st.status !== 'CORTEX_STEP_STATUS_DONE' && firstStillRunning < 0) {
              firstStillRunning = absIdx;
            }
            continue;
          }
          if (ev.kind === 'user_input') {
            // user input comes through as DONE immediately; skip echoing
          } else if (ev.kind === 'assistant_message') {
            // Always update with latest version (handles streaming updates)
            lastAssistantText = ev.text;
            broadcast(session.id, {
              type: 'event',
              sessionId: session.id,
              event: { type: 'cascade.step', step: ev },
            });
          } else {
            // Stream partial output for running runCommand steps
            if (ev.tool === 'run_command' && st.status !== 'CORTEX_STEP_STATUS_DONE') {
              const rawPayload = st.runCommand || st.run_command || {};
              const full = rawPayload.combinedOutput?.full || rawPayload.output || '';
              const known = cmdOutputLen[absIdx] || 0;
              if (full.length > known) {
                cmdOutputLen[absIdx] = full.length;
                broadcast(session.id, {
                  type: 'command_output',
                  sessionId: session.id,
                  stepIndex: absIdx,
                  delta: full.slice(known),
                  full,
                });
              }
              hasRunningCmd = true;
            }
            // Tool items: only commit once DONE so we don't dup
            if (st.status === 'CORTEX_STEP_STATUS_DONE' && !seenDoneIdx.has(absIdx)) {
              if (ev.kind === 'error') {
                items.push({ type: 'error', summary: ev.text || '', text: ev.text, details: ev.details });
              } else {
                items.push({ type: ev.tool || ev.kind, summary: ev.summary, details: ev.details });
              }
              broadcast(session.id, {
                type: 'event',
                sessionId: session.id,
                event: { type: 'cascade.step', step: ev },
              });
            }
          }

          if (st.status === 'CORTEX_STEP_STATUS_DONE') {
            // If this step had a requestedInteraction, it's now resolved — clear banner
            if (st.requestedInteraction && !seenDoneIdx.has(absIdx)) {
              broadcast(session.id, { type: 'command_approved', sessionId: session.id });
            }
            // Clear any running command panel if this was it
            if (run.runningStepIdx === absIdx) {
              run.runningStepIdx = null;
              hasRunningCmd = false;
              broadcast(session.id, { type: 'command_done', sessionId: session.id });
            }
            seenDoneIdx.add(absIdx);
          } else if (firstStillRunning < 0) {
            firstStillRunning = absIdx;
            // Broadcast running command info so frontend can show cancel/input panel
            if (!st.requestedInteraction && ev.kind === 'tool' && run.runningStepIdx !== absIdx) {
              run.runningStepIdx = absIdx;
              const cmdLine = ev.summary || ev.details?.commandLine || ev.details?.command || '';
              broadcast(session.id, {
                type: 'command_running',
                sessionId: session.id,
                stepIndex: absIdx,
                commandLine: cmdLine,
                cascadeId,
              });
            }
          }
        }
        // Next poll re-reads from the first still-running step (if any)
        nextFetchFrom = firstStillRunning >= 0 ? firstStillRunning : highWaterMark;
      }
      const status = await windsurf.getTrajectoryStatus(server, cascadeId);
      const isIdle = String(status?.status || '').includes('IDLE');
      if (isIdle) {
        consecutiveIdle++;
      } else {
        consecutiveIdle = 0;
      }
      // Break if: (a) IDLE and we got at least 1 new step, or (b) IDLE for 5+ consecutive polls (safety)
      if (
        (isIdle && highWaterMark > messageStartOffset) ||
        consecutiveIdle >= 5
      ) {
        if (consecutiveIdle >= 5 && highWaterMark <= messageStartOffset) {
          console.warn(`[windsurf] ${session.id.slice(0, 8)} IDLE for ${consecutiveIdle} polls with no new steps — breaking`);
        }
        // One last fetch from messageStartOffset to make sure we have the
        // latest text for the assistant_message (which may have updated
        // between the previous fetch and IDLE).
        try {
          const finalSteps = await windsurf.getTrajectorySteps(server, cascadeId, messageStartOffset);
          for (const st of finalSteps) {
            const ev = windsurf.translateStep(st);
            if (ev?.kind === 'assistant_message') lastAssistantText = ev.text;
          }
        } catch (_) {}
        break;
      }
    }

    if (run.cancelled) {
      try { await windsurf.cancelCascade(server, cascadeId); } catch (_) {}
      store.appendMessage(session.id, {
        role: 'assistant',
        content: lastAssistantText,
        items,
        error: 'cancelled by user',
      });
    } else if (lastAssistantText || items.length > 0) {
      store.appendMessage(session.id, {
        role: 'assistant',
        content: lastAssistantText,
        items,
      });
    } else {
      const detail = `轮次结束但未收到任何回复 (polled ${highWaterMark - messageStartOffset} steps, ${items.length} items, ${consecutiveIdle} idle polls)`;
      console.warn(`[windsurf] ${session.id.slice(0, 8)} ${detail}`);
      store.appendMessage(session.id, {
        role: 'assistant',
        content: '',
        items,
        error: detail,
      });
    }
    broadcast(session.id, { type: 'turn_done', sessionId: session.id, exitCode: run.cancelled ? 130 : 0 });
    broadcastAll({ type: 'session_updated', session: store.get(session.id) });
  } catch (e) {
    console.error(`[windsurf] error:`, e.message);
    broadcast(session.id, { type: 'error', message: e.message });
    store.appendMessage(session.id, { role: 'assistant', content: '', error: e.message });
    broadcast(session.id, { type: 'turn_done', sessionId: session.id, exitCode: 1 });
    broadcastAll({ type: 'session_updated', session: store.get(session.id) });
  } finally {
    run.cascadeId = null;
    run.cancelled = false;
  }
}

// ─── WebSocket protocol ───────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Authenticate WebSocket connections
  if (!checkWsAuth(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Send list of all sessions (history) on connect
  ws.send(JSON.stringify({ type: 'sessions_list', sessions: store.list() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      switch (msg.type) {
        case 'create_session': {
          // Validate provider name to prevent injection
          const provider = ['codex', 'windsurf'].includes(msg.provider) ? msg.provider : 'codex';
          const requestedCwd = msg.cwd ? path.resolve(msg.cwd) : os.homedir();
          const cwd = fs.existsSync(requestedCwd) ? requestedCwd : os.homedir();
          const s = store.create({
            provider,
            cwd,
            title: msg.title ? String(msg.title).slice(0, 200) : undefined,
          });
          ws.send(JSON.stringify({ type: 'session_created', session: s }));
          broadcastAll({ type: 'sessions_list', sessions: store.list() });
          break;
        }

        case 'load_session': {
          const s = store.get(msg.sessionId);
          if (!s) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            break;
          }
          ws.send(JSON.stringify({ type: 'session_data', session: s }));
          // Subscribe this ws to live updates for the session
          let run = activeRuns.get(s.id);
          if (!run) {
            run = { clients: new Set(), buffer: [], proc: null };
            activeRuns.set(s.id, run);
          }
          run.clients.add(ws);
          // If a run is currently in progress, replay buffered events then notify
          if (run.proc || run.cascadeId) {
            ws.send(JSON.stringify({ type: 'turn_running', sessionId: s.id }));
            for (const buffered of (run.buffer || [])) {
              ws.send(buffered);
            }
            // Re-send any pending user-facing interaction (e.g. askUserQuestion)
            // so that a reconnected client sees the waiting banner again.
            if (run.lastPendingPayload) {
              ws.send(JSON.stringify(run.lastPendingPayload));
            }
          } else if (s.provider === 'windsurf' && s.threadId) {
            // No active run tracked — check if Windsurf is still running this cascade
            // and start a catch-up poll if so (fire-and-forget)
            startCatchUpPoll(s).catch(() => {});
          }
          break;
        }

        case 'send_message': {
          const s = store.get(msg.sessionId);
          if (!s) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            break;
          }
          const existingRun = activeRuns.get(s.id);
          if (existingRun?.proc || existingRun?.cascadeId) {
            ws.send(JSON.stringify({ type: 'error', message: 'A turn is already running for this session.' }));
            break;
          }
          const content = String(msg.content || '').trim();
          const attachments = msg.attachments || [];
          const config = PROVIDERS[s.provider];
          if (config?.type === 'cascade-ls') {
            runWindsurfTurn(s, content, ws, attachments);
          } else {
            runCodexTurn(s, content, ws, attachments);
          }
          break;
        }

        case 'approve_command': {
          const run = activeRuns.get(msg.sessionId);
          if (run?.cascadeId && run?.serverInfo) {
            // Use the real requestedInteraction stored during polling; fall back to ResolveOutstandingSteps
            const interaction = run.pendingInteraction || null;
            const cid = msg.cascadeId || run.cascadeId;
            console.log('[windsurf] approve_command pendingInteraction:', JSON.stringify(interaction)?.slice(0, 200));
            windsurf.approveInteraction(run.serverInfo, cid, interaction)
              .then(() => {
                run.pendingInteraction = null;
                run.lastPendingPayload = null;
                broadcast(msg.sessionId, { type: 'command_approved', sessionId: msg.sessionId });
              })
              .catch((e) => {
                run.cancelled = true;
                broadcast(msg.sessionId, { type: 'approve_failed', sessionId: msg.sessionId, message: `批准失败: ${e.message}` });
              });
          }
          break;
        }

        case 'cancel_step': {
          // Cancel a specific running step (e.g. a stuck interactive command)
          const run = activeRuns.get(msg.sessionId);
          if (run?.cascadeId && run?.serverInfo) {
            const stepIdx = msg.stepIndex ?? run.runningStepIdx;
            if (stepIdx != null) {
              run.runningStepIdx = null; // reset so polling picks up next step
              windsurf.cancelCascadeSteps(run.serverInfo, run.cascadeId, [stepIdx])
                .then(() => {
                  broadcast(msg.sessionId, { type: 'command_done', sessionId: msg.sessionId });
                  console.log(`[windsurf] cancelled step ${stepIdx} for ${msg.sessionId.slice(0, 8)}`);
                })
                .catch(async (e) => {
                  // Fallback: try ResolveOutstandingSteps
                  console.warn(`[windsurf] CancelCascadeSteps failed (${e.message}), trying ResolveOutstandingSteps`);
                  try {
                    await windsurf.resolveOutstandingSteps(run.serverInfo, run.cascadeId);
                    broadcast(msg.sessionId, { type: 'command_done', sessionId: msg.sessionId });
                  } catch (e2) {
                    broadcast(msg.sessionId, { type: 'error', message: `Cancel step failed: ${e2.message}` });
                  }
                });
            }
          }
          break;
        }

        case 'send_step_input': {
          // Send text input to a step waiting for stdin (e.g. git commit message via askUserQuestion)
          const run = activeRuns.get(msg.sessionId);
          if (run?.cascadeId && run?.serverInfo && msg.text) {
            const ri = run.pendingInteraction;
            const cid = msg.cascadeId || run.cascadeId;
            // Try as askUserQuestion response first, then resolveOutstandingSteps
            const interaction = ri || {};
            const body = {
              cascadeId: cid,
              interaction: {
                trajectoryId: interaction.trajectoryId || interaction.trajectory_id || cid,
                stepIndex: interaction.stepIndex ?? interaction.step_index ?? (run.runningStepIdx ?? 0),
                askUserQuestion: { response: msg.text },
              },
            };
            windsurf.rpcDirect(run.serverInfo, 'HandleCascadeUserInteraction', body)
              .then(() => {
                run.pendingInteraction = null;
                broadcast(msg.sessionId, { type: 'command_approved', sessionId: msg.sessionId });
              })
              .catch((e) => broadcast(msg.sessionId, { type: 'error', message: `Send input failed: ${e.message}` }));
          }
          break;
        }

        case 'answer_question': {
          const run = activeRuns.get(msg.sessionId);
          if (run?.cascadeId && run?.serverInfo) {
            const ri = run.pendingInteraction || {};
            const cid = msg.cascadeId || run.cascadeId;
            // CortexStepAskUserQuestion.Response is a oneof: selectedOptions(indices) | userInput(string).
            // Sending a bare string for `response` causes the proto unmarshaler to fail.
            const indices = Array.isArray(msg.selectedIndices)
              ? msg.selectedIndices.filter((n) => Number.isInteger(n))
              : [];
            const responseProto = indices.length
              ? { selectedOptions: { indices } }
              : { userInput: String(msg.response || '') };
            const body = {
              cascadeId: cid,
              interaction: {
                trajectoryId: ri.trajectoryId || ri.trajectory_id || cid,
                stepIndex: ri.stepIndex ?? ri.step_index ?? 0,
                askUserQuestion: { response: responseProto },
              },
            };
            console.log(`[windsurf] answer_question body:`, JSON.stringify(body).slice(0, 400));
            windsurf.rpcDirect(run.serverInfo, 'HandleCascadeUserInteraction', body)
              .then(() => {
                run.pendingInteraction = null;
                run.lastPendingPayload = null;
                broadcast(msg.sessionId, { type: 'question_answered', sessionId: msg.sessionId });
              })
              .catch((e) => {
                console.warn(`[windsurf] answer_question failed: ${e.message}`);
                broadcast(msg.sessionId, { type: 'error', message: `Answer failed: ${e.message}` });
              });
          }
          break;
        }

        case 'skip_question': {
          const run = activeRuns.get(msg.sessionId);
          if (run?.cascadeId && run?.serverInfo) {
            windsurf.resolveOutstandingSteps(run.serverInfo, run.cascadeId)
              .then(() => {
                run.pendingInteraction = null;
                run.lastPendingPayload = null;
                broadcast(msg.sessionId, { type: 'question_answered', sessionId: msg.sessionId });
              })
              .catch((e) => {
                broadcast(msg.sessionId, { type: 'error', message: `Skip failed: ${e.message}` });
              });
          }
          break;
        }

        case 'cancel_turn': {
          const run = activeRuns.get(msg.sessionId);
          if (run?.proc) {
            run.proc.kill('SIGINT');
            ws.send(JSON.stringify({ type: 'turn_cancelled', sessionId: msg.sessionId }));
          } else if (run?.cascadeId) {
            run.cancelled = true;
            ws.send(JSON.stringify({ type: 'turn_cancelled', sessionId: msg.sessionId }));
          }
          break;
        }

        case 'delete_session': {
          const run = activeRuns.get(msg.sessionId);
          if (run?.proc) run.proc.kill('SIGTERM');
          activeRuns.delete(msg.sessionId);
          store.remove(msg.sessionId);
          broadcastAll({ type: 'sessions_list', sessions: store.list() });
          break;
        }

        case 'rename_session': {
          const s = store.update(msg.sessionId, { title: msg.title });
          if (s) broadcastAll({ type: 'session_updated', session: s });
          break;
        }

        case 'update_model': {
          const s = store.update(msg.sessionId, { modelUid: msg.modelUid || null });
          if (s) broadcastAll({ type: 'session_updated', session: s });
          break;
        }

        case 'update_reasoning_effort': {
          const s = store.update(msg.sessionId, { reasoningEffort: msg.reasoningEffort || null });
          if (s) broadcastAll({ type: 'session_updated', session: s });
          break;
        }

        case 'load_windsurf_history': {
          const s = store.get(msg.sessionId);
          if (!s || !s.threadId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session has no Windsurf thread ID' }));
            break;
          }
          try {
            const servers = await windsurf.detectLanguageServersWithPath();
            if (!servers.length) {
              ws.send(JSON.stringify({ type: 'error', message: 'No running Windsurf server detected' }));
              break;
            }
            let server = servers.find((srv) => srv.workspacePath && s.cwd.startsWith(srv.workspacePath));
            if (!server) server = servers[0];

            const steps = await windsurf.getTrajectorySteps(server, s.threadId, 0);
            const messages = [];
            let cur = null; // current assistant turn accumulator

            for (const step of steps) {
              if (step.status !== 'CORTEX_STEP_STATUS_DONE') continue;
              const ev = windsurf.translateStep(step);
              if (!ev) continue;

              if (ev.kind === 'user_input') {
                // Commit previous assistant turn before new user message
                if (cur?.assistantText) {
                  messages.push({ role: 'assistant', content: cur.assistantText, items: cur.items, timestamp: Date.now() });
                }
                if (ev.text) messages.push({ role: 'user', content: ev.text, timestamp: Date.now() });
                cur = { assistantText: '', items: [], itemKeys: new Set() };
              } else if (ev.kind === 'assistant_message' && ev.text && cur) {
                cur.assistantText = ev.text; // keep last version (streaming updates)
              } else if (ev.kind === 'tool' && cur) {
                const key = `${ev.tool}:${ev.summary}`;
                if (!cur.itemKeys.has(key)) {
                  cur.itemKeys.add(key);
                  cur.items.push({ type: ev.tool, summary: ev.summary });
                }
              }
            }
            if (cur?.assistantText) {
              messages.push({ role: 'assistant', content: cur.assistantText, items: cur.items, timestamp: Date.now() });
            }

            store.update(s.id, { messages });
            ws.send(JSON.stringify({ type: 'history_loaded', sessionId: s.id, count: messages.length }));
            broadcastAll({ type: 'session_updated', session: store.get(s.id) });
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to load history: ${e.message}` }));
          }
          break;
        }

        case 'update_providers': {
          // Only allow updating args (not the command binary) to prevent
          // arbitrary command execution. The command itself must be set via
          // environment variables (CODEX_CMD, WINDSURF_CMD) at startup.
          if (msg.providers && typeof msg.providers === 'object') {
            for (const [name, cfg] of Object.entries(msg.providers)) {
              if (PROVIDERS[name] && typeof cfg.args === 'string') {
                PROVIDERS[name].args = cfg.args.trim();
              }
            }
          }
          ws.send(JSON.stringify({ type: 'providers_updated' }));
          break;
        }

        case 'list_dir': {
          const dirPath = path.resolve(msg.path || os.homedir());
          // Restrict directory browsing to the user's home tree
          const homeDir = os.homedir();
          if (!dirPath.startsWith(homeDir) && dirPath !== '/') {
            ws.send(JSON.stringify({ type: 'dir_error', message: 'Access denied: path outside home directory' }));
            break;
          }
          try {
            const stat = fs.statSync(dirPath);
            if (!stat.isDirectory()) throw new Error('Not a directory');
            const raw = fs.readdirSync(dirPath, { withFileTypes: true });
            const entries = raw
              .filter((e) => msg.showHidden || !e.name.startsWith('.'))
              .map((e) => ({
                name: e.name,
                isDir: e.isDirectory(),
                fullPath: path.join(dirPath, e.name),
              }))
              .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));

            const parent = path.dirname(dirPath);
            ws.send(JSON.stringify({
              type: 'dir_listing',
              path: dirPath,
              parent: parent !== dirPath ? parent : null,
              entries,
              _for: msg._for || null,
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'dir_error', message: e.message }));
          }
          break;
        }

        case 'get_windsurf_quota': {
          try {
            const servers = windsurf.detectLanguageServers();
            let capacity = {};
            if (servers.length) {
              try { capacity = await windsurf.checkCapacity(servers[0]); } catch (_) {}
            }
            const dbData = windsurf.getQuotaFromDb() || {};
            const data = { ...capacity, db: dbData };
            console.log('[quota] raw:', JSON.stringify(data));
            ws.send(JSON.stringify({ type: 'windsurf_quota', data }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'windsurf_quota', error: e.message }));
          }
          break;
        }

        case 'list_windsurf_workspaces': {
          try {
            const servers = await windsurf.detectLanguageServersWithPath();
            if (!servers.length) {
              ws.send(JSON.stringify({ type: 'windsurf_workspaces', workspaces: [] }));
              break;
            }
            // Each LS has its own trajectory view; aggregate from ALL servers
            // and dedupe by cascadeId (keep the most recently modified entry)
            const byId = new Map();
            await Promise.all(servers.map(async (s) => {
              try {
                const list = await windsurf.listTrajectories(s);
                for (const t of list) {
                  const prev = byId.get(t.cascadeId);
                  if (!prev || (t.lastModifiedTime || '') > (prev.lastModifiedTime || '')) {
                    byId.set(t.cascadeId, t);
                  }
                }
              } catch (_) {}
            }));
            const allTrajectories = [...byId.values()];
            const wsMap = new Map(); // workspacePath -> { count, lastModified }
            for (const t of allTrajectories) {
              if (t.isArchived) continue;
              for (const w of (t.workspaces || [])) {
                const uri = w.workspaceFolderAbsoluteUri || '';
                if (!uri.startsWith('file://')) continue;
                const p = decodeURIComponent(uri.slice('file://'.length));
                const existing = wsMap.get(p);
                if (!existing || (t.lastModifiedTime || '') > (existing.lastModified || '')) {
                  wsMap.set(p, {
                    count: (existing?.count || 0) + 1,
                    lastModified: t.lastModifiedTime || existing?.lastModified || '',
                  });
                } else {
                  existing.count++;
                }
              }
            }
            // Build workspace list sorted by most recent activity
            const workspaces = [...wsMap.entries()]
              .map(([p, info]) => ({
                pid: servers[0].pid,
                port: servers[0].port,
                workspacePath: p,
                trajectoryCount: info.count,
                lastModified: info.lastModified,
              }))
              .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
            ws.send(JSON.stringify({ type: 'windsurf_workspaces', workspaces }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          }
          break;
        }

        case 'list_windsurf_trajectories': {
          try {
            // Each LS has its own trajectory view; aggregate from ALL servers
            // and dedupe by cascadeId (keep the most recently modified entry).
            // A trajectory created in workspace X is only visible from X's LS.
            const servers = await windsurf.detectLanguageServersWithPath();
            if (!servers.length) {
              ws.send(JSON.stringify({ type: 'error', message: 'No Windsurf server detected' }));
              break;
            }
            const byId = new Map();
            await Promise.all(servers.map(async (s) => {
              try {
                const part = await windsurf.listTrajectories(s);
                for (const t of part) {
                  const prev = byId.get(t.cascadeId);
                  if (!prev || (t.lastModifiedTime || '') > (prev.lastModifiedTime || '')) {
                    byId.set(t.cascadeId, t);
                  }
                }
              } catch (_) {}
            }));
            const list = [...byId.values()];
            const filtered = list
              .filter((t) => !t.isArchived)
              .filter((t) => {
                if (!msg.workspacePath) return true;
                return t.workspaces?.some((w) =>
                  (w.workspaceFolderAbsoluteUri || '').includes(msg.workspacePath)
                );
              })
              .sort((a, b) => (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || ''));
            ws.send(JSON.stringify({
              type: 'windsurf_trajectories',
              workspacePath: msg.workspacePath,
              trajectories: filtered.slice(0, 30),
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          }
          break;
        }

        case 'attach_windsurf_trajectory': {
          // Create a session bound to an existing Cascade trajectory
          try {
            const s = store.create({
              provider: 'windsurf',
              cwd: msg.workspacePath || os.homedir(),
              title: msg.title || `Cascade @ ${path.basename(msg.workspacePath || '')}`,
            });
            store.update(s.id, { threadId: msg.cascadeId });
            const session = store.get(s.id);
            ws.send(JSON.stringify({ type: 'session_created', session }));
            broadcastAll({ type: 'sessions_list', sessions: store.list() });
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          }
          break;
        }

        case 'revert_last_exchange': {
          const result = store.revertLastExchange(msg.sessionId);
          if (result) {
            ws.send(JSON.stringify({ type: 'revert_done', sessionId: msg.sessionId, content: result.content }));
            broadcastAll({ type: 'session_updated', session: result.session });
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Nothing to revert' }));
          }
          break;
        }

        default:
          break;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    for (const run of activeRuns.values()) run.clients.delete(ws);
  });
});

// ─── REST ─────────────────────────────────────────────────────────────────

app.get('/api/providers', checkHttpAuth, (_req, res) => res.json(Object.keys(PROVIDERS)));
app.get('/api/sessions', checkHttpAuth, (_req, res) => res.json(store.list()));

// File upload endpoint
app.post('/api/upload', checkHttpAuth, (req, res) => {
  try {
    const { sessionId, files } = req.body;
    if (!files?.length) return res.json({ files: [] });

    // Sanitize sessionId to prevent path traversal
    const safeSessionId = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = path.join(UPLOAD_DIR, safeSessionId);
    if (!sessionDir.startsWith(UPLOAD_DIR)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const saved = [];
    for (const f of files) {
      // Sanitize file extension to prevent executable uploads
      const rawExt = path.extname(f.name) || '.bin';
      const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, '');
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filepath = path.join(sessionDir, safeName);
      const buf = Buffer.from(f.data, 'base64');
      fs.writeFileSync(filepath, buf);
      saved.push({
        name: f.name,
        path: filepath,
        url: `/uploads/${safeSessionId}/${safeName}`,
        type: f.type || 'application/octet-stream',
        size: buf.length,
      });
    }

    res.json({ files: saved });
  } catch (e) {
    console.error('[upload] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Static frontend
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\u{1F680} AI Relay (chat) running`);
  console.log(`   HTTP : http://0.0.0.0:${PORT}`);
  console.log(`   WS   : ws://0.0.0.0:${PORT}`);
  console.log(`   Storage: ${path.join(os.homedir(), '.ai-relay/sessions.json')}`);
  console.log(`   Providers: ${Object.keys(PROVIDERS).join(', ')}`);
});
