import { useState, useRef, useEffect } from 'react';
import PromptTemplates from './PromptTemplates';
import ModelSelector from './ModelSelector';

const SpeechRec = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null;

function getCapacityStatus(data) {
  if (!data || data.error) return null;
  if (data.hasCapacity === true)  return 'ok';
  if (data.hasCapacity === false) return 'full';
  return null;
}

const EFFORT_LEVELS = [
  { value: 'low',        label: '低' },
  { value: 'medium',     label: '中' },
  { value: 'high',       label: '高' },
  { value: 'extra_high', label: '极高' },
];

export default function MessageInput({ onSend, onCancel, turnRunning, provider, modelUid, onModelChange, reasoningEffort, onReasoningEffortChange, windsurfQuota, onRefreshQuota }) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const textareaRef = useRef(null);
  const recognitionRef = useRef(null);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !turnRunning) {
      e.preventDefault();
      submit();
    }
  };

  const handleChange = (e) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  // Voice input via Web Speech API
  const toggleVoice = () => {
    if (!SpeechRec) {
      alert('Voice input not supported on this browser.');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SpeechRec();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    let finalTranscript = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript;
        else interim += r[0].transcript;
      }
      setValue((prev) => {
        // Replace the previously-listening interim text
        return (finalTranscript || interim);
      });
    };
    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);

    recognitionRef.current = rec;
    rec.start();
  };

  useEffect(() => () => recognitionRef.current?.stop?.(), []);

  return (
    <div className="shrink-0 border-t border-gray-800 bg-gray-900">
      {showTemplates && (
        <PromptTemplates
          onPick={(text) => {
            setValue(text);
            setShowTemplates(false);
            setTimeout(() => textareaRef.current?.focus(), 50);
          }}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {(onModelChange || (provider === 'codex' && onReasoningEffortChange) || provider === 'windsurf') && (
        <div className="px-3 pt-2 flex items-center gap-3 flex-wrap">
          {onModelChange && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">模型</span>
              <ModelSelector
                modelUid={modelUid}
                onModelChange={onModelChange}
                disabled={turnRunning}
                provider={provider}
              />
            </div>
          )}
          {provider === 'windsurf' && (() => {
            const status = getCapacityStatus(windsurfQuota);
            return (
              <div className="flex items-center gap-2 ml-auto">
                {windsurfQuota?.error ? (
                  <span className="text-xs text-red-400 opacity-70" title={windsurfQuota.error}>配额获取失败</span>
                ) : status === 'ok' ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                    配额充足
                  </span>
                ) : status === 'full' ? (
                  <span className="flex items-center gap-1.5 text-xs text-red-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
                    配额已用尽
                  </span>
                ) : windsurfQuota !== null ? (
                  <span className="text-xs text-gray-500">配额未知</span>
                ) : (
                  <span className="text-xs text-gray-600">配额查询中…</span>
                )}
                {onRefreshQuota && (
                  <button
                    onClick={onRefreshQuota}
                    disabled={turnRunning}
                    className="text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-40"
                    title="刷新配额"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })()}

          {provider === 'codex' && onReasoningEffortChange && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">思考</span>
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                {EFFORT_LEVELS.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => !turnRunning && onReasoningEffortChange(reasoningEffort === value ? null : value)}
                    disabled={turnRunning}
                    className={`px-2.5 py-0.5 text-xs font-medium transition-colors
                      ${ (reasoningEffort || 'medium') === value
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="px-3 pt-2 pb-safe pb-2.5">
        <div className="flex gap-2 items-end">
          <button
            onClick={() => setShowTemplates((v) => !v)}
            className="w-10 h-10 shrink-0 flex items-center justify-center text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors"
            title="Prompt templates"
          >
            ✨
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={turnRunning ? 'Codex is working…' : 'Send a message…'}
            disabled={turnRunning}
            rows={1}
            className="flex-1 bg-gray-800 text-white text-sm rounded-xl px-3.5 py-2.5 resize-none outline-none focus:ring-1 focus:ring-emerald-500 placeholder-gray-600 disabled:opacity-50"
            style={{ minHeight: '40px', maxHeight: '160px' }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="sentences"
            spellCheck={false}
          />

          {SpeechRec && !turnRunning && (
            <button
              onClick={toggleVoice}
              className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-xl transition-colors ${
                listening
                  ? 'bg-red-500 text-white animate-pulse'
                  : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
              title="Voice input"
            >
              🎤
            </button>
          )}

          {turnRunning ? (
            <button
              onClick={onCancel}
              className="w-10 h-10 shrink-0 flex items-center justify-center bg-red-500 hover:bg-red-400 text-white rounded-xl transition-colors"
              title="Stop"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!value.trim()}
              className="w-10 h-10 shrink-0 flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 active:scale-95 rounded-xl transition-all"
              title="Send"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
