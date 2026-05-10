import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import CodeBlock from './CodeBlock';
import ToolItem, { ThinkingBlock } from './ToolItem';

// Live view of an in-progress turn.
// Builds an interleaved timeline so tool calls and assistant text appear
// in the order they actually happen, matching the VSCode plugin experience.
export default function StreamingTurn({ events, turnRunning }) {
  const timeline = useMemo(() => {
    const tl = [];

    for (const evt of events) {
      // ── codex item.completed events ──────────────────────────────────
      if (evt.type === 'item.completed' && evt.item) {
        const item = evt.item;
        if (item.type === 'agent_message' && item.text) {
          tl.push({ kind: 'text', content: item.text });
        } else {
          tl.push({ kind: 'tool', item });
        }
      }

      // ── windsurf cascade.step events ─────────────────────────────────
      if (evt.type === 'cascade.step' && evt.step) {
        const s = evt.step;
        if (s.kind === 'assistant_message') {
          // Carry thinking into timeline (coalesce into nearest thinking entry)
          if (s.thinking) {
            const prevThink = tl.findLast?.((e) => e.kind === 'thinking') ??
              [...tl].reverse().find((e) => e.kind === 'thinking');
            if (prevThink) {
              prevThink.thinking = s.thinking;
            } else {
              tl.push({ kind: 'thinking', thinking: s.thinking });
            }
          }
          // Cascade streams updates to the same step; coalesce into one entry
          const last = tl[tl.length - 1];
          const lastText = last?.kind === 'text' ? last : [...tl].reverse().find((e) => e.kind === 'text');
          if (lastText && !s.text && s.thinking) {
            // thinking-only update, no text change
          } else if (last?.kind === 'text') {
            last.content = s.text; // streaming update in-place
          } else if (s.text) {
            tl.push({ kind: 'text', content: s.text });
          }
        } else if (s.kind === 'tool') {
          tl.push({
            kind: 'tool',
            item: {
              type: s.tool || 'tool',
              command: s.summary,
              path: s.summary,
              summary: s.summary,
              name: s.tool,
              details: s.details,
            },
          });
        } else if (s.kind === 'error') {
          tl.push({ kind: 'tool', item: { type: 'error', text: s.text } });
        }
      }
    }

    return tl;
  }, [events]);

  const isEmpty = timeline.length === 0;
  const lastIsText = timeline[timeline.length - 1]?.kind === 'text';
  const showLoader = turnRunning;

  return (
    <div className="flex justify-start">
      <div className="bg-gray-800 text-gray-100 rounded-2xl rounded-bl-md px-4 py-2.5 max-w-[88%] sm:max-w-[80%] text-sm shadow-sm overflow-x-auto">
        {timeline.map((entry, i) =>
          entry.kind === 'tool' ? (
            <ToolItem key={i} item={entry.item} />
          ) : entry.kind === 'thinking' ? (
            <ThinkingBlock key={i} text={entry.thinking} live={turnRunning} />
          ) : (
            <div key={i} className="markdown-body mt-1 first:mt-0">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ node, children, ...props }) => <CodeBlock>{children}</CodeBlock>,
                  a: ({ node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline" />
                  ),
                }}
              >
                {entry.content}
              </ReactMarkdown>
            </div>
          )
        )}

        {showLoader && (
          <div className="flex items-center gap-2 text-gray-400 text-xs py-0.5 mt-1 first:mt-0">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            <span>{isEmpty ? 'Thinking…' : 'Working…'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
