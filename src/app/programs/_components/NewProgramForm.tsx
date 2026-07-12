'use client';

// Phase 3e: posts /api/generate-program and routes to the program hub on 202.
// The POST + error-vocabulary mapping lives in the shared submitProgram helper
// (chat intake Block 4) — the chat confirmation card uses the same one.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitProgram } from './submit-program';

// Notebook language (intake Block 5): fields are sticky-note fills with gold
// kicker labels, matching the chat pane it shares the sheet with.
const inputCls =
  'w-full rounded border border-note-edge bg-note px-3 py-2 font-script text-sm text-script-body outline-none placeholder:italic placeholder:text-script-dim';

export function NewProgramForm({ defaultGoal }: { defaultGoal?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const result = await submitProgram({
      goal: String(f.get('goal') ?? ''),
      background: String(f.get('background') ?? '') || undefined,
      totalHoursPerWeek: Number(f.get('totalHoursPerWeek')),
      totalWeeks: Number(f.get('totalWeeks')),
    });
    if (result.ok) {
      router.push(`/programs/${result.programId}`);
      return;
    }
    setBusy(false);
    setError(result.message);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="nb-kicker text-[11px] text-note-label">Goal *</span>
        <textarea
          name="goal"
          required
          maxLength={2000}
          rows={3}
          defaultValue={defaultGoal}
          placeholder="e.g. Be ready for first-year CS: comfortable with Python and calculus"
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="nb-kicker text-[11px] text-note-label">Your background (optional)</span>
        <textarea
          name="background"
          maxLength={2000}
          rows={2}
          placeholder="What do you already know?"
          className={inputCls}
        />
      </label>
      <div className="flex gap-4">
        <label className="flex flex-1 flex-col gap-1">
          <span className="nb-kicker text-[11px] text-note-label">Hours / week *</span>
          <input type="number" name="totalHoursPerWeek" required min={1} max={40} defaultValue={5} className={inputCls} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="nb-kicker text-[11px] text-note-label">Weeks *</span>
          <input type="number" name="totalWeeks" required min={1} max={52} defaultValue={8} className={inputCls} />
        </label>
      </div>
      {error && <p className="font-script text-sm text-crayon-red">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="btn-ink -rotate-[0.5deg] self-start px-6 py-1.5 text-[24px] disabled:opacity-50"
      >
        {busy ? 'Planning your program…' : 'Generate program'}
      </button>
      <p className="font-script text-xs text-script-faint">
        Planning takes a few seconds; the tracks build in the background afterwards.
      </p>
    </form>
  );
}
