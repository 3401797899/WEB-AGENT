import { useState, useRef } from 'react';

export default function CodeBlock({ children }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = ref.current?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) {}
      document.body.removeChild(ta);
    }
  };

  return (
    <div className="relative group my-2">
      <button
        onClick={handleCopy}
        className="absolute top-1.5 right-1.5 px-2 py-1 text-[10px] font-medium bg-gray-700/80 hover:bg-gray-600 text-gray-200 rounded opacity-70 group-hover:opacity-100 transition-opacity"
        aria-label="Copy"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
      <pre ref={ref} className="!bg-gray-950 !p-3 rounded-lg overflow-x-auto text-xs">
        {children}
      </pre>
    </div>
  );
}
