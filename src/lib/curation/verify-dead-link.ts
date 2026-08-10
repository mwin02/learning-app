// Reports R2: auto-verification of a learner's dead_link report.
//
// The one report category a machine can settle on its own, because
// `checkLiveness` IS the predicate the pipeline already trusts — same 6s bound,
// same browser UA, same AUTHORITATIVE/HEURISTIC split. Reusing it means the
// auto-action and the sourcing pipeline can never disagree about what "dead"
// means. Everything else stays human-triaged (R4).
//
// The three branches, and why they differ:
//
//   authoritative failure (404/410, malformed url, YouTube oEmbed miss)
//     → hard reject. The server stated it; a human adds nothing. `hard` (not
//       `soft`) because this is a broken thing, not a disliked one — it is the
//       flag a future Track-patching layer reads to know in-flight learners are
//       pointing at something genuinely gone. First user-facing writer of that
//       distinction.
//   heuristic failure (suspicious title, redirect into an error path, unreachable)
//     → stays open, verdict stamped into `resolution`. The 2026-08-03 sweep
//       showed 10 of these flip to alive on a re-run; deprecating on one would
//       delete live resources.
//   alive
//     → stays open. NOT a false report: this is the khanacademy.org soft-404
//       class liveness.ts's own header admits it structurally cannot see (a
//       client-rendered shell byte-identical for a live and a removed page).
//       The learner IS a real browser render, so here the human outranks the
//       machine and the report goes to the operator queue unchallenged.
//
// `cascade: false` deliberately: a dead link on one child of a container says
// nothing about its siblings — each child is a separate URL with a separate fate.
//
// Which rows are probed is a question about SETTLEDNESS, not about `status`
// (F1c). Only `deprecated` + `hard` is a settled dead-link defect: someone has
// already recorded this exact verdict, so a second report costs no network call
// and auto-resolves (`already_deprecated`). The other two non-`active` states are
// not settled and are probed:
//
//   deprecated + soft (or unrecorded severity) — evict-low-trust.ts deprecates
//     with `soft` for being DISLIKED, which says nothing about liveness. A
//     genuinely dead row stuck at `soft` never reaches the flag a Track-patching
//     layer reads, and Tracks are immutable, so in-flight learners keep seeing it.
//     An authoritative verdict escalates it to `hard` in place.
//   pending_review — still selectable (search-resources.ts's DEFAULT_STATUSES)
//     and still sitting in persisted Paths. Closing it with "already deprecated"
//     would be false, and would keep a dead row's chance of being approved.
//
// `origin='generated'` rows are never probed (authored on-ramps have no external
// URL to be dead), and a concurrent reject surfacing as `raced` is logged, not
// thrown — but not left open: see the re-read at the reject site (F1d).
//
// Runs synchronously inside the report request. Rejected alternatives: voiding
// the promise (unsound on Cloud Run with min-instances=0 — the instance can be
// frozen the moment the response is written) and a queue hop (a whole job type
// for one HTTP call). See resource-reports.md § R2.

import type { Prisma, ReportState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { checkLiveness, type LivenessVerdict } from '@/lib/agents/validation/validators/liveness';
import { log, logError } from '@/lib/log';

export type LivenessCheck = (url: string) => Promise<LivenessVerdict>;

export type DeadLinkOutcome =
  // Authoritatively dead and hard-deprecated. The only outcome that acted.
  | 'confirmed_dead'
  // The row was already hard-deprecated when the report arrived, or another
  // request settled it mid-probe: the defect is recorded, so the report is
  // auto-resolved rather than left open. A state we
  // KNOW, unlike the guesses above it — R3 can tell the learner the resource is
  // already gone, and R4 never sees a contextless duplicate.
  | 'already_deprecated'
  // Probe suspects death but isn't sure — left for the operator.
  | 'inconclusive'
  // Probe says the URL resolves; the learner's report stands anyway.
  | 'appears_live'
  // Not probed, and nothing we can conclude: an authored `generated` row (no
  // external URL to be dead — a genuine oddity worth a human's eye), a row that
  // vanished between the route's lookup and here, or a probe that failed
  // outright. All leave the report open, meaning "recorded, a human will look".
  | 'skipped';

// R3's contract. `detail` is the liveness reason (the same string the operator
// sees in `resolution`); `state` is the report's state AFTER the probe, since a
// confirmed kill flips it out from under the route's upsert result.
export type DeadLinkProbe = {
  outcome: DeadLinkOutcome;
  detail?: string;
  state: ReportState;
};

const OPEN: DeadLinkProbe = { outcome: 'skipped', state: 'open' };

export async function verifyDeadLink(args: {
  resourceId: string;
  reportId: string;
  check?: LivenessCheck;
}): Promise<DeadLinkProbe> {
  // A network probe must never be able to 500 a report that is already durably
  // recorded. Every failure below degrades to "recorded, unverified" — the same
  // thing the learner sees for every other category — and is logged loudly so
  // the silence isn't total.
  try {
    return await probe(args);
  } catch (err) {
    logError('report.dead-link-probe-failed', {
      resourceId: args.resourceId,
      reportId: args.reportId,
      err,
    });
    return OPEN;
  }
}

async function probe({
  resourceId,
  reportId,
  check = checkLiveness,
}: {
  resourceId: string;
  reportId: string;
  check?: LivenessCheck;
}): Promise<DeadLinkProbe> {
  const resource = await loadResource(resourceId);
  if (!resource) {
    log('report.dead-link-skipped', { resourceId, reason: 'not-found' });
    return OPEN;
  }

  // The defect this report names is already settled, so resolve it instead of
  // leaving it open. R1's reopen rule (a re-report clears `resolution` and flips
  // back to `open`) is right in general — a re-report is evidence the fix didn't
  // take — but it fires on the upsert, before anyone has looked at the row. Here
  // we can see that the fix demonstrably DID take, and this runs after, so it gets
  // the last word. Without this, every learner who re-reports an already-killed
  // link mints a contextless open row in R4's queue.
  if (isSettledDead(resource)) return alreadyDeprecated(resourceId, reportId, resource);

  // An authored on-ramp has no external URL to be dead, so there is nothing to
  // probe and nothing to conclude — a dead-link report against one is an oddity
  // a human should see, not something to auto-resolve.
  if (resource.origin === 'generated') {
    log('report.dead-link-skipped', { resourceId, reason: 'generated' });
    return OPEN;
  }

  const verdict = await check(resource.url);
  if (verdict.alive) {
    log('report.dead-link-alive', { resourceId, reportId });
    return { outcome: 'appears_live', state: 'open' };
  }

  if (verdict.quarantine) {
    await stamp(reportId, verdict.reason);
    log('report.dead-link-inconclusive', { resourceId, reportId, reason: verdict.reason });
    return { outcome: 'inconclusive', detail: verdict.reason, state: 'open' };
  }

  return resource.status === 'deprecated'
    ? escalateToHard(resourceId, reportId, verdict.reason)
    : rejectAsDead(resourceId, reportId, verdict.reason);
}

const RESOURCE_SELECT = {
  status: true,
  origin: true,
  url: true,
  deprecationSeverity: true,
} as const;

type ResourceRow = Prisma.ResourceGetPayload<{ select: typeof RESOURCE_SELECT }>;

function loadResource(resourceId: string): Promise<ResourceRow | null> {
  return prisma.resource.findUnique({ where: { id: resourceId }, select: RESOURCE_SELECT });
}

// The one settled shape. An unrecorded severity is treated as unsettled on
// purpose: nothing asserts the row is dead, so it is worth a probe, and the probe
// can supply the `hard` the row is missing.
function isSettledDead(resource: ResourceRow): boolean {
  return resource.status === 'deprecated' && resource.deprecationSeverity === 'hard';
}

async function alreadyDeprecated(
  resourceId: string,
  reportId: string,
  resource: ResourceRow
): Promise<DeadLinkProbe> {
  const resolution = `resource already deprecated (${resource.deprecationSeverity ?? 'unspecified'} severity)`;
  await resolve(reportId, resolution);
  log('report.dead-link-already-deprecated', {
    resourceId,
    reportId,
    severity: resource.deprecationSeverity,
  });
  return { outcome: 'already_deprecated', detail: resolution, state: 'auto_resolved' };
}

// An authoritatively dead row that is already deprecated at a lower severity
// (F1c). applyPendingReview can't reach it — its reject matches only
// `pending_review`/`active` rows — and it doesn't need to: the candidate links
// were dropped and readiness recomputed when the row was first deprecated, so
// what is missing is only the `hard` flag itself.
async function escalateToHard(
  resourceId: string,
  reportId: string,
  reason: string
): Promise<DeadLinkProbe> {
  const { count } = await prisma.resource.updateMany({
    // Spelled as an explicit OR rather than `{ not: 'hard' }`, which compiles to a
    // plain SQL inequality and is therefore NULL — not true — for a NULL severity.
    // NULL is the case that matters most: the column arrived with no backfill
    // (20260606000000_resource_deprecation_severity), so every pre-June deprecation
    // still carries NULL, and those are exactly the rows nobody has ever recorded a
    // liveness verdict on.
    where: {
      id: resourceId,
      status: 'deprecated',
      OR: [{ deprecationSeverity: 'soft' }, { deprecationSeverity: null }],
    },
    data: { deprecationSeverity: 'hard' },
  });
  if (count === 0) return settledUnderUs(resourceId, reportId, reason);

  await resolve(reportId, reason);
  log('report.dead-link-escalated', { resourceId, reportId, reason });
  return { outcome: 'confirmed_dead', detail: reason, state: 'auto_resolved' };
}

async function rejectAsDead(
  resourceId: string,
  reportId: string,
  reason: string
): Promise<DeadLinkProbe> {
  const result = await applyPendingReview({
    action: 'reject',
    resourceId,
    severity: 'hard',
    cascade: false,
  });
  if (result.kind !== 'rejected') {
    log('report.dead-link-reject-skipped', { resourceId, reportId, result: result.kind });
    return settledUnderUs(resourceId, reportId, reason);
  }

  await resolve(reportId, reason);
  log('report.dead-link-confirmed', {
    resourceId,
    reportId,
    reason,
    conceptLinksRemoved: result.conceptLinksRemoved,
    pathsRecomputed: result.pathsRecomputed,
    pathsRegressed: result.pathsRegressed,
  });
  return { outcome: 'confirmed_dead', detail: reason, state: 'auto_resolved' };
}

// A write we expected to win didn't (F1d). `raced` alone can't tell us whether
// another request just settled this row or whether it slipped out of a reviewable
// state for some other reason, and guessing "inconclusive" produces the exact
// outcome the already-deprecated branch exists to prevent: two learners on the
// same 404 inside the probe's 6s window get contradictory copy, and R4 inherits an
// open report on a settled resource. So re-read and let the row answer.
async function settledUnderUs(
  resourceId: string,
  reportId: string,
  reason: string
): Promise<DeadLinkProbe> {
  const current = await loadResource(resourceId);
  if (current && current.status === 'deprecated') {
    return alreadyDeprecated(resourceId, reportId, current);
  }
  // Still reviewable, or gone: the resource is not ours to deprecate, but the
  // probe saw something real — record it and hand the report to the operator.
  await stamp(reportId, reason);
  log('report.dead-link-unsettled', { resourceId, reportId, status: current?.status ?? null });
  return { outcome: 'inconclusive', detail: reason, state: 'open' };
}

// The verdict is written even when nothing was acted on, so R4's operator opens
// the report already knowing what the machine thought of the URL.
async function stamp(reportId: string, reason: string): Promise<void> {
  await prisma.resourceReport.update({ where: { id: reportId }, data: { resolution: reason } });
}

// Close the report without a human: either the probe just killed the resource,
// or it was already dead. Both leave an operator nothing to do.
async function resolve(reportId: string, resolution: string): Promise<void> {
  await prisma.resourceReport.update({
    where: { id: reportId },
    data: { state: 'auto_resolved', resolution, resolvedAt: new Date() },
  });
}
