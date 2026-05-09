import { useState, useEffect } from 'react';

const DEFAULT_TEMPLATES = [
  { label: '🐛 Fix bug', text: 'Find and fix the bug in: ' },
  { label: '🧪 Add tests', text: 'Add tests for: ' },
  { label: '📖 Explain', text: 'Explain how this works: ' },
  { label: '♻️ Refactor', text: 'Refactor this for clarity and performance: ' },
  { label: '⚡ Optimize', text: 'Optimize this code: ' },
  { label: '📝 Document', text: 'Add docstrings/comments to: ' },
  { label: '🚀 Build feature', text: 'Implement: ' },
  { label: '🔍 Code review', text: 'Review the recent changes for issues, edge cases, and improvements.' },
  { label: '🧹 Clean up', text: 'Clean up unused code, imports and TODOs in the project.' },
  { label: '📋 Summarize', text: 'Summarize what this project does and its structure.' },
];

const STORAGE_KEY = 'promptTemplates';

function loadTemplates() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch (_) {}
  return DEFAULT_TEMPLATES;
}

function saveTemplates(t) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

export default function PromptTemplates({ onPick, onClose }) {
  const [templates, setTemplates] = useState(loadTemplates);
  const [editing, setEditing] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newText, setNewText] = useState('');

  useEffect(() => { saveTemplates(templates); }, [templates]);

  const addTemplate = () => {
    if (!newLabel.trim() || !newText.trim()) return;
    setTemplates([...templates, { label: newLabel.trim(), text: newText.trim() }]);
    setNewLabel('');
    setNewText('');
  };

  const removeTemplate = (idx) => {
    setTemplates(templates.filter((_, i) => i !== idx));
  };

  return (
    <div className="border-t border-gray-800 bg-gray-900 max-h-[50vh] overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 sticky top-0 bg-gray-900 border-b border-gray-800">
        <span className="text-xs uppercase tracking-wider text-gray-500">Prompt Templates</span>
        <div className="flex gap-1">
          <button
            onClick={() => setEditing((v) => !v)}
            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded"
          >
            {editing ? 'Done' : 'Edit'}
          </button>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white w-6 h-6 flex items-center justify-center rounded"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="p-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {templates.map((t, i) => (
          <div key={i} className="relative">
            <button
              onClick={() => !editing && onPick(t.text)}
              className="w-full text-left px-2.5 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-200 transition-colors"
            >
              {t.label}
            </button>
            {editing && (
              <button
                onClick={() => removeTemplate(i)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] flex items-center justify-center"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className="p-3 border-t border-gray-800 space-y-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. 🎨 Style)"
            className="w-full bg-gray-800 text-sm text-white rounded px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Prompt text"
            className="w-full bg-gray-800 text-sm text-white rounded px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <button
            onClick={addTemplate}
            className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-sm font-medium"
          >
            Add template
          </button>
        </div>
      )}
    </div>
  );
}
