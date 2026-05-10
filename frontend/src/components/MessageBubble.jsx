import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import CodeBlock from './CodeBlock';
import ToolItem from './ToolItem';

const MessageBubble = memo(function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`rounded-2xl px-4 py-2.5 max-w-[88%] sm:max-w-[80%] text-sm leading-relaxed shadow-sm overflow-x-auto ${
          isUser
            ? 'bg-emerald-600 text-white rounded-br-md'
            : 'bg-gray-800 text-gray-100 rounded-bl-md'
        }`}
      >
        {/* Tool / non-message items (file changes, command runs) — only on assistant side */}
        {!isUser && Array.isArray(message.items) && message.items.length > 0 && (
          <div className="space-y-1 mb-2">
            {message.items.map((item, i) => (
              <ToolItem key={i} item={item} />
            ))}
          </div>
        )}

        {message.error ? (
          <div className="text-red-300 whitespace-pre-wrap font-mono text-xs">
            {message.error}
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
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )
        ) : (
          <span className="text-gray-500 italic text-xs">(no message)</span>
        )}
      </div>
    </div>
  );
});

export default MessageBubble;
