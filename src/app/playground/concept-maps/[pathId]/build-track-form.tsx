'use client';

// Phase 2.5e-4: "Build a Track" trigger on the inspector. Collapsed to a button
// until opened, then a small form for the learner inputs (prior knowledge, target
// mastery, timeframe, hours/week) that POSTs to /api/playground/build-track and,
// on success, redirects to the read-only Track view. Disabled unless the Path is
// spine_ready — the builder gates on it, so we don't even let the operator try.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Difficulty } from '@prisma/client';

const MASTERY = Object.values(Difficulty);
const BTN = 'rounded border px-2 py-1 text-sm disabled:opacity-40 disabled:cursor-not-allowed';
const FIELD = 'rounded border px-2 py-1 text-sm';

export function BuildTrackForm({ pathId, spineReady }: { pathId: string; spineReady: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [priorKnowledge, setPriorKnowledge] = useState('');
  const [targetMastery, setTargetMastery] = useState<Difficulty>(Difficulty.beginner);
  const [timeframeWeeks, setTimeframeWeeks] = useState('6');
  const [hoursPerWeek, setHoursPerWeek] = useState('5');

  if (!spineReady) {
    return (
      <p className="text-sm text-gray-500">
        Build a Track — available once this map is <code>spine_ready</code>.
      </p>
    );
  }

  if (!open) {
    return (
      <button className={BTN} onClick={() => setOpen(true)}>
        Build a Track
      </button>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { pathId, targetMastery };
      if (priorKnowledge.trim()) body.priorKnowledge = priorKnowledge.trim();
      const weeks = Number(timeframeWeeks);
      const hours = Number(hoursPerWeek);
      if (Number.isInteger(weeks) && weeks > 0) body.timeframeWeeks = weeks;
      if (Number.isInteger(hours) && hours > 0) body.hoursPerWeek = hours;

      const res = await fetch('/api/playground/build-track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: { trackId?: string; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.trackId) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/playground/tracks/${data.trackId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded border p-3 max-w-md">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Build a Track</span>
        <button className="text-xs text-gray-500 underline" onClick={() => setOpen(false)} disabled={busy}>
          cancel
        </button>
      </div>

      <label className="text-xs text-gray-600">
        Prior knowledge (free text)
        <textarea
          className={`${FIELD} mt-0.5 w-full`}
          rows={2}
          value={priorKnowledge}
          onChange={(e) => setPriorKnowledge(e.target.value)}
          placeholder="e.g. comfortable with basic Python and algebra"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-gray-600 flex flex-col">
          Target mastery
          <select
            className={`${FIELD} mt-0.5`}
            value={targetMastery}
            onChange={(e) => setTargetMastery(e.target.value as Difficulty)}
          >
            {MASTERY.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-600 flex flex-col">
          Timeframe (weeks)
          <input
            className={`${FIELD} mt-0.5 w-24`}
            type="number"
            min={1}
            value={timeframeWeeks}
            onChange={(e) => setTimeframeWeeks(e.target.value)}
          />
        </label>
        <label className="text-xs text-gray-600 flex flex-col">
          Hours / week
          <input
            className={`${FIELD} mt-0.5 w-24`}
            type="number"
            min={1}
            value={hoursPerWeek}
            onChange={(e) => setHoursPerWeek(e.target.value)}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button className={BTN} onClick={submit} disabled={busy}>
          {busy ? 'Building…' : 'Build'}
        </button>
        <span className="text-xs text-gray-500">Runs a live compose call (~10–30s).</span>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
