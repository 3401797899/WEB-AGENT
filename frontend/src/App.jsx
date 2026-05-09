import { useState, useEffect, useRef, useCallback } from 'react';
import SessionTabs from './components/SessionTabs';
import ChatView from './components/ChatView';
import MessageInput from './components/MessageInput';
import NewSessionModal from './components/NewSessionModal';
import SettingsModal, { loadProviderSettings } from './components/SettingsModal';

const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (import.meta.env.PROD
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    : `ws://${window.location.hostname}:3001`);

export default function App() {
  // Sessions list (lightweight: id, provider, cwd, title, updatedAt, messageCount)
  const [sessions, setSessions] = useState([]);
  // Full active session data (with messages)
  const [activeSession, setActiveSession] = useState(null);
  const [activeId, setActiveId] = useState(null);
  // Live-streaming events for the in-progress turn (cleared on turn_done)
  const [streamingEvents, setStreamingEvents] = useState([]);
  const [turnRunning, setTurnRunning] = useState(false);

  const [showNewModal, setShowNewModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [windsurfQuota, setWindsurfQuota] = useState(null);
  const wsRef = useRef(null);
  const activeIdRef = useRef(null);
  const activeProviderRef = useRef(null);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { activeProviderRef.current = activeSession?.provider ?? null; }, [activeSession?.provider]);

  const sendWs = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const showToast = useCallback((text, kind = 'error') => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // ── WebSocket lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    let ws;

    const connect = () => {
      if (dead) return;
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        const saved = loadProviderSettings();
        ws.send(JSON.stringify({ type: 'update_providers', providers: saved }));
        // Re-subscribe to the active session on reconnect so buffered events are replayed
        if (activeIdRef.current) {
          ws.send(JSON.stringify({ type: 'load_session', sessionId: activeIdRef.current }));
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {};

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        switch (msg.type) {
          case 'sessions_list': {
            setSessions(msg.sessions || []);
            // Auto-select first session if none selected
            if (!activeIdRef.current && msg.sessions?.length) {
              const id = msg.sessions[0].id;
              setActiveId(id);
              ws.send(JSON.stringify({ type: 'load_session', sessionId: id }));
              if (msg.sessions[0].provider === 'windsurf') {
                ws.send(JSON.stringify({ type: 'get_windsurf_quota' }));
              }
            }
            break;
          }
          case 'session_data': {
            setActiveSession(msg.session);
            setStreamingEvents([]);
            if (msg.session.provider === 'windsurf') {
              ws.send(JSON.stringify({ type: 'get_windsurf_quota' }));
            }
            break;
          }
          case 'session_created': {
            setActiveSession(msg.session);
            setActiveId(msg.session.id);
            setStreamingEvents([]);
            break;
          }
          case 'session_updated': {
            // Refresh session if it's the active one
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.id === msg.session.id);
              const lite = {
                id: msg.session.id,
                provider: msg.session.provider,
                cwd: msg.session.cwd,
                title: msg.session.title,
                updatedAt: msg.session.updatedAt,
                createdAt: msg.session.createdAt,
                messageCount: msg.session.messages.length,
              };
              if (idx === -1) return [lite, ...prev];
              const next = [...prev];
              next[idx] = lite;
              return next;
            });
            if (activeIdRef.current === msg.session.id) {
              setActiveSession(msg.session);
            }
            break;
          }
          case 'event': {
            if (msg.sessionId === activeIdRef.current) {
              setStreamingEvents((prev) => [...prev, msg.event]);
            }
            break;
          }
          case 'stderr': {
            // Could show as small subtle log; ignore for now
            break;
          }
          case 'turn_running': {
            if (msg.sessionId === activeIdRef.current) setTurnRunning(true);
            break;
          }
          case 'turn_done': {
            if (msg.sessionId === activeIdRef.current) {
              setTurnRunning(false);
              setStreamingEvents([]);
              // Refresh windsurf quota after each turn
              if (activeProviderRef.current === 'windsurf') {
                ws.send(JSON.stringify({ type: 'get_windsurf_quota' }));
              }
            }
            break;
          }
          case 'turn_cancelled': {
            if (msg.sessionId === activeIdRef.current) {
              setTurnRunning(false);
              setStreamingEvents([]);
              showToast('Turn cancelled', 'info');
            }
            break;
          }
          case 'windsurf_quota': {
            setWindsurfQuota(msg.error ? { error: msg.error } : (msg.data || {}));
            break;
          }
          case 'history_loaded': {
            setLoadingHistory(false);
            showToast(`已加载 ${msg.count} 条历史消息`, 'success');
            break;
          }
          case 'error': {
            showToast(msg.message);
            setTurnRunning(false);
            setLoadingHistory(false);
            break;
          }
          default:
            break;
        }
      };
    };

    connect();
    return () => { dead = true; ws?.close(); };
  }, [showToast]);

  // ── Actions ────────────────────────────────────────────────────────────
  const selectSession = useCallback((id) => {
    setActiveId(id);
    setStreamingEvents([]);
    setTurnRunning(false);
    setWindsurfQuota(null);
    sendWs({ type: 'load_session', sessionId: id });
    // Fetch quota if session is windsurf
    const s = sessions.find((s) => s.id === id);
    if (s?.provider === 'windsurf') {
      sendWs({ type: 'get_windsurf_quota' });
    }
  }, [sendWs, sessions]);

  const createSession = useCallback((provider, cwd) => {
    sendWs({ type: 'create_session', provider, cwd });
    setShowNewModal(false);
  }, [sendWs]);

  const attachWindsurfTrajectory = useCallback(({ cascadeId, workspacePath, title }) => {
    sendWs({ type: 'attach_windsurf_trajectory', cascadeId, workspacePath, title });
    setShowNewModal(false);
  }, [sendWs]);

  const sendMessage = useCallback((content) => {
    if (!activeId || !content.trim()) return;
    setTurnRunning(true);
    setStreamingEvents([]);
    sendWs({ type: 'send_message', sessionId: activeId, content });
  }, [activeId, sendWs]);

  const cancelTurn = useCallback(() => {
    if (!activeId) return;
    sendWs({ type: 'cancel_turn', sessionId: activeId });
  }, [activeId, sendWs]);

  const deleteSession = useCallback((id) => {
    sendWs({ type: 'delete_session', sessionId: id });
    if (id === activeId) {
      setActiveId(null);
      setActiveSession(null);
    }
  }, [activeId, sendWs]);

  const renameSession = useCallback((id, title) => {
    sendWs({ type: 'rename_session', sessionId: id, title });
  }, [sendWs]);

  const updateModel = useCallback((sessionId, modelUid) => {
    sendWs({ type: 'update_model', sessionId, modelUid });
  }, [sendWs]);

  const updateReasoningEffort = useCallback((sessionId, reasoningEffort) => {
    sendWs({ type: 'update_reasoning_effort', sessionId, reasoningEffort });
  }, [sendWs]);

  const loadWindsurfHistory = useCallback((sessionId) => {
    setLoadingHistory(true);
    sendWs({ type: 'load_windsurf_history', sessionId });
  }, [sendWs]);

  return (
    <div className="flex flex-col bg-gray-950 text-white" style={{ height: '100dvh' }}>
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg max-w-[90vw] text-center ${
            toast.kind === 'error' ? 'bg-red-600' :
            toast.kind === 'info' ? 'bg-gray-700' : 'bg-emerald-600'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold tracking-tight shrink-0">
            <span className="text-emerald-400">AI</span> Relay
          </span>
          <div
            className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`}
            title={connected ? 'Connected' : 'Reconnecting…'}
          />
          {activeSession && (
            <span className="text-xs text-gray-500 truncate ml-1 hidden sm:block">
              {activeSession.cwd}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            title="Settings"
          >
            ⚙️
          </button>
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 rounded-lg text-sm font-medium transition-all"
          >
            + New
          </button>
        </div>
      </header>

      {/* Tabs */}
      {sessions.length > 0 && (
        <SessionTabs
          sessions={sessions}
          activeId={activeId}
          onSelect={selectSession}
          onDelete={deleteSession}
          onRename={renameSession}
        />
      )}

      {/* Chat area */}
      <main className="flex-1 overflow-hidden flex flex-col min-h-0">
        {!activeSession ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="text-6xl select-none">🤖</div>
            <div>
              <p className="text-gray-300 text-lg font-medium">Welcome to AI Relay</p>
              <p className="text-gray-500 text-sm mt-1">
                Send tasks to Codex from anywhere. Sessions are saved locally.
              </p>
            </div>
            <button
              onClick={() => setShowNewModal(true)}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors"
            >
              Start a new session
            </button>
          </div>
        ) : (
          <ChatView
            session={activeSession}
            streamingEvents={streamingEvents}
            turnRunning={turnRunning}
            onLoadHistory={loadWindsurfHistory}
            loadingHistory={loadingHistory}
          />
        )}
      </main>

      {/* Input */}
      {activeSession && (
        <MessageInput
          onSend={sendMessage}
          onCancel={cancelTurn}
          turnRunning={turnRunning}
          provider={activeSession.provider}
          modelUid={activeSession.modelUid}
          onModelChange={(uid) => updateModel(activeSession.id, uid)}
          reasoningEffort={activeSession.reasoningEffort}
          onReasoningEffortChange={(e) => updateReasoningEffort(activeSession.id, e)}
          windsurfQuota={windsurfQuota}
          onRefreshQuota={() => sendWs({ type: 'get_windsurf_quota' })}
        />
      )}

      {/* Modals */}
      {showNewModal && (
        <NewSessionModal
          wsRef={wsRef}
          onClose={() => setShowNewModal(false)}
          onCreate={createSession}
          onAttachWindsurf={attachWindsurfTrajectory}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={(settings) => sendWs({ type: 'update_providers', providers: settings })}
        />
      )}
    </div>
  );
}
