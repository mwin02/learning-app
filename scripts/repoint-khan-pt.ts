// The last repair in `resource-standard.md`'s sweep, and the only one that changes what a
// row POINTS AT.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/repoint-khan-pt.ts
//   … scripts/repoint-khan-pt.ts --apply --target-host=<hostname>
//
// DRY RUN IS THE DEFAULT AND THERE IS NO `--yes`, same as `sweep-serveability.ts`, from
// which this driver also inherits `requireTargetAck` and the rule that matters most:
//
// THE POPULATION IS WHATEVER THE CLASSIFIER SAYS. Not one resource id is written down here.
// A `/pt/` row is `isKhanUrl(url) && urlKind(url) === 'pt'` via the shipped classifier, and
// the sweep skips exactly that set so the two drivers partition the library between them.
//
// ── WHAT A `/pt/` PAGE IS, AND WHY IT IS REPOINTED RATHER THAN DEPRECATED ──────────────────
//
// A Khan "project task" is a 2–6 minute teaching video followed by an in-browser challenge.
// The challenge half fails clause 5 (consumed, not performed) and the video half is an
// ordinary lesson — so deprecating the row throws away real teaching, and ten of these rows
// are attached to live SQL concepts. Repointing the row at the video keeps the lesson and
// leaves the challenge behind: `url` moves to the YouTube watch URL, `type` becomes `video`,
// and `durationMin` becomes the provider's own number for that clip, stamped `api`.
//
// A `/pt/` row whose video does NOT resolve is deprecated `soft` through the reject seam
// instead — the plan's resolved open question. Non-resolution is an outcome this driver
// reports, not an error: it is exactly what the plan's `NEEDS VERIFICATION` asked to measure.
//
// ── WHY THIS WRITES `url` DIRECTLY INSTEAD OF GOING THROUGH `updateResource` ───────────────
//
// `ResourceUpdateFields` whitelists durationMin/title/summary/difficulty/requiresPurchase
// and (since S6) `type`. `url` is deliberately absent: it is the row's IDENTITY — the unique
// column every dedup path collapses onto — and S6 did not change that. Nothing in this block
// is a reason to widen an edit whitelist for a one-shot repair, so the repoint is a direct
// `prisma.resource.update` and this comment is the justification the plan asked for.
// A second reason it could not have gone through that seam anyway: `updateResource` derives
// `durationSource: 'reviewer'` from any supplied `durationMin` (it has two reviewer-facing
// callers), and a number read off the YouTube Data API is `api`. Asserting `reviewer` here
// would poison the one provenance tier no automated pass may overwrite.
//
// ⚠️ AND THE PROPERTY THE DIRECT WRITE EXISTS TO PRESERVE: a field update does NOT touch
// `ConceptResource`. That is the opposite of `applyPendingReview`, which drops the links on
// purpose, and it is the whole point of this block — the ten attached lessons must survive
// the repoint. Nothing below may route a repoint through a seam that cleans up links.
//
// ── THE URL COLLISION ─────────────────────────────────────────────────────────────────────
//
// `Resource.url` is `@unique`, so a `/pt/` row whose video is ALREADY in the library as its
// own row cannot be repointed onto it. Checked BEFORE writing rather than by catching a
// constraint error — a caught 23505 tells you a row exists but not which one, and a failed
// write inside a loop leaves the operator guessing which half of the run applied. Such a row
// takes the deprecate branch: the lesson is not lost, it is already filed.
//
// ⚠️ AND THAT LAST CLAUSE IS ONLY TRUE OF AN INCUMBENT THAT CAN STILL BE SERVED, which is
// why the holder lookup is filtered to the actionable statuses (`active`, `pending_review` —
// the same window `sweep-serveability.ts` writes within). A DEPRECATED row at the target URL
// is not "already filed": deprecating the `/pt/` row against it would retire the second copy
// of a lesson whose first copy is already retired, drop the concept links of a row this block
// exists to keep attached, and leave the video unservable from both rows. Ten attached SQL
// lessons are one furniture sweep away from that, so it is a real path, not a hypothetical.
//
// ── THE RETIRED INCUMBENT IS A THIRD STATE, AND IT IS AN ESCALATION ───────────────────────
//
// Filtering the lookup does not make the repoint possible: the unique constraint is
// unconditional and does not care that the incumbent is deprecated. So such a row can neither
// be repointed nor honestly deprecated, and the driver refuses BOTH and prints it loudly —
// the shape `sweep-serveability.ts` already uses for a row whose two re-type findings name
// different targets. The rule both share: WHEN THE RIGHT ANSWER NEEDS A JUDGMENT THE DRIVER
// CANNOT MAKE, REFUSE AND PRINT — never fall through to the destructive option.
//
// The judgment being deferred is real and is nobody's here: reviving the incumbent (why was
// it retired? a dead link, or a decision this row does not overturn?), or retiring the `/pt/`
// row and accepting the hole, or merging the two — none of which is "repoint at a video".
// Escalating touches nothing, so both rows stay exactly as recoverable as they were, and the
// `/pt/` row keeps teaching in the meantime. It is counted in the totals like every other
// outcome and it is excluded from the `--apply` loop, so it cannot be actioned by accident.
//
// ── EVIDENCE, AND WHY A FRESH CLONE CANNOT REPRODUCE THIS RUN ─────────────────────────────
//
// The video ids come from the probe artifacts in `docs/audits/khan-batch-*.json*`, read
// through `sweep-serveability.ts`'s own `readBatches` so both drivers resolve a re-probed
// resource identically. ⚠️ `docs/audits/` IS GIT-IGNORED: those 526 artifacts exist only on
// the machine that produced them, so this driver's inputs are not reproducible from a clone —
// a row is simply unresolvable where no artifact exists, which is a deprecation, so the
// missing evidence is conservative in the direction the standard's error budget dislikes.
// Re-probing before a re-run is the honest fix if that population ever grows.
//
// Idempotent by construction: a repointed row's URL is no longer a `/pt/` URL and a
// deprecated row is outside the actionable population, so a second run finds nothing.

import type { DecompositionStatus, ResourceStatus, ResourceType } from '@prisma/client';
import { isKhanUrl, urlKind } from '../src/lib/curation/serveability';
import type { ProbeEvidence } from '../src/lib/curation/serveability-probe';
import { secondsToMinutes } from '../src/lib/curation/duration-estimate';
import { applyPendingReview } from '../src/lib/curation/pending-review';
import { prisma } from '../src/lib/db';
import { youtubeDurations, loadCachedVideoDurations } from './apply-khan-durations';
import { readBatches } from './sweep-serveability';
import { requireTargetAck } from './target-guard';

// The form every other YouTube row in the library carries (`youtube-search.ts`,
// `decomposition/youtube.ts`), so a repointed row is indistinguishable from a natively
// sourced one — to the embed allowlist, to liveness checks, and to the dedup.
const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

// Rows this driver may write. A `deprecated` row has already been decided, and re-deciding
// it would let a re-run silently re-open a closed call.
const ACTIONABLE_STATUS: ResourceStatus[] = ['active', 'pending_review'];

const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be'];

type Row = {
  id: string;
  url: string;
  title: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number | null;
};

export type Outcome =
  | { action: 'repoint'; videoId: string; url: string; seconds: number; durationMin: number }
  // `unresolvable` and `collision` are both deprecations and are kept apart anyway: they are
  // different findings about the library, and the plan asks for the collision to be printed
  // as such rather than folded into "no video".
  | { action: 'deprecate'; reason: 'unresolvable' | 'collision'; detail: string }
  // Writes nothing, on purpose — see THE RETIRED INCUMBENT in the header.
  | { action: 'escalate'; reason: 'deprecated-incumbent'; detail: string }
  | { action: 'skip'; reason: 'already-decided' | 'not-atomic'; detail: string };

// A row already sitting on a candidate video URL. The STATUS travels with it because it is
// the whole question: an incumbent that can still be served makes the `/pt/` row redundant,
// and one that cannot makes it the last copy of the lesson.
export type Holder = { id: string; status: ResourceStatus };

export type Planned = { row: Row; attached: boolean; outcome: Outcome };

export function isProjectTask(url: string): boolean {
  return isKhanUrl(url) && urlKind(url) === 'pt';
}

/**
 * The one video a `/pt/` row may be repointed at. Exactly one id, for
 * `proposeKhanDuration`'s reason: a page carrying several is ambiguous about which one it
 * IS, and taking the first would be a guess wearing a measurement's stamp — here it would
 * additionally move the row onto the wrong lesson permanently. Measured over the artifacts,
 * every probed `/pt/` page reports exactly one.
 */
export function videoIdFor(probe: ProbeEvidence | null): { id: string } | { reason: string } {
  if (!probe) return { reason: 'no probe artifact for this row (never probed, or the probe failed)' };
  if (probe.blocked) return { reason: 'probe reported the page blocked/not-found' };
  if (probe.videoIds.length !== 1) {
    return { reason: `${probe.videoIds.length} youtube id(s) in the page, need exactly 1` };
  }
  return { id: probe.videoIds[0] };
}

/**
 * Pure. `holders` maps a video id to the EXISTING row already sitting on that URL, carrying
 * its status because a live incumbent and a retired one are opposite findings (header).
 * `claimed` maps a video id to the `/pt/` row earlier in this same run that will take it —
 * not optional: two `/pt/` rows embedding the same clip would otherwise both plan a repoint
 * and the second write would hit the unique constraint the first created. An in-run claim is
 * live by construction, which is why it carries no status.
 */
export function planFor(
  row: Row,
  probe: ProbeEvidence | null,
  durations: Map<string, number>,
  holders: Map<string, Holder>,
  claimed: Map<string, string>,
): Outcome {
  if (!ACTIONABLE_STATUS.includes(row.status)) {
    return { action: 'skip', reason: 'already-decided', detail: `status=${row.status}` };
  }
  // Both seams below require it: the reject seam refuses an unresolved row outright
  // (`blocked`), and repointing a container would move its children's parent out from under
  // them. No production `/pt/` row is anything but atomic; this declines rather than guesses
  // if one ever is.
  if (row.decompositionStatus !== 'atomic') {
    return { action: 'skip', reason: 'not-atomic', detail: `decompositionStatus=${row.decompositionStatus}` };
  }

  const resolved = videoIdFor(probe);
  if ('reason' in resolved) return { action: 'deprecate', reason: 'unresolvable', detail: resolved.reason };
  const { id: videoId } = resolved;

  const claimant = claimed.get(videoId);
  if (claimant !== undefined && claimant !== row.id) {
    return {
      action: 'deprecate',
      reason: 'collision',
      detail: `${watchUrl(videoId)} is claimed by resource ${claimant} earlier in this run — repointing would violate the unique-URL constraint`,
    };
  }

  const holder = holders.get(videoId);
  if (holder !== undefined && holder.id !== row.id) {
    // The status decides which of two opposite findings this is, and the branch below is the
    // one the header calls a third state: the URL is taken either way, but only a servable
    // incumbent makes the lesson safe to let go of.
    if (ACTIONABLE_STATUS.includes(holder.status)) {
      return {
        action: 'deprecate',
        reason: 'collision',
        detail: `${watchUrl(videoId)} is already resource ${holder.id} (${holder.status}) — repointing would violate the unique-URL constraint`,
      };
    }
    return {
      action: 'escalate',
      reason: 'deprecated-incumbent',
      detail:
        `${watchUrl(videoId)} is held by resource ${holder.id}, which is ${holder.status} — ` +
        'the URL is taken so the repoint is impossible, and the incumbent cannot serve the lesson ' +
        'either, so deprecating this row would retire the last copy. Revive the incumbent or decide by hand.',
    };
  }

  const seconds = durations.get(videoId);
  if (seconds === undefined) {
    return {
      action: 'deprecate',
      reason: 'unresolvable',
      detail: `videoId ${videoId} unresolved by the cached index and the Data API`,
    };
  }

  return { action: 'repoint', videoId, url: watchUrl(videoId), seconds, durationMin: secondsToMinutes(seconds) };
}

// Cache first (zero quota, zero network), Data API for the rest — the same two-tier lookup
// `apply-khan-durations.ts` performs, imported from it rather than restated so there is one
// description of how a Khan video id becomes a number.
export async function resolveDurations(videoIds: string[]): Promise<Map<string, number>> {
  const durations = loadCachedVideoDurations();
  const missing = videoIds.filter((id) => !durations.has(id));
  console.log(
    `\nvideo ids: ${videoIds.length} unique — ${videoIds.length - missing.length} from the cached index (0 quota), ${missing.length} to look up`,
  );
  for (const [id, seconds] of await youtubeDurations(missing)) durations.set(id, seconds);
  return durations;
}

export async function collectPlans(
  probes: Map<string, ProbeEvidence | null> = readBatches(),
  resolve: (ids: string[]) => Promise<Map<string, number>> = resolveDurations,
): Promise<Planned[]> {
  const all = await prisma.resource.findMany({
    select: {
      id: true,
      url: true,
      title: true,
      type: true,
      status: true,
      decompositionStatus: true,
      durationMin: true,
    },
    orderBy: { id: 'asc' },
  });
  const rows = all.filter((r) => isProjectTask(r.url));

  const attached = new Set(
    (
      await prisma.conceptResource.findMany({
        where: { resourceId: { in: rows.map((r) => r.id) } },
        select: { resourceId: true },
        distinct: ['resourceId'],
      })
    ).map((r) => r.resourceId),
  );

  const candidates = [
    ...new Set(
      rows.flatMap((r) => {
        const v = videoIdFor(probes.get(r.id) ?? null);
        return 'id' in v ? [v.id] : [];
      }),
    ),
  ];

  // Which candidate ids are already somebody's URL. A substring match catches every shape a
  // YouTube row can carry (`watch?v=`, `youtu.be/`, `m.youtube.com`, an `embed/` form), and
  // the host filter keeps an 11-character id that happens to appear inside an unrelated URL
  // from reading as a collision.
  //
  // ⚠️ NO STATUS FILTER IN THE QUERY, deliberately, and it is not the defect it looks like:
  // the unique constraint is unconditional, so a DEPRECATED row on the target URL still
  // blocks the write and this driver still has to know about it. What the status must not do
  // is decide the outcome by omission — a retired incumbent read as a plain collision would
  // deprecate the `/pt/` row and retire the last servable copy of the lesson. So every holder
  // is fetched and `planFor` splits them: live → collision, retired → escalation. A live one
  // wins when both shapes of the same video exist, because any servable copy makes this row
  // genuinely redundant.
  const holders = new Map<string, Holder>();
  for (const videoId of candidates) {
    const onUrl = (
      await prisma.resource.findMany({
        where: { url: { contains: videoId } },
        select: { id: true, url: true, status: true },
      })
    ).filter((h) => YOUTUBE_HOSTS.some((host) => h.url.includes(host)));
    const hit = onUrl.find((h) => ACTIONABLE_STATUS.includes(h.status)) ?? onUrl[0];
    if (hit) holders.set(videoId, { id: hit.id, status: hit.status });
  }

  const durations = await resolve(candidates);

  const claimed = new Map<string, string>();
  return rows.map((row) => {
    const outcome = planFor(row, probes.get(row.id) ?? null, durations, holders, claimed);
    if (outcome.action === 'repoint') claimed.set(outcome.videoId, row.id);
    return { row, attached: attached.has(row.id), outcome };
  });
}

export type ApplyOutcome = { ok: boolean; detail: string };

export async function applyPlan({ row, outcome }: Planned): Promise<ApplyOutcome> {
  if (outcome.action === 'repoint') {
    // ⚠️ A DIRECT FIELD UPDATE, and both halves of that are deliberate — see the header.
    // `url` is outside every edit whitelist because it is the row's identity, and a field
    // update is also the only write here that leaves `ConceptResource` alone, which is the
    // property this block exists to preserve. `durationSource: 'api'` is the provider's own
    // number for this exact clip; `updateResource` would have stamped it `reviewer`.
    const updated = await prisma.resource.update({
      where: { id: row.id },
      data: {
        url: outcome.url,
        type: 'video',
        durationMin: outcome.durationMin,
        durationSource: 'api',
      },
      select: { url: true, type: true, durationMin: true, durationSource: true },
    });
    return {
      ok: true,
      detail: `→ ${updated.url}  type=${updated.type}  durationMin=${updated.durationMin} (${updated.durationSource})`,
    };
  }
  if (outcome.action === 'deprecate') {
    // The only permitted removal seam: it also drops the ConceptResource links and recomputes
    // each affected Path's readiness. `soft`, never `hard` — `hard` means broken, and a `/pt/`
    // page works fine, we just cannot serve what we cannot measure. Nothing here deletes a row.
    // cascade: false — the population is per-row by construction.
    const result = await applyPendingReview({
      action: 'reject',
      resourceId: row.id,
      cascade: false,
      severity: 'soft',
    });
    return result.kind === 'rejected'
      ? {
          ok: true,
          detail: `deprecated soft (links removed ${result.conceptLinksRemoved}, paths regressed ${result.pathsRegressed})`,
        }
      : { ok: false, detail: result.kind };
  }
  // Reached only by `escalate` and `skip`, and both mean the same thing to a caller: this
  // driver has no write for this row. `main()` never offers them here.
  return { ok: false, detail: `nothing planned (${outcome.reason})` };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────

const section = (title: string) => console.log(`\n${'─'.repeat(100)}\n${title}`);

function line(p: Planned, lead: string) {
  console.log(
    `  ${lead}\n      ${p.attached ? 'attached' : '        '}  status=${p.row.status}  type=${p.row.type}` +
      `  durationMin=${p.row.durationMin ?? 'null'}\n      ${p.row.title}\n      ${p.row.url}`,
  );
}

function report(planned: Planned[]) {
  const of = (action: Outcome['action'], reason?: string) =>
    planned.filter(
      (p) => p.outcome.action === action && (reason === undefined || ('reason' in p.outcome && p.outcome.reason === reason)),
    );

  const repoint = of('repoint');
  const unresolvable = of('deprecate', 'unresolvable');
  const collision = of('deprecate', 'collision');
  const escalated = of('escalate');
  const skipped = of('skip');
  const inPopulation = planned.length - skipped.length;
  const decided = repoint.length + unresolvable.length + collision.length + escalated.length;

  section(`PER-ROW OUTCOME — ${planned.length} Khan /pt/ row(s) found`);
  for (const p of planned) {
    const o = p.outcome;
    const lead =
      o.action === 'repoint'
        ? `REPOINT      ${o.videoId} → ${o.seconds}s → ${o.durationMin}min`
        : o.action === 'deprecate'
          ? `DEPRECATE    ${o.reason}: ${o.detail}`
          : o.action === 'escalate'
            ? `⚠ ESCALATE   ${o.reason}: ${o.detail}`
            : `skip         ${o.reason}: ${o.detail}`;
    line(p, lead);
  }

  const attachedIn = (ps: Planned[]) => ps.filter((p) => p.attached).length;
  section('TOTALS');
  console.log(
    `  ${String(repoint.length).padStart(4)}  REPOINT    at the embedded video (${attachedIn(repoint)} attached to a concept)\n` +
      `  ${String(unresolvable.length).padStart(4)}  DEPRECATE  soft — no video resolved (${attachedIn(unresolvable)} attached)\n` +
      `  ${String(collision.length).padStart(4)}  DEPRECATE  soft — the video is already a SERVABLE row (${attachedIn(collision)} attached)\n` +
      `  ${String(escalated.length).padStart(4)}  ESCALATE   writes nothing — the video is held by a DEPRECATED row (${attachedIn(escalated)} attached)\n` +
      `  ${'─'.repeat(4)}\n` +
      `  ${String(decided).padStart(4)}  = ${inPopulation} row(s) in the actionable population  ` +
      `[${decided === inPopulation ? '✓ the four outcomes sum' : '⚠️ MISMATCH'}]\n` +
      `  ${String(skipped.length).padStart(4)}  skipped (outside it: already deprecated, or not atomic)\n` +
      `  ${'─'.repeat(4)}\n` +
      `  ${String(planned.length).padStart(4)}  = /pt/ rows found\n\n` +
      `  ${String(repoint.length + unresolvable.length + collision.length).padStart(4)}  of those are WRITES; the ${escalated.length} escalation(s) are for a human`,
  );

  if (escalated.length > 0) {
    section(`⚠ ESCALATION — ${escalated.length} row(s) whose video is held by a deprecated row, LEFT UNTOUCHED`);
    for (const p of escalated) line(p, p.row.id);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('repoint-khan-pt', apply, 'REPOINT');
  console.log(`\n=== repoint-khan-pt (${apply ? 'APPLY' : 'DRY RUN'}) ===`);

  const planned = await collectPlans();
  report(planned);

  // An escalation is deliberately NOT in here: it is a row the driver refuses to decide, and
  // an `--apply` that acted on one would be exactly the destructive fallthrough the refusal
  // exists to prevent.
  const writes = planned.filter((p) => p.outcome.action === 'repoint' || p.outcome.action === 'deprecate');
  if (!apply) {
    console.log(
      `\nDry run — nothing written. Read the per-row outcomes above, then re-run with --apply to act on ${writes.length} row(s).\n`,
    );
    return;
  }

  const tally = new Map<string, number>();
  const failed: string[] = [];
  for (const p of writes) {
    const outcome = await applyPlan(p);
    const key = outcome.ok ? p.outcome.action : `${p.outcome.action} FAILED`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    console.log(`  ${outcome.ok ? '✓' : '✗'} ${p.row.id}  ${outcome.detail}`);
    if (!outcome.ok) failed.push(`  ${p.row.id} → ${outcome.detail}`);
  }

  section('APPLIED');
  for (const [k, v] of [...tally].sort()) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (failed.length > 0) console.log(`\nnot applied:\n${failed.join('\n')}`);

  const left = (await prisma.resource.findMany({ select: { url: true } })).filter((r) => isProjectTask(r.url));
  console.log(`\n/pt/ URLs left in the table: ${left.length} (deprecated rows keep their URL — a Resource is never deleted)`);
}

// Guarded so the integration test can import the planning and apply seams without the driver
// running against whatever DATABASE_URL the test suite is pointed at.
if (process.argv[1]?.endsWith('repoint-khan-pt.ts')) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
