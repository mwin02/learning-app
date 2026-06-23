'use client';

// Phase 2.6 (learn UI): the sticky top navigation bar. Recreated from the Home
// Summary (Hi-Fi) prototype's nav. The nav links + search are presentational chrome
// for now (no Catalog/Paths routes yet); the progress ring reflects live course
// progress from the course context.

import { ProgressRing } from './primitives';
import { SearchIcon } from './icons';
import { useCourse } from './course-context';

// Placeholder product brand — the app's public name isn't finalized (entity-naming
// decision is deferred in the roadmap). Single source so it's trivial to change.
const BRAND = 'Adaptive';

export function TopNav() {
  const { model } = useCourse();
  return (
    <div className="sticky top-0 z-[5] flex h-[var(--nav-h)] items-center gap-5 border-b border-line bg-card px-[26px]">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand font-mono text-sm font-semibold text-white">
          {BRAND.charAt(0)}
        </div>
        <span className="text-lg font-semibold tracking-[-0.2px]">{BRAND}</span>
      </div>

      <nav className="ml-4 flex gap-[22px] text-sm">
        <a href="#my-courses" className="font-medium text-brand hover:underline">
          My Courses
        </a>
        <a href="#catalog" className="text-body hover:text-ink-soft">
          Catalog
        </a>
        <a href="#paths" className="text-body hover:text-ink-soft">
          Paths
        </a>
      </nav>

      <div className="flex-1" />

      {/* Presentational search for now — accepts input but has no backend yet, so
          submitting is a no-op (preventDefault) rather than navigating nowhere. */}
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex h-[38px] w-60 items-center gap-2 rounded-control border border-line bg-surface px-3 text-faint focus-within:border-hairline"
      >
        <SearchIcon size={16} />
        <input
          type="search"
          placeholder="Search lessons"
          aria-label="Search lessons"
          className="w-full bg-transparent text-sm text-ink-soft placeholder:text-faint focus:outline-none"
        />
      </form>

      <ProgressRing pct={model.progressPct} size={30} thickness={4} track="var(--color-line)">
        <span className="font-mono text-2xs font-semibold text-brand">{model.progressPct}</span>
      </ProgressRing>

      <div
        className="h-[34px] w-[34px] rounded-full"
        style={{ background: 'linear-gradient(135deg,#dfe5ee,#c6d0e0)' }}
        aria-hidden
      />
    </div>
  );
}
