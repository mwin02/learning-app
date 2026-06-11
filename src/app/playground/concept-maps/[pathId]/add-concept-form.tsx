'use client';

// Path-level "add concept" form on the inspector (2.5d-7b). Collapsed to a single
// button until opened, then a slug + title + membership row that posts add_concept
// via useMapEdit. A new spine concept starts as a spine hole (no resources yet), so
// the refreshed header reflects the recomputed readiness immediately.

import { useState } from 'react';
import { useMapEdit } from './use-map-edit';

const BTN = 'rounded border px-2 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

export function AddConceptForm({ pathId }: { pathId: string }) {
  const { run, busy, error, pending, setError } = useMapEdit();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [membership, setMembership] = useState<'spine' | 'frontier'>('spine');
  const disabled = busy || pending;

  async function add() {
    if (slug.trim() === '' || title.trim() === '') {
      setError('slug and title are required');
      return;
    }
    const ok = await run({
      action: 'add_concept',
      pathId,
      slug: slug.trim(),
      title: title.trim(),
      membership,
    });
    if (ok) {
      setSlug('');
      setTitle('');
      setMembership('spine');
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${BTN} border-indigo-600 text-indigo-700 hover:bg-indigo-50`}>
        + Add concept
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-indigo-200 bg-indigo-50/40 p-2 text-xs">
      <input
        value={slug}
        disabled={disabled}
        onChange={(e) => setSlug(e.target.value)}
        placeholder="slug (kebab-case)"
        className="w-44 rounded border px-1.5 py-0.5"
      />
      <input
        value={title}
        disabled={disabled}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="title"
        className="w-56 rounded border px-1.5 py-0.5"
      />
      <select
        value={membership}
        disabled={disabled}
        onChange={(e) => setMembership(e.target.value as 'spine' | 'frontier')}
        className="rounded border px-1 py-0.5"
      >
        <option value="spine">spine</option>
        <option value="frontier">frontier</option>
      </select>
      <button type="button" disabled={disabled} onClick={add} className={`${BTN} border-green-600 text-green-700 hover:bg-green-50`}>
        Add
      </button>
      <button type="button" disabled={disabled} onClick={() => setOpen(false)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
        Cancel
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
