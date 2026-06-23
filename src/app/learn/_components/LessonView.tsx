'use client';

// Phase 2.6 (learn UI), Block 2: the per-lesson content column. Presentational
// scaffold around the (Block 3) resource player — eyebrow context, title + type
// badge, summary, "in this lesson" concepts, an up-next preview, and the footer
// nav (previous / mark-complete / next) wired to the shared course context. The
// prototype's tabs + fake media chrome are intentionally dropped (no transcript /
// discussion / exercise data backs them yet — see roadmap 2.5h/2.5i).

import Link from 'next/link';
import type { TrackResourceView } from '@/lib/track-view';
import type { LessonTypeKind } from '@/lib/course-home-model';
import { useCourse } from './course-context';
import { ResourcePane } from './ResourcePane';
import { LessonTypeIcon } from './primitives';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EmbedIcon,
  LinkIcon,
  PlayIcon,
} from './icons';

export type LessonNavLesson = { id: string; title: string };
export type LessonNextLesson = LessonNavLesson & { type: LessonTypeKind; estMinutes: number };

export type LessonViewModel = {
  id: string;
  trackId: string;
  eyebrow: string;
  title: string;
  type: LessonTypeKind;
  summary: string;
  concepts: string[];
  estMinutes: number;
  resources: TrackResourceView[];
  prev: LessonNavLesson | null;
  next: LessonNextLesson | null;
};

// Each type's badge: a small inline icon + label + the accent token pair (text
// color / soft bg). Icons use currentColor, so they inherit the badge color; token
// values flip in dark mode, so the badge follows the palette automatically.
const TYPE_BADGE: Record<
  LessonTypeKind,
  { label: string; color: string; bg: string; icon: React.ReactNode }
> = {
  video: {
    label: 'VIDEO',
    color: 'var(--color-brand)',
    bg: 'var(--color-brand-bg)',
    icon: <PlayIcon size={12} />,
  },
  embed: {
    label: 'EMBED',
    color: 'var(--color-accent-embed)',
    bg: 'var(--color-accent-embed-bg)',
    icon: <EmbedIcon size={13} />,
  },
  link: {
    label: 'READING',
    color: 'var(--color-accent-link)',
    bg: 'var(--color-accent-link-bg)',
    icon: <LinkIcon size={13} />,
  },
};

export function LessonView({ model }: { model: LessonViewModel }) {
  const { isComplete, toggleComplete } = useCourse();
  const done = isComplete(model.id);
  const badge = TYPE_BADGE[model.type];

  return (
    <div className="px-10 pb-14 pt-[30px]">
      <div className="mx-auto max-w-[760px]">
        <div className="eyebrow tracking-[1px] text-faint">{model.eyebrow}</div>

        <div className="mb-[18px] mt-2 flex items-center gap-3">
          <h1 className="flex-1 text-2xl font-bold tracking-[-0.4px]">{model.title}</h1>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-[11px] py-[5px] font-mono text-2xs tracking-[0.5px]"
            style={{ color: badge.color, background: badge.bg }}
          >
            {badge.icon}
            {badge.label}
          </span>
        </div>

        <ResourcePane resources={model.resources} />

        {model.summary && (
          <p className="mt-[22px] text-md leading-[1.65] text-body">{model.summary}</p>
        )}

        {model.concepts.length > 0 && (
          <>
            <div className="eyebrow mb-2.5 mt-6 tracking-[1.5px] text-faint">IN THIS LESSON</div>
            <ul className="mb-6 flex flex-col gap-2.5">
              {model.concepts.map((c) => (
                <li key={c} className="flex gap-2.5 text-sm leading-[1.45] text-body">
                  <CheckIcon size={16} strokeWidth={2.2} className="mt-0.5 flex-none text-brand" />
                  {c}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Exercise slot (roadmap 2.5h) — lesson.exercises is empty today; the
            in-lesson practice block renders here when exercises exist. */}

        {model.next && <UpNext trackId={model.trackId} next={model.next} />}

        <FooterNav
          trackId={model.trackId}
          prev={model.prev}
          next={model.next}
          done={done}
          onToggle={() => toggleComplete(model.id)}
        />
      </div>
    </div>
  );
}

function UpNext({ trackId, next }: { trackId: string; next: LessonNextLesson }) {
  return (
    <Link
      href={`/learn/${trackId}/${next.id}`}
      className="card mt-6 flex items-center gap-3.5 p-4 hover:border-hairline"
    >
      <LessonTypeIcon type={next.type} />
      <div className="min-w-0 flex-1">
        <div className="meta-xs text-faint">UP NEXT</div>
        <div className="mt-0.5 truncate text-sm font-semibold">{next.title}</div>
      </div>
      <span className="meta-xs flex-none">~{next.estMinutes} min</span>
    </Link>
  );
}

function FooterNav({
  trackId,
  prev,
  next,
  done,
  onToggle,
}: {
  trackId: string;
  prev: LessonNavLesson | null;
  next: LessonNextLesson | null;
  done: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-[26px] flex items-center gap-3 border-t border-line pt-5">
      {prev ? (
        <Link
          href={`/learn/${trackId}/${prev.id}`}
          className="flex items-center gap-2 rounded-button border-[1.5px] border-hairline px-[15px] py-2.5 text-sm font-medium text-ink-soft hover:bg-fill-soft"
        >
          <ChevronLeftIcon size={15} /> Previous
        </Link>
      ) : (
        <span className="flex items-center gap-2 rounded-button border-[1.5px] border-line px-[15px] py-2.5 text-sm font-medium text-faint">
          <ChevronLeftIcon size={15} /> Previous
        </span>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        className={`flex items-center gap-2 rounded-button border-[1.5px] px-[15px] py-2.5 text-sm font-medium ${
          done
            ? 'border-success bg-success text-white'
            : 'border-success text-success hover:bg-success-bg'
        }`}
      >
        <CheckIcon size={15} strokeWidth={2} /> {done ? 'Completed' : 'Mark complete'}
      </button>

      {next ? (
        <Link
          href={`/learn/${trackId}/${next.id}`}
          className="flex items-center gap-2 rounded-button bg-brand px-[18px] py-2.5 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(63,106,216,0.3)] hover:bg-brand-dark"
        >
          Next lesson <ChevronRightIcon size={15} />
        </Link>
      ) : (
        <Link
          href={`/learn/${trackId}`}
          className="flex items-center gap-2 rounded-button bg-brand px-[18px] py-2.5 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(63,106,216,0.3)] hover:bg-brand-dark"
        >
          Back to overview <ChevronRightIcon size={15} />
        </Link>
      )}
    </div>
  );
}
