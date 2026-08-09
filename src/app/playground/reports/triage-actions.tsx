'use client';

// Action buttons for one category group in the operator triage queue. Thin client
// over POST /api/playground/reports: it owns no decision logic — which actions a
// category offers is report-triage-view.ts's pure rule, and what each action does
// is report-triage.ts's. This sends and refreshes.
//
// Two actions need a payload, so they reveal a small inline field instead of
// firing immediately: `refile` (the target topic) and `edit` (the corrected
// fields). Everything else is one click.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ReportCategory, Difficulty } from '@prisma/client';
import type { TriageAction } from '@/lib/curation/report-triage';
import { actionsForCategory, ACTION_LABELS, ACTION_CLASSES } from '@/lib/report-triage-view';

type EditFields = {
  durationMin?: number;
  title?: string;
  summary?: string;
  difficulty?: Difficulty;
  requiresPurchase?: boolean;
};

export function TriageActions({
  reportId,
  category,
  currentTopic,
  currentRequiresPurchase,
}: {
  reportId: string;
  category: ReportCategory;
  currentTopic: string | null;
  currentRequiresPurchase: boolean;
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<TriageAction | null>(null);
  const [open, setOpen] = useState<'refile' | 'edit' | null>(null);
  const [topic, setTopic] = useState(currentTopic ?? '');
  const [duration, setDuration] = useState('');
  const [difficulty, setDifficulty] = useState('');
  // durationMin and difficulty encode "untouched" as '' — a value neither field
  // can legitimately take. A boolean has no such spare value: `false` is a real
  // setting, so an unchecked box is indistinguishable from an untouched one, and
  // submitting it would silently rewrite "paywalled" to "free" on every unrelated
  // edit. So the checkbox starts from the row's CURRENT value (nothing to submit
  // if it is left alone) and `purchaseTouched` is the sentinel the empty string
  // plays for the others.
  const [requiresPurchase, setRequiresPurchase] = useState(currentRequiresPurchase);
  const [purchaseTouched, setPurchaseTouched] = useState(false);
  const [resolveSiblings, setResolveSiblings] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const disabled = busy !== null || isRefreshing;
  const actions = actionsForCategory(category);

  async function send(action: TriageAction, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch('/api/playground/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportId, action, resolveSiblings, ...extra }),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setMsg({ ok: false, text: (data.error as string) ?? `HTTP ${res.status}` });
        return;
      }
      const also = typeof data.alsoResolved === 'number' && data.alsoResolved > 0
        ? ` · +${data.alsoResolved} duplicate report(s)`
        : '';
      setMsg({ ok: true, text: `${(data.resolution as string) ?? 'done'}${also}` });
      setOpen(null);
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function submitEdit() {
    const fields: EditFields = {};
    const minutes = Number(duration);
    if (duration.trim() && Number.isInteger(minutes) && minutes > 0) fields.durationMin = minutes;
    if (difficulty) fields.difficulty = difficulty as Difficulty;
    if (purchaseTouched) fields.requiresPurchase = requiresPurchase;
    if (Object.keys(fields).length === 0) {
      setMsg({ ok: false, text: 'Change a duration, a difficulty, or the paywall flag first.' });
      return;
    }
    void send('edit', { fields });
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={disabled}
            onClick={() =>
              action === 'refile' || action === 'edit'
                ? setOpen(open === action ? null : action)
                : void send(action)
            }
            className={`rounded border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${ACTION_CLASSES[action]}`}
          >
            {busy === action ? '…' : ACTION_LABELS[action]}
          </button>
        ))}
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={resolveSiblings}
            onChange={(e) => setResolveSiblings(e.target.checked)}
          />
          also close duplicates
        </label>
      </div>

      {open === 'refile' && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="target topic"
            className="rounded border px-2 py-0.5 text-xs"
          />
          <button
            type="button"
            disabled={disabled || topic.trim().length === 0}
            onClick={() => void send('refile', { topic: topic.trim() })}
            className="rounded border border-blue-600 px-2 py-0.5 text-xs text-blue-700 disabled:opacity-40"
          >
            Refile
          </button>
        </div>
      )}

      {open === 'edit' && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="durationMin"
            inputMode="numeric"
            className="w-28 rounded border px-2 py-0.5 text-xs"
          />
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="rounded border px-2 py-0.5 text-xs"
          >
            <option value="">difficulty…</option>
            <option value="beginner">beginner</option>
            <option value="intermediate">intermediate</option>
            <option value="advanced">advanced</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={requiresPurchase}
              onChange={(e) => {
                setRequiresPurchase(e.target.checked);
                setPurchaseTouched(true);
              }}
            />
            requiresPurchase
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={submitEdit}
            className="rounded border border-blue-600 px-2 py-0.5 text-xs text-blue-700 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      )}

      {msg && <p className={`text-xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}
