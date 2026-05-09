import { useState, useRef, useEffect } from 'react';

const MODELS_BY_PROVIDER = {
  windsurf: [
    { uid: 'claude-sonnet-4-6-thinking', label: 'Claude Sonnet 4.6 Thinking' },
    { uid: 'claude-opus-4-7',            label: 'Claude Opus 4.7 Medium' },
    { uid: 'claude-opus-4-6-thinking',   label: 'Claude Opus 4.6 Thinking' },
  ],
  codex: [
    { uid: 'gpt-5.5', label: 'GPT-5.5 (default)' },
    { uid: 'gpt-5.4', label: 'GPT-5.4' },
    { uid: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { uid: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { uid: 'gpt-5.2', label: 'GPT-5.2' },
  ],
};

const DEFAULT_BY_PROVIDER = {
  windsurf: 'claude-sonnet-4-6-thinking',
  codex: 'gpt-5.5',
};

export default function ModelSelector({ modelUid, onModelChange, disabled, provider }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const dropdownRef = useRef(null);

  const presets = MODELS_BY_PROVIDER[provider] || MODELS_BY_PROVIDER.windsurf;
  const defaultModel = DEFAULT_BY_PROVIDER[provider] || 'o4-mini';
  const current = modelUid || defaultModel;
  const preset = presets.find((m) => m.uid === current);
  const displayLabel = preset ? preset.label : current;

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!dropdownRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = (uid) => {
    onModelChange(uid);
    setOpen(false);
    setCustom('');
  };

  const submitCustom = () => {
    const uid = custom.trim();
    if (uid) select(uid);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono transition-colors
          ${disabled
            ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
            : 'bg-gray-800 text-emerald-400 hover:bg-gray-700 cursor-pointer'
          }`}
        title="Switch model"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span className="max-w-[140px] truncate">{displayLabel}</span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-1 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-xl w-56 py-1 text-sm">
          {presets.map((m) => (
            <button
              key={m.uid}
              onClick={() => select(m.uid)}
              className={`w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors flex items-center justify-between gap-2
                ${current === m.uid ? 'text-emerald-400' : 'text-gray-200'}`}
            >
              <span>{m.label}</span>
              {current === m.uid && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}

          <div className="border-t border-gray-800 mt-1 pt-1 px-2 pb-1">
            <p className="text-xs text-gray-500 mb-1 px-1">Custom model UID</p>
            <div className="flex gap-1">
              <input
                type="text"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
                placeholder="e.g. gpt-4o-mini"
                className="flex-1 bg-gray-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-1 focus:ring-emerald-500 placeholder-gray-600 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                onClick={submitCustom}
                disabled={!custom.trim()}
                className="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-xs font-medium transition-colors"
              >
                Set
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
