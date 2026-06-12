import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LessonResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isDevAuthEnabled } from '@/lib/dev-auth';

export const dynamic = 'force-dynamic';

const TRACK_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  building: 'bg-amber-100 text-amber-800',
  ready: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

const ROLE_STYLE: Record<string, string> = {
  primary: 'bg-green-100 text-green-800',
  alternate: 'bg-gray-100 text-gray-600',
};

// Phase 2.5e-4: read-only view of a built Track — its ordered Lessons, each with
// the concepts it teaches, its primary resource, and the frozen alternates with
// delivery mode. Just enough to verify the builder end-to-end before the polished
// 2.5k render lands.
export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}) {
  if (!isDevAuthEnabled()) notFound();
  const { trackId } = await params;

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      status: true,
      title: true,
      summary: true,
      targetMastery: true,
      priorKnowledge: true,
      timeframeWeeks: true,
      hoursPerWeek: true,
      createdAt: true,
      path: { select: { id: true, topic: true } },
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: {
          id: true,
          orderInTrack: true,
          title: true,
          summary: true,
          conceptsTaught: true,
          estMinutes: true,
          resources: {
            select: {
              role: true,
              deliveryMode: true,
              resource: { select: { id: true, title: true, url: true, type: true } },
            },
          },
        },
      },
    },
  });
  if (!track) notFound();

  const style = TRACK_STATUS_STYLE[track.status] ?? 'bg-gray-100 text-gray-700';
  const totalMinutes = track.lessons.reduce((sum, l) => sum + l.estMinutes, 0);
  // Primary first within each lesson.
  const roleOrder = (r: string) => (r === LessonResourceRole.primary ? 0 : 1);

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <Link
          href={`/playground/concept-maps/${track.path.id}`}
          className="text-sm text-gray-600 underline"
        >
          ← {track.path.topic} concept map
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-3">
          {track.title ?? `Track for ${track.path.topic}`}
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${style}`}>{track.status}</span>
        </h1>
        {track.summary && <p className="text-sm text-gray-700 mt-1 max-w-2xl">{track.summary}</p>}
        <p className="text-sm text-gray-600 mt-2">
          {track.lessons.length} lessons · ~{totalMinutes} min ·{' '}
          target mastery: <span className="font-medium">{track.targetMastery ?? 'beginner'}</span>
          {track.timeframeWeeks && track.hoursPerWeek && (
            <> · budget: {track.timeframeWeeks}w × {track.hoursPerWeek}h/w</>
          )}
        </p>
        {track.priorKnowledge && (
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Prior knowledge: <span className="italic">{track.priorKnowledge}</span>
          </p>
        )}
      </section>

      <ol className="flex flex-col gap-3">
        {track.lessons.map((lesson) => (
          <li key={lesson.id} className="border rounded p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-gray-400 font-mono">{lesson.orderInTrack}</span>
              <span className="font-medium">{lesson.title}</span>
              <span className="text-xs text-gray-500">~{lesson.estMinutes} min</span>
            </div>
            {lesson.summary && <p className="text-sm text-gray-600 mt-1">{lesson.summary}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              {lesson.conceptsTaught.map((slug) => (
                <code key={slug} className="text-xs bg-gray-50 text-gray-500 rounded px-1">
                  {slug}
                </code>
              ))}
            </div>

            <ul className="mt-2 flex flex-col gap-1">
              {[...lesson.resources]
                .sort((a, b) => roleOrder(a.role) - roleOrder(b.role))
                .map((r) => (
                  <li key={r.resource.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${ROLE_STYLE[r.role] ?? ''}`}
                    >
                      {r.role}
                    </span>
                    <a href={r.resource.url} target="_blank" rel="noreferrer" className="underline">
                      {r.resource.title}
                    </a>
                    <span className="text-xs text-gray-400">
                      {r.resource.type} · {r.deliveryMode}
                    </span>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
    </main>
  );
}
