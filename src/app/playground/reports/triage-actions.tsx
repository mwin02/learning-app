'use client';

// Action buttons for one category group in the operator triage queue. Thin client
// over POST /api/playground/reports: it owns no decision logic — which actions a
// category offers is report-triage-view.ts's pure rule, and what each action does
// is report-triage.ts's. This sends and refreshes.
//
// Three actions need a payload, so they reveal a small inline control instead of
// firing immediately: `refile` (the target topic), `edit` (the corrected fields)
// and — when the group was reported from more than one lesson — `unlink` (which
// lesson). Everything else is one click.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ReportCategory, Difficulty } from '@prisma/client';
import type { TriageAction } from '@/lib/curation/report-triage';
import {
  actionsForCategory,
  ACTION_LABELS,
  ACTION_CLASSES,
  type LessonChoice,
} from '@/lib/report-triage-view';
import { MAX_EDITABLE_DURATION_MIN } from '@/lib/api/resource-update-schema';

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
  lessonChoices,
  currentTopic,
  currentRequiresPurchase,
}: {
  reportId: string;
  category: ReportCategory;
  lessonChoices: LessonChoice[];
  currentTopic: string | null;
  currentRequiresPurchase: boolean;
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<TriageAction | null>(null);
  const [open, setOpen] = useState<'refile' | 'edit' | 'unlink' | null>(null);
  // Which reported lesson `unlink` acts on. It closes only the reports about the
  // lesson it unlinked, so the choice IS the scope of the resolution.
  const [pickedLessonReport, setPickedLessonReport] = useState<string | null>(null);
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
  // Derived, never stored: a successful unlink refreshes the page and the target
  // it resolved leaves `lessonChoices`, but this component does not remount. A
  // stored id would then match no <option> — the browser would show the first
  // remaining lesson while the value still pointed at the closed report, so the
  // next click acted on a resolved row and reported `not_open` against a lesson
  // the operator was never shown. Falling back keeps what is displayed and what
  // is sent the same thing.
  const lessonReport =
    lessonChoices.find((c) => c.reportId === pickedLessonReport)?.reportId ??
    lessonChoices[0]?.reportId ??
    reportId;

  async function send(
    action: TriageAction,
    extra: Record<string, unknown> = {},
    targetReportId = reportId,
  ) {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch('/api/playground/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportId: targetReportId, action, resolveSiblings, ...extra }),
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
    // A duration the API would reject is reported here rather than dropped — the
    // old silent skip posted the OTHER fields and reported success, so "90 min"
    // or "12.5" looked applied and was not.
    if (duration.trim()) {
      const minutes = Number(duration);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EDITABLE_DURATION_MIN) {
        setMsg({
          ok: false,
          text: `durationMin must be a whole number of minutes, 1–${MAX_EDITABLE_DURATION_MIN} — “${duration.trim()}” was not applied.`,
        });
        return;
      }
      fields.durationMin = minutes;
    }
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
            onClick={() => {
              // One reported lesson (the common case) needs no picker — but it
              // still acts on THAT lesson's report, which is not always the
              // group's oldest.
              if (action === 'unlink' && lessonChoices.length <= 1) {
                void send(action, {}, lessonChoices[0]?.reportId ?? reportId);
                return;
              }
              if (action === 'refile' || action === 'edit' || action === 'unlink') {
                setOpen(open === action ? null : action);
                return;
              }
              void send(action);
            }}
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

      {open === 'unlink' && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={lessonReport}
            onChange={(e) => setPickedLessonReport(e.target.value)}
            className="max-w-xs rounded border px-2 py-0.5 text-xs"
          >
            {lessonChoices.map((c) => (
              <option key={c.reportId} value={c.reportId}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send('unlink', {}, lessonReport)}
            className="rounded border border-amber-600 px-2 py-0.5 text-xs text-amber-700 disabled:opacity-40"
          >
            Unlink
          </button>
          <span className="text-xs text-gray-500">closes only this lesson&rsquo;s reports</span>
        </div>
      )}

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
