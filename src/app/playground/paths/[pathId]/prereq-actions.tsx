'use client';

// Per-concept prerequisite editing on the inspector (2.5d-7b): list this concept's
// existing prerequisites each with a remove (✕), plus an "add prerequisite" picker
// over the other concepts in the map. Replaces the static "requires: …" line.
//
// Edge direction matches the API: a prerequisite P of concept C is the edge
// P → C, so add posts { fromConceptId: P, toConceptId: C } and remove posts the
// same pair. The picker excludes self, already-direct prerequisites, and — for a
// SPINE concept — frontier candidates (a spine concept's prerequisites must all be
// spine, or trimming the frontier node would strand it; the API also hard-rejects
// this). Cycle rejection stays the API's job: a would-be cycle surfaces as the
// inline 409 error rather than being pre-filtered here.

import { useState } from 'react';
import { useMapEdit } from './use-map-edit';

type Membership = 'spine' | 'frontier';
// Displayed prerequisites need only id + title; picker candidates also carry
// membership so a spine concept can filter out frontier options.
type PrereqRef = { id: string; title: string };
type ConceptRef = PrereqRef & { membership: Membership };

const BTN = 'rounded border px-1.5 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

export function PrereqActions({
  conceptId,
  membership,
  prereqs,
  allConcepts,
}: {
  conceptId: string;
  membership: Membership;
  prereqs: PrereqRef[];
  allConcepts: ConceptRef[];
}) {
  const { run, busy, error, pending } = useMapEdit();
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const disabled = busy || pending;

  const prereqIds = new Set(prereqs.map((p) => p.id));
  // Candidates: every other concept not already a direct prerequisite. A spine
  // concept additionally can't take a frontier prerequisite (spine stays
  // downward-closed) — so those are filtered out of the picker for it.
  const candidates = allConcepts.filter(
    (c) =>
      c.id !== conceptId &&
      !prereqIds.has(c.id) &&
      !(membership === 'spine' && c.membership === 'frontier'),
  );

  async function add() {
    if (pick === '') return;
    const ok = await run({ action: 'add_prereq', fromConceptId: pick, toConceptId: conceptId });
    if (ok) {
      setPick('');
      setAdding(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-1 text-xs text-gray-500">
      <div className="flex flex-wrap items-center gap-1">
        {prereqs.length === 0 ? (
          <span>foundational (no prerequisites)</span>
        ) : (
          <>
            <span>requires:</span>
            {prereqs.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5">
                {p.title}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => run({ action: 'remove_prereq', fromConceptId: p.id, toConceptId: conceptId })}
                  className="text-red-600 hover:text-red-800 disabled:opacity-40"
                  aria-label={`Remove prerequisite ${p.title}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </>
        )}

        {adding ? (
          <span className="inline-flex items-center gap-1">
            <select value={pick} disabled={disabled} onChange={(e) => setPick(e.target.value)} className="rounded border px-1 py-0.5">
              <option value="">(pick a prerequisite)</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <button type="button" disabled={disabled || pick === ''} onClick={add} className={`${BTN} border-green-600 text-green-700 hover:bg-green-50`}>
              Add
            </button>
            <button type="button" disabled={disabled} onClick={() => setAdding(false)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
              Cancel
            </button>
          </span>
        ) : (
          candidates.length > 0 && (
            <button type="button" disabled={disabled} onClick={() => setAdding(true)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
              + prerequisite
            </button>
          )
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </div>
  );
}
