'use client';

// Per-candidate-resource in-place edit buttons on the inspector (2.5d-7): rescore
// (change role + coverageScore) or detach a Concept↔Resource link. Attaching a
// NEW resource needs a picker, so it's 2.5d-7b. Rescore opens a small inline
// editor (a role <select> + a 0–1 number input); on save it posts rescore_resource
// and the refreshed list re-renders with the new score + recomputed readiness
// (a teaches≥floor rescore can flip a spine hole's Path to spine_ready, and back).

import { useState } from 'react';
import { ConceptResourceRole } from '@prisma/client';
import { useMapEdit } from './use-map-edit';

const ROLES = Object.values(ConceptResourceRole);
const BTN = 'rounded border px-1.5 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

export function ResourceActions({
  conceptId,
  resourceId,
  role,
  coverageScore,
}: {
  conceptId: string;
  resourceId: string;
  role: ConceptResourceRole;
  coverageScore: number;
}) {
  const { run, busy, error, pending, setError } = useMapEdit();
  const [editing, setEditing] = useState(false);
  const [nextRole, setNextRole] = useState<ConceptResourceRole>(role);
  const [score, setScore] = useState(String(coverageScore));
  const disabled = busy || pending;

  async function detach() {
    if (!window.confirm('Detach this resource from the concept?')) return;
    await run({ action: 'detach_resource', conceptId, resourceId });
  }

  async function save() {
    const cs = Number(score);
    if (!Number.isFinite(cs) || cs < 0 || cs > 1) {
      setError('coverageScore must be 0–1');
      return;
    }
    const ok = await run({ action: 'rescore_resource', conceptId, resourceId, role: nextRole, coverageScore: cs });
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <select
          value={nextRole}
          disabled={disabled}
          onChange={(e) => setNextRole(e.target.value as ConceptResourceRole)}
          className="rounded border px-1 py-0.5 text-xs"
        >
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
          className="w-16 rounded border px-1 py-0.5 text-xs tabular-nums"
        />
        <button type="button" disabled={disabled} onClick={save} className={`${BTN} border-green-600 text-green-700 hover:bg-green-50`}>
          Save
        </button>
        <button type="button" disabled={disabled} onClick={() => setEditing(false)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
          Cancel
        </button>
        {error && <span className="text-red-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" disabled={disabled} onClick={() => setEditing(true)} className={`${BTN} border-gray-400 text-gray-600 hover:bg-gray-50`}>
        Rescore
      </button>
      <button type="button" disabled={disabled} onClick={detach} className={`${BTN} border-red-500 text-red-600 hover:bg-red-50`}>
        Detach
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}
