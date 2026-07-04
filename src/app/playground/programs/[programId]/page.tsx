import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';
import { PROGRAM_STATUS_STYLE, TIER_STYLE } from '../status-style';

export const dynamic = 'force-dynamic';

// Phase 2.75e (playground stub): read-only phased view of one Program — the analog of
// the track viewer one level up. Each phase (phaseLabel) is a section; each topic slot
// shows its priority tier, budget, rationale, and the built Track (linking into the
// track viewer) or its not-yet-built status. Verifies the plan → fan-out → assemble
// chain end-to-end before the polished learner render (real 2.75e, post-Phase-3).

const CR_STATUS_STYLE: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-600',
  running: 'bg-amber-100 text-amber-800',
  fulfilled: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

export default async function ProgramDetailPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  await requireAdminPage();
  const { programId } = await params;

  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: {
      id: true,
      goal: true,
      background: true,
      totalHoursPerWeek: true,
      totalWeeks: true,
      antiList: true,
      status: true,
      error: true,
      createdAt: true,
      // Plan slots in cross-program order; the Track (once built) via trackId.
      programPaths: {
        orderBy: { orderInProgram: 'asc' },
        select: {
          id: true,
          topic: true,
          phaseLabel: true,
          orderInProgram: true,
          priorityTier: true,
          trackId: true,
          track: {
            select: { id: true, title: true, status: true, goal: true, _count: { select: { lessons: true } } },
          },
        },
      },
      // The child requests carry the per-topic budget + rationale + (for unbuilt
      // slots) the live build status; joined to slots by topic below.
      courseRequests: {
        select: { topic: true, status: true, goal: true, hoursPerWeek: true, timeframeWeeks: true, error: true },
      },
    },
  });
  if (!program) notFound();

  const reqByTopic = new Map(program.courseRequests.map((r) => [r.topic, r]));
  const coreCount = program.programPaths.filter((p) => p.priorityTier === 'core').length;

  // Group slots into phases, preserving orderInProgram (first occurrence sets phase order).
  const phases: { label: string; slots: typeof program.programPaths }[] = [];
  for (const slot of program.programPaths) {
    let phase = phases.find((ph) => ph.label === slot.phaseLabel);
    if (!phase) {
      phase = { label: slot.phaseLabel, slots: [] };
      phases.push(phase);
    }
    phase.slots.push(slot);
  }

  const statusStyle = PROGRAM_STATUS_STYLE[program.status] ?? 'bg-gray-100 text-gray-700';

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <Link href="/playground/programs" className="text-sm text-gray-600 underline">
          ← All programs
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-3">
          {program.goal}
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusStyle}`}>{program.status}</span>
        </h1>
        <p className="text-sm text-gray-600 mt-2">
          {program.programPaths.length} topic{program.programPaths.length === 1 ? '' : 's'}
          {coreCount > 0 && <> ({coreCount} core)</>} · budget: {program.totalHoursPerWeek}h/wk ×{' '}
          {program.totalWeeks}w
        </p>
        {program.background && (
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Background: <span className="italic">{program.background}</span>
          </p>
        )}
        {program.antiList.length > 0 && (
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            Excluded: {program.antiList.map((a) => (
              <code key={a} className="text-xs bg-gray-50 text-gray-500 rounded px-1 mr-1">{a}</code>
            ))}
          </p>
        )}
        {program.status === 'failed' && program.error && (
          <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2 mt-2 max-w-2xl">
            Plan failed: {program.error}
          </p>
        )}
      </section>

      {program.programPaths.length === 0 ? (
        <p className="text-sm text-gray-600">
          No topic slots — the plan pass produced nothing buildable.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {phases.map((phase) => (
            <section key={phase.label}>
              <div className="border-b pb-1 mb-3">
                <h2 className="text-lg font-semibold">{phase.label}</h2>
              </div>
              <ol className="flex flex-col gap-3">
                {phase.slots.map((slot) => {
                  const cr = reqByTopic.get(slot.topic);
                  const rationale = slot.track?.goal ?? cr?.goal;
                  return (
                    <li key={slot.id} className="border rounded p-3">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-xs text-gray-400 font-mono">{slot.orderInProgram}</span>
                        <span className="font-medium">{slot.topic}</span>
                        <span
                          className={`rounded px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${
                            TIER_STYLE[slot.priorityTier] ?? 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {slot.priorityTier === 'nice_to_have' ? 'nice to have' : 'core'}
                        </span>
                        {cr && (
                          <span className="text-xs text-gray-500">
                            {cr.hoursPerWeek}h/wk × {cr.timeframeWeeks}w
                          </span>
                        )}
                      </div>
                      {rationale && <p className="text-sm text-gray-600 mt-1 max-w-2xl">{rationale}</p>}

                      <div className="mt-2 text-sm">
                        {slot.track ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link href={`/playground/tracks/${slot.track.id}`} className="underline font-medium">
                              {slot.track.title ?? `Track for ${slot.topic}`}
                            </Link>
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                CR_STATUS_STYLE[slot.track.status === 'ready' ? 'fulfilled' : slot.track.status] ??
                                'bg-gray-100 text-gray-700'
                              }`}
                            >
                              {slot.track.status}
                            </span>
                            <span className="text-xs text-gray-500">{slot.track._count.lessons} lessons</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap text-gray-500">
                            <span className="italic">not yet built</span>
                            {cr && (
                              <span
                                className={`rounded px-2 py-0.5 text-xs font-medium ${
                                  CR_STATUS_STYLE[cr.status] ?? 'bg-gray-100 text-gray-700'
                                }`}
                              >
                                {cr.status}
                              </span>
                            )}
                            {cr?.error && <span className="text-xs text-red-700">{cr.error}</span>}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
