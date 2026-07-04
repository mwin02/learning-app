'use client';

// Notebook landing (Block A): the "write your goal" prompt — a lined textarea
// with a bobbing pencil, example chips that fill it, and the build CTA. Static
// for now: the CTA routes into sign-in with next=/programs/new; carrying the
// typed goal through OAuth into the create form is a later wired enhancement.

import { useState } from 'react';

const EXAMPLES = [
  { text: 'Linear algebra for ML', rot: '-1.5deg', seed: 'I want to understand linear algebra so I can get into machine learning.' },
  { text: 'Python for data work', rot: '1deg', seed: 'I want to learn Python well enough to analyse data at work.' },
  { text: 'Calculus from scratch', rot: '-0.6deg', seed: 'I want to build strong intuition for calculus from scratch.' },
];

export function GoalScratchpad() {
  const [goal, setGoal] = useState('');

  return (
    <>
      <div className="mb-3 max-w-[660px]">
        <div className="nb-kicker mb-1.5 text-note-label">✎ my learning goal —</div>
        <div className="relative pb-0.5 pt-1.5">
          <textarea
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. I want to understand linear algebra so I can get into machine learning…"
            className="block w-full resize-none bg-transparent p-0 font-script text-[23px] leading-[34px] text-pen caret-pen outline-none placeholder:italic placeholder:text-script-dim"
          />
          <div className="pencil-bob absolute -bottom-[30px] -right-1.5 origin-bottom text-[34px]" aria-hidden>
            ✏️
          </div>
        </div>
        <div className="mt-1 border-t-2 border-rule" />
      </div>

      <div className="my-4 mb-[26px] flex max-w-[640px] flex-wrap items-center gap-2.5">
        <span className="font-script text-xs text-script-faint">try —</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.text}
            type="button"
            onClick={() => setGoal(ex.seed)}
            className="cursor-pointer rounded border border-note-edge bg-note px-[13px] py-[5px] font-script text-sm text-script-body shadow-[0_2px_5px_rgba(0,0,0,.07)] hover:brightness-[0.98]"
            style={{ transform: `rotate(${ex.rot})` }}
          >
            {ex.text}
          </button>
        ))}
      </div>

      <div className="mb-11 flex items-center gap-4">
        <a
          href="/auth/login?next=%2Fprograms%2Fnew"
          className="btn-ink -rotate-[0.8deg] px-[26px] py-[9px] text-[26px] no-underline"
        >
          Build my program →
        </a>
        <span className="font-script text-sm text-script-faint">free · no card needed</span>
      </div>
    </>
  );
}
