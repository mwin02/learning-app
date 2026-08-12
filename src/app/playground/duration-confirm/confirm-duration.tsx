'use client';

// Q10 — one button, and it is deliberately the only control here.
//
// It PATCHes the proposed duration through the same endpoint Q9's RowCorrections
// uses, so the server stamps `durationSource: 'reviewer'`; the client never asserts
// a provenance. There is no "reject" action because rejecting is the default state
// of the world — an unconfirmed proposal leaves the row `unknown`, which is where it
// already is.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

const replySchema = z.object({ error: z.string().optional(), warning: z.string().optional() });

export function ConfirmDuration({
  resourceId,
  proposedMin,
}: {
  resourceId: string;
  proposedMin: number;
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/playground/resources', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceId, fields: { durationMin: proposedMin } }),
      });
      const parsed = replySchema.safeParse(await res.json().catch(() => ({})));
      if (!res.ok) {
        setError((parsed.success && parsed.data.error) || `HTTP ${res.status}`);
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-gray-600">
      <button
        type="button"
        disabled={busy || isRefreshing}
        onClick={() => void confirm()}
        className="rounded border border-gray-500 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? '…' : `Confirm ${proposedMin} min`}
      </button>
      <span>same video → records a reviewer measurement</span>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
