'use client';

// Per-row curation buttons for the human-review queue. Thin client over POST
// /api/playground/decomposition-review (2.5b-6): it owns no decision logic — it
// just sends the action and reflects the API's response, then refreshes the
// server-rendered list so a decided row drops out of the queue.
//
// On a successful accept/reject/decompose the row leaves the queue and this
// component unmounts on refresh. The message stays visible only for the case
// that KEEPS the row: a non-forced decompose that re-routed to human_review
// (e.g. oversize) — where the API's `reason` tells you to retry with Force.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DecomposeManualModal } from './decompose-manual-modal';

type Action = 'accept_atomic' | 'reject' | 'decompose';

type ReviewResult = {
  resourceId: string;
  status: string;
  childrenCreated?: number;
  reason?: string;
};

// label is also the in-flight key, so only the clicked button shows "…".
const BUTTONS: Array<{ label: string; action: Action; force?: boolean; className: string }> = [
  { label: 'Accept atomic', action: 'accept_atomic', className: 'border-green-600 text-green-700 hover:bg-green-50' },
  { label: 'Reject', action: 'reject', className: 'border-red-600 text-red-700 hover:bg-red-50' },
  { label: 'Decompose', action: 'decompose', className: 'border-blue-600 text-blue-700 hover:bg-blue-50' },
  { label: 'Force decompose', action: 'decompose', force: true, className: 'border-blue-800 text-blue-900 hover:bg-blue-50' },
];

export function ReviewActions({ resourceId, title }: { resourceId: string; title: string }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const disabled = busy !== null || isRefreshing;

  async function run(label: string, action: Action, force: boolean) {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch('/api/playground/decomposition-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceId, action, force }),
      });
      const data: ReviewResult & { error?: string } = await res.json().catch(() => ({}) as never);
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const parts = [`→ ${data.status}`];
      if (typeof data.childrenCreated === 'number') parts.push(`${data.childrenCreated} children`);
      if (data.reason) parts.push(data.reason);
      setMsg({ ok: true, text: parts.join(' · ') });
      // Re-render the server list: decided rows drop out; a row that stayed
      // queued (e.g. decompose → human_review) remains, now with the message.
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {BUTTONS.map((b) => (
          <button
            key={b.label}
            type="button"
            disabled={disabled}
            onClick={() => run(b.label, b.action, b.force ?? false)}
            className={`rounded border px-2 py-0.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed ${b.className}`}
          >
            {busy === b.label ? '…' : b.label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setManualOpen(true)}
          className="rounded border border-purple-700 px-2 py-0.5 text-xs text-purple-800 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Decompose manual…
        </button>
      </div>
      {msg && (
        <p className={`text-xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</p>
      )}
      {manualOpen && (
        <DecomposeManualModal
          resourceId={resourceId}
          title={title}
          onClose={() => setManualOpen(false)}
        />
      )}
    </div>
  );
}
