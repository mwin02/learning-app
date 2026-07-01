'use client';

// Phase 2.75e (learn UI): the program hub's sticky top bar — mirrors the course
// player's TopNav chrome (brand, nav links, presentational search) but shows a
// program-level "courses ready" pill instead of a single course's progress ring
// (the program has no per-lesson progress of its own; that lives inside each Track).

import { SearchIcon } from '../../learn/_components/icons';

const BRAND = 'Adaptive';

export function ProgramTopNav({ builtCount, trackCount }: { builtCount: number; trackCount: number }) {
  return (
    <div className="sticky top-0 z-[5] flex h-[var(--nav-h)] items-center gap-5 border-b border-line bg-card px-[26px]">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand font-mono text-sm font-semibold text-white">
          {BRAND.charAt(0)}
        </div>
        <span className="text-lg font-semibold tracking-[-0.2px]">{BRAND}</span>
      </div>

      <nav className="ml-4 flex gap-[22px] text-sm">
        <a href="#my-programs" className="font-medium text-brand hover:underline">
          My Programs
        </a>
        <a href="#catalog" className="text-body hover:text-ink-soft">
          Catalog
        </a>
        <a href="#paths" className="text-body hover:text-ink-soft">
          Paths
        </a>
      </nav>

      <div className="flex-1" />

      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex h-[38px] w-60 items-center gap-2 rounded-control border border-line bg-surface px-3 text-faint focus-within:border-hairline"
      >
        <SearchIcon size={16} />
        <input
          type="search"
          placeholder="Search courses"
          aria-label="Search courses"
          className="w-full bg-transparent text-sm text-ink-soft placeholder:text-faint focus:outline-none"
        />
      </form>

      <span className="rounded-button bg-fill px-3 py-1.5 text-2xs font-medium text-muted">
        {builtCount} / {trackCount} ready
      </span>

      <div
        className="h-[34px] w-[34px] rounded-full"
        style={{ background: 'linear-gradient(135deg,#dfe5ee,#c6d0e0)' }}
        aria-hidden
      />
    </div>
  );
}
