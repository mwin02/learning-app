// Notebook landing (Block A of the frontend redesign). Anonymous: the "what do
// you want to learn?" sheet — goal scratchpad, example chips, how-it-works —
// with the build CTA routing into sign-in. Signed in (UI Block 8): a dashboard
// sheet — continue card for the last program worked on, plus the same goal
// scratchpad as the new-program entry point (the create button it replaces).

import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getViewer } from '@/lib/auth/viewer';
import { BRAND } from '@/lib/brand';
import { loadContinueCard } from '@/lib/continue-card';
import { Desk, Sheet } from '@/components/notebook/Sheet';
import { ActivityHeatmap } from './_components/ActivityHeatmap';
import { ContinueCard } from './_components/ContinueCard';
import { GoalScratchpad } from './_components/GoalScratchpad';

export const dynamic = 'force-dynamic';

const STEPS = [
  { n: 1, color: 'var(--color-nb-coral)', title: 'Describe it', body: 'Tell us your goal and background — a sentence is enough.' },
  { n: 2, color: 'var(--color-nb-gold)', title: 'Get a program', body: 'We plan the courses you need and sequence real lessons, readings and exercises into each one.' },
  { n: 3, color: 'var(--color-nb-violet)', title: 'Start learning', body: 'Track progress in your own notebook and pick up where you left off.' },
];

function HighlightedTitle() {
  return (
    <h1 className="mb-2 mt-1.5 font-hand text-[64px] font-bold leading-[0.92] text-script">
      What do you
      <br />
      want to{' '}
      <span style={{ background: 'linear-gradient(transparent 60%, rgba(255,224,102,.75) 60%)' }}>
        learn?
      </span>
    </h1>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string }>;
}) {
  const [{ auth_error }, viewer] = await Promise.all([searchParams, getViewer()]);
  // Heatmap window: 26 full weeks + the current partial one is ≤189 local days;
  // 191 UTC days over-fetches a hair so timezone shift can't clip the oldest cell.
  const heatSince = new Date(Date.now() - 191 * 24 * 60 * 60 * 1000);
  const [user, card, heatRows] = viewer.userId
    ? await Promise.all([
        prisma.user.findUnique({
          where: { id: viewer.userId },
          select: { email: true, name: true },
        }),
        loadContinueCard(viewer.userId),
        prisma.progress.findMany({
          where: { userId: viewer.userId, completedAt: { gte: heatSince } },
          select: { completedAt: true },
        }),
      ])
    : [null, null, []];

  return (
    <Desk maxWidth={1040}>
      <Sheet>
        {auth_error && (
          <p className="mb-4 max-w-[440px] rounded border border-note-edge bg-note px-3.5 py-2 font-script text-sm text-crayon-red">
            Sign-in didn’t work — please try again.
          </p>
        )}

        {viewer.userId ? (
          /* ---- signed in: dashboard ---- */
          <>
            <div className="nb-kicker">welcome back —</div>
            <h1 className="mb-2 mt-1.5 font-hand text-[52px] font-bold leading-[0.95] text-script">
              {user?.name ?? user?.email ?? 'Your notebook'}
              {viewer.isAdmin ? ' (admin)' : ''}
            </h1>
            <p className="mb-[26px] max-w-[560px] text-lg leading-[34px]">
              {card
                ? 'Pick up where you left off, or scribble a new goal below.'
                : 'Scribble a goal below and we’ll build your program.'}
            </p>

            {card && <ContinueCard card={card} />}

            <div className="mb-3 font-hand text-3xl font-bold text-script">
              Start something new
            </div>
            <GoalScratchpad signedIn />

            <div className="mb-3 font-hand text-3xl font-bold text-script">My study log</div>
            <ActivityHeatmap completions={heatRows.map((r) => r.completedAt.getTime())} />

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link href="/programs" className="font-script text-sm text-script-faint underline">
                flip to all my programs →
              </Link>
              {viewer.isAdmin && (
                <Link href="/playground" className="font-script text-sm text-script-faint underline">
                  Playground
                </Link>
              )}
            </div>
          </>
        ) : (
          /* ---- anonymous: the pitch ---- */
          <>
            <div className="nb-kicker">{BRAND} · learn anything</div>
            <HighlightedTitle />
            <p className="mb-[26px] max-w-[600px] text-[19px] leading-[34px]">
              Write your goal in plain words. We’ll turn it into a guided program of courses —
              sequenced videos, readings and problem sets, made just for you.
            </p>

            <GoalScratchpad />

            <div className="mb-3 font-hand text-3xl font-bold text-script">How it works</div>
            <div className="grid max-w-[820px] grid-cols-1 gap-[26px] sm:grid-cols-3">
              {STEPS.map((step) => (
                <div key={step.n}>
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-[38px] w-[38px] flex-none -rotate-6 items-center justify-center rounded-[50%_50%_50%_8px] border-[2.5px] font-hand text-[22px] font-bold"
                      style={{ borderColor: step.color, color: step.color }}
                    >
                      {step.n}
                    </div>
                    <div className="font-hand text-[23px] font-bold text-script">{step.title}</div>
                  </div>
                  <p className="mb-0 mt-1.5 text-sm leading-[26px]">{step.body}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </Sheet>
    </Desk>
  );
}
