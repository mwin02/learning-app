// Phase 2.6 (learn UI): the "Continue learning" card — resumes the current lesson.
// Recreated from the Home Summary (Hi-Fi) prototype. Presentational; the current
// lesson (or null when the course is complete) comes from the course model.

import Link from 'next/link';
import { CheckIcon, PlayIcon } from './icons';
import type { ContinueLesson } from '@/lib/course-home-model';

export function ContinueLearningCard({
  trackId,
  lesson,
}: {
  trackId: string;
  lesson: ContinueLesson | null;
}) {
  if (!lesson) {
    return (
      <div className="card mb-[var(--space-section)] flex items-center gap-[18px] p-4">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-success text-white">
          <CheckIcon size={18} />
        </span>
        <div>
          <div className="eyebrow text-success">COURSE COMPLETE</div>
          <div className="mt-1 text-xl font-semibold">You&apos;ve finished every lesson 🎉</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card mb-[var(--space-section)] flex items-center gap-[18px] p-4">
      <div className="flex h-[78px] w-[122px] flex-none items-center justify-center rounded-button border border-[#e0e6f2] bg-[linear-gradient(135deg,#eef2fb,#e1e8f6)]">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand shadow-[0_3px_10px_rgba(63,106,216,0.38)]">
          <PlayIcon size={15} className="text-white" />
        </div>
      </div>
      <div className="flex-1">
        <div className="eyebrow text-brand">CONTINUE LEARNING</div>
        <div className="my-1 text-xl font-semibold">{lesson.title}</div>
        <div className="meta">{lesson.meta}</div>
      </div>
      <Link
        href={`/learn/${trackId}/${lesson.id}`}
        className="rounded-button bg-brand px-5 py-[11px] text-sm font-semibold text-white shadow-[0_1px_2px_rgba(63,106,216,0.3)] hover:bg-brand-dark"
      >
        Resume →
      </Link>
    </div>
  );
}
