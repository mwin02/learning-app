'use client';

// Q9 — the two corrections a reviewer can make from the approval queue, where
// they are cheapest: the page is already open, so the true duration and the true
// topic are free here and nowhere else.
//
// Two endpoints, deliberately, because they are two axes:
//   duration → PATCH /api/playground/resources   (metadata whitelist; the server
//              stamps `durationSource: 'reviewer'` — never sent from here, a
//              client cannot assert a provenance other than "a human measured it")
//   topic    → POST  /api/playground/resource-refile  (filing; routes through
//              setPrimaryTopic so the ResourceTopic membership and the
//              `Resource.topic` mirror move together)
//
// Neither is a precondition for approving. A row with no measurable duration
// stays approvable with `unknown` — see the page's note.
//
// Collapsed behind a toggle so the queue stays scannable; ReviewActions next door
// is the same shape (thin client, no decision logic, refresh on success).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { MAX_EDITABLE_DURATION_MIN } from '@/lib/api/resource-update-schema';

// The response is a boundary like any other: parsed, not cast. Only the three
// fields this component renders — both routes return more, and neither shape is
// this component's business.
const replySchema = z.object({
  error: z.string().optional(),
  warning: z.string().optional(),
  topic: z.string().optional(),
});

const INPUT_CLASS =
  'rounded border border-gray-300 px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40';
const SUBMIT_CLASS =
  'rounded border border-gray-500 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40';

export function RowCorrections({
  resourceId,
  currentTopic,
  currentDurationMin,
}: {
  resourceId: string;
  currentTopic: string | null;
  currentDurationMin: number | null;
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'duration' | 'topic' | null>(null);
  const [duration, setDuration] = useState(currentDurationMin?.toString() ?? '');
  // Prefilled so the reviewer edits a slug rather than recalling one; the server
  // refuses an unchanged topic, so a stray click cannot rewrite provenance alone.
  const [topic, setTopic] = useState(currentTopic ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const disabled = busy !== null || isRefreshing;

  async function send(which: 'duration' | 'topic', url: string, method: string, body: unknown) {
    setBusy(which);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = replySchema.safeParse(await res.json().catch(() => ({})));
      const reply = parsed.success ? parsed.data : {};
      if (!res.ok) {
        setMsg({ ok: false, text: reply.error ?? `HTTP ${res.status}` });
        return;
      }
      const warning = reply.warning ? ` — ${reply.warning}` : '';
      setMsg({
        ok: true,
        text:
          which === 'duration'
            ? `duration saved as reviewer-measured${warning}`
            : `refiled to "${reply.topic ?? topic.trim()}" (origin review)`,
      });
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // Rejected here rather than posted and bounced, so "90 min" or "12.5" reads back
  // in the operator's own words instead of a generic validation failure.
  function submitDuration() {
    const minutes = Number(duration.trim());
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EDITABLE_DURATION_MIN) {
      setMsg({
        ok: false,
        text: `A whole number of minutes, 1–${MAX_EDITABLE_DURATION_MIN} — “${duration.trim()}” was not applied.`,
      });
      return;
    }
    void send('duration', '/api/playground/resources', 'PATCH', {
      resourceId,
      fields: { durationMin: minutes },
    });
  }

  function submitTopic() {
    const value = topic.trim();
    if (!value) {
      setMsg({ ok: false, text: 'Enter a topic slug to refile onto.' });
      return;
    }
    void send('topic', '/api/playground/resource-refile', 'POST', { resourceId, topic: value });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs text-gray-500 underline"
      >
        Correct duration / topic
      </button>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
        <label className="flex items-center gap-1">
          Duration
          <input
            type="number"
            min={1}
            max={MAX_EDITABLE_DURATION_MIN}
            value={duration}
            disabled={disabled}
            onChange={(e) => setDuration(e.target.value)}
            className={`${INPUT_CLASS} w-20`}
          />
          min
        </label>
        <button type="button" disabled={disabled} onClick={submitDuration} className={SUBMIT_CLASS}>
          {busy === 'duration' ? '…' : 'Save measured'}
        </button>
        <label className="flex items-center gap-1">
          Topic
          <input
            type="text"
            value={topic}
            disabled={disabled}
            onChange={(e) => setTopic(e.target.value)}
            className={`${INPUT_CLASS} w-44`}
          />
        </label>
        <button type="button" disabled={disabled} onClick={submitTopic} className={SUBMIT_CLASS}>
          {busy === 'topic' ? '…' : 'Refile'}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}
