import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/auth/viewer';
import { PROGRAM_STATUS_STYLE } from '../programs/status-style';

export const dynamic = 'force-dynamic';

// Failed-builds triage surface. A build that never completed is a `failed`
// CourseRequest (the worker's per-job deadline, an aborted remediation, a flaky
// LLM/fetch) — terminal, with NO automatic retry (reclaimStale only bounces
// `running` rows). This page surfaces those so an operator can see, diagnose
// (Block 2), and act on them (Block 3). Three sections:
//   1. Plan-pass failures  — Programs that failed BEFORE fan-out (no children);
//      the failure lives on Program.error, not any request.
//   2. Grouped by program  — failed child builds under their parent Program
//      (a `partial` Program is exactly "some children failed").
//   3. Standalone builds   — failed /generate-path requests (no programId).
// Read-only for now; retry/delete land in Block 3.

// Cap each scan. This is an internal force-dynamic triage page, not paginated —
// the cap keeps a degenerate backlog from scanning the whole table on every load.
const ROW_CAP = 300;

const FAILED_BADGE = 'bg-red-100 text-red-800';

type FailedRequest = {
  id: string;
  topic: string;
  error: string | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  programId: string | null;
  program: { id: string; goal: string; title: string | null; status: string } | null;
};

// Wall-clock the build ran before failing: claim → fail if it was claimed
// (the common case), else created → fail (never claimed).
function fmtDuration(r: FailedRequest): string {
  const start = r.claimedAt ?? r.createdAt;
  const s = Math.max(0, Math.round((r.updatedAt.getTime() - start.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtWhen(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function RequestRow({ r }: { r: FailedRequest }) {
  return (
    <li className="flex flex-col gap-1 border-l-2 border-red-200 pl-3 py-1 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-medium text-gray-800">{r.topic}</span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${FAILED_BADGE}`}>failed</span>
        <span className="text-gray-500">ran {fmtDuration(r)}</span>
        <span className="font-mono text-gray-400">{fmtWhen(r.updatedAt)}</span>
      </div>
      <p className="font-mono text-red-900/80 break-all">{r.error ?? '(no error message recorded)'}</p>
    </li>
  );
}

export default async function FailedBuildsPage() {
  await requireAdminPage();

  const [failedRequests, planFailures] = await Promise.all([
    prisma.courseRequest.findMany({
      where: { status: 'failed' },
      orderBy: { updatedAt: 'desc' },
      take: ROW_CAP,
      select: {
        id: true,
        topic: true,
        error: true,
        claimedAt: true,
        createdAt: true,
        updatedAt: true,
        programId: true,
        program: { select: { id: true, goal: true, title: true, status: true } },
      },
    }),
    // Plan-pass failures: a `failed` Program with zero children never fanned out
    // (enqueueProgram's plan pass produced nothing / threw), so no failed request
    // represents it. Surfaced on its own.
    prisma.program.findMany({
      where: { status: 'failed', courseRequests: { none: {} } },
      orderBy: { updatedAt: 'desc' },
      take: ROW_CAP,
      select: { id: true, goal: true, title: true, error: true, updatedAt: true },
    }),
  ]);

  const standalone = failedRequests.filter((r) => !r.program);

  // Group failed children under their parent Program, preserving the newest-first
  // order (the map's first-seen order is the query's updatedAt-desc order).
  const byProgram = new Map<
    string,
    { program: NonNullable<FailedRequest['program']>; requests: FailedRequest[] }
  >();
  for (const r of failedRequests) {
    if (!r.program) continue;
    let g = byProgram.get(r.program.id);
    if (!g) {
      g = { program: r.program, requests: [] };
      byProgram.set(r.program.id, g);
    }
    g.requests.push(r);
  }
  const programGroups = [...byProgram.values()];

  const nothing = planFailures.length === 0 && programGroups.length === 0 && standalone.length === 0;

  return (
    <main className="p-6 flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold mb-2">Failed builds</h1>
        <p className="text-sm text-gray-600 max-w-3xl">
          Builds that never completed — a <code>failed</code> <code>CourseRequest</code> (worker
          deadline, aborted remediation, a flaky model/fetch) or a Program whose plan pass failed.
          These are <strong>terminal</strong>: nothing retries them automatically (
          <code>reclaimStale</code> only bounces <code>running</code> rows). Triage them here.
        </p>
      </section>

      {nothing && <p className="text-sm text-gray-600">No failed builds. 🎉</p>}

      {planFailures.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Plan-pass failures</h2>
          <ul className="flex flex-col gap-3">
            {planFailures.map((p) => (
              <li key={p.id} className="border rounded p-4 text-sm flex flex-col gap-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <Link href={`/playground/programs/${p.id}`} className="font-medium underline">
                    {p.title ?? p.goal}
                  </Link>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${PROGRAM_STATUS_STYLE.failed}`}>
                    failed
                  </span>
                  <span className="font-mono text-xs text-gray-400 ml-auto">{fmtWhen(p.updatedAt)}</span>
                </div>
                <p className="font-mono text-xs text-red-900/80 break-all">
                  {p.error ?? '(no error message recorded)'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {programGroups.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Failed builds by program</h2>
          <ul className="flex flex-col gap-4">
            {programGroups.map(({ program, requests }) => (
              <li key={program.id} className="border rounded p-4 text-sm flex flex-col gap-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <Link href={`/playground/programs/${program.id}`} className="font-medium underline">
                    {program.title ?? program.goal}
                  </Link>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      PROGRAM_STATUS_STYLE[program.status as keyof typeof PROGRAM_STATUS_STYLE] ??
                      'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {program.status}
                  </span>
                  <span className="text-xs text-gray-500 ml-auto">
                    {requests.length} failed {requests.length === 1 ? 'build' : 'builds'}
                  </span>
                </div>
                <ul className="flex flex-col gap-2">
                  {requests.map((r) => (
                    <RequestRow key={r.id} r={r} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {standalone.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-gray-700">Standalone builds</h2>
          <ul className="flex flex-col gap-4">
            {standalone.map((r) => (
              <li key={r.id} className="border rounded p-4">
                <ul>
                  <RequestRow r={r} />
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
