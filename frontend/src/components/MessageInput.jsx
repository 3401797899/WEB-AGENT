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

const MAX_CMD_PREVIEW = 120; // chars before truncating

function CommandLineDisplay({ command, expanded, onToggle, className = '' }) {
  const cmd = command || '(running…)';
  const isLong = cmd.length > MAX_CMD_PREVIEW;
  const display = expanded || !isLong
    ? cmd
    : cmd.slice(0, MAX_CMD_PREVIEW) + '…';
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <code className={`text-[11px] font-mono ${expanded ? 'whitespace-pre-wrap break-all max-h-32 overflow-y-auto' : 'truncate'} text-gray-400`}>
        {display}
      </code>
      {isLong && (
        <button
          onClick={onToggle}
          className="self-start text-[10px] text-blue-400/70 hover:text-blue-300 transition-colors"
        >
          {expanded ? '▴ 收起' : `▾ 展开（共 ${cmd.length} 字符）`}
        </button>
      )}
    </div>
  );
}

const EFFORT_LEVELS = [
  { value: 'low',        label: '低' },
  { value: 'medium',     label: '中' },
  { value: 'high',       label: '高' },
  { value: 'extra_high', label: '极高' },
];

export default function MessageInput({ onSend, onCancel, turnRunning, provider, modelUid, onModelChange, reasoningEffort, onReasoningEffortChange, windsurfQuota, onRefreshQuota, pendingApproval, onApprove, onReject, runningStep, onCancelStep, onSendStepInput, commandOutput, commandStuck, onCancelTurn, onCancelStepAndHint, pendingQuestion, onAnswerQuestion, onSkipQuestion, pendingEditText, onConsumeEditText }) {
  const [value, setValue] = useState('');
  const [stepInput, setStepInput] = useState('');
  const [questionInput, setQuestionInput] = useState('');
  const [selectedOptions, setSelectedOptions] = useState([]);
  const [attachments, setAttachments] = useState([]); // [{ name, type, size, dataUrl }]
  const [listening, setListening] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const outputRef = useRef(null);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [commandOutput]);

  // Reset expand state when a new command appears
  useEffect(() => { setCmdExpanded(false); }, [runningStep, pendingApproval]);
  // Reset question input when a new question appears
  useEffect(() => { setQuestionInput(''); setSelectedOptions([]); }, [pendingQuestion]);

  // Populate textarea when editing a previous message
  useEffect(() => {
    if (pendingEditText != null) {
      setValue(pendingEditText);
      onConsumeEditText?.();
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, 160) + 'px';
          el.focus();
        }
      }, 50);
    }
  }, [pendingEditText]);

  const submit = () => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    onSend(text || '(附件)', attachments);
    setValue('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const addFiles = (files) => {
    if (!files?.length) return;
    const MAX_SIZE = 20 * 1024 * 1024; // 20MB per file
    Array.from(files).forEach((file) => {
      if (file.size > MAX_SIZE) return;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          { name: file.name, type: file.type, size: file.size, dataUrl: reader.result },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !turnRunning) {
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
        {runningStep && !pendingApproval ? (
          <div className="flex flex-col gap-2">
            {/* Stuck warning banner */}
            {commandStuck && (
              <div className="flex items-center gap-2 bg-red-950/60 border border-red-600/50 rounded-xl px-3 py-2.5 animate-pulse">
                <span className="text-red-400 text-lg shrink-0">⚠️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-red-300 font-semibold">命令可能已卡住</p>
                  <p className="text-[11px] text-red-400/70">超过 15 秒无输出，终端可能在等待输入或命令不完整</p>
                </div>
              </div>
            )}
            {/* Command info */}
            <div className={`flex flex-col gap-1 rounded-xl overflow-hidden ${commandStuck ? 'bg-red-950/30 border border-red-700/30' : 'bg-blue-950/50 border border-blue-700/40'}`}>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className={`shrink-0 ${commandStuck ? 'text-red-400' : 'text-blue-400'}`}>{commandStuck ? '🔴' : '⚙️'}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium ${commandStuck ? 'text-red-300' : 'text-blue-300'}`}>
                    {commandStuck ? '命令无响应' : '命令执行中'}
                  </p>
                  <CommandLineDisplay
                    command={runningStep.commandLine}
                    expanded={cmdExpanded}
                    onToggle={() => setCmdExpanded((v) => !v)}
                  />
                </div>
              </div>
              {commandOutput ? (
                <pre ref={outputRef} className="px-3 pb-2 text-[11px] font-mono text-green-300/80 max-h-32 overflow-y-auto whitespace-pre-wrap break-all border-t border-gray-800/40">{commandOutput}</pre>
              ) : null}
            </div>
            {/* Action buttons - prominent when stuck */}
            {commandStuck ? (
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => onCancelStepAndHint?.(
                    `上一条命令在终端中打开了交互式程序（如 vim/less/nano 等编辑器），导致卡住无法返回。请改用非交互方式重新执行，例如：\n- git 操作加 --no-edit 参数\n- 避免打开 vim/nano，改用 echo 或 sed 写入\n- 使用 EDITOR=true 或 GIT_EDITOR=true 环境变量\n请继续完成之前的任务。`
                  )}
                  className="w-full py-3 bg-orange-600 hover:bg-orange-500 active:scale-[0.98] text-white text-sm font-bold rounded-xl transition-all"
                >
                  🔄 终止并提示 AI 避开交互
                </button>
                <button
                  onClick={onCancelStep}
                  className="w-full py-2.5 bg-red-600 hover:bg-red-500 active:scale-[0.98] text-white text-sm font-medium rounded-xl transition-all"
                >
                  ⏹ 仅终止此命令（AI 继续）
                </button>
                <button
                  onClick={onCancelTurn}
                  className="w-full py-2 bg-gray-700 hover:bg-gray-600 active:scale-[0.98] text-gray-300 text-xs font-medium rounded-xl transition-all"
                >
                  取消整个任务
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={stepInput}
                  onChange={(e) => setStepInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && stepInput.trim()) {
                      onSendStepInput?.(stepInput.trim());
                      setStepInput('');
                    }
                  }}
                  placeholder="发送输入（如提交消息、:wq 等）"
                  className="flex-1 bg-gray-800 text-white text-sm rounded-xl px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-600"
                />
                <button
                  onClick={() => { if (stepInput.trim()) { onSendStepInput?.(stepInput.trim()); setStepInput(''); } }}
                  disabled={!stepInput.trim()}
                  className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition-colors"
                >
                  发送
                </button>
                <button
                  onClick={onCancelStep}
                  className="px-3 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded-xl transition-colors"
                >
                  终止
                </button>
              </div>
            )}
          </div>
        ) : pendingQuestion ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-2 bg-indigo-950/50 border border-indigo-700/40 rounded-xl px-3 py-2.5">
              <span className="text-indigo-400 shrink-0 mt-0.5">❓</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-indigo-300 font-medium mb-0.5">AI 提出了一个问题</p>
                <p className="text-sm text-white">{pendingQuestion.question || '(no question)'}</p>
              </div>
            </div>
            {pendingQuestion.options?.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pendingQuestion.options.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (pendingQuestion.allowMultiple) {
                        setSelectedOptions((prev) =>
                          prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
                        );
                      } else {
                        onAnswerQuestion?.(opt.label, [i]);
                      }
                    }}
                    title={opt.description || ''}
                    className={`px-3 py-2 text-sm font-medium rounded-xl transition-all active:scale-95 ${
                      selectedOptions.includes(i)
                        ? 'bg-indigo-600 text-white ring-2 ring-indigo-400'
                        : 'bg-gray-800 text-gray-200 hover:bg-gray-700 hover:text-white'
                    }`}
                  >
                    {opt.label}
                    {opt.description && (
                      <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{opt.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {pendingQuestion.allowMultiple && selectedOptions.length > 0 && (
              <button
                onClick={() => {
                  const labels = selectedOptions.map((i) => pendingQuestion.options[i]?.label).filter(Boolean);
                  onAnswerQuestion?.(labels.join(', '), [...selectedOptions]);
                }}
                className="py-2 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white text-sm font-medium rounded-xl transition-all"
              >
                确认选择（{selectedOptions.length}）
              </button>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={questionInput}
                onChange={(e) => setQuestionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && questionInput.trim()) {
                    onAnswerQuestion?.(questionInput.trim());
                    setQuestionInput('');
                  }
                }}
                placeholder="输入自定义回复…"
                className="flex-1 bg-gray-800 text-white text-sm rounded-xl px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-600"
              />
              <button
                onClick={() => { if (questionInput.trim()) { onAnswerQuestion?.(questionInput.trim()); setQuestionInput(''); } }}
                disabled={!questionInput.trim()}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                回复
              </button>
              <button
                onClick={onSkipQuestion}
                className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-medium rounded-xl transition-colors"
              >
                跳过
              </button>
            </div>
          </div>
        ) : pendingApproval ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2 bg-amber-950/50 border border-amber-700/40 rounded-xl px-3 py-2">
              <span className="text-amber-400 shrink-0 mt-0.5">⚠️</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-amber-300 font-medium">命令需要批准才能运行</p>
                <CommandLineDisplay
                  command={pendingApproval.commandLine || '(unknown command)'}
                  expanded={cmdExpanded}
                  onToggle={() => setCmdExpanded((v) => !v)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onApprove}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-sm font-medium rounded-xl transition-all"
              >
                ✓ 允许运行
              </button>
              <button
                onClick={onReject}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 active:scale-95 text-white text-sm font-medium rounded-xl transition-all"
              >
                ✕ 取消任务
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 items-end">
            <button
              onClick={() => setShowTemplates((v) => !v)}
              className="w-10 h-10 shrink-0 flex items-center justify-center text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors"
              title="Prompt templates"
            >
              ✨
            </button>

            <div className="flex-1 flex flex-col bg-gray-800 rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-emerald-500">
              {attachments.length > 0 && (
                <div className="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto">
                  {attachments.map((a, i) => (
                    <div key={i} className="relative shrink-0 group/att">
                      {a.type?.startsWith('image/') ? (
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="h-16 w-16 object-cover rounded-lg border border-gray-700"
                        />
                      ) : (
                        <div className="h-16 w-16 flex flex-col items-center justify-center rounded-lg border border-gray-700 bg-gray-750 px-1">
                          <span className="text-lg">📄</span>
                          <span className="text-[9px] text-gray-400 truncate w-full text-center">{a.name}</span>
                        </div>
                      )}
                      <button
                        onClick={() => removeAttachment(i)}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-full flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={turnRunning ? 'AI 工作中…' : '输入消息… ⌘/Ctrl+Enter 发送'}
                disabled={turnRunning}
                rows={1}
                className="flex-1 bg-transparent text-white text-sm px-3.5 py-2.5 resize-none outline-none placeholder-gray-600 disabled:opacity-50"
                style={{ minHeight: '40px', maxHeight: '160px' }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="sentences"
                spellCheck={false}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.csv,.log,.sh,.sql"
                className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {!turnRunning && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-10 h-10 shrink-0 flex items-center justify-center bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 rounded-xl transition-colors"
                title="添加附件"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            )}

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
                disabled={!value.trim() && attachments.length === 0}
                className="w-10 h-10 shrink-0 flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 active:scale-95 rounded-xl transition-all"
                title="发送 (⌘/Ctrl+Enter)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
