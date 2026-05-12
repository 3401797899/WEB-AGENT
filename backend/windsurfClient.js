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

// ─── Auth: read apiKey + matching identity atomically ─────────────────────
//
// Windsurf scatters auth state across two SQLite rows that can desync when
// account-pool / account-switcher tools rotate trial accounts:
//
//   codeium.windsurf.codeium.apiKey        ← what the IDE actually uses for
//                                            Cascade RPCs (the "live" key)
//   codeium.windsurf.windsurf.pendingApiKeyMigration
//                                          ← rotation tools may stage a new
//                                            key here pending migration
//   windsurfAuthStatus.apiKey              ← the post-migration target
//   windsurfAuthStatus.userStatusProtoBinaryBase64
//                                          ← identity blob (user_id,
//                                            team_id, plan_name) paired
//                                            with windsurfAuthStatus.apiKey
//
// CRITICAL: identity must match the apiKey we send. Mixing them (e.g.
// sending apiKey from `codeium.apiKey` with user_id parsed from
// windsurfAuthStatus when the two point at different accounts) makes the
// upstream throttle aggressively with "Reached overall message rate limit"
// or "internal error" responses, even though the IDE on the same machine
// works fine.

let _cachedAuth = null;   // { apiKey, userId, teamId, planName, sessionId }
let _cachedAuthTime = 0;
const AUTH_CACHE_MS = 2000;  // short; account-pool can rotate every few seconds

function decodeJwtSessionId(apiKey) {
  try {
    const part = (apiKey || '').split('$')[1]?.split('.')[1];
    if (!part) return null;
    const pad = '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(part + pad, 'base64url').toString('utf8')
    );
    return payload.session_id || null;
  } catch (_) { return null; }
}

function parseIdentityBlob(b64) {
  // userStatusProtoBinaryBase64 contains length-prefixed protobuf strings.
  // Extract user-XXX (32 hex), devin-team$..., and plan name.
  const out = { userId: null, teamId: null, planName: null };
  if (!b64) return out;
  try {
    const txt = Buffer.from(b64, 'base64').toString('binary');
    const uid = txt.match(/user-[a-f0-9]{32}/);
    if (uid) out.userId = uid[0];
    const tid = txt.match(/devin-team\$[\x20-\x7e]{5,80}?(?=[\x00-\x1f])/);
    if (tid) out.teamId = tid[0];
    const plan = txt.match(/\b(Free|Trial|Pro|Teams|Enterprise|Plus)\b/);
    if (plan) out.planName = plan[1];
  } catch (_) {}
  return out;
}

let _keychainPassword = null;
function getKeychainPassword() {
  if (_keychainPassword) return _keychainPassword;
  try {
    _keychainPassword = execSync(
      'security find-generic-password -s "Windsurf Safe Storage" -w',
      { encoding: 'utf8' }
    ).trim();
  } catch (_) { _keychainPassword = null; }
  return _keychainPassword;
}

function decryptSessionsBlob(db) {
  try {
    const password = getKeychainPassword();
    if (!password) return null;
    const sessionsKey =
      'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}';
    const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(sessionsKey);
    if (!row) return null;
    const enc = Buffer.from(JSON.parse(row.value).data);
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, ' ');
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
    const arr = JSON.parse(out.toString());
    return arr[0]?.accessToken || null;
  } catch (_) {
    return null;
  }
}

function readAuthFresh() {
  const home = require('os').homedir();
  const dbPath = path.join(
    home,
    'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'
  );
  const db = new Database(dbPath, { readonly: true });

  let cw = null, wa = null;
  try {
    const r1 = db.prepare("SELECT value FROM ItemTable WHERE key='codeium.windsurf'").get();
    if (r1) cw = JSON.parse(r1.value);
  } catch (_) {}
  try {
    const r2 = db.prepare("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus'").get();
    if (r2) wa = JSON.parse(r2.value);
  } catch (_) {}

  // Priority:
  // (1) codeium.windsurf.codeium.apiKey — this is the key the IDE Cascade
  //     renderer reads on each message. Account-pool tools that swap
  //     accounts by writing directly to this field (alongside updating
  //     `lastLoginEmail`) give us the freshest live key.
  // (2) keychain `windsurf_auth.sessions` — what `handleAuthSessionAlt`
  //     writes. May lag when only codeium.apiKey is swapped.
  // (3) windsurfAuthStatus.apiKey — UI-level snapshot; can be oldest.
  let apiKey = null, source = null;
  if (cw && cw['codeium.apiKey']) {
    apiKey = cw['codeium.apiKey'];
    source = 'codeium.apiKey';
  }
  if (!apiKey) {
    const kc = decryptSessionsBlob(db);
    if (kc) { apiKey = kc; source = 'keychain'; }
  }
  if (!apiKey && wa?.apiKey) {
    apiKey = wa.apiKey;
    source = 'windsurfAuthStatus.apiKey';
  }

  // Identity (user_id, team_id, plan_name) lives in
  // windsurfAuthStatus.userStatusProtoBinaryBase64 and is paired with
  // windsurfAuthStatus.apiKey. Only include identity when our chosen key
  // equals windsurfAuthStatus.apiKey — otherwise we'd send mismatched
  // identity, which actually triggers upstream throttling.
  const identityMatches = apiKey && wa?.apiKey && apiKey === wa.apiKey;
  let identity = { userId: null, teamId: null, planName: null };
  if (identityMatches && wa) {
    identity = parseIdentityBlob(wa.userStatusProtoBinaryBase64);
  }

  const lastLoginEmail = cw?.lastLoginEmail || null;

  db.close();
  if (!apiKey) throw new Error('No Windsurf apiKey available');

  return {
    apiKey,
    source,
    sessionId: decodeJwtSessionId(apiKey),
    email: lastLoginEmail,
    userId: identity.userId,
    teamId: identity.teamId,
    planName: identity.planName,
    identityPaired: identityMatches,
  };
}

function _refreshAuth() {
  if (_cachedAuth && Date.now() - _cachedAuthTime < AUTH_CACHE_MS) return _cachedAuth;
  const fresh = readAuthFresh();
  // Log once per change so account rotation is visible in logs
  if (!_cachedAuth || _cachedAuth.sessionId !== fresh.sessionId) {
    const sidTail = fresh.sessionId
      ? fresh.sessionId.replace(/^windsurf-session-/, '').slice(0, 12)
      : '?';
    console.log(
      `[windsurf-auth] sid=${sidTail}` +
      ` source=${fresh.source}` +
      ` email=${fresh.email || '?'}` +
      ` paired=${fresh.identityPaired}`
    );
  }
  _cachedAuth = fresh;
  _cachedAuthTime = Date.now();
  return fresh;
}

function getApiKey() {
  return _refreshAuth().apiKey;
}

function getIdentity() {
  const a = _refreshAuth();
  return {
    userId: a.userId,
    teamId: a.teamId,
    planName: a.planName,
    paired: a.identityPaired,
    sessionId: a.sessionId,
    email: a.email,
    source: a.source,
  };
}

function clearApiKeyCache() {
  _cachedAuth = null;
  _cachedAuthTime = 0;
}

// ─── Connect/JSON RPC client ──────────────────────────────────────────────

// Versions and identity must match what the IDE itself sends, otherwise the
// upstream service rate-limits us as a low-trust client (you'll see
// "Reached overall message rate limit" even though IDE on same account
// works fine). Sourced from Windsurf.app/.../product.json.
//   - ide_version       = product.windsurfVersion (e.g. "2.2.17")
//   - extension_version = product.codeiumVersion  (e.g. "1.48.2")
//   - os                = "mac" / "linux" / "windows"  (NOT process.platform's "darwin")
const EXT_PATH = '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf';
let _productCache = null;
function getProduct() {
  if (_productCache) return _productCache;
  const fs = require('fs');
  const fallback = { ideVersion: '2.2.17', extVersion: '1.48.2' };
  try {
    const p = JSON.parse(
      fs.readFileSync('/Applications/Windsurf.app/Contents/Resources/app/product.json', 'utf8')
    );
    _productCache = {
      ideVersion: p.windsurfVersion || fallback.ideVersion,
      extVersion: p.codeiumVersion || fallback.extVersion,
    };
  } catch (_) {
    _productCache = fallback;
  }
  return _productCache;
}

const OS_NAME =
  process.platform === 'darwin' ? 'mac' :
  process.platform === 'win32'  ? 'windows' : 'linux';

// session_id is a UUID string; request_id is uint64 (decimal string).
// Confirmed by tcpdump on IDE → LS traffic.
const SESSION_ID = require('crypto').randomUUID();
let _reqCounter = 0;
function nextRequestId() {
  _reqCounter = (_reqCounter + 1) >>> 0;
  return String(_reqCounter);
}

function buildMetadata(apiKey) {
  const { ideVersion, extVersion } = getProduct();
  const id = getIdentity();
  const md = {
    ide_name: 'windsurf',
    ide_type: 'IDE_TYPE_WINDSURF',
    ide_version: ideVersion,
    // Real wire value is just "windsurf" (NOT "codeium.windsurf");
    // mismatched extension_name causes the upstream to bucket us as a
    // low-trust client and rate-limit aggressively.
    extension_name: 'windsurf',
    extension_version: extVersion,
    api_key: apiKey,
    locale: 'en',
    os: OS_NAME,
    session_id: SESSION_ID,
    request_id: nextRequestId(),
    extension_path: EXT_PATH,
  };
  // These three are the difference between "trusted IDE bucket" and
  // "anonymous client" rate limit on the upstream.
  if (id.userId)   md.user_id        = id.userId;
  if (id.teamId)   md.force_team_id  = id.teamId;
  if (id.planName) md.plan_name      = id.planName;
  return md;
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

async function cancelCascadeSteps(server, cascadeId, stepIndices) {
  return rpc(server, 'CancelCascadeSteps', { cascadeId, stepIndices });
}

// Direct RPC call without any metadata wrapping
async function rpcDirect(server, method, body) {
  return rpc(server, method, body);
}

// Approve a requestedInteraction using the correct HandleCascadeUserInteraction RPC.
// The `interaction` arg is the requestedInteraction object from a trajectory step.
// It is a CascadeUserInteraction proto that carries trajectoryId, stepIndex, and one
// of the interaction oneof fields (runCommand, deploy, etc.).
async function approveInteraction(server, cascadeId, interaction) {
  // Build the approved interaction response.
  // We mirror the incoming requestedInteraction but flip confirm=true for runCommand,
  // or accept=true for deploy, etc.
  const ri = interaction || {};

  // Determine which oneof variant is present
  const runCommand = ri.runCommand || ri.run_command;
  const deploy     = ri.deploy;
  const resolveTask = ri.resolveTask || ri.resolve_task;
  const upsertCodemap = ri.upsertCodemap || ri.upsert_codemap;
  const readUrlContent = ri.readUrlContent || ri.read_url_content;

  let interactionPayload;
  if (runCommand) {
    const cmd = runCommand.proposedCommandLine || runCommand.proposed_command_line
             || runCommand.commandLine || runCommand.command_line || '';
    interactionPayload = {
      runCommand: {
        confirm: true,
        proposedCommandLine: cmd,
        submittedCommandLine: cmd,
      },
    };
  } else if (deploy) {
    interactionPayload = { deploy: { ...deploy, confirm: true } };
  } else if (resolveTask) {
    interactionPayload = { resolveTask: { ...resolveTask, confirm: true } };
  } else if (upsertCodemap) {
    interactionPayload = { upsertCodemap: { ...upsertCodemap, confirm: true } };
  } else if (readUrlContent) {
    interactionPayload = { readUrlContent: { ...readUrlContent, action: 'ALLOW' } };
  } else {
    // Unknown interaction type — try ResolveOutstandingSteps as fallback
    console.warn('[windsurf] unknown interaction type, trying ResolveOutstandingSteps');
    return rpc(server, 'ResolveOutstandingSteps', { cascadeId });
  }

  const body = {
    cascadeId,
    interaction: {
      trajectoryId: ri.trajectoryId || ri.trajectory_id || cascadeId,
      stepIndex: ri.stepIndex ?? ri.step_index ?? 0,
      ...interactionPayload,
    },
  };

  try {
    await rpc(server, 'HandleCascadeUserInteraction', body);
    console.log('[windsurf] approved via HandleCascadeUserInteraction');
    return;
  } catch (e) {
    // Fallback: ResolveOutstandingSteps only needs cascadeId
    console.warn(`[windsurf] HandleCascadeUserInteraction failed (${e.message}), trying ResolveOutstandingSteps`);
    return rpc(server, 'ResolveOutstandingSteps', { cascadeId });
  }
}

// Resolve all outstanding steps at once (bulk approve / skip).
async function resolveOutstandingSteps(server, cascadeId) {
  return rpc(server, 'ResolveOutstandingSteps', { cascadeId });
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
    case 'errorMessage': {
      // payload = { error: { userErrorMessage, shortError, fullError, errorCode }, shouldShowUser }
      const err = payload?.error || payload || {};
      const text = err.userErrorMessage || err.shortError || err.errorMessage
                || payload?.errorMessage || payload?.message
                || (typeof payload === 'string' ? payload : JSON.stringify(payload));
      return {
        kind: 'error',
        text,
      };
    }
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
  getIdentity,
  checkCapacity,
  getQuotaFromDb,
  listTrajectories,
  startCascade,
  sendMessage,
  getTrajectorySteps,
  getTrajectoryStatus,
  cancelCascade,
  cancelCascadeSteps,
  rpcDirect,
  approveInteraction,
  resolveOutstandingSteps,
  deleteCascade,
  translateStep,
  clearApiKeyCache,
};
