// Phase 2.6 (learn UI): small presentational primitives shared by the sidebar and
// the course-home main column. Colors come from the central design tokens (see
// globals.css): utility classes where possible, and `var(--color-*)` in inline
// `style` for the data-driven (per-status / per-type) cases that can't be classes.

import type { LessonStatus, LessonTypeKind, SectionStatus } from '@/lib/course-home-model';
import { CheckIcon, EmbedIcon, LinkIcon, PlayIcon } from './icons';

// Per-status color trio (CSS-var values so it stays tied to the token palette).
// Used in inline style + passed to ProgressBar fill, hence not a utility class.
export const SECTION_STATUS_STYLE: Record<
  SectionStatus,
  { color: string; bg: string; label: string }
> = {
  done: { color: 'var(--color-success)', bg: 'var(--color-success-bg)', label: 'Completed' },
  active: { color: 'var(--color-brand)', bg: 'var(--color-brand-bg)', label: 'In progress' },
  not_started: { color: 'var(--color-faint)', bg: 'var(--color-line-faint)', label: 'Not started' },
};

export function ProgressBar({
  pct,
  fill = 'var(--color-brand)',
  track = 'var(--color-track)',
  className,
}: {
  pct: number;
  fill?: string;
  track?: string;
  className?: string;
}) {
  return (
    <div
      className={`h-1.5 rounded overflow-hidden ${className ?? ''}`}
      style={{ background: track }}
    >
      <div className="h-full rounded" style={{ width: `${pct}%`, background: fill }} />
    </div>
  );
}

export function ProgressRing({
  pct,
  size = 62,
  thickness = 8,
  track = 'var(--color-track)',
  children,
}: {
  pct: number;
  size?: number;
  thickness?: number;
  track?: string;
  children: React.ReactNode;
}) {
  const inner = size - thickness * 2;
  return (
    <div
      className="flex items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(var(--color-brand) ${pct}%, ${track} 0)`,
      }}
    >
      <div
        className="flex items-center justify-center rounded-full bg-white font-semibold"
        style={{ width: inner, height: inner }}
      >
        {children}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: SectionStatus }) {
  const s = SECTION_STATUS_STYLE[status];
  return (
    <span
      className="rounded-full text-center font-mono text-2xs tracking-wide"
      style={{ color: s.color, background: s.bg, padding: '4px 10px', minWidth: 104 }}
    >
      {s.label}
    </span>
  );
}

// done → filled green check · current → blue ring + dot · todo → hollow gray ring.
// (No "locked" — the app has no lesson gating.)
export function LessonStatusIcon({ status }: { status: LessonStatus }) {
  if (status === 'done') {
    return (
      <span
        className="inline-flex flex-none items-center justify-center rounded-full bg-success text-white"
        style={{ width: 18, height: 18 }}
      >
        <CheckIcon size={11} />
      </span>
    );
  }
  if (status === 'current') {
    return (
      <span
        className="inline-flex flex-none items-center justify-center rounded-full"
        style={{ width: 18, height: 18, border: '2px solid var(--color-brand)' }}
      >
        <span className="rounded-full bg-brand" style={{ width: 7, height: 7 }} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-none rounded-full"
      style={{ width: 18, height: 18, border: '1.8px solid var(--color-hairline)' }}
    />
  );
}

// Video reuses the brand; embed/link are bespoke type-accent colors (not core
// palette tokens — kept literal on purpose).
const TYPE_STYLE: Record<LessonTypeKind, { color: string; icon: React.ReactNode }> = {
  video: { color: 'var(--color-brand)', icon: <PlayIcon size={13} /> },
  embed: { color: '#c2872c', icon: <EmbedIcon size={15} /> },
  link: { color: '#2f9aa8', icon: <LinkIcon size={14} /> },
};

export function LessonTypeIcon({ type }: { type: LessonTypeKind }) {
  const s = TYPE_STYLE[type];
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-[7px] border border-line bg-fill"
      style={{ width: 26, height: 26, color: s.color }}
    >
      {s.icon}
    </span>
  );
}
