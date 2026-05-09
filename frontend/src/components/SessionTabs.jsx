import { useState } from 'react';

export default function SessionTabs({ sessions, activeId, onSelect, onDelete, onRename }) {
  const [menuId, setMenuId] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const dotColor = (provider) =>
    provider === 'codex' ? 'bg-blue-400' :
    provider === 'windsurf' ? 'bg-purple-400' : 'bg-gray-400';

  const handleRename = (s) => {
    setMenuId(null);
    const next = prompt('Rename session:', s.title);
    if (next && next.trim() && next !== s.title) onRename(s.id, next.trim());
  };

  const handleDelete = (s) => {
    setMenuId(null);
    if (confirm(`Delete "${s.title}"?\n\nThis cannot be undone.`)) onDelete(s.id);
  };

  return (
    <>
      <div className="flex items-stretch bg-gray-900 border-b border-gray-800 shrink-0 relative">
        <div className="flex overflow-x-auto scrollbar-none flex-1 min-w-0">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group relative flex items-stretch shrink-0 border-b-2 ${
                s.id === activeId
                  ? 'border-emerald-500 bg-gray-800/40'
                  : 'border-transparent hover:bg-gray-800/20'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className={`flex items-center gap-2 pl-3 pr-1 py-2 whitespace-nowrap text-xs font-medium ${
                  s.id === activeId ? 'text-white' : 'text-gray-400'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor(s.provider)}`} />
                <span className="max-w-[140px] truncate">{s.title}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuId(menuId === s.id ? null : s.id);
                }}
                className="px-2 text-gray-500 hover:text-white flex items-center text-base leading-none"
                aria-label="Session menu"
              >
                ⋯
              </button>

              {menuId === s.id && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuId(null)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
                    <button
                      type="button"
                      onClick={() => handleRename(s)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-gray-200"
                    >
                      ✏️ Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(s)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-red-400"
                    >
                      🗑 Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* "All sessions" drawer trigger */}
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="px-3 text-gray-400 hover:text-white border-l border-gray-800 shrink-0"
          aria-label="All sessions"
          title="All sessions"
        >
          📋
        </button>
      </div>

      {showAll && (
        <AllSessionsDrawer
          sessions={sessions}
          activeId={activeId}
          dotColor={dotColor}
          onClose={() => setShowAll(false)}
          onSelect={(id) => { onSelect(id); setShowAll(false); }}
          onRename={(s) => {
            const next = prompt('Rename session:', s.title);
            if (next && next.trim() && next !== s.title) onRename(s.id, next.trim());
          }}
          onDelete={(s) => {
            if (confirm(`Delete "${s.title}"?\n\nThis cannot be undone.`)) onDelete(s.id);
          }}
        />
      )}
    </>
  );
}

// Full list of all sessions with delete / rename / multi-delete actions.
function AllSessionsDrawer({ sessions, activeId, dotColor, onClose, onSelect, onRename, onDelete }) {
  const [bulk, setBulk] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? sessions.filter((s) =>
        s.title?.toLowerCase().includes(query.toLowerCase()) ||
        s.provider?.toLowerCase().includes(query.toLowerCase()) ||
        s.cwd?.toLowerCase().includes(query.toLowerCase())
      )
    : sessions;

  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const deleteSelected = () => {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} session(s)?\n\nThis cannot be undone.`)) return;
    for (const id of selected) {
      const s = sessions.find((x) => x.id === id);
      if (s) onDelete(s);
    }
    setSelected(new Set());
    setBulk(false);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-md flex flex-col"
        style={{ maxHeight: '85dvh' }}>

        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold">
            历史会话
            <span className="ml-2 text-xs font-normal text-gray-500">
              {query.trim() ? `${filtered.length} / ${sessions.length}` : sessions.length}
            </span>
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setBulk((v) => !v); setSelected(new Set()); }}
              className={`text-xs px-2.5 py-1 rounded-lg ${
                bulk ? 'bg-emerald-600/20 text-emerald-300' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {bulk ? '完成' : '选择'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500 shrink-0">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题、provider、路径…"
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-gray-500 hover:text-white text-xs">✕</button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-8">
              {query.trim() ? '没有匹配的会话' : '暂无会话'}
            </p>
          )}
          {filtered.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-900 ${
                s.id === activeId ? 'bg-gray-800/40' : ''
              }`}
            >
              {bulk && (
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                  className="w-5 h-5 accent-emerald-500"
                />
              )}
              <button
                type="button"
                onClick={() => bulk ? toggle(s.id) : onSelect(s.id)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor(s.provider)}`} />
                <div className="min-w-0">
                  <p className="text-sm truncate">{s.title}</p>
                  <p className="text-[10px] text-gray-500 truncate">
                    {s.provider} · {s.messageCount || 0} msgs
                    {s.updatedAt ? ' · ' + new Date(s.updatedAt).toLocaleString() : ''}
                  </p>
                </div>
              </button>
              {!bulk && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onRename(s)}
                    className="text-gray-500 hover:text-white p-1.5"
                    aria-label="Rename"
                  >✏️</button>
                  <button
                    type="button"
                    onClick={() => onDelete(s)}
                    className="text-gray-500 hover:text-red-400 p-1.5"
                    aria-label="Delete"
                  >🗑</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {bulk && (
          <div className="px-5 py-3 border-t border-gray-800 shrink-0 flex gap-2">
            <button
              type="button"
              onClick={deleteSelected}
              disabled={!selected.size}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl text-sm font-medium"
            >
              Delete {selected.size || ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
