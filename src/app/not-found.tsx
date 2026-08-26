// The 404 sheet. Root not-found.tsx catches both explicit notFound() calls (the
// thirteen in learn/ and programs/) and any URL that matches no route at all, so
// this is the single page for "there is nothing here".
//
// Worth knowing when reading the copy: several notFound() call sites are ACCESS
// failures, not missing pages — an unenrolled or signed-out visitor asking for a
// lesson is deliberately given a non-enumerable 404. Hence the sign-in suggestion.
//
// No metadata export: Next documents that only for global-not-found.js, and it
// injects noindex on 404s itself.

import Link from 'next/link';
import { ErrorSheet, Swipe } from '@/components/notebook/ErrorSheet';
import { RequestedPath, ReportBrokenLink } from './_components/RequestedPath';

// The design's three suggestions were invented course copy ("Section 2 was
// renumbered"); these are the routes that actually exist.
const SUGGESTIONS = [
  { href: '/programs', text: 'Open the program from your programs page and pick the lesson there' },
  { href: '/', text: 'Start something new from your notebook' },
  { href: '/signin', text: 'Sign in — some lessons only exist once you are enrolled' },
];

function TornScrap() {
  return (
    <div
      className="relative -rotate-[2.2deg] border border-note-edge px-[18px] pb-[26px] pt-5 shadow-[0_6px_16px_rgba(0,0,0,.14)]"
      style={{
        // A torn piece of the sheet: paper shaded a little toward the desk it
        // fell onto. color-mix so it tracks both themes' tokens.
        background: 'color-mix(in srgb, var(--color-paper) 88%, var(--color-desk))',
        clipPath:
          'polygon(0 0,100% 0,100% 84%,88% 92%,72% 84%,55% 94%,38% 85%,20% 95%,0 86%)',
      }}
    >
      <div className="font-script text-2xs uppercase tracking-[1.4px] text-note-label">
        torn out · unreadable
      </div>
      <div className="-rotate-3 font-hand text-[74px] font-bold leading-[0.9] text-crayon-red">
        404
      </div>
      {/* the illegible remains of whatever was written here */}
      <div className="mt-3 flex flex-col gap-[9px]" aria-hidden>
        {['92%', '78%', '86%', '54%'].map((w) => (
          <div key={w} className="h-2 rounded bg-hole" style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}

export default function NotFound() {
  return (
    <ErrorSheet
      badge="error 404"
      kicker="this page fell out of the binder"
      headline={
        <>
          There&rsquo;s <Swipe>nothing written</Swipe> here
        </>
      }
      aside={
        <>
          <TornScrap />
          <RequestedPath />
        </>
      }
      footnote="If a page here sent you to a dead link, tell us — we'll fix it."
      footerAction={<ReportBrokenLink />}
    >
      <p className="mb-1.5 max-w-[470px] text-lg leading-[34px] text-script-body text-pretty">
        We looked on every page and couldn&rsquo;t find it. The link may be old, or the lesson
        may have moved to another section.
      </p>

      <div className="mb-1 mt-5 font-hand text-[26px] font-bold text-script">Try one of these</div>
      <div className="mb-[22px] flex flex-col gap-0.5">
        {SUGGESTIONS.map(({ href, text }) => (
          <Link
            key={href}
            href={href}
            className="nb-hl-hover flex items-start gap-[11px] rounded-control text-[17px] leading-[34px] text-script-body"
          >
            <span className="flex-none text-[19px] text-pen">→</span>
            <span>{text}</span>
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Link href="/programs" className="-rotate-[0.6deg] px-[22px] py-[7px] text-2xl btn-ink">
          ← Back to my courses
        </Link>
        <Link href="/" className="px-4 py-[5px] text-[22px] btn-doodle">
          Start something new
        </Link>
      </div>
    </ErrorSheet>
  );
}
