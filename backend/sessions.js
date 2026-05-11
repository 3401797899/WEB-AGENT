// Persistent chat-session storage in ~/.ai-relay/sessions.json
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const STORE_DIR = path.join(os.homedir(), '.ai-relay');
const STORE_FILE = path.join(STORE_DIR, 'sessions.json');

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

let sessions = load(); // array of session objects

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(sessions, null, 2));
  } catch (e) {
    console.error('[sessions] persist error:', e.message);
  }
}

function list() {
  return sessions.map((s) => ({
    id: s.id,
    provider: s.provider,
    cwd: s.cwd,
    title: s.title,
    modelUid: s.modelUid || null,
    reasoningEffort: s.reasoningEffort || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
  }));
}

function get(id) {
  return sessions.find((s) => s.id === id) || null;
}

function create({ provider, cwd, title }) {
  const now = Date.now();
  const session = {
    id: uuidv4(),
    provider,
    cwd,
    title: title || `${provider}@${path.basename(cwd) || '~'}`,
    threadId: null, // populated by codex on first turn
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  sessions.unshift(session);
  persist();
  return session;
}

function update(id, patch) {
  const s = get(id);
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: Date.now() });
  persist();
  return s;
}

function appendMessage(id, message) {
  const s = get(id);
  if (!s) return null;
  s.messages.push({ ...message, timestamp: Date.now() });
  s.updatedAt = Date.now();
  persist();
  return s;
}

function revertLastExchange(id) {
  const s = get(id);
  if (!s || !s.messages.length) return null;
  // Find the last user message
  let lastUserIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return null;
  const userContent = s.messages[lastUserIdx].content;
  // Remove from lastUserIdx onwards (user msg + assistant response)
  s.messages.splice(lastUserIdx);
  s.updatedAt = Date.now();
  persist();
  return { session: s, content: userContent };
}

function remove(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  sessions.splice(idx, 1);
  persist();
  return true;
}

module.exports = {
  list,
  get,
  create,
  update,
  appendMessage,
  revertLastExchange,
  remove,
};
