import { useState } from 'react';

function DiffView({ patch }) {
  const lines = (patch || '').split('\n');
  return (
    <pre className="text-[10px] overflow-x-auto max-h-72 font-mono leading-4 p-2 bg-gray-950 rounded-lg select-text">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+++') || line.startsWith('---')
              ? 'text-gray-400'
              : line.startsWith('+')
              ? 'bg-green-950/60 text-green-300'
              : line.startsWith('-')
              ? 'bg-red-950/60 text-red-300'
              : line.startsWith('@@')
              ? 'text-blue-400 bg-blue-950/20'
              : 'text-gray-400'
          }
        >
          {line || '\u00A0'}
        </div>
      ))}
    </pre>
  );
}

function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  const preview = text?.replace(/\n/g, ' ').slice(0, 60) || '';
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors group"
      >
        <span className="text-[11px]">💭</span>
        <span className="font-medium">Thinking</span>
        {!open && preview && (
          <span className="text-gray-600 truncate max-w-[200px] font-mono">{preview}…</span>
        )}
        <span className="text-gray-600 group-hover:text-gray-400 ml-0.5">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 ml-4 p-2.5 bg-purple-950/20 border border-purple-800/30 rounded-lg text-[11px] text-purple-200/80 whitespace-pre-wrap font-mono leading-relaxed max-h-56 overflow-y-auto select-text">
          {text}
        </div>
      )}
    </div>
  );
}

function CommandBlock({ item }) {
  const [open, setOpen] = useState(false);
  const command =
    item.command || item.cmd || item.summary ||
    item.details?.command || item.details?.commandLine || '';
  const output =
    item.output || item.stdout ||
    item.details?.output || item.details?.stdout || '';
  const exitCode =
    item.exitCode ?? item.exit_code ??
    item.details?.exitCode ?? item.details?.exit_code;
  const failed = exitCode !== undefined && exitCode !== null && exitCode !== 0;
  const hasDetail = !!(output || item.details);

  return (
    <div className="my-1">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors
          ${failed ? 'bg-red-950/40 hover:bg-red-950/60' : 'bg-gray-900/70 hover:bg-gray-800/70'}`}
      >
        <span className={`font-bold font-mono shrink-0 ${failed ? 'text-red-400' : 'text-emerald-400'}`}>$</span>
        <code className={`flex-1 min-w-0 truncate font-mono ${failed ? 'text-red-200' : 'text-gray-200'}`}>
          {command}
        </code>
        {exitCode !== undefined && exitCode !== null && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
            failed ? 'text-red-300 bg-red-950/60' : 'text-emerald-300 bg-emerald-950/60'
          }`}>
            {exitCode}
          </span>
        )}
        {hasDetail && (
          <span className="text-gray-600 shrink-0">{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && (
        <pre className="mt-0.5 ml-2 p-2 bg-black/60 rounded-md text-[10px] text-gray-300 overflow-x-auto max-h-48 font-mono leading-relaxed whitespace-pre-wrap border border-gray-800/50 select-text">
          {output || JSON.stringify(item.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function FileChangeBlock({ item }) {
  const [open, setOpen] = useState(false);
  const filePath =
    item.path || item.file || item.summary ||
    item.details?.targetFile || item.details?.uri ||
    item.details?.absolutePath || '';
  const patch = item.patch || item.diff || item.details?.patch || '';
  const content =
    item.content ||
    item.details?.codeContent || item.details?.CodeContent ||
    item.details?.content || '';
  const hasPatch = !!patch;
  const hasContent = !!content;
  const hasDetail = hasPatch || hasContent || !!item.details;
  const fileName = filePath ? filePath.split('/').pop() : '';
  const dirPart = filePath && fileName && filePath !== fileName
    ? filePath.slice(0, filePath.length - fileName.length - 1)
    : '';

  return (
    <div className="my-1">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-teal-950/30 hover:bg-teal-950/50 text-xs transition-colors"
      >
        <span className="text-teal-400 shrink-0">✎</span>
        <span className="text-teal-200 font-medium shrink-0">{fileName || filePath}</span>
        {dirPart && (
          <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{dirPart}</span>
        )}
        {hasDetail && (
          <span className="text-gray-600 shrink-0 ml-auto">{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 ml-2">
          {hasPatch ? (
            <DiffView patch={patch} />
          ) : hasContent ? (
            <pre className="p-2 bg-gray-950 rounded-md text-[10px] text-gray-300 overflow-x-auto max-h-72 font-mono leading-relaxed border border-gray-800/50 select-text">
              {content}
            </pre>
          ) : (
            <pre className="p-2 bg-gray-950 rounded-md text-[10px] text-gray-500 overflow-x-auto max-h-48 border border-gray-800/50">
              {JSON.stringify(item.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const TOOL_META = {
  viewFile:            { icon: '👁',  label: 'Read',      color: 'text-sky-400' },
  grepSearch:          { icon: '🔍', label: 'Search',     color: 'text-sky-400' },
  find:                { icon: '🔍', label: 'Find',       color: 'text-sky-400' },
  listDirectory:       { icon: '📁', label: 'List dir',   color: 'text-sky-400' },
  readUrlContent:      { icon: '🌐', label: 'URL',        color: 'text-sky-400' },
  viewCodeItem:        { icon: '🔎', label: 'View code',  color: 'text-sky-400' },
  searchKnowledgeBase: { icon: '📚', label: 'KB search',  color: 'text-sky-400' },
  lookupKnowledgeBase: { icon: '📚', label: 'KB lookup',  color: 'text-sky-400' },
  mcp_tool_call:       { icon: '🔌', label: 'MCP',        color: 'text-orange-400' },
  tool_call:           { icon: '🔌', label: 'Tool',       color: 'text-orange-400' },
  error:               { icon: '✗',  label: 'Error',      color: 'text-red-400' },
};

function GenericToolBlock({ item }) {
  const [open, setOpen] = useState(false);
  const isError = item.type === 'error';
  const meta = TOOL_META[item.type] || {
    icon: '⚙',
    label: item.name || item.type || 'Tool',
    color: 'text-gray-400',
  };
  const summary =
    item.command || item.path || item.summary || item.query ||
    (item.input || item.arguments
      ? JSON.stringify(item.input || item.arguments).slice(0, 80)
      : '');

  return (
    <div className="my-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1 rounded hover:bg-gray-800/50 text-xs transition-colors"
      >
        <span className={`${meta.color} w-4 shrink-0 text-center`}>{meta.icon}</span>
        <span className={`font-medium ${meta.color}`}>{meta.label}</span>
        {summary && (
          <span className="text-gray-600 font-mono truncate flex-1 min-w-0">{summary}</span>
        )}
        {isError && item.text && !summary && (
          <span className="text-red-400 truncate flex-1 min-w-0">{item.text}</span>
        )}
        <span className="text-gray-700 shrink-0">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="ml-6 mt-0.5 p-2 bg-gray-950 rounded text-[10px] text-gray-400 overflow-x-auto max-h-48 border border-gray-800/40 select-text">
          {isError && item.text
            ? item.text
            : JSON.stringify(item.details ?? item, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function ToolItem({ item }) {
  if (!item) return null;
  const t = item.type;

  if (t === 'reasoning')
    return <ThinkingBlock text={item.text || ''} />;

  if (t === 'command_execution' || t === 'run_command')
    return <CommandBlock item={item} />;

  if (
    t === 'file_change' || t === 'file_edit' || t === 'patch' ||
    t === 'writeToFile' || t === 'proposeCode'
  )
    return <FileChangeBlock item={item} />;

  return <GenericToolBlock item={item} />;
}
