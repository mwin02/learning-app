// Notebook sign-in page (Block A of the frontend redesign). We're Google-OAuth
// only, so the design's email/password form reduces to one "Continue with
// Google" action that hands off to the existing /auth/login route (which runs
// the whole PKCE dance). Carries the ?next return path through, sanitized.
// Already signed in? Straight to your programs.

import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { safeNextPath } from '../auth/safe-next';
import { Desk, Sheet } from '@/components/notebook/Sheet';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; auth_error?: string }>;
}) {
  const [{ next, auth_error }, viewer] = await Promise.all([searchParams, getViewer()]);
  if (viewer.userId) redirect(safeNextPath(next ?? '/programs'));

  const nextPath = safeNextPath(next ?? null);
  const loginHref =
    nextPath === '/' ? '/auth/login' : `/auth/login?next=${encodeURIComponent(nextPath)}`;

  return (
    <Desk maxWidth={720}>
      <Sheet className="min-h-[640px]">
        <div className="nb-kicker">welcome back —</div>
        <h1 className="mb-1.5 mt-1 font-hand text-[52px] font-bold leading-[0.95] text-script">
          Sign in to your{' '}
          <span style={{ background: 'linear-gradient(transparent 62%, rgb(var(--nb-highlighter) / .75) 62%)' }}>
            notebook
          </span>
        </h1>
        <p className="mb-[26px] max-w-[460px] text-[17px] leading-[34px]">
          Pick up your programs right where you left off.
        </p>

        {auth_error && (
          <p className="mb-5 max-w-[440px] rounded border border-note-edge bg-note px-3.5 py-2 font-script text-sm text-crayon-red">
            Sign-in didn’t work — please try again.
          </p>
        )}

        <div className="max-w-[440px]">
          <a href={loginHref} className="btn-ink block -rotate-[0.6deg] py-[9px] text-center text-[28px] no-underline">
            Continue with Google →
          </a>

          <div className="my-[22px] flex items-center gap-3">
            <div className="flex-1 border-t-2 border-dashed border-rule" />
            <span className="font-script text-sm text-script-dim">that’s it</span>
            <div className="flex-1 border-t-2 border-dashed border-rule" />
          </div>

          <p className="text-center font-script text-md text-script-body">
            New here? The same button starts your notebook — no separate sign-up.
          </p>
        </div>
      </Sheet>
    </Desk>
  );
}
