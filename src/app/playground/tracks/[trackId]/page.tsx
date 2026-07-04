import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LessonResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';

export const dynamic = 'force-dynamic';

const TRACK_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  building: 'bg-amber-100 text-amber-800',
  ready: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

type ResourceRow = {
  role: string;
  deliveryMode: string;
  resource: { id: string; title: string; url: string; type: string };
};

function ResourceItem({ r }: { r: ResourceRow }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <a href={r.resource.url} target="_blank" rel="noreferrer" className="underline">
        {r.resource.title}
      </a>
      <span className="text-xs text-gray-400">
        {r.resource.type} · {r.deliveryMode}
      </span>
    </li>
  );
}

type LessonRow = {
  id: string;
  orderInTrack: number;
  sectionId: string | null;
  title: string;
  summary: string;
  conceptsTaught: string[];
  estMinutes: number;
  resources: ResourceRow[];
};

function LessonItem({ lesson }: { lesson: LessonRow }) {
  // Resources arrive in allocator order (orderInLesson). The mandatory core is the
  // role=primary set (multiple since 2.5e-7b); the rest are the frozen
  // optional/substitute pool — kept so invalidation can promote one if a core
  // resource dies (mandatory set degrades → promote an optional).
  const core = lesson.resources.filter((r) => r.role === LessonResourceRole.primary);
  const optional = lesson.resources.filter((r) => r.role !== LessonResourceRole.primary);
  return (
    <li className="border rounded p-3">
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

      <div className="mt-2 flex flex-col gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-green-700">
            Core{core.length > 1 ? ` (${core.length})` : ''}
          </p>
          <ul className="mt-0.5 flex flex-col gap-1">
            {core.map((r) => (
              <ResourceItem key={r.resource.id} r={r} />
            ))}
          </ul>
        </div>
        {optional.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
              Optional ({optional.length})
            </p>
            <ul className="mt-0.5 flex flex-col gap-1">
              {optional.map((r) => (
                <ResourceItem key={r.resource.id} r={r} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

// Phase 2.5e-4: read-only view of a built Track — its ordered Lessons, each with
// the concepts it teaches, its primary resource, and the frozen alternates with
// delivery mode. Just enough to verify the builder end-to-end before the polished
// 2.5k render lands.
export default async function TrackDetailPage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}) {
  await requireAdminPage();
  const { trackId } = await params;

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      status: true,
      title: true,
      summary: true,
      targetMastery: true,
      intent: true,
      goal: true,
      priorKnowledge: true,
      timeframeWeeks: true,
      hoursPerWeek: true,
      createdAt: true,
      path: { select: { id: true, topic: true } },
      // Phase 2.5e (track sections): chapters grouping the lessons, in order. Empty
      // when the best-effort sectioner didn't run / produced a flat track — the view
      // then renders the lessons as one ungrouped list.
      sections: {
        orderBy: { orderInTrack: 'asc' },
        select: { id: true, orderInTrack: true, title: true, intro: true },
      },
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: {
          id: true,
          orderInTrack: true,
          sectionId: true,
          title: true,
          summary: true,
          conceptsTaught: true,
          estMinutes: true,
          resources: {
            // Allocator order within the lesson: mandatory core first, then pool.
            orderBy: { orderInLesson: 'asc' },
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
          {track.intent && (
            <> · intent: <span className="font-medium">{track.intent}</span></>
          )}
          {track.timeframeWeeks && track.hoursPerWeek && (
            <> · budget: {track.timeframeWeeks}w × {track.hoursPerWeek}h/w</>
          )}
        </p>
        {track.goal && (
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Goal: <span className="italic">{track.goal}</span>
          </p>
        )}
        {track.priorKnowledge && (
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Prior knowledge: <span className="italic">{track.priorKnowledge}</span>
          </p>
        )}
      </section>

      {track.sections.length > 0 ? (
        // Grouped: each Section is a contentless chapter divider (title + intro)
        // over a contiguous run of lessons. Lessons keep their global orderInTrack
        // number — the header is a visual grouping, not a renumbering.
        <div className="flex flex-col gap-6">
          {track.sections.map((section) => {
            const lessons = track.lessons.filter((l) => l.sectionId === section.id);
            return (
              <section key={section.id}>
                <div className="border-b pb-1 mb-3">
                  <h2 className="text-lg font-semibold">
                    <span className="text-gray-400 font-mono text-sm mr-2">
                      {section.orderInTrack}
                    </span>
                    {section.title}
                  </h2>
                  {section.intro && (
                    <p className="text-sm text-gray-600 mt-1 max-w-2xl">{section.intro}</p>
                  )}
                </div>
                <ol className="flex flex-col gap-3">
                  {lessons.map((lesson) => (
                    <LessonItem key={lesson.id} lesson={lesson} />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      ) : (
        // Flat fallback: no sections (sectioner didn't run, failed, or the track was
        // too short / collapsed to a single chapter).
        <ol className="flex flex-col gap-3">
          {track.lessons.map((lesson) => (
            <LessonItem key={lesson.id} lesson={lesson} />
          ))}
        </ol>
      )}
    </main>
  );
}
