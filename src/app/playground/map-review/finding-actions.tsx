'use client';

// Per-finding decision buttons for the map-review worklist. Thin client over
// POST /api/playground/map-review, mirroring decomposition-review/review-actions:
// no decision logic here — send the action, reflect the API's response, refresh
// the server list so a decided finding drops out. Merge is the only mutating
// action (it deletes the losing concept), so each duplication gets one button
// per possible winner; the API's cycle refusal (422) and concurrent-decision
// 409s surface as the inline message.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function FindingActions({
  reviewId,
  kind,
  conceptSlugs,
}: {
  reviewId: string;
  kind: string;
  conceptSlugs: string[];
}) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const disabled = busy !== null || isRefreshing;
  const mergeable = kind === 'duplication' && conceptSlugs.length === 2;

  async function run(label: string, body: Record<string, string>) {
    setBusy(label);
    setMsg(null);
    try {
      const res = await fetch('/api/playground/map-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewId, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        action?: string;
        resolution?: string;
      };
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setMsg({ ok: true, text: `→ ${data.resolution ?? data.action}` });
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
        {mergeable &&
          conceptSlugs.map((winner) => (
            <button
              key={winner}
              type="button"
              disabled={disabled}
              onClick={() => run(`merge-${winner}`, { action: 'merge', winnerSlug: winner })}
              className="rounded border border-blue-700 px-2 py-0.5 text-xs text-blue-800 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === `merge-${winner}` ? '…' : `Merge → keep ${winner}`}
            </button>
          ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => run('dismiss', { action: 'dismiss' })}
          className="rounded border border-gray-500 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'dismiss' ? '…' : 'Dismiss'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => run('keep', { action: 'keep' })}
          className="rounded border border-amber-600 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'keep' ? '…' : 'Keep as-is'}
        </button>
      </div>
      {msg && (
        <p className={`text-xs ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>
      )}
    </div>
  );
}
