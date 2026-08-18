// The library sweep — repair every row that fails `resource-standard.md`, one repair per row.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/sweep-serveability.ts
//   … scripts/sweep-serveability.ts --apply --target-host=<hostname>
//
// DRY RUN IS THE DEFAULT AND THERE IS NO `--yes`. Every `--apply` is meant to be preceded by
// a printed dry run a human has read; a flag that skipped that reading would remove the only
// checkpoint standing between a classifier change and ~100 rows leaving retrieval. Modelled
// on `deprecate-furniture.ts`, from which it inherits `requireTargetAck`, the dry-run
// default, the Track fingerprint, and the rule that matters most:
//
// THE POPULATION IS WHATEVER THE CLASSIFIERS SAY. Not one resource id is written down here.
// The rows below come from `classifyServeability`, `classifyServeabilityFromProbe` and
// `classifyMetadataIntegrity` — the same three, over the same probe artifacts, in the same
// order as `report-serveability.ts`, so the report and the sweep cannot disagree about who
// is in the population. The reconciliation section prints S5's own tables for that reason.
//
// ── THREE REPAIRS, AND THE PRECEDENCE IS ENFORCED HERE, NOT LEFT TO THE OPERATOR ──────────
//
//   decompose  >  re-type  >  deprecate
//
//   decompose — the row is a CONTAINER misfiled as an atomic leaf (clause 3). Neither
//               removal nor a re-type: `applyPendingReview({ action: 'decompose' })` flips
//               `decompositionStatus` to `pending` and hands it to the decomposition queue,
//               dropping its ConceptResource links and recomputing readiness on the way
//               (`pending-review.ts` — documented and intended; remediation refills the hole).
//   re-type   — the page contradicts the stored form (clause 6). The row is a good lesson
//               wearing a stale label, and deprecating it on that label would invert the
//               standard's one-sided error budget.
//   deprecate — a serveability failure with nothing to repair: `applyPendingReview({ action:
//               'reject', severity: 'soft' })`, the ONLY seam that also drops the concept
//               links and recomputes Path readiness. `soft`, never `hard`: `hard` means
//               broken, and these are working pages we choose not to serve. Nothing here
//               deletes a row — a Resource is referenced by ratings, reports, Lesson
//               snapshots and rejections.
//
// ⚠️ WHY DECOMPOSE HAS TO OUTRANK DEPRECATE, and it is not a stylistic ordering: an
// `interactive` row queued for decompose still matches `classifyServeability`'s
// `interactive-type` rule, which fires unless the row is explicitly `decomposed` — and
// `pending` is not `decomposed`. Without the precedence this sweep would deprecate the very
// rows it had just queued. The same fact is why a row already sitting in the decomposition
// queue is never a deprecation candidate below (`applyPendingReview` refuses it as `blocked`
// anyway, which is the seam agreeing).
//
// ⚠️ A DECOMPOSE ROW'S `type` IS DELIBERATELY LEFT ALONE, and it looks like an omission.
// The MITx 6.036 rows are `interactive`, which is a CONTAINER_TYPE — and that is precisely
// what makes `classify()` fetch the page and let the doc-TOC router decide. Retyping them to
// `article` first would make `classify()` return atomic WITHOUT FETCHING (`router.ts`), the
// short-circuit S6's schema header and S7's skill both warn about, and would defeat the
// decomposition this repair exists to trigger. Only `decompositionStatus` moves.
//
// ⚠️ TWO RE-TYPE FINDINGS NAMING DIFFERENT TARGETS ARE AN ESCALATION, NOT A CHOICE. S4
// deliberately picks no winner and neither does this driver: such a row is printed loudly,
// counted separately, and left untouched — including untouched by the deprecation it would
// otherwise be eligible for.
//
// Khan `/pt/` rows are SKIPPED ENTIRELY and counted: S9 repoints them at their embedded
// video, and deprecating them here would destroy the ten attached SQL lessons that block
// exists to keep.
//
// Clause-6 `review` findings (175 rows, nearly all a stored title that no longer matches the
// rendered page) are a separate review campaign, not this driver's work. Counted and
// pointed at the report; never acted on.
//
// Idempotent by construction, per repair: a deprecated row leaves the actionable population
// (status filter); a re-typed row no longer contradicts its URL or its page; a decomposed
// row is no longer `atomic`, which is the precondition of both container rules.
//
// ⚠️ AND SAFE TO RE-RUN AFTER S9, which is a stronger claim than idempotence and was NOT true
// of the first version of this driver. A probe is keyed by resourceId, so a repointed row
// still carries the probe of the page it used to point at; judging the row on that page
// deprecated the ten attached `/pt/` lessons S9 had just rescued. `probeDescribes` below is
// the fix, and it is general — no rule here mentions `/pt/` or YouTube.

import { readdirSync, readFileSync } from 'node:fs';
import type { DecompositionStatus, ResourceStatus, ResourceType, DurationSource } from '@prisma/client';
import {
  classifyMetadataIntegrity,
  type MetadataDiscrepancy,
  type RetypeTarget,
} from '../src/lib/curation/metadata-integrity';
import { classifyServeability, isKhanUrl, urlKind } from '../src/lib/curation/serveability';
import {
  classifyServeabilityFromProbe,
  type ProbeEvidence,
} from '../src/lib/curation/serveability-probe';
import { applyPendingReview } from '../src/lib/curation/pending-review';
import { updateResource } from '../src/lib/curation/update-resource';
import { prisma } from '../src/lib/db';
import { requireTargetAck } from './target-guard';

const BATCH_DIR = 'docs/audits';
const BATCH_FILE = /^khan-batch-.+\.jsonl?$/;

// Rows this sweep may write. A `deprecated` row has already been decided; re-deciding it
// would let a classifier change silently re-open a closed call, and is also what makes a
// second `--apply` a no-op.
const ACTIONABLE_STATUS: ResourceStatus[] = ['active', 'pending_review'];

// `applyPendingReview` refuses a reject on either of these (`blocked`): a row whose shape is
// unsettled is not approvable or rejectable until the decomposition axis resolves.
const UNRESOLVED: DecompositionStatus[] = ['pending', 'human_review'];

// An edX `sequential` block is a UNIT CONTAINING CHILD PAGES, so a row filed as an atomic
// leaf on one is a container misfiled — clause 3, the same defect `khan-container-url`
// names, on a host the classifier has no rule for. It lives here rather than in
// `serveability.ts` because S8 may not change the classifiers; that is the reason, and it is
// the one clause-3 signal this driver adds. A URL SHAPE, never a host or an id list.
const EDX_SEQUENTIAL = /\+type@sequential\+block@/;

type Row = {
  id: string;
  url: string;
  title: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number | null;
  durationSource: DurationSource;
};

type Failure = { clause: number; rule: string };

export type Analysis = {
  row: Row;
  pickable: boolean;
  attached: boolean;
  failures: Failure[];
  discrepancies: MetadataDiscrepancy[];
  // Clause 3 on a host `classifyServeability` has no rule for — reported separately below so
  // the reconciliation table stays byte-comparable with S5's.
  edxSequential: boolean;
  // A probe existed but describes a different page than this row now points at, so it was
  // withheld from the serveability verdict. See `probeDescribes`.
  probeVoided: boolean;
};

type SkipReason =
  | 'clean'
  | 'khan-pt' // S9's population
  | 'retype-target-conflict' // escalation: two targets, no winner picked
  | 'review-only' // a real clause-6 finding that does not say what the row should become
  | 'already-decided' // deprecated: outside the actionable population
  | 'in-decomposition-queue' // pending/human_review: the reject seam refuses it too
  | 'not-atomic'; // a repair whose seam requires an atomic row, on one that is not

export type Plan =
  | { action: 'decompose'; rule: string }
  | { action: 'retype'; to: RetypeTarget; clearDuration: boolean; rule: string }
  | { action: 'deprecate'; rule: string }
  | { action: 'none'; reason: SkipReason };

// Same reader as `report-serveability.ts`, deliberately: sorted filenames and last-write-wins
// so a resource probed twice resolves identically on every run, and so the two drivers see
// the same evidence. `null` = probed and we still have no page (agent failure), which the
// classifiers read as "no evidence" rather than as a pass.
export function readBatches(dir = BATCH_DIR): Map<string, ProbeEvidence | null> {
  type BatchRow = { resourceId: string; probe: ProbeEvidence | null; status: 'ok' | 'failed' };
  const byResource = new Map<string, ProbeEvidence | null>();
  for (const f of readdirSync(dir).filter((f) => BATCH_FILE.test(f)).sort()) {
    const raw = readFileSync(`${dir}/${f}`, 'utf8');
    const rows: BatchRow[] = f.endsWith('.jsonl')
      ? raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      : JSON.parse(raw);
    for (const r of rows) byResource.set(r.resourceId, r.status === 'ok' ? r.probe : null);
  }
  return byResource;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ⚠️ A PROBE IS KEYED BY resourceId, NOT BY URL, so it describes the page that row pointed at
// WHEN IT WAS PROBED — which is not necessarily the page it points at now. A stale probe that
// is allowed to answer a serveability question answers it about somebody else's page.
//
// The case that forced this, and it is not hypothetical: S9 repoints a Khan `/pt/` row at its
// embedded video, so `row.url` becomes a youtube.com URL while the stored probe is still the
// Khan challenge page — `hasEditor: true`, `articleWords: null`. That fires `editor-no-prose`,
// clause 6 finds nothing to repair (the row is no longer a Khan URL, and `pageKind:
// 'challenge'` names no retype target), and the sweep falls through to DEPRECATE. Running
// `sweep --apply`, then `repoint --apply`, then the sweep again — the natural sequence after
// any classifier change, and the one this driver's header advertises as safe — would
// soft-deprecate the ten attached SQL lessons S9 exists to save.
//
// The same defect, less loudly, on the 7 rows whose stored URL redirects across kinds: the
// probe judges the landed page while `classifyMetadataIntegrity` simultaneously reports
// `url-redirects-across-kinds`, whose whole meaning is that the landed page is DIFFERENT
// CONTENT from this row. One classifier judging a row on a page the other has just declared
// is not this row's is not a verdict.
//
// So: kind or host disagreement voids the probe as evidence about this row.
// ⚠️ ONLY those two. Slug drift is normal and common on Khan and must still count —
// `metadata-integrity.ts` draws exactly this line ("the slug alone changing is normal and is
// deliberately not a finding; the kind changing is not"), and voiding on it would silently
// discard most of the page evidence the library has. An unparseable URL on either side voids
// too, because we cannot show the two agree, and the standard's one-sided error budget says
// an unproven signal does not get to exclude.
function probeDescribes(rowUrl: string, probeUrl: string): boolean {
  const rowHost = hostOf(rowUrl);
  const probeHost = hostOf(probeUrl);
  if (rowHost === null || probeHost === null) return false;
  if (rowHost !== probeHost) return false;
  return urlKind(rowUrl) === urlKind(probeUrl);
}

export function analyse(row: Row, probe: ProbeEvidence | null, attached: boolean): Analysis {
  const failures: Failure[] = [];

  const verdict = classifyServeability(row);
  if (!verdict.serveable) failures.push({ clause: verdict.clause, rule: verdict.reason });

  // Routed to the classifier's EXISTING no-evidence arm rather than given a fourth outcome: a
  // probe that does not describe this row is precisely an absence of evidence about it, which
  // is what that arm already means and already prevents from being read as a pass.
  const probeVoided = probe !== null && !probeDescribes(row.url, probe.url);
  const fromProbe = classifyServeabilityFromProbe(probeVoided ? null : probe, {
    url: row.url,
    title: row.title,
  });
  if (fromProbe.evidence && !fromProbe.serveable) {
    failures.push({ clause: fromProbe.clause, rule: fromProbe.reason });
  }

  // ⚠️ The FULL probe, deliberately, voided or not. Comparing a stored field against the page
  // the URL actually lands on is what clause 6 IS — `url-redirects-across-kinds` exists to
  // report exactly the disagreement that voided the probe above, and it reports it as
  // `review`, which repairs nothing on its own. Voiding the probe here too would delete the
  // finding that explains the row instead of acting on it.
  const meta = classifyMetadataIntegrity(row, probe);

  return {
    row,
    pickable: row.status === 'active' && row.decompositionStatus === 'atomic',
    attached,
    failures,
    discrepancies: meta.pageChecked ? meta.discrepancies : meta.rowDiscrepancies,
    edxSequential: EDX_SEQUENTIAL.test(row.url),
    probeVoided,
  };
}

// A re-type changes the row's FORM, and a duration recorded against the old form is a promise
// the new form cannot keep: `…/bayes-theorem/v/bayes-theorem` is stored `course` carrying 45
// minutes, and re-typing it to `video` while leaving 45 attached trades one lie for another.
// Conservative on both sides — cleared ONLY when the re-type itself makes the number wrong:
//
//   • the old type was a container form (anything but `article`/`video`, the two leaf types),
//     so the number described a whole unit rather than the one page the row now claims to be.
//     An `article` → `video` relabel leaves the number alone: it was measured against this
//     single page either way.
//   • and nobody authoritative measured it. `api` is a provider's own number for this exact
//     content and `reviewer` is a human's, and `update-resource.ts` documents `reviewer` as
//     the highest authority no automated pass may overwrite.
//
// Clearing stamps `durationSource: 'unknown'` = "re-measure me" (S6), which is the honest
// state; leaving a stale number would be a clause-6 defect created by a clause-6 repair.
function clearsDuration(row: Row): boolean {
  if (row.durationMin === null) return false;
  if (row.type === 'article' || row.type === 'video') return false;
  return row.durationSource !== 'api' && row.durationSource !== 'reviewer';
}

export function planFor(a: Analysis): Plan {
  const { row } = a;

  // S9's population, before anything else can claim it.
  if (isKhanUrl(row.url) && urlKind(row.url) === 'pt') return { action: 'none', reason: 'khan-pt' };

  if (a.failures.length === 0 && a.discrepancies.length === 0 && !a.edxSequential) {
    return { action: 'none', reason: 'clean' };
  }

  const retypes = a.discrepancies.filter((d) => d.repair === 'retype');
  const targets = [...new Set(retypes.map((d) => d.to))];
  if (targets.length > 1) return { action: 'none', reason: 'retype-target-conflict' };

  if (!ACTIONABLE_STATUS.includes(row.status)) return { action: 'none', reason: 'already-decided' };

  // Out of bounds for all three repairs at once, and checked here so every one of them
  // declines with the same honest reason: the decompose and re-type seams require an atomic
  // row, and the reject seam refuses an unresolved one outright (`blocked`). This is also
  // what makes a second `--apply` a no-op on the rows the FIRST one queued — those are
  // `pending` now, and an `interactive` row queued for decompose still matches
  // `interactive-type`, so without this check the sweep would deprecate its own repairs.
  if (UNRESOLVED.includes(row.decompositionStatus)) {
    return { action: 'none', reason: 'in-decomposition-queue' };
  }

  const containerRule = a.failures.find((f) => f.rule === 'khan-container-url')?.rule
    ?? (a.edxSequential ? 'edx-sequential-url' : null);
  if (containerRule !== null) {
    if (row.decompositionStatus !== 'atomic') return { action: 'none', reason: 'not-atomic' };
    return { action: 'decompose', rule: containerRule };
  }

  if (targets.length === 1) {
    if (row.decompositionStatus !== 'atomic') return { action: 'none', reason: 'not-atomic' };
    return {
      action: 'retype',
      to: targets[0],
      clearDuration: clearsDuration(row),
      rule: retypes.map((d) => d.kind).join('+'),
    };
  }

  if (a.failures.length > 0) {
    return { action: 'deprecate', rule: a.failures.map((f) => `${f.clause}:${f.rule}`).join(' ') };
  }

  return { action: 'none', reason: 'review-only' };
}

export type Planned = { analysis: Analysis; plan: Plan };

export async function collectPlans(
  probes: Map<string, ProbeEvidence | null> = readBatches(),
): Promise<Planned[]> {
  const rows = await prisma.resource.findMany({
    select: {
      id: true,
      url: true,
      title: true,
      type: true,
      status: true,
      decompositionStatus: true,
      durationMin: true,
      durationSource: true,
    },
    orderBy: { id: 'asc' },
  });
  const attached = new Set(
    (await prisma.conceptResource.findMany({ select: { resourceId: true }, distinct: ['resourceId'] }))
      .map((r) => r.resourceId),
  );
  return rows.map((row) => {
    const analysis = analyse(row, probes.get(row.id) ?? null, attached.has(row.id));
    return { analysis, plan: planFor(analysis) };
  });
}

export type ApplyOutcome = { ok: boolean; detail: string };

export async function applyPlan({ analysis, plan }: Planned): Promise<ApplyOutcome> {
  const id = analysis.row.id;
  if (plan.action === 'decompose') {
    const result = await applyPendingReview({ action: 'decompose', resourceId: id });
    return result.kind === 'queued_decompose'
      ? { ok: true, detail: `queued (links removed ${result.conceptLinksRemoved}, paths regressed ${result.pathsRegressed})` }
      : { ok: false, detail: result.kind };
  }
  if (plan.action === 'retype') {
    const result = await updateResource(id, {
      type: plan.to,
      ...(plan.clearDuration ? { durationMin: null } : {}),
    });
    return result.kind === 'updated'
      ? { ok: true, detail: `type=${result.resource.type} durationMin=${result.resource.durationMin ?? 'null'}` }
      : { ok: false, detail: result.kind === 'refused' ? result.reason : result.kind };
  }
  if (plan.action === 'deprecate') {
    // cascade: false — the population is per-row by construction, and a cascade would reach
    // rows no classifier looked at.
    const result = await applyPendingReview({ action: 'reject', resourceId: id, cascade: false, severity: 'soft' });
    return result.kind === 'rejected'
      ? { ok: true, detail: `deprecated ${result.deprecated} (links removed ${result.conceptLinksRemoved}, paths regressed ${result.pathsRegressed})` }
      : { ok: false, detail: result.kind };
  }
  return { ok: false, detail: `no repair planned (${plan.reason})` };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────

const counts = (rows: Analysis[]) => {
  const pick = rows.filter((a) => a.pickable);
  const att = pick.filter((a) => a.attached);
  return `${String(rows.length).padStart(5)} / ${String(pick.length).padStart(5)} / ${String(att.length).padStart(5)}`;
};
const line = (label: string, rows: Analysis[]) => console.log(`  ${counts(rows)}  ${label}`);
const section = (title: string) => console.log(`\n${'─'.repeat(100)}\n${title}`);
const flags = (a: Analysis) => `${a.pickable ? 'pickable' : '        '} ${a.attached ? 'attached' : '        '}`;
const repairOf = (d: MetadataDiscrepancy) => (d.repair === 'retype' ? `retype ${d.to}` : 'review');

function detail(a: Analysis, lead: string) {
  console.log(
    `  ${lead}\n      ${flags(a)}  status=${a.row.status}  decompositionStatus=${a.row.decompositionStatus}  type=${a.row.type}` +
      `\n      ${a.row.title}\n      ${a.row.url}`,
  );
}

// Tracks are immutable and this sweep is supposed to leave them that way. Asserted by
// counting rather than by reading the code path, exactly as `deprecate-furniture.ts --tracks`
// does: if a repair ever did reach a Track, these four numbers would move.
async function trackFingerprint(): Promise<string> {
  const [tracks, lessons, lessonResources] = await Promise.all([
    prisma.track.count(),
    prisma.lesson.count(),
    prisma.lessonResource.count(),
  ]);
  const latest = await prisma.track.aggregate({ _max: { updatedAt: true } });
  return `tracks=${tracks} lessons=${lessons} lessonResources=${lessonResources} maxTrackUpdatedAt=${
    latest._max.updatedAt?.toISOString() ?? 'none'
  }`;
}

// S5's own tables, recomputed here from the same classifiers over the same artifacts. If any
// line below disagrees with `report-serveability.ts`, the two drivers disagree about the
// population and neither should be trusted until they don't.
function reconcile(all: Analysis[]) {
  section('RECONCILIATION WITH report-serveability.ts (all / pickable / pickable+attached)');
  const clauses = [...new Set(all.flatMap((a) => a.failures.map((f) => f.clause)))].sort();
  for (const clause of clauses) {
    console.log(`\n clause ${clause}`);
    const inClause = all.filter((a) => a.failures.some((f) => f.clause === clause));
    const rules = [...new Set(inClause.flatMap((a) => a.failures.filter((f) => f.clause === clause).map((f) => f.rule)))].sort();
    for (const rule of rules) {
      line(rule, inClause.filter((a) => a.failures.some((f) => f.clause === clause && f.rule === rule)));
    }
    line(`— clause ${clause} total (rows, deduplicated)`, inClause);
  }
  const failing = all.filter((a) => a.failures.length > 0);
  console.log('');
  line('— ANY serveability clause (rows, deduplicated across clauses)', failing);

  console.log('\n clause 6');
  const withDiscrepancy = all.filter((a) => a.discrepancies.length > 0);
  const rules6 = [...new Set(withDiscrepancy.flatMap((a) => a.discrepancies.map((d) => `${d.kind}  →  ${repairOf(d)}`)))].sort();
  for (const rule of rules6) {
    line(rule, withDiscrepancy.filter((a) => a.discrepancies.some((d) => `${d.kind}  →  ${repairOf(d)}` === rule)));
  }
  line('— clause 6 total (rows, deduplicated)', withDiscrepancy);

  // ⚠️ NOT IN S5'S REPORT, and the difference is intentional: no classifier implements it,
  // and S8 may not add one. Listed apart so nobody reads it as a clause-3 count that moved.
  console.log('');
  line('edx-sequential-url — clause 3 on a host no classifier covers (S8-local, absent from S5)',
    all.filter((a) => a.edxSequential));

  // ⚠️ THE ONE PLACE THIS DRIVER KNOWINGLY DISAGREES WITH S5, and the disagreement is the
  // point: `report-serveability.ts` hands every probe to `classifyServeabilityFromProbe`
  // keyed only by resourceId, so it still derives clause-4/5 verdicts from probes that no
  // longer describe their row. Any clause-4/5 line above that differs from the report differs
  // by these rows, and the report is the one that is wrong. Reported, not fixed here — S5 is
  // read-only and repairing it is its own block.
  const voided = all.filter((a) => a.probeVoided);
  line('PROBE VOIDED — its landed page is a different host or content kind than this row now serves', voided);
  for (const a of voided) {
    console.log(`      ${a.row.url}`);
  }
}

function report(planned: Planned[]) {
  const all = planned.map((p) => p.analysis);
  const of = (action: Plan['action'], reason?: SkipReason) =>
    planned.filter((p) => p.plan.action === action && (reason === undefined || (p.plan.action === 'none' && p.plan.reason === reason)));
  const rowsOf = (ps: Planned[]) => ps.map((p) => p.analysis);

  console.log(
    `\n${all.length} resource rows` +
      `\n${all.filter((a) => a.pickable).length} pickable (active + atomic)` +
      `\n${all.filter((a) => a.attached).length} attached to at least one concept`,
  );
  reconcile(all);

  const decompose = of('decompose');
  const retype = of('retype');
  const deprecate = of('deprecate');

  section('PLANNED REPAIRS (all / pickable / pickable+attached)');
  line('DECOMPOSE — a container misfiled as an atomic leaf (clause 3)', rowsOf(decompose));
  line('RE-TYPE   — the page names a form the row should have carried (clause 6)', rowsOf(retype));
  line('DEPRECATE — fails a serveability clause with no repair available (soft)', rowsOf(deprecate));
  console.log('');
  for (const [reason, label] of [
    ['khan-pt', 'skipped: Khan /pt/ — S9 repoints these at their embedded video'],
    ['retype-target-conflict', '⚠ SKIPPED: two re-type findings naming DIFFERENT targets — escalation, no winner picked'],
    ['review-only', 'skipped: clause-6 `review` finding only — a separate review campaign, see report-serveability.ts'],
    ['already-decided', 'skipped: already deprecated — outside the actionable population'],
    ['in-decomposition-queue', 'skipped: pending/human_review — the reject seam refuses it too'],
    ['not-atomic', 'skipped: repair needs an atomic row and this one is not'],
  ] as [SkipReason, string][]) {
    line(label, rowsOf(of('none', reason)));
  }

  for (const [title, ps, lead] of [
    ['DECOMPOSE', decompose, (p: Planned) => p.plan.action === 'decompose' ? p.plan.rule : ''],
    ['RE-TYPE', retype, (p: Planned) =>
      p.plan.action === 'retype'
        ? `→ ${p.plan.to}   ${p.plan.rule}` +
          (p.plan.clearDuration ? `   ⚠ CLEARING durationMin=${p.analysis.row.durationMin} (${p.analysis.row.durationSource}) → null/unknown` : '')
        : ''],
    ['DEPRECATE (soft)', deprecate, (p: Planned) => p.plan.action === 'deprecate' ? p.plan.rule : ''],
  ] as [string, Planned[], (p: Planned) => string][]) {
    section(`${title} — ${ps.length} row(s)`);
    for (const p of ps) detail(p.analysis, lead(p));
  }

  const escalated = of('none', 'retype-target-conflict');
  if (escalated.length > 0) {
    section(`⚠ ESCALATION — ${escalated.length} row(s) with two re-type targets, LEFT UNTOUCHED`);
    for (const p of escalated) {
      detail(p.analysis, p.analysis.row.id);
      for (const d of p.analysis.discrepancies) console.log(`      ${repairOf(d).padEnd(15)} ${d.detail}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('sweep-serveability', apply, 'REPAIR');
  console.log(`\n=== sweep-serveability (${apply ? 'APPLY' : 'DRY RUN'}) ===`);

  const before = await trackFingerprint();
  console.log(`tracks before: ${before}`);

  const planned = await collectPlans();
  report(planned);

  const actionable = planned.filter((p) => p.plan.action !== 'none');
  if (!apply) {
    console.log(
      `\nDry run — nothing written. Re-run with --apply to repair ${actionable.length} row(s).`,
    );
    return;
  }

  const tally = new Map<string, number>();
  const failed: string[] = [];
  for (const p of actionable) {
    const outcome = await applyPlan(p);
    const key = outcome.ok ? p.plan.action : `${p.plan.action} FAILED`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (!outcome.ok) failed.push(`  ${p.plan.action} ${p.analysis.row.id} → ${outcome.detail}`);
  }

  section('APPLIED');
  for (const [k, v] of [...tally].sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
  if (failed.length > 0) console.log(`\nnot applied:\n${failed.join('\n')}`);

  const hard = await prisma.resource.count({ where: { deprecationSeverity: 'hard' } });
  console.log(`\nrows at deprecationSeverity=hard (unchanged by this pass): ${hard}`);
  const after = await trackFingerprint();
  console.log(`tracks after:  ${after}`);
  console.log(after === before ? 'tracks unchanged ✓' : '⚠️ TRACK STATE MOVED — investigate');
}

// Guarded so the integration test can import the planning and apply seams without the driver
// running against whatever DATABASE_URL the test suite is pointed at.
if (process.argv[1]?.endsWith('sweep-serveability.ts')) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
