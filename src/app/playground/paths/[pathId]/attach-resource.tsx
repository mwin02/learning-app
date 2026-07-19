'use client';

// Per-concept "attach resource" picker on the inspector (2.5d-7c) — the search-
// backed action that fills a spine hole from the UI. Collapsed to a button until
// opened, then: a search box hitting /api/playground/resource-search (pickable
// candidates only), a shared role + coverageScore the operator sets once, and an
// Attach button per result that posts attach_resource via useMapEdit. On success
// the refreshed concept shows the new candidate and any readiness flip
// (teaches≥floor on a hole → Path spine_ready).

import { useState } from 'react';
import { ConceptResourceRole } from '@prisma/client';
import { useMapEdit } from './use-map-edit';

const ROLES = Object.values(ConceptResourceRole);
const BTN = 'rounded border px-1.5 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

type Candidate = {
  id: string;
  title: string;
  url: string;
  type: string;
  difficulty: string;
  topic: string;
  conceptsTaught: string[];
};

export function AttachResource({
  conceptId,
  conceptTitle,
  topic,
}: {
  conceptId: string;
  conceptTitle: string;
  topic: string;
}) {
  const { run, busy, error, pending, setError } = useMapEdit();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(conceptTitle);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [role, setRole] = useState<ConceptResourceRole>(ConceptResourceRole.teaches);
  const [score, setScore] = useState('0.8');
  const disabled = busy || pending || searching;

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query.trim(), topic });
      const res = await fetch(`/api/playground/resource-search?${params}`);
      const data: { results?: Candidate[]; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResults(data.results ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function attach(resourceId: string) {
    const cs = Number(score);
    if (!Number.isFinite(cs) || cs < 0 || cs > 1) {
      setError('coverageScore must be 0–1');
      return;
    }
    // On success the list refreshes and this picker unmounts, so no local reset.
    await run({ action: 'attach_resource', conceptId, resourceId, role, coverageScore: cs });
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${BTN} border-emerald-600 text-emerald-700 hover:bg-emerald-50`}>
        + Attach resource
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border border-emerald-200 bg-emerald-50/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <input
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="search pickable resources…"
          className="w-64 rounded border px-1.5 py-0.5"
        />
        <button type="button" disabled={disabled} onClick={search} className={`${BTN} border-emerald-600 text-emerald-700 hover:bg-emerald-50`}>
          {searching ? '…' : 'Search'}
        </button>
        <span className="ml-2 text-gray-500">attach as</span>
        <select value={role} disabled={disabled} onChange={(e) => setRole(e.target.value as ConceptResourceRole)} className="rounded border px-1 py-0.5">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={score}
          disabled={disabled}
          onChange={(e) => setScore(e.target.value)}
          className="w-16 rounded border px-1 py-0.5 tabular-nums"
        />
        <button type="button" disabled={disabled} onClick={() => setOpen(false)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
          Close
        </button>
        {error && <span className="text-red-600">{error}</span>}
      </div>

      {results !== null && (
        results.length === 0 ? (
          <p className="text-gray-500">no pickable resources match.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {results.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <button type="button" disabled={disabled} onClick={() => attach(r.id)} className={`${BTN} border-green-600 text-green-700 hover:bg-green-50`}>
                  Attach
                </button>
                <a href={r.url} target="_blank" rel="noreferrer" className="underline truncate max-w-md">
                  {r.title}
                </a>
                <span className="text-gray-400">
                  {r.type} · {r.topic}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
