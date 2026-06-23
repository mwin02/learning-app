// Phase 2.6 (learn UI), Block 1: the course-player shell. A two-pane layout shared
// by the overview page and (Block 2) the per-lesson content page — both render into
// {children}, so the sidebar syllabus + course header stay fixed while the content
// pane swaps. Data loads here via the cached getTrackView; the child pages call the
// same loader and the React cache() dedupes it to one query per request.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTrackView } from '@/lib/track-view';
import { formatDuration } from '@/lib/format-duration';
import { Syllabus } from './Syllabus';

export const dynamic = 'force-dynamic';

export default async function LearnLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ trackId: string }>;
}) {
  const { trackId } = await params;
  const track = await getTrackView(trackId);
  if (!track) notFound();

  return (
    // Explicit light surface: the app is light-only, but globals.css flips the
    // body background to near-black under prefers-color-scheme: dark. Pin the
    // learn shell to a light palette so device dark mode doesn't bleed through.
    <div className="flex flex-1 min-h-0 bg-white text-gray-900">
      <aside className="w-80 shrink-0 overflow-y-auto border-r bg-gray-50 p-4">
        <Link href={`/learn/${track.id}`} className="block">
          <h1 className="text-base font-semibold leading-snug text-gray-900 hover:underline">
            {track.title ?? `${track.topic} course`}
          </h1>
        </Link>
        <p className="mt-1 text-xs text-gray-500">
          {track.lessons.length} lessons · {formatDuration(track.totalMinutes)}
        </p>
        <div className="mt-4">
          <Syllabus track={track} />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
