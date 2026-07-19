'use client';

// Frontend redesign Block 5: the lesson view as a notebook sheet, per the
// Lesson View (Notebook) mock. Kicker + hand-font title + dashed type badge,
// the taped resource pane, summary, "in this lesson" points, practice (index
// cards, reveal-only), the up-next index card, and the footer nav wired to the
// shared course context. The mock's tabs (transcript/discussion) and fake
// player chrome are dropped — no data backs them; the iframe has real controls.

import { useState } from 'react';
import Link from 'next/link';
import type { TrackExerciseView } from '@/lib/track-view';
import type { LessonViewModel, LessonNavLesson, LessonNextLesson } from '@/app/learn/_components/LessonView';
import { useCourse } from '@/app/learn/_components/course-context';
import { IndexCard, PctDone } from '@/components/notebook/primitives';
import { NotebookResourcePane, TypeIcon, type MyVotes } from './NotebookResourcePane';

const TYPE_LABEL = { video: 'video', embed: 'embed', link: 'reading' } as const;

// `myVotes`: the viewer's own resource votes (free-beta A2), hydrated by the
// lesson page server-side and passed through to the resource pane's thumbs.
export function NotebookLessonView({ model, myVotes }: { model: LessonViewModel; myVotes?: MyVotes }) {
  const { model: course, basePath, isComplete, toggleComplete } = useCourse();
  const done = isComplete(model.id);

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
      <div className="mb-4 mt-0.5 flex flex-wrap items-center gap-3.5">
        <h1 className="m-0 font-hand text-[46px] font-bold leading-none text-script">{model.title}</h1>
        <span className="-rotate-2 rounded border border-dashed border-note-edge bg-note px-2.5 py-[3px] font-script text-2xs uppercase tracking-[0.5px] text-note-label">
          ✎ {TYPE_LABEL[model.type]} · ~{model.estMinutes} min
        </span>
      </div>

      <NotebookResourcePane resources={model.resources} myVotes={myVotes} />

      {model.summary && (
        <p className="mb-5 mt-6 max-w-[660px] text-lg leading-[34px]">{model.summary}</p>
      )}

      {model.concepts.length > 0 && (
        <div className="mb-6">
          <div className="mb-1 font-hand text-[26px] font-bold text-script">In this lesson</div>
          <div className="flex max-w-[640px] flex-col gap-0.5">
            {model.concepts.map((c) => (
              <div key={c} className="flex items-start gap-2.5 text-md leading-[30px]">
                <span className="flex-none text-lg text-pen">→</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <NotebookExercises exercises={model.exercises} />

      {model.next && (
        <Link href={`${basePath}/${model.next.id}`} className="block no-underline">
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
    <div className="mb-6">
      <div className="mb-2 font-hand text-[26px] font-bold text-script">Practice</div>
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
        {exercises.map((ex, i) => (
          <Exercise key={ex.id} exercise={ex} index={i + 1} />
        ))}
      </ul>
    </div>
  );
}

// Reveal-only, like the old card: prompt (MCQ options are lines in the prompt),
// then a doodle button expands the answer + why. No auto-grading (Phase-4 tutor).
function Exercise({ exercise, index }: { exercise: TrackExerciseView; index: number }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <li
      className="max-w-[640px] rounded-[3px] border border-note-edge bg-card px-[18px] py-3.5 shadow-[0_4px_10px_rgba(0,0,0,.08)]"
      style={{ borderLeft: '5px solid var(--color-pen)' }}
    >
      <div className="mb-1 flex items-baseline gap-2.5">
        <span className="font-hand text-[22px] font-bold text-pen">Q{index}</span>
        <span className="font-script text-2xs uppercase tracking-[1px] text-script-dim">
          {exercise.kind === 'mcq' ? 'multiple choice' : 'short answer'}
        </span>
      </div>
      <p className="m-0 whitespace-pre-line font-script text-sm leading-[26px] text-script-body">
        {exercise.prompt}
      </p>
      {revealed ? (
        <div className="mt-3 border-t border-dashed border-rule pt-2.5">
          <div className="font-script text-2xs uppercase tracking-[1px] text-crayon-green">answer</div>
          <p className="m-0 mt-1 whitespace-pre-line font-script text-sm leading-[26px] text-script-body">
            {exercise.answer}
          </p>
          {exercise.rubric && (
            <>
              <div className="mt-2.5 font-script text-2xs uppercase tracking-[1px] text-script-dim">why</div>
              <p className="m-0 mt-1 whitespace-pre-line font-script text-sm leading-[26px] text-script-faint">
                {exercise.rubric}
              </p>
            </>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setRevealed(true)} className="btn-doodle mt-3 px-3.5 py-0.5 text-[19px]">
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
    <div className="mt-[30px] flex flex-wrap items-center gap-3.5 border-t-2 border-dashed border-rule pt-[18px]">
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

      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        className={`rounded-[9px_8px_11px_10px] border-2 px-4 py-1 font-hand text-[20px] font-bold ${
          done ? 'border-crayon-green bg-crayon-green text-white' : 'border-crayon-green bg-transparent text-crayon-green'
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
