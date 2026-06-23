// Phase 2.6 (learn UI), Block 1: the course sidebar — sections as chapter headers
// over their lessons, each lesson a link into the content pane. Server-rendered and
// progress-agnostic for now; Block 3 layers localStorage completion checkmarks on
// top (likely by promoting this to a client component fed the same lesson list).

import Link from 'next/link';
import type { TrackView } from '@/lib/track-view';

function LessonLink({
  trackId,
  lesson,
  index,
}: {
  trackId: string;
  lesson: TrackView['lessons'][number];
  index: number;
}) {
  return (
    <li>
      <Link
        href={`/learn/${trackId}/${lesson.id}`}
        className="flex items-baseline gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
      >
        <span className="font-mono text-xs text-gray-400">{index}</span>
        <span className="flex-1">{lesson.title}</span>
        <span className="shrink-0 text-xs text-gray-400">{lesson.estMinutes}m</span>
      </Link>
    </li>
  );
}

export function Syllabus({ track }: { track: TrackView }) {
  const hasSections = track.sections.length > 0;

  return (
    <nav className="flex flex-col gap-4">
      {hasSections ? (
        track.sections.map((section) => {
          const lessons = track.lessons.filter((l) => l.sectionId === section.id);
          return (
            <div key={section.id}>
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {section.title}
              </p>
              <ul className="mt-1 flex flex-col">
                {lessons.map((lesson) => (
                  <LessonLink
                    key={lesson.id}
                    trackId={track.id}
                    lesson={lesson}
                    index={lesson.orderInTrack}
                  />
                ))}
              </ul>
            </div>
          );
        })
      ) : (
        // Flat fallback: the best-effort sectioner didn't run / produced no chapters.
        <ul className="flex flex-col">
          {track.lessons.map((lesson) => (
            <LessonLink
              key={lesson.id}
              trackId={track.id}
              lesson={lesson}
              index={lesson.orderInTrack}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
