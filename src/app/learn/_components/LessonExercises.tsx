'use client';

// Phase 2.5h: the in-lesson practice block. Reveal-only — each exercise shows its
// prompt (MCQ options are embedded in the prompt text, rendered on their own lines),
// and a "Reveal answer" toggle expands the answer + explanation. No auto-grading
// (that's the Phase-4 tutor). Token-only styling so it's dark-mode-clean for free.

import { useState } from 'react';
import type { TrackExerciseView } from '@/lib/track-view';
import { ChevronRightIcon } from './icons';

export function LessonExercises({ exercises }: { exercises: TrackExerciseView[] }) {
  if (exercises.length === 0) return null;
  return (
    <>
      <div className="eyebrow mb-2.5 mt-6 tracking-[1.5px] text-faint">PRACTICE</div>
      <ul className="mb-6 flex flex-col gap-3">
        {exercises.map((ex, i) => (
          <ExerciseCard key={ex.id} exercise={ex} index={i + 1} />
        ))}
      </ul>
    </>
  );
}

function ExerciseCard({ exercise, index }: { exercise: TrackExerciseView; index: number }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <li className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="meta-xs text-faint">Q{index}</span>
        <span className="font-mono text-2xs uppercase tracking-[0.5px] text-brand">
          {exercise.kind === 'mcq' ? 'Multiple choice' : 'Short answer'}
        </span>
      </div>

      {/* Prompt — MCQ options are A)/B)/… lines inside the prompt; keep the breaks. */}
      <p className="whitespace-pre-line text-sm leading-[1.6] text-body">{exercise.prompt}</p>

      {revealed ? (
        <div className="mt-3 border-t border-line pt-3">
          <div className="meta-xs mb-1 text-success">ANSWER</div>
          <p className="whitespace-pre-line text-sm leading-[1.6] text-ink">{exercise.answer}</p>
          {exercise.rubric && (
            <>
              <div className="meta-xs mb-1 mt-3 text-faint">WHY</div>
              <p className="whitespace-pre-line text-sm leading-[1.6] text-body">{exercise.rubric}</p>
            </>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-button border-[1.5px] border-hairline px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-fill-soft"
        >
          Reveal answer <ChevronRightIcon size={14} />
        </button>
      )}
    </li>
  );
}
