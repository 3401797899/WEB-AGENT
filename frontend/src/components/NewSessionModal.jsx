import { useState, useEffect, useCallback } from 'react';

const PROVIDERS = [
  { id: 'codex', label: 'Codex', emoji: '🔷' },
  { id: 'windsurf', label: 'Windsurf', emoji: '🪄' },
];

export default function NewSessionModal({ wsRef, onClose, onCreate, onAttachWindsurf }) {
  const [provider, setProvider] = useState('codex');

  // Codex: directory browser state
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [entries, setEntries] = useState([]);
  const [dirLoading, setDirLoading] = useState(true);
  const [dirError, setDirError] = useState('');

  // Windsurf state
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWs, setSelectedWs] = useState(null);
  const [trajectories, setTrajectories] = useState([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState('');
  // Windsurf custom dir browser
  const [wsCustomDir, setWsCustomDir] = useState(false);
  const [wsCurrentPath, setWsCurrentPath] = useState('');
  const [wsParentPath, setWsParentPath] = useState(null);
  const [wsEntries, setWsEntries] = useState([]);
  const [wsDirLoading, setWsDirLoading] = useState(false);

  const send = useCallback(
    (m) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    [wsRef]
  );

  const requestDir = useCallback(
    (p) => {
      setDirLoading(true);
      setDirError('');
      send({ type: 'list_dir', path: p || undefined });
    },
    [send]
  );

  // Listen for replies
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'dir_listing') {
        if (msg._for === 'windsurf') {
          setWsCurrentPath(msg.path);
          setWsParentPath(msg.parent);
          setWsEntries(msg.entries || []);
          setWsDirLoading(false);
        } else {
          setCurrentPath(msg.path);
          setParentPath(msg.parent);
          setEntries(msg.entries || []);
          setDirLoading(false);
        }
      } else if (msg.type === 'dir_error') {
        setDirError(msg.message);
        setDirLoading(false);
      } else if (msg.type === 'windsurf_workspaces') {
        setWorkspaces(msg.workspaces || []);
        setWsLoading(false);
        if (!msg.workspaces?.length) {
          setWsError('No running Windsurf IDE detected. Open a workspace in Windsurf first.');
        }
      } else if (msg.type === 'windsurf_trajectories') {
        setTrajectories(msg.trajectories || []);
        setWsLoading(false);
      } else if (msg.type === 'error') {
        setWsError(msg.message);
        setWsLoading(false);
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [wsRef]);

  // Initial load when provider changes
  useEffect(() => {
    setWsError('');
    if (provider === 'codex') {
      requestDir();
    } else if (provider === 'windsurf') {
      setWsLoading(true);
      setWorkspaces([]);
      setSelectedWs(null);
      setTrajectories([]);
      send({ type: 'list_windsurf_workspaces' });
    }
  }, [provider, send, requestDir]);

  const pickWorkspace = (w) => {
    setSelectedWs(w);
    setWsLoading(true);
    setTrajectories([]);
    send({ type: 'list_windsurf_trajectories', workspacePath: w.workspacePath });
  };

  const openWsCustomDir = (p) => {
    setWsDirLoading(true);
    send({ type: 'list_dir', path: p || undefined, _for: 'windsurf' });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-md flex flex-col"
        style={{ maxHeight: '85dvh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold">New Session</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"
          >✕</button>
        </div>

        {/* Provider selector */}
        <div className="px-5 py-4 border-b border-gray-800 shrink-0">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Provider</p>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => setProvider(p.id)}
                className={`flex items-center gap-2 py-2.5 px-3 rounded-xl text-sm font-medium transition-all border ${
                  provider === p.id
                    ? p.id === 'codex'
                      ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                      : 'bg-purple-600/20 border-purple-500 text-purple-300'
                    : 'bg-gray-800 border-transparent text-gray-400'
                }`}
              >
                <span>{p.emoji}</span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Provider-specific body */}
        {provider === 'codex' && (
          <CodexBrowser
            currentPath={currentPath}
            parentPath={parentPath}
            entries={entries}
            loading={dirLoading}
            error={dirError}
            onRequest={requestDir}
            onCreate={() => onCreate('codex', currentPath)}
          />
        )}

        {provider === 'windsurf' && (
          <WindsurfPicker
            workspaces={workspaces}
            selectedWs={selectedWs}
            trajectories={trajectories}
            loading={wsLoading}
            error={wsError}
            onPickWorkspace={pickWorkspace}
            onBack={() => { setSelectedWs(null); setTrajectories([]); }}
            onNewTrajectory={() => onCreate('windsurf', selectedWs.workspacePath)}
            onAttach={(t) =>
              onAttachWindsurf({
                cascadeId: t.cascadeId,
                workspacePath: selectedWs.workspacePath,
                title: t.title,
              })
            }
            customDir={wsCustomDir}
            onOpenCustomDir={() => { setWsCustomDir(true); openWsCustomDir(); }}
            onCloseCustomDir={() => setWsCustomDir(false)}
            customCurrentPath={wsCurrentPath}
            customParentPath={wsParentPath}
            customEntries={wsEntries}
            customDirLoading={wsDirLoading}
            onBrowseCustomDir={openWsCustomDir}
            onCreateCustom={() => onCreate('windsurf', wsCurrentPath)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Codex sub-views ──────────────────────────────────────────────────────

function CodexBrowser({ currentPath, parentPath, entries, loading, error, onRequest, onCreate }) {
  return (
    <>
      <div className="flex-1 flex flex-col px-5 py-4 min-h-0 overflow-hidden">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 shrink-0">
          Working Directory
        </p>
        <code className="text-xs text-emerald-400 truncate font-mono mb-2 shrink-0">
          {currentPath || '…'}
        </code>
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

        <div className="flex-1 bg-gray-950 rounded-xl overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-24 text-gray-500 text-sm">Loading…</div>
          ) : (
            <div>
              {parentPath && (
                <button
                  onClick={() => onRequest(parentPath)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800 text-left"
                >
                  <span className="text-gray-500">📁</span>
                  <span className="text-sm text-gray-400">..</span>
                </button>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.fullPath}
                  onClick={() => entry.isDir && onRequest(entry.fullPath)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                    entry.isDir ? 'hover:bg-gray-800' : 'opacity-40'
                  }`}
                >
                  <span>{entry.isDir ? '📂' : '📄'}</span>
                  <span className="text-sm truncate">{entry.name}</span>
                </button>
              ))}
              {!entries.length && (
                <p className="text-center text-gray-600 text-sm py-6">Empty directory</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="px-5 pb-5 pt-2 shrink-0">
        <button
          onClick={onCreate}
          disabled={!currentPath}
          className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-medium"
        >
          Create Session
        </button>
      </div>
    </>
  );
}

// ─── Windsurf sub-views ───────────────────────────────────────────────────

function WindsurfPicker({
  workspaces, selectedWs, trajectories, loading, error,
  onPickWorkspace, onBack, onNewTrajectory, onAttach,
  customDir, onOpenCustomDir, onCloseCustomDir,
  customCurrentPath, customParentPath, customEntries, customDirLoading,
  onBrowseCustomDir, onCreateCustom,
}) {
  if (customDir) {
    return (
      <>
        <div className="flex-1 flex flex-col px-5 py-4 min-h-0 overflow-hidden">
          <div className="flex items-center gap-2 mb-2 shrink-0">
            <button onClick={onCloseCustomDir} className="text-xs text-gray-400 hover:text-white">‹ back</button>
            <p className="text-xs text-gray-500 uppercase tracking-wider">自定义目录</p>
          </div>
          <code className="text-xs text-purple-400 truncate font-mono mb-2 shrink-0">
            {customCurrentPath || '…'}
          </code>
          <div className="flex-1 bg-gray-950 rounded-xl overflow-y-auto min-h-0">
            {customDirLoading ? (
              <div className="flex items-center justify-center h-24 text-gray-500 text-sm">Loading…</div>
            ) : (
              <div>
                {customParentPath && (
                  <button onClick={() => onBrowseCustomDir(customParentPath)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800 text-left">
                    <span className="text-gray-500">📁</span>
                    <span className="text-sm text-gray-400">..</span>
                  </button>
                )}
                {customEntries.map((entry) => (
                  <button key={entry.fullPath}
                    onClick={() => entry.isDir && onBrowseCustomDir(entry.fullPath)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${entry.isDir ? 'hover:bg-gray-800' : 'opacity-40'}`}>
                    <span>{entry.isDir ? '📂' : '📄'}</span>
                    <span className="text-sm truncate">{entry.name}</span>
                  </button>
                ))}
                {!customEntries.length && (
                  <p className="text-center text-gray-600 text-sm py-6">Empty directory</p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="px-5 pb-5 pt-2 shrink-0">
          <button onClick={onCreateCustom} disabled={!customCurrentPath}
            className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-medium">
            在此目录创建 Cascade
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex-1 flex flex-col px-5 py-4 min-h-0 overflow-hidden">
        {!selectedWs ? (
          <>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 shrink-0">
              Pick a Windsurf workspace
            </p>
            {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
            <div className="flex-1 bg-gray-950 rounded-xl overflow-y-auto min-h-0">
              {loading ? (
                <div className="flex items-center justify-center h-24 text-gray-500 text-sm">
                  Detecting…
                </div>
              ) : (
                <>
                  {workspaces.length === 0 && (
                    <p className="text-center text-gray-600 text-sm py-6 px-4">
                      No running Windsurf workspace.<br />
                      Open one in the Windsurf IDE first.
                    </p>
                  )}
                  {workspaces.map((w) => (
                    <button
                      key={w.pid}
                      onClick={() => onPickWorkspace(w)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800 text-left border-b border-gray-900"
                    >
                      <span>🪄</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">
                          {w.workspacePath ? w.workspacePath.split('/').pop() : '(unknown)'}
                        </p>
                        <p className="text-xs text-gray-500 truncate font-mono">
                          {w.workspacePath || w.workspaceId}
                        </p>
                      </div>
                      <span className="text-gray-500">›</span>
                    </button>
                  ))}
                  <button onClick={onOpenCustomDir}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800 text-left border-t border-gray-800 text-purple-400">
                    <span>📂</span>
                    <span className="text-sm font-medium">自选目录…</span>
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <button
              onClick={onBack}
              className="text-xs text-gray-400 hover:text-white mb-2 self-start"
            >‹ back</button>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1 shrink-0">
              {selectedWs.workspacePath?.split('/').pop()}
            </p>
            <p className="text-[10px] text-gray-600 truncate font-mono mb-3 shrink-0">
              {selectedWs.workspacePath}
            </p>

            <div className="flex-1 bg-gray-950 rounded-xl overflow-y-auto min-h-0">
              <button
                onClick={onNewTrajectory}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800 text-left border-b border-gray-900 text-emerald-400"
              >
                <span>✨</span>
                <span className="text-sm font-medium">Start a new Cascade</span>
              </button>

              {loading ? (
                <div className="flex items-center justify-center h-24 text-gray-500 text-sm">
                  Loading…
                </div>
              ) : (
                <>
                  {trajectories.length > 0 && (
                    <p className="text-[10px] text-gray-600 uppercase tracking-wider px-4 py-2">
                      Recent Cascades
                    </p>
                  )}
                  {trajectories.map((t) => (
                    <button
                      key={t.cascadeId}
                      onClick={() => onAttach(t)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800 text-left border-b border-gray-900"
                    >
                      <span>{t.status === 'CASCADE_RUN_STATUS_RUNNING' ? '⏳' : '💬'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate">{t.title}</p>
                        <p className="text-[10px] text-gray-500">
                          {t.stepCount} steps · {new Date(t.lastModifiedTime).toLocaleString()}
                        </p>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
