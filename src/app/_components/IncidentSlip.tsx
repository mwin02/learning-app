'use client';

// The 500 page's "for support" slip: the facts a learner can hand us, plus a
// one-click copy so they land in the mail intact.
//
// The copy button degrades rather than throws — navigator.clipboard is absent on
// insecure origins and can be denied outright, and this component is already
// rendering inside a failed page. A failed copy says so and leaves the rows on
// screen to be selected by hand.

import { useState } from 'react';
import type { IncidentRow } from '@/lib/error-view';
import { incidentText } from '@/lib/error-view';

export function IncidentSlip({ rows }: { rows: IncidentRow[] }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(incidentText(rows));
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="rotate-[1.2deg] rounded border border-note-edge border-t-[5px] border-t-crayon-red bg-card px-[17px] pb-[17px] pt-[15px] shadow-[0_5px_14px_rgba(0,0,0,.09)]">
      <div className="font-script text-2xs uppercase tracking-[1px] text-script-dim">for support</div>
      <div className="mb-2.5 mt-px font-hand text-2xl font-bold leading-none text-script">
        Incident slip
      </div>
      <div className="flex flex-col gap-2">
        {rows.map(({ k, v }) => (
          <div key={k} className="flex items-baseline gap-2.5 border-b border-dashed border-note-edge pb-1.5">
            <span className="w-[78px] flex-none font-script text-2xs uppercase tracking-[0.8px] text-script-dim">
              {k}
            </span>
            {/* The When row is a wall-clock stamp, so a server pass and the client
                pass differ by milliseconds; the rest of the rows are deterministic. */}
            <span suppressHydrationWarning className="flex-1 break-all font-script text-sm text-script">
              {v}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={copy} className="px-3 py-0.5 text-[19px] btn-doodle">
          {copied === 'ok' ? 'Copied' : 'Copy details'}
        </button>
        <span className="font-script text-xs text-script-dim">
          {copied === 'failed' ? 'copy it by hand' : 'paste into your email'}
        </span>
      </div>
    </div>
  );
}
