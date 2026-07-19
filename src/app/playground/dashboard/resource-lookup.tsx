'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Jump box for the resource detail page — the resource index tab is gone, so
// this is how an operator opens /playground/resource/[id] from a pasted id.
export function ResourceLookup() {
  const router = useRouter();
  const [id, setId] = useState('');

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = id.trim();
        if (trimmed) router.push(`/playground/resource/${encodeURIComponent(trimmed)}`);
      }}
    >
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="Resource id (cuid)"
        className="w-72 rounded border px-2 py-1 text-sm font-mono"
      />
      <button
        type="submit"
        className="rounded border px-3 py-1 text-sm hover:bg-gray-100"
        disabled={id.trim() === ''}
      >
        Open
      </button>
    </form>
  );
}
