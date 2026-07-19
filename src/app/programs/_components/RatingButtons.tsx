'use client';

// Free-beta A2: the thumbs-up/down toggle pair, notebook-styled. Plain toggles
// by design — no aggregate counts (locked: showing counts invites herding and
// looks bad at beta n). Optimistic: the tap paints immediately, a non-OK/failed
// POST rolls it back. Tapping the active thumb clears the vote (value: null).
//
// Some placements sit inside an <a> / <details summary> (the alternate rows), so
// every click preventDefaults + stopPropagates — a vote must never navigate the
// row or toggle the disclosure it lives in.

import { useState } from 'react';
import type { VoteValue } from '@/lib/rating-db';

type Vote = VoteValue | null;

function ThumbIcon({ down = false, size = 15 }: { down?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={down ? { transform: 'scale(-1, -1)' } : undefined}
    >
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4.2-7.3a1.8 1.8 0 0 1 3.3 1.2L13.8 8H19a2 2 0 0 1 2 2.4l-1.5 8A2 2 0 0 1 17.5 20H7" />
    </svg>
  );
}

export function RatingButtons({ resourceId, initial }: { resourceId: string; initial: Vote }) {
  const [vote, setVote] = useState<Vote>(initial);
  const [busy, setBusy] = useState(false);

  const cast = async (e: React.MouseEvent, clicked: VoteValue) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next: Vote = vote === clicked ? null : clicked;
    const prev = vote;
    setVote(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/resources/${resourceId}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      });
      if (!res.ok) setVote(prev);
    } catch {
      setVote(prev);
    } finally {
      setBusy(false);
    }
  };

  const btn = (clicked: VoteValue, label: string) => {
    const active = vote === clicked;
    return (
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        title={label}
        onClick={(e) => cast(e, clicked)}
        className={`inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border transition-colors ${
          active
            ? clicked === 1
              ? 'border-crayon-green bg-crayon-green/10 text-crayon-green'
              : 'border-crayon-red bg-crayon-red/10 text-crayon-red'
            : 'border-transparent text-script-dim hover:border-rule hover:text-pen'
        }`}
      >
        <ThumbIcon down={clicked === -1} />
      </button>
    );
  };

  return (
    <span className="inline-flex items-center gap-1" data-rating={resourceId}>
      {btn(1, 'Good resource')}
      {btn(-1, 'Bad resource')}
    </span>
  );
}
