// Phase 2.6 (learn UI): small presentational primitives + the design's color
// tokens, shared by the sidebar and the course-home main column. Recreated from the
// "Home Summary (Hi-Fi)" prototype. All server-renderable (no hooks).

import type { LessonStatus, LessonTypeKind, SectionStatus } from '@/lib/course-home-model';
import { CheckIcon, EmbedIcon, LinkIcon, PlayIcon } from './icons';

// IBM Plex font-family class hooks. The CSS vars are defined by next/font in the
// learn layout; these arbitrary-value classes apply them. MONO is used heavily for
// the design's eyebrow/label/meta text.
export const MONO = 'font-[family-name:var(--font-plex-mono)]';
export const SANS = 'font-[family-name:var(--font-plex-sans)]';

// Brand + neutral palette pulled verbatim from the prototype.
export const COLORS = {
  brand: '#3f6ad8',
  brandDark: '#3357be',
  brandBg: '#eaf0fc',
  green: '#2f9e6f',
  greenBg: '#e7f4ee',
  surface: '#f5f6f8',
  border: '#e7eaef',
  borderSoft: '#eef1f5',
  track: '#eaedf2',
  muted: '#9aa2ad',
} as const;

export const SECTION_STATUS_STYLE: Record<
  SectionStatus,
  { color: string; bg: string; label: string }
> = {
  done: { color: '#2f9e6f', bg: '#e7f4ee', label: 'Completed' },
  active: { color: '#3f6ad8', bg: '#eaf0fc', label: 'In progress' },
  not_started: { color: '#9aa2ad', bg: '#f0f2f5', label: 'Not started' },
};

export function ProgressBar({
  pct,
  fill = COLORS.brand,
  track = COLORS.track,
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
  track = COLORS.track,
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
      style={{ width: size, height: size, background: `conic-gradient(${COLORS.brand} ${pct}%, ${track} 0)` }}
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
      className="rounded-full text-center font-mono text-[10px] tracking-wide"
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
        className="inline-flex flex-none items-center justify-center rounded-full text-white"
        style={{ width: 18, height: 18, background: COLORS.green }}
      >
        <CheckIcon size={11} />
      </span>
    );
  }
  if (status === 'current') {
    return (
      <span
        className="inline-flex flex-none items-center justify-center rounded-full"
        style={{ width: 18, height: 18, border: `2px solid ${COLORS.brand}` }}
      >
        <span className="rounded-full" style={{ width: 7, height: 7, background: COLORS.brand }} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-none rounded-full"
      style={{ width: 18, height: 18, border: '1.8px solid #cfd5dd' }}
    />
  );
}

const TYPE_STYLE: Record<LessonTypeKind, { color: string; icon: React.ReactNode }> = {
  video: { color: '#3f6ad8', icon: <PlayIcon size={13} /> },
  embed: { color: '#c2872c', icon: <EmbedIcon size={15} /> },
  link: { color: '#2f9aa8', icon: <LinkIcon size={14} /> },
};

export function LessonTypeIcon({ type }: { type: LessonTypeKind }) {
  const s = TYPE_STYLE[type];
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-[7px] border bg-[#f2f4f7]"
      style={{ width: 26, height: 26, borderColor: COLORS.border, color: s.color }}
    >
      {s.icon}
    </span>
  );
}
