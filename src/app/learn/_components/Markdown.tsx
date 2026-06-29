'use client';

// Phase 2g (rendering): markdown renderer for generated lesson bodies. react-markdown
// emits raw semantic elements (h2/p/ul/code/pre/…); the `.lesson-prose` component class
// in globals.css styles them with design tokens, so this stays a thin, token-clean,
// dark-mode-aware wrapper with no per-element className wiring. remark-gfm adds tables,
// strikethrough, and task lists. Raw HTML is NOT enabled (react-markdown's safe
// default) — generated content is trusted, but there's no reason to widen the surface.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ content }: { content: string }) {
  return (
    <div className="lesson-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
