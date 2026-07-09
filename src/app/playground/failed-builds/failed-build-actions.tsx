'use client';

// Action buttons for the failed-builds page. Thin client over
// POST /api/playground/failed-builds — owns no decision logic, just sends the
// action and refreshes the server-rendered list so the acted row updates
// (a retried request leaves the failed list; a deleted row disappears).
//
// Retry is async by design: it only re-queues, and the running worker rebuilds
// the request next tick — so the toast says "re-queued", not "rebuilt".

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type DeleteKind = 'courseRequest' | 'program' | 'track';

async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  try {
    const res = await fetch('/api/playground/failed-builds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, text: (data.error as string) ?? `HTTP ${res.status}` };
    if (data.requeued) {
      return { ok: true, text: data.programReset ? 're-queued · program → building' : 're-queued' };
    }
    return { ok: true, text: 'deleted' };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}

const BTN = 'rounded border px-2 py-0.5 text-2xs disabled:cursor-not-allowed disabled:opacity-40';
const RETRY_CLASS = 'border-indigo-600 text-indigo-700 hover:bg-indigo-50';
const DELETE_CLASS = 'border-red-700 text-red-700 hover:bg-red-50';

// Retry + Delete for a failed CourseRequest row.
export function RequestActions({ courseRequestId }: { courseRequestId: string }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const disabled = busy !== null || isRefreshing;

  async function run(label: string, body: Record<string, unknown>) {
    setBusy(label);
    setMsg(null);
    const result = await postAction(body);
    setMsg(result);
    setBusy(null);
    if (result.ok) startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col gap-1 mt-1">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => run('retry', { action: 'retry', courseRequestId })}
          className={`${BTN} ${RETRY_CLASS}`}
        >
          {busy === 'retry' ? '…' : 'Retry'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (!confirm('Delete this failed build request? This cannot be undone.')) return;
            run('delete', { action: 'delete', kind: 'courseRequest', id: courseRequestId });
          }}
          className={`${BTN} ${DELETE_CLASS}`}
        >
          {busy === 'delete' ? '…' : 'Delete'}
        </button>
      </div>
      {msg && <p className={`text-2xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}

// Delete for a failed plan-pass Program (or, generally, a failed Track/Program).
export function DeleteButton({ kind, id, label }: { kind: DeleteKind; id: string; label: string }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
    setBusy(true);
    setMsg(null);
    const result = await postAction({ action: 'delete', kind, id });
    setMsg(result);
    setBusy(false);
    if (result.ok) startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" disabled={busy || isRefreshing} onClick={run} className={`${BTN} ${DELETE_CLASS}`}>
        {busy ? '…' : 'Delete'}
      </button>
      {msg && <span className={`text-2xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</span>}
    </div>
  );
}
