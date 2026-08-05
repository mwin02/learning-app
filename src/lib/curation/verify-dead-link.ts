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
// Guards mirror evict-low-trust.ts: only `active` rows are probed (so a second
// report on an already-deprecated row costs no network call — idempotent, and it
// auto-resolves, see `already_deprecated`), `origin='generated'` rows never are
// (authored on-ramps have no external URL to be dead), and a concurrent reject
// surfacing as `raced` is logged, not thrown.
//
// Runs synchronously inside the report request. Rejected alternatives: voiding
// the promise (unsound on Cloud Run with min-instances=0 — the instance can be
// frozen the moment the response is written) and a queue hop (a whole job type
// for one HTTP call). See docs/resource-reports-plan.md § R2.

import type { ReportState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { checkLiveness, type LivenessVerdict } from '@/lib/agents/validation/validators/liveness';
import { log, logError } from '@/lib/log';

export type LivenessCheck = (url: string) => Promise<LivenessVerdict>;

export type DeadLinkOutcome =
  // Authoritatively dead and hard-deprecated. The only outcome that acted.
  | 'confirmed_dead'
  // The row was already out of `active` when the report arrived: the defect is
  // settled, so the report is auto-resolved rather than left open. A state we
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
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { status: true, origin: true, url: true, deprecationSeverity: true },
  });
  if (!resource) {
    log('report.dead-link-skipped', { resourceId, reason: 'not-found' });
    return OPEN;
  }

  // Already out of `active`: the defect this report names is settled, so resolve
  // it instead of leaving it open. R1's reopen rule (a re-report clears
  // `resolution` and flips back to `open`) is right in general — a re-report is
  // evidence the fix didn't take — but it fires on the upsert, before anyone has
  // looked at the row. Here we can see that the fix demonstrably DID take, and
  // this runs after, so it gets the last word. Without this, every learner who
  // re-reports an already-killed link mints a contextless open row in R4's queue.
  if (resource.status !== 'active') {
    const resolution = `resource already deprecated (${resource.deprecationSeverity ?? 'unspecified'} severity)`;
    await resolve(reportId, resolution);
    log('report.dead-link-already-deprecated', {
      resourceId,
      reportId,
      severity: resource.deprecationSeverity,
    });
    return { outcome: 'already_deprecated', detail: resolution, state: 'auto_resolved' };
  }

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

  const result = await applyPendingReview({
    action: 'reject',
    resourceId,
    severity: 'hard',
    cascade: false,
  });
  if (result.kind !== 'rejected') {
    // A concurrent decision won, or the row left the reviewable state under us.
    // The resource is no longer ours to deprecate — record what the probe saw and
    // hand the report to the operator rather than throwing away a real signal.
    await stamp(reportId, verdict.reason);
    log('report.dead-link-reject-skipped', { resourceId, reportId, result: result.kind });
    return { outcome: 'inconclusive', detail: verdict.reason, state: 'open' };
  }

  await resolve(reportId, verdict.reason);
  log('report.dead-link-confirmed', {
    resourceId,
    reportId,
    reason: verdict.reason,
    conceptLinksRemoved: result.conceptLinksRemoved,
    pathsRecomputed: result.pathsRecomputed,
    pathsRegressed: result.pathsRegressed,
  });
  return { outcome: 'confirmed_dead', detail: verdict.reason, state: 'auto_resolved' };
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
