'use client';

// Frontend redesign Block 4: the course home as a notebook sheet — hero
// (kicker/title/summary), the continue-learning sticky, a hand-drawn stat row,
// key concepts, and the section breakdown. Consumes the same useCourse()
// context as the old CourseHome, so the admin /learn viewer keeps the old
// design untouched. Adapted from the Home Summary (Notebook) mock: "time
// spent" → lessons completed (no time tracking), "what you'll learn" → key
// concepts (no outcomes field), and no locked lessons.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCourse } from '@/app/learn/_components/course-context';
import { ContinueCard } from '@/components/notebook/ContinueCard';
import { SectionRow } from '@/components/notebook/SectionRow';
import { PctDone, RingDoodle } from '@/components/notebook/primitives';
import { accentFor } from '@/components/notebook/accents';

function encouragement(pct: number): string {
  if (pct === 0) return 'start when you’re ready';
  if (pct === 100) return 'course complete 🎉';
  return 'on track — keep going!';
}

export function NotebookCourseHome() {
  const { model, basePath } = useCourse();
  const { programId } = useParams<{ programId: string }>();

  return (
    <>
      {/* sheet header — course-scoped progress readout, aligned right (the
          brand lives in the app-wide top nav). */}
      <div className="mb-5 flex h-[44px] items-end justify-end">
        <PctDone pct={model.progressPct} />
      </div>

      <div className="mb-1.5 font-script text-xs text-script-dim">
        <Link href={`/programs/${programId}`} className="text-script-dim no-underline hover:text-pen">
          Program overview
        </Link>
        &nbsp;→&nbsp;{model.title}
      </div>

      {/* hero */}
      <div className="nb-kicker">{model.eyebrow.toLowerCase()}</div>
      <h1 className="mb-2.5 mt-1.5 font-hand text-[52px] font-bold leading-[0.95] text-script">
        <span style={{ background: 'linear-gradient(transparent 62%, rgba(255,224,102,.72) 62%)' }}>
          {model.title}
        </span>
      </h1>
      {model.summary && (
        <p className="mb-6 max-w-[620px] text-lg leading-[34px]">{model.summary}</p>
      )}

      {model.continueLesson ? (
        <ContinueCard
          title={model.continueLesson.title}
          meta={model.continueLesson.meta}
          href={`${basePath}/${model.continueLesson.id}`}
        />
      ) : (
        model.doneCount > 0 && (
          <p className="font-script text-md text-crayon-green">
            ✓ Course complete — you’ve finished every lesson 🎉
          </p>
        )
      )}

      {/* stat row */}
      <div className="mt-7 flex flex-wrap items-center gap-5">
        <RingDoodle pct={model.progressPct} ink="var(--color-pen)">
          <span className="font-hand text-[22px] font-bold text-script">{model.progressPct}%</span>
        </RingDoodle>
        <div>
          <div className="font-script text-2xs uppercase tracking-[0.5px] text-script-dim">
            overall progress
          </div>
          <div className="font-hand text-[26px] font-bold leading-none text-script">
            {model.doneCount} of {model.totalLessons} lessons
          </div>
          <div className="font-script text-xs text-crayon-green">
            {encouragement(model.progressPct)}
          </div>
        </div>
        <div className="flex-1" />
        <div className="border-l-2 border-dashed border-rule px-4 py-1 text-center">
          <div className="font-script text-2xs uppercase tracking-[0.5px] text-script-dim">
            lessons completed
          </div>
          <div className="font-hand text-[38px] font-bold leading-[1.1] text-script">
            {model.doneCount}
          </div>
        </div>
        <div className="border-l-2 border-dashed border-rule px-4 py-1 text-center">
          <div className="font-script text-2xs uppercase tracking-[0.5px] text-script-dim">
            time left
          </div>
          <div className="font-hand text-[38px] font-bold leading-[1.1] text-script">
            {model.timeRemainingLabel}
          </div>
        </div>
      </div>

      {/* key concepts */}
      {model.keyConcepts.length > 0 && (
        <div className="mt-[30px]">
          <div className="mb-2 font-hand text-[30px] font-bold text-script">Key concepts</div>
          <div className="grid max-w-[760px] grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
            {model.keyConcepts.map((concept) => (
              <div key={concept} className="flex items-start gap-2.5 text-md leading-[30px]">
                <span className="flex-none text-lg text-pen">→</span>
                <span>{concept}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* course content breakdown */}
      <div className="mt-[34px]">
        <div className="mb-3 flex items-baseline gap-3">
          <div className="font-hand text-[30px] font-bold text-script">Course content</div>
          <div className="font-script text-xs text-script-dim">
            — {model.sections.length} section{model.sections.length === 1 ? '' : 's'} ·{' '}
            {model.totalLessons} lesson{model.totalLessons === 1 ? '' : 's'}
          </div>
        </div>
        {model.sections.map((section, i) => (
          <SectionRow
            key={section.id}
            n={section.n}
            accent={accentFor(i)}
            title={section.title}
            meta={`${section.countLabel} · ${section.durLabel}`}
            done={section.doneCount}
            total={section.total}
          />
        ))}
      </div>
    </>
  );
}
