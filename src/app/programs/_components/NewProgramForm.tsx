'use client';

// Phase 3e: posts /api/generate-program and routes to the program hub on 202.
// The POST + error-vocabulary mapping lives in the shared submitProgram helper
// (chat intake Block 4) — the chat confirmation card uses the same one.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitProgram } from './submit-program';

const inputCls =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink';

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
        <span className="meta-xs">Goal *</span>
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
        <span className="meta-xs">Your background (optional)</span>
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
          <span className="meta-xs">Hours / week *</span>
          <input type="number" name="totalHoursPerWeek" required min={1} max={40} defaultValue={5} className={inputCls} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="meta-xs">Weeks *</span>
          <input type="number" name="totalWeeks" required min={1} max={52} defaultValue={8} className={inputCls} />
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-button bg-brand px-5 py-2.5 font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Planning your program…' : 'Generate program'}
      </button>
      <p className="meta-xs">
        Planning takes a few seconds; the tracks build in the background afterwards.
      </p>
    </form>
  );
}
