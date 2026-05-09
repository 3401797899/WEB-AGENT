import { useState, useEffect } from 'react';

const DEFAULTS = {
  codex:    { command: 'codex',    args: '' },
  windsurf: { command: 'windsurf', args: '' },
};

export function loadProviderSettings() {
  try {
    return JSON.parse(localStorage.getItem('providerSettings')) || DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export default function SettingsModal({ onClose, onSave }) {
  const [settings, setSettings] = useState(() => {
    const saved = loadProviderSettings();
    // Merge with defaults in case new keys were added
    return {
      codex:    { ...DEFAULTS.codex,    ...saved.codex },
      windsurf: { ...DEFAULTS.windsurf, ...saved.windsurf },
    };
  });

  const handleChange = (provider, field, value) => {
    setSettings((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  const handleSave = () => {
    localStorage.setItem('providerSettings', JSON.stringify(settings));
    onSave(settings);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold">Provider Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Providers */}
        <div className="p-5 space-y-6 overflow-y-auto">
          {['codex', 'windsurf'].map((provider) => (
            <div key={provider}>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">
                {provider === 'codex' ? '🔷 Codex' : '🪄 Windsurf'}
              </p>
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Executable path
                  </label>
                  <input
                    type="text"
                    value={settings[provider].command}
                    onChange={(e) => handleChange(provider, 'command', e.target.value)}
                    placeholder={`e.g. /usr/local/bin/${provider}`}
                    className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-emerald-500 font-mono placeholder-gray-600"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">
                    Extra arguments <span className="text-gray-600">(space-separated)</span>
                  </label>
                  <input
                    type="text"
                    value={settings[provider].args}
                    onChange={(e) => handleChange(provider, 'args', e.target.value)}
                    placeholder={`e.g. --model gpt-4o`}
                    className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-emerald-500 font-mono placeholder-gray-600"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          ))}

          <p className="text-xs text-gray-600">
            Settings are saved locally and pushed to the backend each time you connect.
          </p>
        </div>

        {/* Save */}
        <div className="px-5 pb-5 pt-2 border-t border-gray-800">
          <button
            onClick={handleSave}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl font-medium transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
