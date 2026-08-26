// The sheet the 404 and 500 pages share. Both artboards are the same page: a
// right-aligned error badge, a handwritten headline with a highlighter swipe, a
// prose column, a 290px paper-scrap column beside it, and a dashed footer.
//
// The design drew its own brand header inside the sheet; ours is dropped because
// TopNav already renders above every page from the root layout — error boundaries
// and not-found mount below it — so reproducing it would double the wordmark.
// Only the badge survives from that row.
//
// Purely presentational, no "use client": error.tsx supplies its own boundary.

import { Desk, Sheet } from './Sheet';

/** The yellow marker swipe under a headline word. */
export function Swipe({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ background: 'linear-gradient(transparent 62%, var(--nb-swipe) 62%)' }}>
      {children}
    </span>
  );
}

export function ErrorSheet({
  badge,
  badgeClassName = 'text-script-faint',
  kicker,
  kickerClassName = 'text-pen',
  headline,
  children,
  aside,
  footnote,
  footerAction,
  decoration,
}: {
  badge: string; // "error 404" / "error 500 · our side"
  badgeClassName?: string;
  kicker: string;
  kickerClassName?: string;
  headline: React.ReactNode;
  children: React.ReactNode; // body of the left column
  aside: React.ReactNode; // the 290px scrap column
  footnote: string;
  footerAction: React.ReactNode;
  decoration?: React.ReactNode; // absolutely-positioned flourish (the 500's ink blot)
}) {
  return (
    <Desk maxWidth={900}>
      <Sheet className="min-h-[600px]">
        {decoration}
        <div className="relative mb-4 flex h-14 items-center justify-end">
          <span className={`font-script text-xs uppercase tracking-[0.8px] ${badgeClassName}`}>
            {badge}
          </span>
        </div>

        <div className="relative flex flex-wrap items-start gap-x-[34px] gap-y-8">
          <div className="min-w-[330px] flex-[1_1_380px]">
            <div className={`nb-kicker ${kickerClassName}`}>{kicker}</div>
            <h1 className="mb-2 mt-1 font-hand text-[56px] font-bold leading-[0.98] text-script">
              {headline}
            </h1>
            {children}
          </div>
          <div className="w-[290px] flex-none pt-2">{aside}</div>
        </div>

        <div className="relative mt-[30px] flex flex-wrap items-center gap-3 border-t-2 border-dashed border-rule-strong pt-[18px]">
          <span className="font-script text-xs text-script-dim">{footnote}</span>
          <div className="flex-1" />
          {footerAction}
        </div>
      </Sheet>
    </Desk>
  );
}

/** The footer's understated text link — underlined in pen, not a button. */
export function ErrorFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="border-b-2 border-pen font-script text-xs text-pen hover:border-pen-deep hover:text-pen-deep">
      {children}
    </a>
  );
}
