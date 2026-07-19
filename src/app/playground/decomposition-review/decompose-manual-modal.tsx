'use client';

// Paste-a-list modal for manual decomposition (the SPA escape hatch's UI). The
// human pastes one lesson per line as `url | title` (optional third field is a
// summary); the client parses that forgiving text into the JSON `children`
// array the decompose_manual API expects, so a person uses pipes while an agent
// POSTs JSON to the same endpoint. Shows a live parsed/error count before submit.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type Child = { url: string; title: string; summary?: string };
type ParseResult = { children: Child[]; errors: string[] };

// One line → `url | title [| summary]`. url + title required; url must parse.
function parseLines(text: string): ParseResult {
  const children: Child[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const [url, title, ...rest] = line.split('|').map((s) => s.trim());
    const summary = rest.join('|').trim();
    if (!url || !title) {
      errors.push(`Line ${i + 1}: expected "url | title"`);
      return;
    }
    try {
      new URL(url);
    } catch {
      errors.push(`Line ${i + 1}: invalid URL`);
      return;
    }
    if (seen.has(url)) return; // silently drop dupes
    seen.add(url);
    children.push({ url, title, ...(summary ? { summary } : {}) });
  });
  return { children, errors };
}

export function DecomposeManualModal({
  resourceId,
  title,
  onClose,
}: {
  resourceId: string;
  title: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { children, errors } = useMemo(() => parseLines(text), [text]);
  const canSubmit = children.length >= 2 && errors.length === 0 && !submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/playground/decomposition-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceId, action: 'decompose_manual', children }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onClose();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">Manual decomposition</h3>
        <p className="mt-1 text-sm text-gray-600 truncate">{title}</p>
        <p className="mt-2 text-xs text-gray-500">
          One lesson per line, in order: <code>url | title</code> (optional third field:{' '}
          <code>| summary</code>). Type is inferred from the URL.
        </p>

        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          spellCheck={false}
          placeholder={'https://example.com/lesson-1 | Intro\nhttps://example.com/lesson-2 | Next steps'}
          className="mt-3 w-full rounded border p-2 font-mono text-xs"
        />

        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-gray-600">
            {children.length} parsed
            {errors.length > 0 && <span className="text-red-600"> · {errors.length} error(s)</span>}
            {children.length === 1 && <span className="text-amber-600"> · need ≥2</span>}
          </span>
          {error && <span className="text-red-600">{error}</span>}
        </div>
        {errors.length > 0 && (
          <ul className="mt-1 max-h-20 overflow-auto text-xs text-red-600">
            {errors.slice(0, 6).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border px-3 py-1 text-sm disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded border border-blue-700 bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-40"
          >
            {submitting ? 'Decomposing…' : `Decompose ${children.length} lessons`}
          </button>
        </div>
      </div>
    </div>
  );
}
