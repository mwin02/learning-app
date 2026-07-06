'use client';

// Phase 2.6 (learn UI), Block C: the course-home main column. The single consumer
// of the course context — reads the derived model once and distributes it to the
// presentational hero + cards. Recreated from the Home Summary (Hi-Fi) prototype.

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
  const { model, basePath } = useCourse();
  return (
    <div className="px-10 pb-[60px] pt-[34px]">
      <div className="mx-auto max-w-[860px]">
        <div className="meta mb-[18px] tracking-[0.5px]">
          My Courses&nbsp;&nbsp;/&nbsp;&nbsp;{titleCase(model.topic)}
        </div>

        <div className="eyebrow text-brand">{model.eyebrow}</div>
        <h1 className="mb-3 mt-[7px] text-3xl font-bold tracking-[-0.5px]">{model.title}</h1>
        {model.summary && (
          <p className="mb-[var(--space-section)] max-w-[660px] text-md leading-[1.6] text-body">{model.summary}</p>
        )}

        <ContinueLearningCard basePath={basePath} lesson={model.continueLesson} />

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
