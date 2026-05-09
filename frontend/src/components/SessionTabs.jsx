import { useState, useRef, useEffect } from 'react';

export default function SessionTabs({ sessions, activeId, onSelect, onDelete, onRename }) {
  const [menuId, setMenuId]         = useState(null);
  const [menuPos, setMenuPos]       = useState({ top: 0, right: 0 });
  const [confirmDel, setConfirmDel] = useState(false);
  const [editingId, setEditingId]   = useState(null);
  const [editValue, setEditValue]   = useState('');
  const [showAll, setShowAll]       = useState(false);
  const editRef = useRef(null);

  const dotColor = (provider) =>
    provider === 'codex' ? 'bg-blue-400' :
    provider === 'windsurf' ? 'bg-purple-400' : 'bg-gray-400';

  const openMenu = (e, id) => {
    e.stopPropagation();
    if (menuId === id) { setMenuId(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setMenuId(id);
    setConfirmDel(false);
  };

  const closeMenu = () => { setMenuId(null); setConfirmDel(false); };

  const startRename = (s) => {
    closeMenu();
    setEditingId(s.id);
    setEditValue(s.title);
    setTimeout(() => editRef.current?.focus(), 30);
  };

  const submitRename = (s) => {
    const v = editValue.trim();
    if (v && v !== s.title) onRename(s.id, v);
    setEditingId(null);
  };

  useEffect(() => {
    if (!menuId) return;
    const handler = (e) => {
      if (!e.target.closest('[data-session-menu]')) closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuId]);

  const menuSession = sessions.find((s) => s.id === menuId);

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
              {editingId === s.id ? (
                <input
                  ref={editRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => submitRename(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(s);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="pl-3 pr-1 py-2 w-32 bg-gray-700 text-white text-xs rounded outline-none focus:ring-1 focus:ring-emerald-500"
                />
              ) : (
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
              )}
              <button
                type="button"
                onClick={(e) => openMenu(e, s.id)}
                className="px-2 text-gray-500 hover:text-white flex items-center text-base leading-none"
                aria-label="Session menu"
              >
                ⋯
              </button>
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

      {/* Fixed dropdown — outside overflow-x-auto so it's never clipped */}
      {menuId && menuSession && (
        <div
          data-session-menu
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ top: menuPos.top, right: menuPos.right }}
        >
          <button
            type="button"
            onClick={() => startRename(menuSession)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-gray-200 flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            重命名
          </button>
          {confirmDel ? (
            <div className="px-3 py-2">
              <p className="text-xs text-gray-400 mb-2">确认删除此会话？</p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => { closeMenu(); onDelete(menuSession.id); }}
                  className="flex-1 py-1 bg-red-600 hover:bg-red-500 rounded text-xs text-white"
                >删除</button>
                <button
                  type="button"
                  onClick={() => setConfirmDel(false)}
                  className="flex-1 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                >取消</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDel(true)}
              className="w-full text-left px-3 py-2 text-xs hover:bg-gray-700 text-red-400 flex items-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              删除会话
            </button>
          )}
        </div>
      )}

      {showAll && (
        <AllSessionsDrawer
          sessions={sessions}
          activeId={activeId}
          dotColor={dotColor}
          onClose={() => setShowAll(false)}
          onSelect={(id) => { onSelect(id); setShowAll(false); }}
          onRename={(s) => startRename(s)}
          onDelete={(s) => onDelete(s.id)}
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
    for (const id of selected) onDelete(id);
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
