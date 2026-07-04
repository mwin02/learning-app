'use client';

// Phase 3e: posts /api/generate-program and routes to the program hub on 202.
// Handles the route's real error vocabulary: 429 FREE_LIMIT_REACHED (quota),
// 422 PLAN_EMPTY (goal produced no in-domain topics), 400/500 generic.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputCls =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink';

export function NewProgramForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const body = {
      goal: String(f.get('goal') ?? ''),
      background: String(f.get('background') ?? '') || undefined,
      totalHoursPerWeek: Number(f.get('totalHoursPerWeek')),
      totalWeeks: Number(f.get('totalWeeks')),
    };
    const res = await fetch('/api/generate-program', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 202 && data.programId) {
      router.push(`/programs/${data.programId}`);
      return;
    }
    setBusy(false);
    if (data.code === 'FREE_LIMIT_REACHED') {
      setError(`You've reached the free limit of ${data.details?.limit ?? ''} programs this month.`);
    } else if (data.code === 'PLAN_EMPTY') {
      setError('We could not turn that goal into a program — try a more specific learning goal.');
    } else if (data.code === 'INVALID_INPUT') {
      setError('Please check the form — some fields are invalid.');
    } else {
      setError('Something went wrong. Please try again.');
    }
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
