'use client';

// Phase 2.6 (learn UI): the sticky top navigation bar. Recreated from the Home
// Summary (Hi-Fi) prototype's nav. The nav links + search are presentational chrome
// for now (no Catalog/Paths routes yet); the progress ring reflects live course
// progress from the course context.

import { MONO, ProgressRing } from './primitives';
import { SearchIcon } from './icons';
import { useCourse } from './course-context';

// Placeholder product brand — the app's public name isn't finalized (entity-naming
// decision is deferred in the roadmap). Single source so it's trivial to change.
const BRAND = 'Adaptive';

export function TopNav() {
  const { model } = useCourse();
  return (
    <div className="sticky top-0 z-[5] flex h-[62px] items-center gap-5 border-b border-[#e7eaef] bg-white px-[26px]">
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-7 w-7 items-center justify-center rounded-lg bg-[#3f6ad8] text-sm font-semibold text-white ${MONO}`}
        >
          {BRAND.charAt(0)}
        </div>
        <span className="text-base font-semibold tracking-[-0.2px]">{BRAND}</span>
      </div>

      <nav className="ml-4 flex gap-[22px] text-sm">
        <a href="#my-courses" className="font-medium text-[#3f6ad8] hover:underline">
          My Courses
        </a>
        <a href="#catalog" className="text-[#6b7480] hover:text-[#3f4651]">
          Catalog
        </a>
        <a href="#paths" className="text-[#6b7480] hover:text-[#3f4651]">
          Paths
        </a>
      </nav>

      <div className="flex-1" />

      {/* Presentational search for now — accepts input but has no backend yet, so
          submitting is a no-op (preventDefault) rather than navigating nowhere. */}
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex h-[38px] w-60 items-center gap-2 rounded-[9px] border border-[#e7eaef] bg-[#f4f6f8] px-3 text-[#9aa2ad] focus-within:border-[#c3cdde]"
      >
        <SearchIcon size={16} />
        <input
          type="search"
          placeholder="Search lessons"
          aria-label="Search lessons"
          className="w-full bg-transparent text-[13px] text-[#3f4651] placeholder:text-[#9aa2ad] focus:outline-none"
        />
      </form>

      <ProgressRing pct={model.progressPct} size={30} thickness={4} track="#e7eaef">
        <span className={`text-[9px] font-semibold text-[#3f6ad8] ${MONO}`}>
          {model.progressPct}
        </span>
      </ProgressRing>

      <div
        className="h-[34px] w-[34px] rounded-full"
        style={{ background: 'linear-gradient(135deg,#dfe5ee,#c6d0e0)' }}
        aria-hidden
      />
    </div>
  );
}
