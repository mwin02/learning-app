'use client';

// Lesson View v3: the lesson as a notebook sheet. v2's single-column stack
// (one big resource, then everything else) is now a two-column body — the stage
// plus the lesson's own prose on the left, the core-resource rail and the
// optional pool on the right — so a lesson with several mandatory resources
// reads as a set to work through rather than a pile, and the optional pool is
// visibly a different kind of thing.
//
// The mock's fake player chrome is dropped (the iframe has real controls), and
// the quiz stays reveal-only: Exercise carries MCQ options as prose lines inside
// `prompt` and a free-text `answer`, with no correct-option marker or attempt
// record, so the mock's graded states have nothing to render from. Only the
// chrome — "Check yourself", the per-question card, the counter — is adopted.

import { useState } from 'react';
import Link from 'next/link';
import type { TrackExerciseView } from '@/lib/track-view';
import type { LessonViewModel, LessonNavLesson, LessonNextLesson } from '@/app/learn/_components/LessonView';
import { useCourse } from '@/app/learn/_components/course-context';
import { IndexCard, PctDone } from '@/components/notebook/primitives';
import { lessonMetaLine } from '@/lib/lesson-resources-view';
import {
  ResourceRail,
  ResourceStage,
  TypeIcon,
  useLessonResources,
  type MyVotes,
} from './NotebookResourcePane';

const TYPE_LABEL = { video: 'video', embed: 'embed', link: 'reading' } as const;

// `myVotes`: the viewer's own resource votes (free-beta A2), hydrated by the
// lesson page server-side and passed through to the resource pane's thumbs.
export function NotebookLessonView({ model, myVotes }: { model: LessonViewModel; myVotes?: MyVotes }) {
  const { model: course, basePath, isComplete, toggleComplete } = useCourse();
  const done = isComplete(model.id);
  const resources = useLessonResources(model.id, model.resources);

  return (
    <>
      {/* sheet header — course-scoped progress, aligned right. */}
      <div className="mb-5 flex h-[44px] items-end justify-between">
        <div className="self-end font-script text-xs text-script-dim">
          <Link href={basePath} className="text-script-dim no-underline hover:text-pen">
            {course.title}
          </Link>
        </div>
        <PctDone pct={course.progressPct} />
      </div>

      <div className="nb-kicker">{model.eyebrow.toLowerCase()}</div>
      <div className="mb-5 mt-0.5 flex flex-wrap items-baseline gap-4">
        <h1 className="m-0 font-hand text-[46px] font-bold leading-none text-script">{model.title}</h1>
        <span className="font-script text-sm text-script-faint">
          {lessonMetaLine({
            estMinutes: model.estMinutes,
            coreCount: resources.view.cores.length,
            exerciseCount: model.exercises.length,
          })}
        </span>
      </div>

      <div className="flex flex-wrap items-start gap-7">
        <div className="min-w-0 flex-1 basis-[440px]">
          <ResourceStage state={resources} myVotes={myVotes} lessonId={model.id} />

          {/* The mock's "In this lesson" concept list is deliberately dropped:
              lessons are nearly always single-concept here, so it restated the
              title under a heading. The concepts still drive the syllabus. */}
          {model.summary && <p className="mt-4 text-lg leading-[34px]">{model.summary}</p>}
        </div>

        <ResourceRail state={resources} myVotes={myVotes} lessonId={model.id} />
      </div>

      <NotebookExercises exercises={model.exercises} />

      {model.next && (
        <Link href={`${basePath}/${model.next.id}`} className="mt-8 block no-underline">
          <IndexCard
            accent="var(--color-pen)"
            icon={<TypeIcon type={model.next.type} />}
            kicker={`up next · ${TYPE_LABEL[model.next.type]}`}
            title={model.next.title}
            meta={`~${model.next.estMinutes} min`}
          />
        </Link>
      )}

      <FooterNav
        basePath={basePath}
        prev={model.prev}
        next={model.next}
        done={done}
        onToggle={() => toggleComplete(model.id)}
      />
    </>
  );
}

function NotebookExercises({ exercises }: { exercises: TrackExerciseView[] }) {
  if (exercises.length === 0) return null;
  return (
    <div className="mt-[38px]">
      <div className="flex flex-wrap items-baseline gap-3.5">
        <span className="font-hand text-[30px] font-bold text-script">Check yourself</span>
        <span className="font-script text-2xs text-script-faint">
          {`${exercises.length} question${exercises.length === 1 ? '' : 's'} · reveal the answer when you’ve had a go`}
        </span>
      </div>
      <ul className="m-0 mt-3.5 flex list-none flex-col gap-3.5 p-0">
        {exercises.map((ex, i) => (
          <Exercise key={ex.id} exercise={ex} index={i + 1} total={exercises.length} />
        ))}
      </ul>
    </div>
  );
}

// Reveal-only: prompt (MCQ options are lines in the prompt), then a doodle button
// expands the answer + why. No auto-grading (Phase-4 tutor), so the mock's
// correct/incorrect card states are deliberately absent — only its chrome is here.
function Exercise({
  exercise,
  index,
  total,
}: {
  exercise: TrackExerciseView;
  index: number;
  total: number;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <li
      className="max-w-[680px] rounded-[4px] border border-note-edge bg-card px-[22px] py-[18px] shadow-[0_5px_14px_rgba(0,0,0,.09)]"
      style={{ borderTop: `5px solid var(--color-${revealed ? 'crayon-green' : 'pen'})` }}
    >
      <div className="flex items-baseline gap-3">
        <span className="font-script text-2xs uppercase tracking-[1px] text-script-dim">
          Question {index} of {total}
        </span>
        <span className="font-script text-2xs uppercase tracking-[1px] text-script-dim">
          {exercise.kind === 'mcq' ? 'multiple choice' : 'short answer'}
        </span>
      </div>
      <p className="m-0 mb-3.5 mt-0.5 whitespace-pre-line font-hand text-[24px] font-bold leading-tight text-script">
        {exercise.prompt}
      </p>
      {revealed ? (
        <div className="border-t border-dashed border-rule pt-2.5">
          <div className="font-script text-2xs uppercase tracking-[1px] text-crayon-green">answer</div>
          <p className="m-0 mt-1 whitespace-pre-line font-script text-sm leading-[26px] text-script-body">
            {exercise.answer}
          </p>
          {exercise.rubric && (
            <div className="mt-3 rounded-[0_6px_6px_0] border-l-4 border-note-label bg-note px-4 py-2.5">
              <div className="font-hand text-[22px] font-bold text-note-label">Why</div>
              <p className="m-0 whitespace-pre-line font-script text-sm leading-[26px] text-script-body">
                {exercise.rubric}
              </p>
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setRevealed(true)} className="btn-doodle px-5 py-0.5 text-[20px]">
          Reveal answer →
        </button>
      )}
    </li>
  );
}

function FooterNav({
  basePath,
  prev,
  next,
  done,
  onToggle,
}: {
  basePath: string;
  prev: LessonNavLesson | null;
  next: LessonNextLesson | null;
  done: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-[34px] flex flex-wrap items-center gap-3.5 border-t-2 border-dashed border-rule pt-[18px]">
      {prev ? (
        <Link href={`${basePath}/${prev.id}`} className="btn-doodle px-4 py-1 text-[20px] no-underline">
          ← Previous
        </Link>
      ) : (
        <span className="rounded-[9px_11px_10px_8px] border-2 border-dashed border-rule px-4 py-1 font-hand text-[20px] font-bold text-script-dim">
          ← Previous
        </span>
      )}

      <div className="flex-1" />

      <span className="font-script text-2xs text-script-dim">
        nothing is gated — mark it done when you&rsquo;re ready
      </span>

      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        className={`rounded-[9px_8px_11px_10px] border-2 px-4 py-1 font-hand text-[20px] font-bold ${
          done ? 'border-crayon-green bg-crayon-green text-on-accent' : 'border-crayon-green bg-transparent text-crayon-green'
        }`}
      >
        ✓ {done ? 'Completed' : 'Mark complete'}
      </button>

      <Link
        href={next ? `${basePath}/${next.id}` : basePath}
        className="btn-ink rotate-[0.6deg] px-5 py-1.5 text-[20px] no-underline"
      >
        {next ? 'Next lesson →' : 'Back to overview →'}
      </Link>
    </div>
  );
}
