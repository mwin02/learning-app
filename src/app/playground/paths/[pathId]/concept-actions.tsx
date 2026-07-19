'use client';

// Per-concept in-place edit buttons on the inspector (2.5d-7): flip membership
// (spine↔frontier), rename, or remove. Picker-free actions only — add_concept /
// prereq edges / resource attach (which need pickers) are 2.5d-7b. Each posts one
// map-edit action via useMapEdit, which refreshes the server list (and any
// recomputed Path readiness) on success.

import { useMapEdit } from './use-map-edit';

const BTN = 'rounded border px-2 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

export function ConceptActions({
  conceptId,
  title,
  membership,
}: {
  conceptId: string;
  title: string;
  membership: 'spine' | 'frontier';
}) {
  const { run, busy, error, pending } = useMapEdit();
  const disabled = busy || pending;
  const toggleTo = membership === 'spine' ? 'frontier' : 'spine';

  async function rename() {
    const next = window.prompt('Rename concept', title);
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === title) return;
    await run({ action: 'edit_concept', conceptId, title: trimmed });
  }

  async function remove() {
    if (!window.confirm(`Remove concept "${title}"? Its prereq edges and resource links are deleted too.`)) {
      return;
    }
    await run({ action: 'remove_concept', conceptId });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => run({ action: 'set_membership', conceptId, membership: toggleTo })}
        className={`${BTN} border-indigo-600 text-indigo-700 hover:bg-indigo-50`}
      >
        Make {toggleTo}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={rename}
        className={`${BTN} border-gray-500 text-gray-700 hover:bg-gray-50`}
      >
        Rename
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={remove}
        className={`${BTN} border-red-600 text-red-700 hover:bg-red-50`}
      >
        Remove
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
