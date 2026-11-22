// What models write (coordinator replies, agent messages, results) is markdown: it renders as such instead of showing
// its asterisks and backticks. react-markdown builds React elements and ignores raw HTML, so model output cannot inject
// markup; remark-gfm adds the tables, task lists and strikethrough models use.
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...p }) => <div className="md-table"><table {...p} /></div>,
};

/** Markdown text as formatted blocks. Memoized: a chat re-renders often while it streams. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
});

/** Markdown reduced to plain words, for one-line summaries: "**Done:** see `a.ts`" becomes "Done: see a.ts". */
export function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
