'use client';

// Phase 2.6 (learn UI): the sticky left course sidebar — course-progress header +
// collapsible sections of lesson rows. Recreated from the Home Summary (Hi-Fi)
// prototype. Read-only over the course context's model; lesson rows link into the
// (future) lesson view. Replaces the Block-1 Syllabus.tsx.

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ProgressBar, LessonStatusIcon, LessonTypeIcon, SECTION_STATUS_STYLE } from './primitives';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import { useCourse } from './course-context';
import type { CourseHomeLesson, CourseHomeSection, LessonStatus } from '@/lib/course-home-model';

function LessonRow({
  trackId,
  lesson,
  active,
}: {
  trackId: string;
  lesson: CourseHomeLesson;
  active: boolean;
}) {
  // The status dot marks the lesson you're viewing as "current": completed rows keep
  // their green check, the active row gets the blue current dot, everything else is
  // a hollow todo. (The model's own "current" — first-not-done — only drives the
  // home page's fallback highlight, not the dot while a lesson is open.)
  const dotStatus: LessonStatus = lesson.status === 'done' ? 'done' : active ? 'current' : 'todo';
  return (
    <Link
      href={`/learn/${trackId}/${lesson.id}`}
      aria-current={active ? 'page' : undefined}
      className={`relative mx-2.5 my-px flex items-center gap-[11px] rounded-control py-2 pl-3.5 pr-2.5 hover:bg-fill ${
        active ? 'bg-brand-bg-soft' : 'bg-transparent'
      }`}
    >
      {active && (
        <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-[3px] bg-brand" />
      )}
      <LessonStatusIcon status={dotStatus} />
      <LessonTypeIcon type={lesson.type} />
      <span className="flex-1 text-sm leading-tight text-ink">{lesson.title}</span>
      <span className="meta-xs">{lesson.meta}</span>
    </Link>
  );
}

function SectionGroup({
  trackId,
  section,
  activeLessonId,
}: {
  trackId: string;
  section: CourseHomeSection;
  activeLessonId: string | null;
}) {
  const hasActive = section.lessons.some((l) => l.id === activeLessonId);

  // Open state is derived, not stored: a manual toggle (null until the user clicks)
  // overrides the default, but the section that contains the viewed lesson is always
  // open so its highlight is visible (e.g. navigating into a collapsed later section
  // via "Next"). Default: open unless untouched (not_started), per the prototype.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const defaultOpen = section.status !== 'not_started';
  const open = hasActive || (manualOpen ?? defaultOpen);

  const dotColor = SECTION_STATUS_STYLE[section.status].color;

  return (
    <div>
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2.5 px-5 py-2.5 text-left hover:bg-fill-soft"
      >
        {open ? (
          <ChevronDownIcon size={14} className="text-faint" />
        ) : (
          <ChevronRightIcon size={14} className="text-faint" />
        )}
        <span className="flex-1">
          <span className="block text-sm font-medium leading-tight">{section.title}</span>
          <span className="meta-xs mt-0.5 block">
            {section.fraction} · {section.durLabel}
          </span>
        </span>
        <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
      </button>
      {open && (
        <div>
          {section.lessons.map((lesson) => (
            <LessonRow
              key={lesson.id}
              trackId={trackId}
              lesson={lesson}
              active={lesson.id === activeLessonId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CourseSidebar() {
  const { model } = useCourse();

  // The location treatment (rail + tint + blue "current" dot) marks the lesson being
  // viewed — the active route. On the course-home route there's no lessonId, so
  // nothing is "current": no row should look like the active tab there. (Home's
  // "resume" affordance is the Continue Learning card, not a sidebar highlight.)
  const params = useParams<{ lessonId?: string }>();
  const activeLessonId = params.lessonId ?? null;

  return (
    <aside className="sticky top-[var(--nav-h)] min-h-[calc(100vh-var(--nav-h))] w-[322px] flex-none self-start border-r border-line bg-card pb-5">
      {/* The course header doubles as the "back to course home" link. */}
      <Link
        href={`/learn/${model.trackId}`}
        aria-label="Back to course overview"
        className="block border-b border-line-soft px-5 pb-[18px] pt-5 hover:bg-fill-soft"
      >
        <div className="eyebrow text-muted">{model.topic.toUpperCase()}</div>
        <div className="mb-3 mt-[5px] text-lg font-semibold leading-tight">{model.title}</div>
        <ProgressBar pct={model.progressPct} />
        <div className="mt-2 flex justify-between">
          <span className="meta">
            {model.doneCount} / {model.totalLessons} lessons
          </span>
          <span className="meta font-medium text-brand">{model.progressPct}%</span>
        </div>
      </Link>

      <div className="eyebrow px-5 pb-1.5 pt-4">COURSE CONTENT</div>

      {model.sections.map((section) => (
        <SectionGroup
          key={section.id}
          trackId={model.trackId}
          section={section}
          activeLessonId={activeLessonId}
        />
      ))}
    </aside>
  );
}
