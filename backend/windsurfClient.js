// Windsurf Cascade adapter.
// Talks to the running Windsurf IDE's local language server (gRPC over Connect/JSON).
// Auto-detects port + CSRF token from the running process and decrypts the API key
// from the macOS Keychain + Windsurf SQLite store.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

// ─── Detect running Windsurf language servers ─────────────────────────────

function detectLanguageServers() {
  let psOut;
  try {
    psOut = execSync('ps -E -ww -A -o pid=,command=', { encoding: 'utf8' });
  } catch (e) {
    return [];
  }

  const out = [];
  for (const line of psOut.split('\n')) {
    if (!line.includes('language_server_macos')) continue;
    if (!line.includes('codeium/windsurf') && !line.includes('Windsurf.app')) continue;

    const tokens = line.trim().split(/\s+/);
    const pid = parseInt(tokens[0]);
    if (!pid) continue;
    const get = (flag) => {
      const i = tokens.indexOf(flag);
      return i >= 0 ? tokens[i + 1] : null;
    };

    const csrf = (line.match(/WINDSURF_CSRF_TOKEN=([\w-]+)/) || [])[1];
    if (!csrf) continue;

    const workspaceId = get('--workspace_id');
    const ideName = get('--ide_name') || 'windsurf';
    let port = get('--server_port');

    if (!port) {
      // --random_port: probe LISTEN sockets owned by this PID.
      try {
        const lsof = execSync(
          `lsof -a -p ${pid} -iTCP -sTCP:LISTEN -P -n 2>/dev/null`,
          { encoding: 'utf8' }
        );
        const ports = [];
        for (const l of lsof.split('\n').slice(1)) {
          const m = l.match(/:(\d+) \(LISTEN\)/);
          if (m) ports.push(parseInt(m[1]));
        }
        for (const p of ports) {
          try {
            const code = execSync(
              `curl -s -o /dev/null -w '%{http_code}' -m 1 -X POST http://127.0.0.1:${p}/exa.language_server_pb.LanguageServerService/CheckChatCapacity -H 'Content-Type: application/json' -H 'x-codeium-csrf-token: ${csrf}'`,
              { encoding: 'utf8' }
            ).trim();
            // 401 missing-CSRF or 200 success -> right server
            if (['200', '400', '401'].includes(code)) {
              port = p;
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    if (!port) continue;

    out.push({
      pid,
      port: parseInt(port),
      csrf,
      workspaceId,
      workspacePath: null, // resolved later via listTrajectories()
      ideName,
    });
  }
  return out;
}

// Returns servers with workspacePath resolved from the most recent trajectory.
async function detectLanguageServersWithPath() {
  const servers = detectLanguageServers();
  await Promise.all(
    servers.map(async (s) => {
      try {
        const list = await listTrajectoriesRaw(s);
        // Pick the most recent (any) trajectory's first workspace folder
        const sorted = list.sort((a, b) =>
          (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || '')
        );
        for (const t of sorted) {
          const w = t.workspaces?.[0]?.workspaceFolderAbsoluteUri;
          if (w && w.startsWith('file://')) {
            s.workspacePath = decodeURIComponent(w.slice('file://'.length));
            break;
          }
        }
      } catch (_) {}
    })
  );
  return servers;
}

// internal helper — list raw trajectories without massaging
async function listTrajectoriesRaw(server) {
  const metadata = buildMetadata(getApiKey());
  const r = await rpc(server, 'GetAllCascadeTrajectories', { metadata });
  return Object.entries(r.trajectorySummaries || {}).map(([cascadeId, s]) => ({
    cascadeId,
    summary: s.summary || '',
    title: s.renamedTitle || s.summary || '(untitled)',
    status: s.status,
    stepCount: parseInt(s.stepCount || 0),
    lastModifiedTime: s.lastModifiedTime,
    workspaces: s.workspaces || [],
    isArchived: !!s.isArchived,
  }));
}

// ─── Decrypt apiKey from Windsurf state ───────────────────────────────────

let _cachedApiKey = null;
function getApiKey() {
  if (_cachedApiKey) return _cachedApiKey;
  const home = require('os').homedir();
  const dbPath = path.join(
    home,
    'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'
  );
  const db = new Database(dbPath, { readonly: true });

  // Fast path: windsurfAuthStatus contains the actual apiKey in cleartext
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus'").get();
    if (row) {
      const j = JSON.parse(row.value);
      if (j.apiKey) {
        db.close();
        _cachedApiKey = j.apiKey;
        return j.apiKey;
      }
    }
  } catch (_) {}

  // Slow path: decrypt the encrypted sessions blob using macOS Keychain key
  let password;
  try {
    password = execSync('security find-generic-password -s "Windsurf Safe Storage" -w', {
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    db.close();
    throw new Error('Windsurf Safe Storage password not found in Keychain');
  }
  const sessionsKey =
    'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}';
  const row2 = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(sessionsKey);
  db.close();
  if (!row2) throw new Error('No Windsurf auth sessions in state.vscdb');
  const enc = Buffer.from(JSON.parse(row2.value).data);
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
  const arr = JSON.parse(out.toString());
  if (!arr[0] || !arr[0].accessToken) throw new Error('No accessToken in sessions');
  _cachedApiKey = arr[0].accessToken;
  return _cachedApiKey;
}

// ─── Connect/JSON RPC client ──────────────────────────────────────────────

function buildMetadata(apiKey) {
  return {
    ide_name: 'windsurf',
    ide_version: '2.1.32',
    extension_name: 'codeium.windsurf',
    extension_version: '1.110.1',
    api_key: apiKey,
    locale: 'en',
  };
}

async function rpc(server, method, body) {
  const url = `http://127.0.0.1:${server.port}/exa.language_server_pb.LanguageServerService/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': server.csrf,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const m = text.match(/"message":"([^"]+)"/);
    throw new Error(`${method}: ${r.status} ${m ? m[1] : text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

// ─── Public: high-level operations ────────────────────────────────────────

async function checkCapacity(server) {
  const metadata = buildMetadata(getApiKey());
  return rpc(server, 'CheckChatCapacity', { metadata });
}

// Read cached quota / account info from the local Windsurf SQLite state db.
// Windsurf may cache flow-action counts in windsurfAuthStatus or related keys.
function getQuotaFromDb() {
  const home = require('os').homedir();
  const dbPath = path.join(
    home,
    'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'
  );
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return null;
  }
  try {
    // Scan all keys for anything quota/flow/capacity related
    const rows = db.prepare(
      "SELECT key, value FROM ItemTable WHERE key LIKE '%quota%' OR key LIKE '%flow%' OR key LIKE '%capacity%' OR key LIKE '%Auth%' OR key LIKE '%auth%'"
    ).all();
    const result = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
  } catch (e) {
    return null;
  } finally {
    db.close();
  }
}

async function listTrajectories(server) {
  const metadata = buildMetadata(getApiKey());
  const r = await rpc(server, 'GetAllCascadeTrajectories', { metadata });
  return Object.entries(r.trajectorySummaries || {}).map(([cascadeId, s]) => ({
    cascadeId,
    summary: s.summary || '',
    title: s.renamedTitle || s.summary || '(untitled)',
    status: s.status,
    stepCount: parseInt(s.stepCount || 0),
    lastModifiedTime: s.lastModifiedTime,
    workspaces: s.workspaces || [],
    isArchived: !!s.isArchived,
  }));
}

async function startCascade(server) {
  const metadata = buildMetadata(getApiKey());
  const r = await rpc(server, 'StartCascade', {
    metadata,
    source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
  });
  return r.cascadeId;
}

async function sendMessage(server, cascadeId, text, modelUid) {
  const metadata = buildMetadata(getApiKey());
  return rpc(server, 'SendUserCascadeMessage', {
    metadata,
    cascadeId,
    items: [{ text }],
    cascadeConfig: modelUid
      ? {
          plannerConfig: {
            requestedModelUid: modelUid,
            planModelUid: modelUid,
          },
        }
      : undefined,
  });
}

async function getTrajectorySteps(server, cascadeId, stepOffset) {
  const r = await rpc(server, 'GetCascadeTrajectorySteps', {
    cascadeId,
    stepOffset: stepOffset || 0,
  });
  return r.steps || [];
}

async function getTrajectoryStatus(server, cascadeId) {
  const r = await rpc(server, 'GetCascadeTrajectory', { cascadeId });
  return {
    status: r.status,
    numTotalSteps: parseInt(r.numTotalSteps || 0),
  };
}

async function cancelCascade(server, cascadeId) {
  return rpc(server, 'CancelCascadeInvocation', { cascadeId });
}

async function deleteCascade(server, cascadeId) {
  return rpc(server, 'DeleteCascadeTrajectory', { cascadeId });
}

// ─── Step → user-facing event translator ──────────────────────────────────

// Given a Cascade step, return a chat-UI item (or null to skip).
function translateStep(step) {
  // Find which oneof "step" branch is set
  const knownMeta = new Set([
    'type',
    'status',
    'metadata',
    'error',
    'asyncLevelOverride',
    'requestedInteraction',
    'userAnnotations',
    'preToolUseHooks',
    'postToolUseHooks',
    'shieldFromCancellation',
  ]);
  const stepKey = Object.keys(step).find((k) => !knownMeta.has(k));
  const payload = stepKey ? step[stepKey] : null;

  switch (stepKey) {
    case 'userInput':
      return {
        kind: 'user_input',
        text: payload?.userResponse || (payload?.items?.[0]?.text ?? ''),
      };
    case 'plannerResponse': {
      let text = payload?.modifiedResponse || payload?.response || '';
      // Extract <thinking> tags if embedded in text
      let thinking = payload?.thinking || payload?.internalThinking || payload?.scratchpad || '';
      if (!thinking) {
        const m = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
        if (m) {
          thinking = m[1].trim();
          text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
        }
      }
      return {
        kind: 'assistant_message',
        thinking,
        text,
        messageId: payload?.messageId,
      };
    }
    case 'runCommand':
      return {
        kind: 'tool',
        tool: 'run_command',
        summary: payload?.command || payload?.commandLine || '',
        details: payload,
      };
    case 'writeToFile':
    case 'proposeCode':
    case 'codeAction':
    case 'applyEdit':
    case 'editFile':
      return {
        kind: 'tool',
        tool: 'proposeCode',
        summary:
          payload?.targetFile || payload?.uri || payload?.path ||
          payload?.edit?.uri || payload?.filePath || '',
        details: payload,
      };
    case 'viewFile':
    case 'viewCodeItem':
      return {
        kind: 'tool',
        tool: stepKey,
        summary:
          payload?.absolutePath || payload?.targetFile ||
          payload?.filePath || payload?.path || payload?.uri ||
          payload?.fileUri || '',
        details: payload,
      };
    case 'grepSearch':
      return {
        kind: 'tool',
        tool: stepKey,
        summary: payload?.query || payload?.searchQuery || '',
        details: payload,
      };
    case 'listDirectory':
      return {
        kind: 'tool',
        tool: stepKey,
        summary:
          payload?.absolutePath || payload?.directoryPath ||
          payload?.path || payload?.dirPath || '',
        details: payload,
      };
    case 'find':
      return {
        kind: 'tool',
        tool: stepKey,
        summary: payload?.nameGlob || payload?.pattern || payload?.query || '',
        details: payload,
      };
    case 'readUrlContent':
      return {
        kind: 'tool',
        tool: stepKey,
        summary: payload?.url || '',
        details: payload,
      };
    case 'searchKnowledgeBase':
    case 'lookupKnowledgeBase':
      return {
        kind: 'tool',
        tool: stepKey,
        summary: payload?.query || payload?.searchQuery || '',
        details: payload,
      };
    case 'errorMessage':
      return {
        kind: 'error',
        text: payload?.errorMessage || JSON.stringify(payload),
      };
    case 'retrieveMemory':
    case 'checkpoint':
    case 'memory':
    case 'planInput':
    case 'finish':
    case 'dummy':
    case 'informPlanner':
    case 'fileBreakdown':
    case 'commandStatus':
    case 'suggestedResponses':
      return null; // skip noise
    default:
      return {
        kind: 'tool',
        tool: stepKey || 'unknown',
        summary: '',
        details: payload,
      };
  }
}

module.exports = {
  detectLanguageServers,
  detectLanguageServersWithPath,
  getApiKey,
  checkCapacity,
  getQuotaFromDb,
  listTrajectories,
  startCascade,
  sendMessage,
  getTrajectorySteps,
  getTrajectoryStatus,
  cancelCascade,
  deleteCascade,
  translateStep,
};
