'use client';

// Action buttons for the pending-review (status-approval) queue. Thin client
// over POST /api/playground/pending-resources: it owns no decision logic — it
// sends the action and refreshes the server-rendered list so a decided row
// drops out (or, for a cascade, the whole tree does; a decomposed one moves to
// the blocked section). Button definitions live in buttons.ts (a plain module)
// so the server page can compose per-row variants.
//
// `cascade` distinguishes the two granularities the queue needs: a container's
// "Approve all / Reject all" walks the whole subtree, while a per-row Approve /
// Reject acts on the single resource (e.g. one child of a still-pending
// container, or a later-found-broken child).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Button } from './buttons';

export function ReviewActions({ resourceId, buttons }: { resourceId: string; buttons: Button[] }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const disabled = busy !== null || isRefreshing;

  async function run(b: Button) {
    setBusy(b.label);
    setMsg(null);
    try {
      const res = await fetch('/api/playground/pending-resources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId,
          action: b.action,
          ...(b.action !== 'decompose' ? { cascade: b.cascade } : {}),
          ...(b.severity ? { severity: b.severity } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setMsg({ ok: false, text: (data.error as string) ?? `HTTP ${res.status}` });
        return;
      }
      const parts: string[] = [];
      if (data.action === 'decompose') parts.push('queued for decomposition');
      if (typeof data.approved === 'number') parts.push(`approved ${data.approved}`);
      if (typeof data.deprecated === 'number') parts.push(`rejected ${data.deprecated}`);
      if (typeof data.conceptLinksRemoved === 'number' && data.conceptLinksRemoved > 0) {
        parts.push(`${data.conceptLinksRemoved} candidate link(s) removed`);
      }
      if (typeof data.pathsRegressed === 'number' && data.pathsRegressed > 0) {
        parts.push(`${data.pathsRegressed} map(s) → building`);
      }
      setMsg({ ok: true, text: parts.join(' · ') || 'done' });
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
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            disabled={disabled}
            onClick={() => run(b)}
            className={`rounded border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${b.className}`}
          >
            {busy === b.label ? '…' : b.label}
          </button>
        ))}
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-gray-600' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}
