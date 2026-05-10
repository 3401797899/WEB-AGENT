const express = require('express');
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

app.use(express.json());

// Active runs: sessionId → { proc, clients: Set<ws>, buffer: events[] }
const activeRuns = new Map();

// Provider configurations
const PROVIDERS = {
  codex: {
    type: 'codex-exec',
    command: process.env.CODEX_CMD || 'codex',
  },
  windsurf: {
    type: 'cascade-ls', // talks to running Windsurf IDE's language server
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

// ─── Run a chat turn (codex exec) ─────────────────────────────────────────

function runCodexTurn(session, userMessage, ws) {
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
  // Allow codex to write files in the workspace (not read-only sandboxed)
  const sandboxArgs = ['-s', 'workspace-write'];
  let baseArgs;
  if (session.threadId) {
    baseArgs = ['exec', ...sandboxArgs, '--cd', session.cwd, 'resume',
                ...modelArgs, ...effortArgs, '--json', '--skip-git-repo-check',
                session.threadId, '-'];
  } else {
    baseArgs = ['exec', ...modelArgs, ...effortArgs, ...sandboxArgs,
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

  proc.stdin.write(userMessage);
  proc.stdin.end();

  const run = activeRuns.get(session.id) || { clients: new Set(), buffer: [] };
  run.proc = proc;
  run.buffer = []; // reset buffer for new turn
  run.clients.add(ws);
  activeRuns.set(session.id, run);

  // Persist user message
  store.appendMessage(session.id, { role: 'user', content: userMessage });
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
            run.pendingInteraction = ri;
            const rc = ri.runCommand || ri.run_command || {};
            const cmdLine = rc.proposedCommandLine || rc.proposed_command_line
                         || rc.commandLine || rc.command_line || rc.command || '';
            broadcast(session.id, {
              type: 'command_approval_needed',
              sessionId: session.id,
              interactionId: String(intId),
              commandLine: cmdLine,
              cascadeId,
            });
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
        } else if (ev.kind === 'tool' && st.status === 'CORTEX_STEP_STATUS_DONE' && !seenDoneIdx.has(absIdx)) {
          seenDoneIdx.add(absIdx);
          items.push({ type: ev.tool, summary: ev.summary });
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

async function runWindsurfTurn(session, userMessage, ws) {
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

    // Persist user message only after confirming cascade is idle and we can send
    store.appendMessage(session.id, { role: 'user', content: userMessage });
    broadcastAll({ type: 'session_updated', session: store.get(session.id) });

    const modelUid = session.modelUid || 'claude-sonnet-4-6-thinking';
    // If session.cwd differs from the server's workspace, prepend the target
    // directory so Cascade knows where to work (no API-level cwd override exists)
    let messageToSend = userMessage;
    const serverWorkspace = server.workspacePath || '';
    if (session.cwd && session.cwd !== serverWorkspace) {
      messageToSend = `[工作目录: ${session.cwd}]\n\n${userMessage}`;
      console.log(`[windsurf] injecting cwd context: ${session.cwd}`);
    }

    // On the first message of a new cascade, inject rules to prevent common issues
    if (messageStartOffset === 0) {
      const rules = [
        '[执行规则]',
        '1. 超过200字符的代码/命令必须写入临时文件执行（如 /tmp/xxx.js），禁止用 node -e/python -c 传超长inline代码',
        '2. 禁止打开交互式编辑器（vim/nano/less），git操作加 --no-edit --no-pager',
      ].join('\n');
      messageToSend = rules + '\n\n' + messageToSend;
    }
    await windsurf.sendMessage(server, cascadeId, messageToSend, modelUid);

    broadcast(session.id, { type: 'event', sessionId: session.id, event: { type: 'cascade.started', cascadeId } });

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
              console.log(`[windsurf] requestedInteraction at step ${absIdx}:`, JSON.stringify(ri).slice(0, 300));
              // Store the real interaction object on the run for use by approve_command handler
              run.pendingInteraction = ri;
              // Extract command line from the runCommand field inside the interaction
              const rc = ri.runCommand || ri.run_command || {};
              const cmdLine = rc.proposedCommandLine || rc.proposed_command_line
                           || rc.commandLine || rc.command_line
                           || rc.command || '';
              broadcast(session.id, {
                type: 'command_approval_needed',
                sessionId: session.id,
                interactionId: String(intId),
                commandLine: cmdLine,
                cascadeId,
              });
              // No auto-approve attempt — keep banner until user acts or step resolves
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
              items.push({ type: ev.tool || ev.kind, summary: ev.summary, details: ev.details });
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
      if (
        status.status === 'CASCADE_RUN_STATUS_IDLE' &&
        highWaterMark >= messageStartOffset + 2
      ) {
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
    } else if (lastAssistantText) {
      store.appendMessage(session.id, {
        role: 'assistant',
        content: lastAssistantText,
        items,
      });
    } else {
      store.appendMessage(session.id, {
        role: 'assistant',
        content: '',
        items,
        error: 'No response from Cascade',
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

wss.on('connection', (ws) => {
  // Send list of all sessions (history) on connect
  ws.send(JSON.stringify({ type: 'sessions_list', sessions: store.list() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    try {
      switch (msg.type) {
        case 'create_session': {
          const s = store.create({
            provider: msg.provider,
            cwd: msg.cwd && fs.existsSync(msg.cwd) ? msg.cwd : os.homedir(),
            title: msg.title,
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
          const config = PROVIDERS[s.provider];
          if (config?.type === 'cascade-ls') {
            runWindsurfTurn(s, content, ws);
          } else {
            runCodexTurn(s, content, ws);
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
                broadcast(msg.sessionId, { type: 'command_approved', sessionId: msg.sessionId });
              })
              .catch((e) => {
                run.cancelled = true;
                broadcast(msg.sessionId, { type: 'approve_failed', sessionId: msg.sessionId, message: e.message });
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
          if (msg.providers && typeof msg.providers === 'object') {
            for (const [name, cfg] of Object.entries(msg.providers)) {
              if (PROVIDERS[name] && cfg.command) {
                PROVIDERS[name].command = cfg.command.trim();
              }
            }
          }
          ws.send(JSON.stringify({ type: 'providers_updated' }));
          break;
        }

        case 'list_dir': {
          const dirPath = msg.path || os.homedir();
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
            ws.send(JSON.stringify({
              type: 'windsurf_workspaces',
              workspaces: servers.map((s) => ({
                pid: s.pid,
                port: s.port,
                workspaceId: s.workspaceId,
                workspacePath: s.workspacePath,
              })),
            }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          }
          break;
        }

        case 'list_windsurf_trajectories': {
          try {
            const servers = await windsurf.detectLanguageServersWithPath();
            const target = msg.workspacePath
              ? servers.find((s) => s.workspacePath === msg.workspacePath)
              : servers[0];
            if (!target) {
              ws.send(JSON.stringify({ type: 'error', message: 'Windsurf workspace not found' }));
              break;
            }
            const list = await windsurf.listTrajectories(target);
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
              workspacePath: target.workspacePath,
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

app.get('/api/providers', (_req, res) => res.json(Object.keys(PROVIDERS)));
app.get('/api/sessions', (_req, res) => res.json(store.list()));

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
