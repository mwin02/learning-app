'use client';

// The top nav's profile control (frontend redesign): a round avatar button that
// toggles a small dropdown. For now the menu holds a single action — Log out —
// which POSTs to /auth/signout (POST, not a link, so a prefetch can't sign the
// user out). Closes on outside-click and Escape. Presentational identity only:
// the avatar shows the account initial derived from the label.

import { useEffect, useRef, useState } from 'react';

export function ProfileMenu({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title={label}
        className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-[2.5px] border-pen bg-paper font-hand text-[20px] font-bold text-pen transition-transform hover:-translate-y-px"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-30 min-w-[168px] rounded-[10px_12px_10px_12px] border-2 border-rule bg-paper p-1.5 shadow-[0_6px_18px_rgba(0,0,0,0.18)]"
        >
          <div className="truncate px-2.5 pb-1.5 pt-1 font-script text-2xs text-script-dim">
            {label}
          </div>
          <div className="mb-1.5 border-t border-dashed border-rule" />
          <form method="post" action="/auth/signout">
            <button
              type="submit"
              role="menuitem"
              className="w-full cursor-pointer rounded-[8px] border-0 bg-transparent px-2.5 py-1.5 text-left font-script text-sm text-script-body hover:bg-note"
            >
              Log out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
