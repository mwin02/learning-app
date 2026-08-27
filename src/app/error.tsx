'use client';

// Free-beta B1: the app-wide error boundary. Every uncaught render error below
// the root layout bubbles here, so this is the fallback users actually see;
// global-error.tsx only takes over when the root layout itself fails.
//
// What it reports is narrower than it looks. In production Next replaces a
// Server Component's error with a generic message plus `digest` before it
// reaches this component, so for server errors the useful record is the
// `server.unhandled` line instrumentation.ts already wrote — the digest sent
// here is what pairs the two. For genuine client-side crashes, this is the only
// record there will ever be. That asymmetry is also why the incident slip drops
// the design's `Type` field: we have no honest value for it (see error-view.ts).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { reportClientError } from '@/lib/client-error-report';
import { incidentRows, incidentText } from '@/lib/error-view';
import { supportMailto } from '@/lib/support';
import { ErrorFooterLink, ErrorSheet, Swipe } from '@/components/notebook/ErrorSheet';
import { IncidentSlip } from './_components/IncidentSlip';

// The spilled ink the 500 artboard is built around. Two irregular blots bled off
// the sheet's top-right corner; Sheet's overflow-hidden does the bleeding.
function InkBlot() {
  return (
    <div aria-hidden>
      <div
        className="absolute -right-[60px] -top-10 h-[300px] w-[300px] rotate-12"
        style={{
          borderRadius: '56% 44% 60% 40% / 48% 58% 42% 52%',
          background:
            'radial-gradient(circle at 40% 38%, color-mix(in srgb, var(--color-pen) 28%, transparent), color-mix(in srgb, var(--color-pen) 14%, transparent) 62%, transparent 72%)',
        }}
      />
      <div
        className="absolute right-[120px] top-[200px] h-12 w-14"
        style={{
          borderRadius: '60% 40% 52% 48% / 54% 46% 58% 42%',
          background: 'color-mix(in srgb, var(--color-pen) 16%, transparent)',
        }}
      />
    </div>
  );
}

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const pathname = usePathname();
  // Stamped once, on the first render of the fallback — near enough to when the
  // error happened, and stable across the retries `unstable_retry` triggers. If
  // this boundary is also rendered server-side the two passes disagree by
  // milliseconds, which is what IncidentSlip's suppressHydrationWarning covers.
  const [when] = useState(() => new Date());

  useEffect(() => {
    reportClientError({ message: error.message, stack: error.stack, digest: error.digest });
  }, [error]);

  const rows = incidentRows({ reference: error.digest, when, where: pathname });
  const mailto = supportMailto({
    subject: `Error on ${pathname}`,
    body: `Something went wrong while I was using the app.\n\n${incidentText(rows)}\n\nWhat I was doing: `,
  });

  return (
    <ErrorSheet
      badge="error 500 · our side"
      badgeClassName="text-crayon-red"
      kicker="we spilled the ink"
      kickerClassName="text-crayon-red"
      headline={
        <>
          This page didn&rsquo;t <Swipe>come out right</Swipe>
        </>
      }
      decoration={<InkBlot />}
      aside={<IncidentSlip rows={rows} />}
      footnote="Still broken after a retry? Send us the incident slip and we'll look at it."
      footerAction={<ErrorFooterLink href={mailto}>Email support</ErrorFooterLink>}
    >
      <p className="mb-1.5 max-w-[470px] text-lg leading-[34px] text-script-body text-pretty">
        Something failed on our end while loading this page — not your connection, and nothing
        you did.
      </p>

      <div
        className="mt-[18px] max-w-[520px] rounded-r-md border-l-4 border-nb-gold px-4 py-[11px]"
        style={{ background: 'color-mix(in srgb, var(--color-nb-gold) 14%, transparent)' }}
      >
        <div className="font-hand text-[22px] font-bold text-nb-gold-ink">What&rsquo;s safe</div>
        <div className="text-md leading-7 text-script-body">
          Anything you had already completed was written down before this happened. Reloading
          won&rsquo;t lose it.
        </div>
      </div>

      <div className="mt-[22px] flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="-rotate-[0.6deg] px-[22px] py-[7px] text-2xl btn-ink"
        >
          ↻ Try again
        </button>
        <Link href="/programs" className="px-4 py-[5px] text-[22px] btn-doodle">
          Back to my courses
        </Link>
        <a href={mailto} className="font-hand text-[22px] font-bold text-crayon-red hover:underline">
          Contact support →
        </a>
      </div>
    </ErrorSheet>
  );
}
