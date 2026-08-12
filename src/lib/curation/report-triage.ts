// Reports R4: the operator triage queue — the shared logic behind
// GET/POST /api/playground/reports and /playground/reports, so a curator and an
// autonomous reviewer act on the same queue through the same code (the
// pending-review.ts pattern).
//
// This module adds NO remediation of its own. Every action routes a learner's
// report to machinery that already exists and is already tested:
//
//   deprecate_hard/soft → applyPendingReview (reject + severity)
//   unlink              → targeted ConceptResource delete + recomputeReadiness
//   refile              → refileToTopic (→ setPrimaryTopic, the one write seam)
//   edit                → updateResource (whitelisted fields, surfaces embeddingStale)
//   dismiss             → report state only
//
// The routing IS the design decision: three defects, three remediation axes.
// `wrong_lesson_fit` in particular must NEVER deprecate — the resource is fine,
// its PLACEMENT is wrong, which is why the report carries a lessonId. See
// report-triage-view.ts for which actions each category offers.

import { BankStaleReason } from '@prisma/client';
import type {
  DeprecationSeverity,
  ReportCategory,
  ReportState,
  ResourceStatus,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { refileToTopic } from '@/lib/curation/refile-topic';
import { updateResource, type ResourceUpdateFields } from '@/lib/curation/update-resource';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import { markBankStale } from '@/lib/agents/content/mark-bank-stale';
import { DB_WRITE_TX_TIMEOUT_MS } from '@/lib/config';
import { log, logWarn } from '@/lib/log';

// ── read side ────────────────────────────────────────────────────────────────

// Audit 7.2: every playground read is row-capped. Reports are rare and deliberate,
// so 500 open rows is a queue nobody is draining, not a paging problem.
export const REPORT_ROW_CAP = 500;

export type TriageReportRow = {
  id: string;
  userId: string;
  resourceId: string;
  category: ReportCategory;
  note: string | null;
  // R2's probe verdict when it had one (heuristic dead-link opinion). Read-only here.
  resolution: string | null;
  // The settled resolution this row carried before a learner re-reported it (F1b).
  // Shown to the operator: a re-report of something already "fixed" is the signal
  // that the fix did not take.
  priorResolution: string | null;
  lessonId: string | null;
  createdAt: Date;
};

// One actionable placement per distinct reported lesson (F3c). `unlink` acts on a
// single lesson's concept links, so the operator has to be able to pick WHICH
// reported lesson — acting on the group's oldest report silently unlinked one
// lesson and closed the reports about the others. `reportId` is the oldest report
// carrying that lesson, so the null bucket (a report whose Track was regenerated
// out from under it, SetNull) can never hide the reports that still have context.
export type LessonTarget = {
  lessonId: string | null;
  reportId: string;
  reports: number;
};

export type TriageCategoryGroup = {
  category: ReportCategory;
  // Distinct reporters. Guaranteed by @@unique([userId, resourceId, category]):
  // two open rows sharing a (resourceId, category) cannot share a userId, so the
  // row count IS the distinct-reporter count — no DISTINCT needed anywhere.
  reporters: number;
  oldestAt: Date;
  reports: TriageReportRow[];
  lessonTargets: LessonTarget[];
};

export type TriageGroup = {
  resourceId: string;
  // Distinct reporters across ALL categories — one person reporting two defects
  // on the same row is one reporter, not two.
  reporters: number;
  oldestAt: Date;
  lessonIds: string[];
  categories: TriageCategoryGroup[];
};

// Pure so the grouping and the ranking are unit-testable without a DB. Ranked by
// distinct reporters desc, then age asc: a defect five people hit outranks one
// person's, and among equals the one that has been rotting longest goes first.
// The same order applies within a resource's categories.
export function groupReports(rows: TriageReportRow[]): TriageGroup[] {
  const byResource = new Map<string, Map<ReportCategory, TriageReportRow[]>>();
  for (const row of rows) {
    const categories = byResource.get(row.resourceId) ?? new Map();
    byResource.set(row.resourceId, categories);
    categories.set(row.category, [...(categories.get(row.category) ?? []), row]);
  }

  const groups = [...byResource].map(([resourceId, categories]) => {
    const all = [...categories.values()].flat();
    return {
      resourceId,
      reporters: new Set(all.map((r) => r.userId)).size,
      oldestAt: oldest(all),
      lessonIds: [...new Set(all.map((r) => r.lessonId).filter(isString))],
      categories: rank(
        [...categories].map(([category, reports]) => ({
          category,
          reporters: reports.length,
          oldestAt: oldest(reports),
          reports: [...reports].sort(byAge),
          lessonTargets: lessonTargets(reports),
        })),
      ),
    };
  });
  return rank(groups);
}

// Pure. Lesson-bearing targets first (oldest lesson first), the contextless
// bucket last if it exists — it is the only one `unlink` cannot act on, so it
// must never be what the UI offers first.
export function lessonTargets(reports: TriageReportRow[]): LessonTarget[] {
  const byLesson = new Map<string | null, TriageReportRow[]>();
  for (const r of reports) byLesson.set(r.lessonId, [...(byLesson.get(r.lessonId) ?? []), r]);

  return [...byLesson]
    .map(([lessonId, rows]) => ({
      lessonId,
      reportId: [...rows].sort(byAge)[0].id,
      reports: rows.length,
      oldestAt: oldest(rows),
    }))
    .sort(
      (a, b) =>
        Number(a.lessonId === null) - Number(b.lessonId === null) ||
        a.oldestAt.getTime() - b.oldestAt.getTime(),
    )
    .map(({ lessonId, reportId, reports }) => ({ lessonId, reportId, reports }));
}

function isString(value: string | null): value is string {
  return value !== null;
}

function oldest(rows: { createdAt: Date }[]): Date {
  return rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0].createdAt);
}

function byAge(a: { createdAt: Date }, b: { createdAt: Date }): number {
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function rank<T extends { reporters: number; oldestAt: Date }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => b.reporters - a.reporters || a.oldestAt.getTime() - b.oldestAt.getTime(),
  );
}

export type TriageItem = TriageGroup & {
  resource: {
    title: string;
    url: string;
    topic: string;
    origin: string;
    status: ResourceStatus;
    trustScore: number;
    deprecationSeverity: DeprecationSeverity | null;
    // The current value the `paywalled` edit toggles. Read so the operator's
    // checkbox starts from reality — see triage-actions.tsx on why a boolean
    // field cannot use the empty-string "untouched" sentinel the others do.
    requiresPurchase: boolean;
  } | null;
  lessons: { id: string; title: string; trackTitle: string | null }[];
  // Reports R2 already settled on this resource without a human. Shown as context
  // only — this block never reopens or rewrites an auto_resolved row (see the
  // module header of verify-dead-link.ts: that record is the audit trail of what
  // the probe did, and a closed accurate report is not queue work).
  autoResolved: number;
};

export async function listReportTriage(
  limit = REPORT_ROW_CAP,
): Promise<{ items: TriageItem[]; truncated: boolean }> {
  const rows = await prisma.resourceReport.findMany({
    where: { state: 'open' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      resourceId: true,
      category: true,
      note: true,
      resolution: true,
      priorResolution: true,
      lessonId: true,
      createdAt: true,
    },
  });

  const groups = groupReports(rows);
  const resourceIds = groups.map((g) => g.resourceId);
  const lessonIds = [...new Set(groups.flatMap((g) => g.lessonIds))];

  const [resources, lessons, autoResolved] = await Promise.all([
    prisma.resource.findMany({
      where: { id: { in: resourceIds } },
      select: {
        id: true,
        title: true,
        url: true,
        topic: true,
        origin: true,
        status: true,
        trustScore: true,
        deprecationSeverity: true,
        requiresPurchase: true,
      },
    }),
    prisma.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: { id: true, title: true, track: { select: { title: true } } },
    }),
    prisma.resourceReport.groupBy({
      by: ['resourceId'],
      where: { resourceId: { in: resourceIds }, state: 'auto_resolved' },
      _count: { _all: true },
    }),
  ]);

  const resourceById = new Map(resources.map(({ id, ...rest }) => [id, rest]));
  const lessonById = new Map(
    lessons.map((l) => [l.id, { id: l.id, title: l.title, trackTitle: l.track.title }]),
  );
  const autoById = new Map(autoResolved.map((a) => [a.resourceId, a._count._all]));

  return {
    items: groups.map((g) => ({
      ...g,
      resource: resourceById.get(g.resourceId) ?? null,
      lessons: g.lessonIds.map((id) => lessonById.get(id)).filter(isLesson),
      autoResolved: autoById.get(g.resourceId) ?? 0,
    })),
    truncated: rows.length === limit,
  };
}

function isLesson(l: TriageItem['lessons'][number] | undefined): l is TriageItem['lessons'][number] {
  return l !== undefined;
}

// ── write side ───────────────────────────────────────────────────────────────

export type ResolveInput = {
  reportId: string;
  // Five people reporting one dead link is one defect: by default the same action
  // closes every other OPEN report on this resource+category. Off when the
  // operator judged this reporter's row individually (a note that doesn't
  // generalize).
  resolveSiblings: boolean;
  note?: string;
} & (
  | { action: 'deprecate_hard' | 'deprecate_soft' | 'unlink' | 'dismiss' }
  | { action: 'refile'; topic: string }
  | { action: 'edit'; fields: ResourceUpdateFields }
);

export type TriageAction = ResolveInput['action'];

export type ResolveResult =
  | { kind: 'not_found' }
  | { kind: 'not_open'; state: ReportState }
  // The delegated machinery declined (a raced deprecation, a vanished lesson, a
  // report with no placement context). Nothing was written; the report stays open.
  | { kind: 'refused'; reason: string }
  | {
      kind: 'resolved';
      reportId: string;
      action: TriageAction;
      state: ReportState;
      resolution: string;
      alsoResolved: number;
    };

// What the delegate did, in operator-readable words, or why it wouldn't.
type Delegated = { outcome: string } | { refused: string };

// `resolution` carries BOTH R2's machine verdict and the operator's outcome, and
// they coexist by composition rather than by a second column: the operator's
// outcome leads (it is what happened), the probe's opinion is preserved behind a
// `probe:` marker (only R2 writes `resolution` on an open report, so an existing
// value is always the machine's). Keeping it means the row still explains why a
// human overrode "url is reachable" — the khanacademy soft-404 case this whole
// feature exists for. Pure, so the composition rule is pinned by a test.
export function composeResolution(
  outcome: string,
  opts: { note?: string; prior?: string | null } = {},
): string {
  const parts = [outcome];
  const note = opts.note?.trim();
  const prior = opts.prior?.trim();
  if (note) parts.push(note);
  if (prior) parts.push(`probe: ${prior}`);
  return parts.join(' · ');
}

export async function resolveReport(input: ResolveInput): Promise<ResolveResult> {
  const report = await prisma.resourceReport.findUnique({
    where: { id: input.reportId },
    select: { resourceId: true, category: true, lessonId: true, state: true, resolution: true },
  });
  if (!report) return { kind: 'not_found' };
  if (report.state !== 'open') return { kind: 'not_open', state: report.state };

  const delegated = await delegate(input, report.resourceId, report.lessonId);
  if ('refused' in delegated) {
    logWarn('report-triage.refused', {
      reportId: input.reportId,
      action: input.action,
      reason: delegated.refused,
    });
    return { kind: 'refused', reason: delegated.refused };
  }

  // dismiss is the one action that judged the report rather than the resource, so
  // it is the one that lands in `dismissed` instead of `resolved`.
  const state: ReportState = input.action === 'dismiss' ? 'dismissed' : 'resolved';
  const resolvedAt = new Date();
  const resolution = composeResolution(delegated.outcome, {
    note: input.note,
    prior: report.resolution,
  });
  await prisma.resourceReport.update({
    where: { id: input.reportId },
    data: { state, resolution, resolvedAt },
  });

  let alsoResolved = 0;
  if (input.resolveSiblings) {
    // Siblings deliberately do NOT inherit this row's `probe:` clause — their own
    // stamped verdict is about the same URL but is their own record.
    //
    // `unlink` is the one action scoped narrower than (resource, category): it
    // removes THIS lesson's concept links and leaves every other placement
    // standing, so closing another lesson's report with it would describe a fix
    // that never touched that lesson (F3c). `lessonId: null` matches the
    // contextless bucket, which is the correct scope for a report with no
    // placement — never all of them.
    const { count } = await prisma.resourceReport.updateMany({
      where: {
        resourceId: report.resourceId,
        category: report.category,
        state: 'open',
        id: { not: input.reportId },
        ...(input.action === 'unlink' ? { lessonId: report.lessonId } : {}),
      },
      data: { state, resolution: composeResolution(delegated.outcome, { note: input.note }), resolvedAt },
    });
    alsoResolved = count;
  }

  log('report-triage.resolved', {
    reportId: input.reportId,
    resourceId: report.resourceId,
    category: report.category,
    action: input.action,
    alsoResolved,
  });
  return { kind: 'resolved', reportId: input.reportId, action: input.action, state, resolution, alsoResolved };
}

async function delegate(
  input: ResolveInput,
  resourceId: string,
  lessonId: string | null,
): Promise<Delegated> {
  switch (input.action) {
    case 'dismiss':
      return { outcome: 'dismissed — not a defect' };

    case 'deprecate_hard':
    case 'deprecate_soft': {
      const severity: DeprecationSeverity = input.action === 'deprecate_hard' ? 'hard' : 'soft';
      const result = await applyPendingReview({
        action: 'reject',
        resourceId,
        severity,
        cascade: false,
      });
      // A lost race means someone else deprecated this row between the read and
      // the conditional write — the operator's intent already holds, so the
      // report is settled, not refused. Only a row that is NOT deprecated after
      // a `raced` verdict is a genuine failure (F3d).
      if (result.kind === 'raced') return alreadyDeprecated(resourceId, severity);
      if (result.kind !== 'rejected') return { refused: `deprecation not applied (${result.kind})` };
      return {
        outcome: `deprecated (${severity}) — ${result.conceptLinksRemoved} candidate link(s) removed, ${result.pathsRegressed} map(s) → building`,
      };
    }

    case 'unlink':
      return unlinkFromLesson(resourceId, lessonId);

    case 'refile':
      return refile(resourceId, input.topic);

    case 'edit': {
      const result = await updateResource(resourceId, input.fields);
      if (result.kind === 'not_found') return { refused: 'resource no longer exists' };
      const stale = result.embeddingStale ? '; embedding stale' : '';
      const warning = result.warning ? ` — ${result.warning}` : '';
      return { outcome: `edited ${result.changed.join(', ')}${stale}${warning}` };
    }
  }
}

async function alreadyDeprecated(
  resourceId: string,
  intended: DeprecationSeverity,
): Promise<Delegated> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { status: true, deprecationSeverity: true },
  });
  if (!resource) return { refused: 'resource no longer exists' };
  if (resource.status !== 'deprecated') {
    return { refused: `deprecation not applied (raced, status ${resource.status})` };
  }
  const severity = resource.deprecationSeverity ?? 'unspecified';
  const note = severity === intended ? '' : ` (asked for ${intended})`;
  return { outcome: `already deprecated (${severity}) — nothing to do${note}` };
}

// The refile axis. The canonicalize-and-check logic (F3b) moved to
// refile-topic.ts at Q9, when the pending-review queue became the second reviewer
// surface that can refile a row; this is the adapter into a report's outcome
// vocabulary.
async function refile(resourceId: string, input: string): Promise<Delegated> {
  const result = await refileToTopic(resourceId, input);
  return result.kind === 'refiled'
    ? { outcome: `refiled to topic "${result.topic}"` }
    : { refused: result.reason };
}

// The `wrong_lesson_fit` axis: drop this resource from the concepts THIS lesson
// teaches, and nothing else. A Lesson's `conceptsTaught` holds Concept slugs, and
// its Track hangs off the living Path, so the mis-attachment is exactly the
// ConceptResource rows joining those slugs to this resource.
//
// Follows dropCandidateLinks (pending-review.ts) rather than reusing it, because
// that helper is subtree-wide by resource and this is deliberately narrow: the
// resource stays active and stays linked everywhere it fits. Same three duties —
// flag reviewed banks stale, delete, recompute the Path's readiness — in one
// transaction so a map's status never disagrees with its candidate rows.
//
// Built Tracks are NOT touched (immutability, see schema.prisma). The learner who
// reported it still sees the resource in their lesson; regeneration (R5–R7) is
// the escape hatch. Only future builds are corrected.
async function unlinkFromLesson(resourceId: string, lessonId: string | null): Promise<Delegated> {
  if (!lessonId) return { refused: 'this report carries no lesson context — nothing to unlink from' };

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: { conceptsTaught: true, track: { select: { pathId: true } } },
  });
  if (!lesson) return { refused: 'the reported lesson no longer exists' };
  const pathId = lesson.track.pathId;

  const links = await prisma.conceptResource.findMany({
    where: { resourceId, concept: { pathId, slug: { in: lesson.conceptsTaught } } },
    select: { conceptId: true, role: true },
  });
  // Idempotent, like map-edit's detach: already gone is a resolved report, not an error.
  if (links.length === 0) return { outcome: 'no candidate link to remove — already unlinked' };

  const conceptIds = links.map((l) => l.conceptId);
  const { status } = await prisma.$transaction(
    async (tx) => {
      const primary = [...new Set(links.filter((l) => l.role === 'teaches').map((l) => l.conceptId))];
      const removed = [...new Set(links.filter((l) => l.role !== 'teaches').map((l) => l.conceptId))];
      await markBankStale(tx, removed, BankStaleReason.resource_removed);
      await markBankStale(tx, primary, BankStaleReason.primary_changed);
      await tx.conceptResource.deleteMany({ where: { resourceId, conceptId: { in: conceptIds } } });
      return recomputeReadiness(pathId, tx);
    },
    { timeout: DB_WRITE_TX_TIMEOUT_MS },
  );

  return { outcome: `unlinked from ${links.length} concept(s) — map ${pathId} → ${status}` };
}
