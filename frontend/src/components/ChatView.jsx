import { useEffect, useRef, useMemo, useState, memo } from 'react';
import MessageBubble from './MessageBubble';
import StreamingTurn from './StreamingTurn';

const PAGE = 50; // messages rendered per page

export default function ChatView({ session, streamingEvents, turnRunning, onLoadHistory, loadingHistory, onEditLastMessage, onRevertLastExchange }) {
  const scrollRef = useRef(null);
  const [showAll, setShowAll] = useState(false);

  const messages = session.messages || [];

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingEvents.length, turnRunning]);

  // Reset showAll when session changes
  useEffect(() => { setShowAll(false); }, [session.id]);

  const visibleMessages = showAll ? messages : messages.slice(-PAGE);
  const hiddenCount = messages.length - visibleMessages.length;

  const empty = messages.length === 0 && streamingEvents.length === 0 && !turnRunning;

  const dirShort = useMemo(() => {
    const parts = (session.cwd || '').split('/').filter(Boolean);
    if (parts.length <= 2) return session.cwd;
    return '…/' + parts.slice(-2).join('/');
  }, [session.cwd]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Session meta header */}
        <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mb-2">
          <span className="bg-gray-800 px-2 py-0.5 rounded">{session.provider}</span>
          <span className="font-mono truncate">{dirShort}</span>
        </div>

        {empty && (
          <div className="text-center text-gray-500 mt-12 space-y-4">
            {session.provider === 'windsurf' && session.threadId && onLoadHistory ? (
              <>
                <p className="text-sm">此会话已关联 Windsurf Cascade，可加载历史消息。</p>
                <button
                  onClick={() => onLoadHistory(session.id)}
                  disabled={loadingHistory || turnRunning}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl text-sm font-medium transition-colors"
                >
                  {loadingHistory ? (
                    <>
                      <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      加载中…
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      加载历史记录
                    </>
                  )}
                </button>
                <p className="text-xs text-gray-600">或直接发消息继续对话</p>
              </>
            ) : (
              <p className="text-sm">Send a message to start the conversation.</p>
            )}
          </div>
        )}

        {hiddenCount > 0 && (
          <div className="text-center">
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1 rounded-full border border-gray-700 hover:border-gray-500 transition-colors"
            >
              ↑ 显示更早的 {hiddenCount} 条消息
            </button>
          </div>
        )}
        {visibleMessages.map((m, i) => {
          // Find if this is the last user message in the full messages array
          const globalIdx = messages.length - visibleMessages.length + i;
          let isLastUser = false;
          if (m.role === 'user') {
            let foundLater = false;
            for (let j = globalIdx + 1; j < messages.length; j++) {
              if (messages[j].role === 'user') { foundLater = true; break; }
            }
            isLastUser = !foundLater;
          }
          return (
            <MessageBubble
              key={m.timestamp || m.id || Math.random()}
              message={m}
              isLastUser={isLastUser}
              onEdit={() => onEditLastMessage?.(m.content)}
              onRevert={() => onRevertLastExchange?.()}
              turnRunning={turnRunning}
            />
          );
        })}

        {turnRunning && (
          <StreamingTurn events={streamingEvents} turnRunning={turnRunning} />
        )}
      </div>
    </div>
  );
}
