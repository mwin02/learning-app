'use client';

// Approve/reject buttons for the pending-review (status-approval) queue. Thin
// client over POST /api/playground/pending-resources: it owns no decision logic
// — it sends the action and refreshes the server-rendered list so a decided row
// drops out (or, for a cascade, the whole tree does).
//
// `cascade` distinguishes the two granularities the queue needs: a container's
// "Approve all / Reject all" walks the whole subtree, while a per-row Approve /
// Reject acts on the single resource (e.g. one child of a still-pending
// container, or a later-found-broken child).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

type Action = 'approve' | 'reject';
type Severity = 'soft' | 'hard';

// `severity` only applies to reject: soft = quality downgrade (future runs
// only), hard = broken/dead link (also lets a future Track layer flag in-flight
// learners). The API defaults to soft, but the UI is explicit so the reviewer's
// intent is recorded on the row.
type Button = {
  label: string;
  action: Action;
  cascade: boolean;
  severity?: Severity;
  className: string;
};

const APPROVE_CLASS = 'border-green-600 text-green-700 hover:bg-green-50';
const REJECT_SOFT_CLASS = 'border-red-600 text-red-700 hover:bg-red-50';
const REJECT_HARD_CLASS = 'border-red-900 text-red-900 hover:bg-red-50';

// Buttons per row variant. A container offers subtree-wide actions; an atomic
// resource or a single child offers per-row actions. Reject splits by severity:
// "quality" (soft) for a working-but-weak resource, "broken" (hard) for a dead
// link.
export const CONTAINER_BUTTONS: Button[] = [
  { label: 'Approve all', action: 'approve', cascade: true, className: APPROVE_CLASS },
  { label: 'Reject all (quality)', action: 'reject', cascade: true, severity: 'soft', className: REJECT_SOFT_CLASS },
  { label: 'Reject all (broken)', action: 'reject', cascade: true, severity: 'hard', className: REJECT_HARD_CLASS },
];

export const ROW_BUTTONS: Button[] = [
  { label: 'Approve', action: 'approve', cascade: false, className: APPROVE_CLASS },
  { label: 'Reject (quality)', action: 'reject', cascade: false, severity: 'soft', className: REJECT_SOFT_CLASS },
  { label: 'Reject (broken)', action: 'reject', cascade: false, severity: 'hard', className: REJECT_HARD_CLASS },
];

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
          cascade: b.cascade,
          ...(b.severity ? { severity: b.severity } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setMsg({ ok: false, text: (data.error as string) ?? `HTTP ${res.status}` });
        return;
      }
      const parts: string[] = [];
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
