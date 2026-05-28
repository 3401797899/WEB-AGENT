import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import CodeBlock from './CodeBlock';
import ToolItem from './ToolItem';

const API_BASE =
  typeof window !== 'undefined' && !import.meta.env.PROD
    ? `http://${window.location.hostname}:3001`
    : '';

const MessageBubble = memo(function MessageBubble({ message, isLastUser, onEdit, onRevert, turnRunning }) {
  const isUser = message.role === 'user';
  const attachments = message.attachments || [];
  // Filter out empty error items that have no useful info
  const items = (message.items || []).filter(item => {
    if (item.type === 'error' && !item.text && !item.summary) return false;
    return true;
  });

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} group w-full min-w-0`}>
      <div className={`flex flex-col ${
        isUser
          ? 'items-end max-w-[88%] sm:max-w-[80%]'
          : 'items-stretch w-[88%] sm:w-[80%]'
      } min-w-0`}>
      <div
        className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm overflow-hidden min-w-0 ${
          isUser
            ? 'max-w-full bg-emerald-600 text-white rounded-br-md'
            : 'w-full bg-gray-800 text-gray-100 rounded-bl-md'
        }`}
      >
        {/* Tool / non-message items (file changes, command runs) — only on assistant side */}
        {!isUser && items.length > 0 && (
          <div className="space-y-1 mb-2">
            {items.map((item, i) => (
              <ToolItem key={i} item={item} />
            ))}
          </div>
        )}

        {/* Attachment images */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) =>
              a.type?.startsWith('image/') ? (
                <a key={i} href={`${API_BASE}${a.url}`} target="_blank" rel="noopener noreferrer">
                  <img
                    src={`${API_BASE}${a.url}`}
                    alt={a.name}
                    className="max-h-48 max-w-full rounded-lg border border-white/10 cursor-pointer hover:opacity-90 transition-opacity"
                  />
                </a>
              ) : (
                <a
                  key={i}
                  href={`${API_BASE}${a.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 bg-black/20 rounded-lg px-2.5 py-1.5 text-xs hover:bg-black/30 transition-colors"
                >
                  <span>📄</span>
                  <span className="truncate max-w-[150px]">{a.name}</span>
                  {a.size && <span className="text-gray-400 shrink-0">({(a.size / 1024).toFixed(0)}KB)</span>}
                </a>
              )
            )}
          </div>
        )}

        {message.error ? (
          <div className="flex items-start gap-2 text-red-300 text-xs">
            <span className="shrink-0 mt-0.5 text-red-400">⚠️</span>
            <div className="whitespace-pre-wrap font-mono break-words min-w-0">{message.error}</div>
          </div>
        ) : message.content ? (
          isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ node, children, ...props }) => (
                    <CodeBlock>{children}</CodeBlock>
                  ),
                  a: ({ node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline" />
                  ),
                  table: ({ node, children, ...props }) => (
                    <div className="overflow-x-auto my-1">
                      <table {...props}>{children}</table>
                    </div>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : items.length > 0 ? null : (
          <span className="text-gray-500 italic text-xs">(no message)</span>
        )}
      </div>
      {isLastUser && !turnRunning && (
        <div className="flex gap-1.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="text-[11px] text-gray-500 hover:text-emerald-400 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800"
            title="编辑此消息"
          >
            ✏️ 编辑
          </button>
          <button
            onClick={onRevert}
            className="text-[11px] text-gray-500 hover:text-red-400 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800"
            title="撤回此消息及回复"
          >
            ↩️ 撤回
          </button>
        </div>
      )}
      </div>
    </div>
  );
});

export default MessageBubble;
