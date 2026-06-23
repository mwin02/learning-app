// Phase 2.6 (learn UI), Block 1: the course overview — the landing pane inside the
// shell. Title, summary, at-a-glance stats, and a "Start course" CTA into the first
// lesson. Block 2 adds the per-lesson content route; Block 3 turns "Start" into
// "Continue" from saved progress.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTrackView } from '@/lib/track-view';
import { formatDuration } from '@/lib/format-duration';

export const dynamic = 'force-dynamic';

export default async function CourseOverviewPage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = await params;
  const track = await getTrackView(trackId);
  if (!track) notFound();

  const firstLesson = track.lessons[0];

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{track.topic}</p>
      <h1 className="mt-1 text-3xl font-bold text-gray-900">
        {track.title ?? `${track.topic} course`}
      </h1>
      {track.summary && <p className="mt-3 text-gray-600">{track.summary}</p>}

      <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-sm text-gray-600">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-400">Lessons</dt>
          <dd className="font-medium text-gray-900">{track.lessons.length}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-400">Est. time</dt>
          <dd className="font-medium text-gray-900">{formatDuration(track.totalMinutes)}</dd>
        </div>
        {track.targetMastery && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-400">Level</dt>
            <dd className="font-medium text-gray-900 capitalize">{track.targetMastery}</dd>
          </div>
        )}
      </dl>

      {firstLesson && (
        <Link
          href={`/learn/${track.id}/${firstLesson.id}`}
          className="mt-8 inline-flex items-center rounded-full bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-700"
        >
          Start course →
        </Link>
      )}
    </div>
  );
}
