'use client';

// Phase 2.6 (learn UI): the sticky left course sidebar — course-progress header +
// collapsible sections of lesson rows. Recreated from the Home Summary (Hi-Fi)
// prototype. Read-only over the course context's model; lesson rows link into the
// (future) lesson view. Replaces the Block-1 Syllabus.tsx.

import { useState } from 'react';
import Link from 'next/link';
import { ProgressBar, LessonStatusIcon, LessonTypeIcon, SECTION_STATUS_STYLE } from './primitives';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import { useCourse } from './course-context';
import type { CourseHomeLesson, CourseHomeSection } from '@/lib/course-home-model';

function LessonRow({ trackId, lesson }: { trackId: string; lesson: CourseHomeLesson }) {
  const isCurrent = lesson.status === 'current';
  return (
    <Link
      href={`/learn/${trackId}/${lesson.id}`}
      className={`relative mx-2.5 my-px flex items-center gap-[11px] rounded-control py-2 pl-3.5 pr-2.5 hover:bg-fill ${
        isCurrent ? 'bg-brand-bg-soft' : 'bg-transparent'
      }`}
    >
      {isCurrent && (
        <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-[3px] bg-brand" />
      )}
      <LessonStatusIcon status={lesson.status} />
      <LessonTypeIcon type={lesson.type} />
      <span className="flex-1 text-sm leading-tight text-ink">{lesson.title}</span>
      <span className="meta-xs">{lesson.meta}</span>
    </Link>
  );
}

function SectionGroup({ trackId, section }: { trackId: string; section: CourseHomeSection }) {
  // Default open unless the section is untouched (not_started), matching the
  // prototype's "current/done open, later closed" feel.
  const [open, setOpen] = useState(section.status !== 'not_started');
  const dotColor = SECTION_STATUS_STYLE[section.status].color;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
            <LessonRow key={lesson.id} trackId={trackId} lesson={lesson} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CourseSidebar() {
  const { model } = useCourse();
  return (
    <aside className="sticky top-[var(--nav-h)] min-h-[calc(100vh-var(--nav-h))] w-[322px] flex-none self-start border-r border-line bg-card pb-5">
      <div className="border-b border-line-soft px-5 pb-[18px] pt-5">
        <div className="eyebrow text-muted">{model.topic.toUpperCase()}</div>
        <div className="mb-3 mt-[5px] text-lg font-semibold leading-tight">{model.title}</div>
        <ProgressBar pct={model.progressPct} />
        <div className="mt-2 flex justify-between">
          <span className="meta">
            {model.doneCount} / {model.totalLessons} lessons
          </span>
          <span className="meta font-medium text-brand">{model.progressPct}%</span>
        </div>
      </div>

      <div className="eyebrow px-5 pb-1.5 pt-4">COURSE CONTENT</div>

      {model.sections.map((section) => (
        <SectionGroup key={section.id} trackId={model.trackId} section={section} />
      ))}
    </aside>
  );
}
