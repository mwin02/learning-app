'use client';

// The 404's clipped slip showing the URL that missed. A client leaf by necessity:
// not-found.tsx takes no props and never sees the request (Next's own docs point
// at client-side usePathname for exactly this), so the path can only be read in
// the browser. Everything else on the page stays a Server Component.

import { usePathname } from 'next/navigation';
import { ErrorFooterLink } from '@/components/notebook/ErrorSheet';
import { supportMailto } from '@/lib/support';

export function RequestedPath() {
  const pathname = usePathname();
  return (
    <div className="relative ml-[22px] mt-3.5 rotate-[1.4deg] rounded-[2px] border border-note-edge bg-note px-[13px] pb-3 pt-[11px] shadow-[0_4px_10px_rgba(0,0,0,.1)]">
      {/* the paperclip holding it to the page */}
      <div className="absolute -top-[9px] left-4 h-[26px] w-3.5 rounded-[7px] border-[2.5px] border-script-dim" aria-hidden />
      <div className="pl-[34px] font-script text-2xs uppercase tracking-[1px] text-note-label">
        requested path
      </div>
      <div className="break-all pl-[34px] font-script text-sm leading-tight text-script">
        {pathname}
      </div>
    </div>
  );
}

// The footer's "report a broken link", prefilled with the path that missed —
// same reason as above for being a client component. Without the path the mail
// arrives saying only "a link is broken", which is not actionable.
export function ReportBrokenLink() {
  const pathname = usePathname();
  return (
    <ErrorFooterLink
      href={supportMailto({
        subject: 'Broken link',
        body: `A link sent me to a page that doesn't exist.\n\nPath: ${pathname}\n\nWhere I came from: `,
      })}
    >
      Report a broken link
    </ErrorFooterLink>
  );
}
