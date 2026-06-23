'use client';

// Phase 2.6 (learn UI), Block C: the course-home main column. The single consumer
// of the course context — reads the derived model once and distributes it to the
// presentational hero + cards. Recreated from the Home Summary (Hi-Fi) prototype.

import { MONO } from './primitives';
import { useCourse } from './course-context';
import { ContinueLearningCard } from './ContinueLearningCard';
import { StatCards } from './StatCards';
import { KeyConcepts } from './KeyConcepts';
import { CourseContentBreakdown } from './CourseContentBreakdown';

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function CourseHome() {
  const { model } = useCourse();
  return (
    <div className="px-10 pb-[60px] pt-[34px]">
      <div className="mx-auto max-w-[860px]">
        <div className={`mb-[18px] text-[11px] tracking-[0.5px] text-[#9aa2ad] ${MONO}`}>
          My Courses&nbsp;&nbsp;/&nbsp;&nbsp;{titleCase(model.topic)}
        </div>

        <div className={`text-[11px] tracking-[1.5px] text-[#3f6ad8] ${MONO}`}>{model.eyebrow}</div>
        <h1 className="mb-3 mt-[7px] text-[32px] font-bold tracking-[-0.5px]">{model.title}</h1>
        {model.summary && (
          <p className="mb-[26px] max-w-[660px] text-base leading-[1.6] text-[#5a636f]">
            {model.summary}
          </p>
        )}

        <ContinueLearningCard trackId={model.trackId} lesson={model.continueLesson} />

        <StatCards
          progressPct={model.progressPct}
          doneCount={model.doneCount}
          totalLessons={model.totalLessons}
          timeRemainingLabel={model.timeRemainingLabel}
        />

        <KeyConcepts concepts={model.keyConcepts} />

        <CourseContentBreakdown sections={model.sections} totalLessons={model.totalLessons} />
      </div>
    </div>
  );
}
