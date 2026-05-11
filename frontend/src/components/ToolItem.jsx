import { useState, useMemo } from 'react';
import hljs from 'highlight.js';

const EXT_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', php: 'php', swift: 'swift', kt: 'kotlin',
  toml: 'ini', ini: 'ini', env: 'bash',
};

function stripXmlWrapper(text) {
  let s = text
    .replace(/<\/?file(?:_contents)?[^>]*>/gi, '')
    .replace(/<\/?source(?:_code)?[^>]*>/gi, '')
    .replace(/<path>[\s\S]*?<\/path>/gi, '')
    .replace(/<filename>[\s\S]*?<\/filename>/gi, '')
    .trim();

  // Strip embedded line numbers: '  42  code' or '42: code' or '42 | code'
  const lines = s.split('\n');
  const looksNumbered = lines.length > 2 && lines.slice(0, Math.min(6, lines.length))
    .filter(Boolean)
    .every((l) => /^\s*\d+[\s:|→\t]/.test(l));
  if (looksNumbered) {
    s = lines.map((l) => l.replace(/^\s*\d+\s*[:|→|]?\s?/, '')).join('\n');
  }

  // Convert leading tabs to 2-space indents so they render cleanly
  s = s.replace(/^(\t+)/gm, (_, tabs) => '  '.repeat(tabs.length));
  return s;
}

function DiffView({ patch, fileName }) {
  const lines = (patch || '').split('\n');
  const added   = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className="rounded-b-md overflow-hidden">
      {(added || removed) > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 bg-gray-900/80 border-b border-gray-800/50">
          {added > 0 && <span className="text-[10px] font-mono text-green-400">+{added}</span>}
          {removed > 0 && <span className="text-[10px] font-mono text-red-400">-{removed}</span>}
        </div>
      )}
      <div className="overflow-x-auto max-h-72 bg-gray-950 select-text">
        {lines.map((line, i) => {
          const isAdd  = line.startsWith('+') && !line.startsWith('+++');
          const isDel  = line.startsWith('-') && !line.startsWith('---');
          const isHunk = line.startsWith('@@');
          const isMeta = line.startsWith('+++') || line.startsWith('---');
          return (
            <div key={i} className={`flex text-[11px] font-mono leading-5 ${
              isAdd  ? 'bg-green-950/50' :
              isDel  ? 'bg-red-950/50' :
              isHunk ? 'bg-blue-950/30' : ''
            }`}>
              <span className={`w-4 shrink-0 text-center select-none text-[10px] leading-5 ${
                isAdd ? 'text-green-500' : isDel ? 'text-red-500' : 'text-gray-700'
              }`}>
                {isAdd ? '+' : isDel ? '-' : isHunk ? '' : ' '}
              </span>
              <span className={`flex-1 px-2 whitespace-pre ${
                isAdd  ? 'text-green-200' :
                isDel  ? 'text-red-300' :
                isHunk ? 'text-blue-400' :
                isMeta ? 'text-gray-500' : 'text-gray-300'
              }`}>{line.slice(isAdd || isDel ? 1 : 0) || '\u00A0'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ThinkingBlock({ text, live = false }) {
  const [open, setOpen] = useState(live);
  const preview = text?.replace(/\n/g, ' ').slice(0, 60) || '';
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors group"
      >
        <span className="text-[11px]">💭</span>
        <span className="font-medium">Thinking</span>
        {live && (
          <span className="flex gap-0.5 ml-1">
            <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        )}
        {!open && !live && preview && (
          <span className="text-gray-600 truncate max-w-[200px] font-mono">{preview}…</span>
        )}
        <span className="text-gray-600 group-hover:text-gray-400 ml-0.5">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 ml-4 p-2.5 bg-purple-950/20 border border-purple-800/30 rounded-lg text-[11px] text-purple-200/80 whitespace-pre-wrap font-mono leading-relaxed max-h-56 overflow-y-auto select-text">
          {text || <span className="text-purple-400/40 italic">waiting…</span>}
        </div>
      )}
    </div>
  );
}

// Strip ANSI escape codes and terminal control sequences from output
function stripAnsi(str) {
  return (str || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences (title etc.)
    .replace(/\x1b[()][AB012]/g, '')             // charset designations
    .replace(/\x1b[=>]/g, '')                    // alt screen
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '') // other control chars
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')  // trailing whitespace per line
    .replace(/\n{3,}/g, '\n\n') // collapse multiple blank lines
    // Strip zsh/bash trailing prompt characters on their own line
    .replace(/\n[%$#>]\s*\n?$/, '')
    .trim();
}

function CommandBlock({ item }) {
  const d = item.details || {};
  const command = d.commandLine || d.command || d.proposedCommandLine ||
    item.command || item.cmd || item.summary || '';
  const cwd = d.cwd || '';
  const cwdName = cwd ? cwd.split('/').pop() || cwd : '';

  const rawOutput =
    d.combinedOutput?.full || d.combinedOutput?.ansiOutput ||
    d.output || d.stdout || item.output || item.stdout || '';
  const output = stripAnsi(rawOutput);

  const exitCode = d.exitCode ?? d.exit_code ?? item.exitCode ?? item.exit_code;
  const hasExitCode = exitCode !== undefined && exitCode !== null;
  const failed = hasExitCode && exitCode !== 0;
  const hasOutput = output.length > 0;

  const [open, setOpen] = useState(failed); // auto-expand on failure

  return (
    <div className="my-1">
      <button
        onClick={() => (hasOutput || d) && setOpen((v) => !v)}
        className={`flex items-center gap-1.5 w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors
          ${failed ? 'bg-red-950/30 hover:bg-red-950/50' : 'bg-gray-900/60 hover:bg-gray-800/60'}`}
      >
        <span className={`font-bold font-mono shrink-0 text-[13px] leading-none ${failed ? 'text-red-400' : 'text-emerald-400'}`}>$</span>
        <code className={`flex-1 min-w-0 truncate font-mono text-[11px] ${failed ? 'text-red-200' : 'text-gray-200'}`} title={command.length > 120 ? command.slice(0, 200) + '…' : command}>
          {command.length > 120 ? command.slice(0, 120) + '…' : command}
        </code>
        {cwdName && (
          <span className="text-gray-600 font-mono text-[10px] shrink-0 hidden sm:inline">{cwdName}</span>
        )}
        {hasExitCode && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 ${
            failed ? 'text-red-300 bg-red-950/60' : 'text-emerald-400/80 bg-emerald-950/40'
          }`}>
            {failed ? `✗ ${exitCode}` : '✓'}
          </span>
        )}
        {(hasOutput || d) && (
          <span className="text-gray-600 shrink-0">{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && (
        <pre className="mt-0.5 ml-2 p-2.5 rounded-md bg-[#0d1117] text-[11px] text-gray-300 overflow-x-auto max-h-64 font-mono leading-relaxed whitespace-pre-wrap select-text border border-gray-800/40 m-0">
          {hasOutput ? output : <span className="text-gray-600 italic">(no output)</span>}
        </pre>
      )}
    </div>
  );
}

function FileChangeBlock({ item }) {
  const [open, setOpen] = useState(false);
  const filePath =
    item.path || item.file || item.summary ||
    item.details?.targetFile || item.details?.uri || item.details?.path ||
    item.details?.absolutePath || item.details?.filePath ||
    item.details?.edit?.uri || '';
  const patch = item.patch || item.diff || item.details?.patch || '';
  const rawContent =
    item.content ||
    item.details?.codeContent || item.details?.CodeContent ||
    item.details?.content || item.details?.newText ||
    item.details?.edit?.newText || item.details?.text || '';
  const hasPatch   = !!patch;
  const hasContent = !!rawContent;
  const hasDetail  = hasPatch || hasContent || !!item.details;
  const isCreate   = item.type === 'writeToFile' || item.type === 'file_change';
  const fileName   = filePath ? filePath.split('/').pop() : '(file)';
  const dirPart    = filePath && fileName && filePath !== fileName
    ? filePath.slice(0, filePath.length - fileName.length - 1) : '';

  const content = useMemo(() => stripXmlWrapper(rawContent), [rawContent]);

  const highlighted = useMemo(() => {
    if (!content || hasPatch) return '';
    const ext  = fileName.split('.').pop()?.toLowerCase();
    const lang = EXT_LANG[ext];
    try {
      return lang
        ? hljs.highlight(content, { language: lang }).value
        : hljs.highlightAuto(content).value;
    } catch {
      try { return hljs.highlightAuto(content).value; } catch { return null; }
    }
  }, [content, fileName, hasPatch]);

  return (
    <div className="my-1">
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-teal-950/30 hover:bg-teal-950/50 text-xs transition-colors"
      >
        <span className="text-teal-400 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </span>
        <span className="text-teal-200 font-medium shrink-0">{fileName}</span>
        {dirPart && (
          <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{dirPart}</span>
        )}
        <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
          isCreate && !hasPatch
            ? 'bg-teal-900/60 text-teal-300'
            : 'bg-yellow-900/40 text-yellow-400'
        }`}>
          {isCreate && !hasPatch ? '新建' : '修改'}
        </span>
        {hasDetail && (
          <span className="text-gray-600 shrink-0 ml-1">{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 ml-2 rounded-md overflow-hidden border border-gray-800/50">
          <div className="flex items-center justify-between px-3 py-1 bg-gray-900 border-b border-gray-800/50">
            <span className="text-[10px] text-gray-500 font-mono">{filePath || fileName}</span>
          </div>
          {hasPatch ? (
            <DiffView patch={patch} fileName={fileName} />
          ) : hasContent ? (
            <pre className="p-3 bg-gray-950 text-[11px] overflow-x-auto max-h-72 font-mono leading-relaxed select-text m-0" style={{ tabSize: 2 }}>
              {highlighted
                ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
                : <code className="text-gray-300">{content}</code>
              }
            </pre>
          ) : (
            <pre className="p-3 bg-gray-950 text-[10px] text-gray-500 overflow-x-auto max-h-48 font-mono m-0">
              {JSON.stringify(item.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Read File ──────────────────────────────────────────────────────────────
function ReadFileBlock({ item }) {
  const [open, setOpen] = useState(false);
  const d = item.details || {};
  const fullPath  =
    d.absolutePath || d.targetFile || d.filePath || d.path ||
    d.uri || d.fileUri || item.summary || '';
  const fileName  = fullPath ? fullPath.split('/').pop() : '';
  const dirPart   = fullPath && fileName ? fullPath.slice(0, fullPath.length - fileName.length - 1) : '';
  const rawContent = d.content || d.fileContents || d.fileContent || '';
  const start     = d.startLine || d.lineStart;
  const end       = d.endLine   || d.lineEnd;
  const lineRange = start ? `L${start}${end && end !== start ? `–${end}` : ''}` : '';

  const content = useMemo(() => stripXmlWrapper(rawContent), [rawContent]);

  const highlighted = useMemo(() => {
    if (!content) return '';
    const ext  = fileName.split('.').pop()?.toLowerCase();
    const lang = EXT_LANG[ext];
    try {
      return lang
        ? hljs.highlight(content, { language: lang }).value
        : hljs.highlightAuto(content).value;
    } catch {
      try { return hljs.highlightAuto(content).value; } catch { return null; }
    }
  }, [content, fileName]);

  return (
    <div className="my-1">
      <button
        onClick={() => content && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-sky-950/30 hover:bg-sky-950/50 text-xs transition-colors"
      >
        <span className="text-sky-400 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </span>
        <span className="text-sky-600 text-[10px] shrink-0">读取</span>
        <span className="text-sky-200 font-medium shrink-0">{fileName}</span>
        {lineRange && <span className="text-sky-600 text-[10px] font-mono shrink-0">{lineRange}</span>}
        {dirPart && <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{dirPart}</span>}
        {content && <span className="text-gray-600 shrink-0 ml-auto">{open ? '▾' : '▸'}</span>}
      </button>
      {open && content && (
        <div className="mt-0.5 ml-2 rounded-md overflow-hidden border border-gray-800/50">
          <div className="flex items-center justify-between px-3 py-1 bg-gray-900 border-b border-gray-800/50">
            <span className="text-[10px] text-gray-500 font-mono">{fullPath || fileName}</span>
            {lineRange && <span className="text-[10px] text-sky-600 font-mono">{lineRange}</span>}
          </div>
          <pre className="p-3 bg-gray-950 text-[11px] overflow-x-auto max-h-72 font-mono leading-relaxed select-text m-0" style={{ tabSize: 2 }}>
            {highlighted
              ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
              : <code className="text-gray-300">{content}</code>
            }
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Search (grep / find) ─────────────────────────────────────────────────────
function SearchBlock({ item }) {
  const [open, setOpen] = useState(false);
  const d = item.details || {};
  const query   = d.query || d.pattern || d.nameGlob || d.searchQuery || item.summary || '';
  const dir     = d.directoryPath || d.searchPath || d.absolutePath || '';
  const pattern = d.filePattern || d.includePattern || '';
  const rawResults = d.results || d.matches || d.output || '';

  // Parse results: each line is typically "file:line: content" or just file paths
  const lines = typeof rawResults === 'string'
    ? rawResults.split('\n').filter(Boolean)
    : Array.isArray(rawResults) ? rawResults.map((r) => typeof r === 'string' ? r : JSON.stringify(r)) : [];
  const matchCount = lines.length;

  return (
    <div className="my-1">
      <button
        onClick={() => matchCount > 0 && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-violet-950/30 hover:bg-violet-950/50 text-xs transition-colors"
      >
        <span className="text-violet-400 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <span className="text-violet-600 text-[10px] shrink-0">搜索</span>
        <span className="text-violet-200 font-mono shrink-0">&ldquo;{query}&rdquo;</span>
        {pattern && <span className="text-gray-600 text-[10px] shrink-0">{pattern}</span>}
        {dir && <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{dir}</span>}
        {matchCount > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-violet-400 font-mono">
            {matchCount} 行 {open ? '▾' : '▸'}
          </span>
        )}
        {matchCount === 0 && rawResults !== '' && (
          <span className="ml-auto text-[10px] text-gray-600 shrink-0">无结果</span>
        )}
      </button>
      {open && matchCount > 0 && (
        <div className="mt-0.5 ml-2 max-h-56 overflow-y-auto border border-gray-800/50 rounded-md bg-gray-950">
          {lines.map((line, i) => {
            const m = line.match(/^([^:]+):?(\d+)?:?\s?(.*)$/);
            const file = m?.[1] || '';
            const lineno = m?.[2] || '';
            const text = m?.[3] || line;
            return (
              <div key={i} className="flex items-start gap-2 px-2 py-0.5 hover:bg-gray-900 text-[10px] border-b border-gray-900">
                {lineno && <span className="text-gray-600 font-mono shrink-0 w-8 text-right">{lineno}</span>}
                <span className="text-gray-300 font-mono break-all">{text || file}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── List Directory ───────────────────────────────────────────────────────────
function ListDirBlock({ item }) {
  const [open, setOpen] = useState(false);
  const d = item.details || {};
  const fullPath = d.absolutePath || d.directoryPath || item.summary || '';
  const dirName  = fullPath ? fullPath.split('/').pop() || fullPath : '(dir)';
  const parentPath = fullPath && dirName && fullPath !== dirName
    ? fullPath.slice(0, fullPath.length - dirName.length - 1) : '';

  const rawEntries = d.entries || d.files || d.output || '';
  const entries = Array.isArray(rawEntries)
    ? rawEntries
    : typeof rawEntries === 'string'
    ? rawEntries.split('\n').filter(Boolean)
    : [];

  return (
    <div className="my-1">
      <button
        onClick={() => entries.length > 0 && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-amber-950/30 hover:bg-amber-950/50 text-xs transition-colors"
      >
        <span className="text-amber-400 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </span>
        <span className="text-amber-600 text-[10px] shrink-0">列表</span>
        <span className="text-amber-200 font-medium shrink-0">{dirName}/</span>
        {parentPath && <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{parentPath}</span>}
        {entries.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-amber-400/70 font-mono">
            {entries.length} 项 {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {open && entries.length > 0 && (
        <div className="mt-0.5 ml-2 max-h-48 overflow-y-auto border border-gray-800/50 rounded-md bg-gray-950 p-1.5">
          {entries.map((entry, i) => {
            const name = typeof entry === 'string' ? entry : entry.name || JSON.stringify(entry);
            const isDir = name.endsWith('/') || entry.type === 'directory';
            return (
              <div key={i} className={`flex items-center gap-1.5 px-1 py-0.5 text-[10px] font-mono ${
                isDir ? 'text-amber-300' : 'text-gray-400'
              }`}>
                <span>{isDir ? '📁' : '📄'}</span>
                <span>{name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Fetch URL ────────────────────────────────────────────────────────────────
function FetchUrlBlock({ item }) {
  const [open, setOpen] = useState(false);
  const d = item.details || {};
  const url     = d.url || item.summary || '';
  const content = d.content || d.output || d.text || '';
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { hostname = url; }

  return (
    <div className="my-1">
      <button
        onClick={() => content && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md bg-cyan-950/30 hover:bg-cyan-950/50 text-xs transition-colors"
      >
        <span className="text-cyan-400 shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        </span>
        <span className="text-cyan-600 text-[10px] shrink-0">请求</span>
        <span className="text-cyan-200 font-medium shrink-0">{hostname}</span>
        <span className="text-gray-600 font-mono text-[10px] truncate flex-1 min-w-0">{url}</span>
        {content && <span className="text-gray-600 shrink-0 ml-auto">{open ? '▾' : '▸'}</span>}
      </button>
      {open && content && (
        <pre className="mt-0.5 ml-2 p-2 bg-gray-950 rounded-md text-[10px] text-gray-300 overflow-x-auto max-h-56 font-mono leading-relaxed border border-gray-800/50 select-text whitespace-pre-wrap">
          {content.slice(0, 4000)}{content.length > 4000 ? '\n…(truncated)' : ''}
        </pre>
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
  const errorText = isError ? (item.text || item.summary || '') : '';
  const summary = isError
    ? errorText
    : (item.command || item.path || item.summary || item.query ||
       (item.input || item.arguments
         ? JSON.stringify(item.input || item.arguments).slice(0, 80)
         : ''));

  return (
    <div className="my-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex ${isError ? 'flex-col items-start' : 'items-center'} gap-1.5 w-full text-left px-2 py-1 rounded text-xs transition-colors ${
          isError ? 'bg-red-950/30 hover:bg-red-950/50' : 'hover:bg-gray-800/50'
        }`}
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`${meta.color} w-4 shrink-0 text-center`}>{meta.icon}</span>
          <span className={`font-medium ${meta.color}`}>{meta.label}</span>
          {!isError && item.details && <span className="text-gray-700 shrink-0">{open ? '▾' : '▸'}</span>}
        </div>
        {summary && (
          <span className={`min-w-0 ${isError ? 'text-red-400 whitespace-pre-wrap break-words w-full pl-6' : 'text-gray-600 font-mono truncate flex-1'}`}>{summary}</span>
        )}
      </button>
      {open && item.details && (
        <pre className="ml-6 mt-0.5 p-2 bg-gray-950 rounded text-[10px] text-gray-400 overflow-x-auto max-h-48 border border-gray-800/40 select-text">
          {JSON.stringify(item.details, null, 2)}
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

  if (t === 'file_change' || t === 'file_edit' || t === 'patch' || t === 'writeToFile' || t === 'proposeCode')
    return <FileChangeBlock item={item} />;

  if (t === 'viewFile' || t === 'viewCodeItem')
    return <ReadFileBlock item={item} />;

  if (t === 'grepSearch' || t === 'find')
    return <SearchBlock item={item} />;

  if (t === 'listDirectory')
    return <ListDirBlock item={item} />;

  if (t === 'readUrlContent')
    return <FetchUrlBlock item={item} />;

  return <GenericToolBlock item={item} />;
}
