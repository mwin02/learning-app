// Clause 6's largest population: rows whose stored title no longer names the page they point
// at. A REPAIR, never a removal — the standard says so directly, and the sweep deliberately
// leaves this set alone and points here.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/repair-stale-titles.ts
//   … scripts/repair-stale-titles.ts --apply --target-host=<hostname>
//
// DRY RUN IS THE DEFAULT AND THERE IS NO `--yes`, inherited from `sweep-serveability.ts`
// along with `requireTargetAck` and the rule that matters most:
//
// THE POPULATION IS WHATEVER THE CLASSIFIER SAYS. Not one resource id is written down here.
// A row is in scope iff `classifyMetadataIntegrity` reports `title-contradicts-page` — the
// set the sweep counts as `skipped: clause-6 review finding only`, so the two drivers
// partition that population rather than overlapping on it.
//
// ── WHY A REPAIR AND NOT A REMOVAL ────────────────────────────────────────────────────────
//
// `resource-standard.md` clause 6 fails a row when what we RECORDED about it stops matching
// what it is — and the remedy it names is correcting the record. These rows are working
// lessons wearing a stale label; 165 of them are pickable and 51 are attached to live
// concepts, so deprecating on a title would invert the standard's one-sided error budget on
// the largest scale in the library.
//
// ── THE CANDIDATE TITLE COMES FROM A SHIPPED SEAM, NOT FROM A REGEX HERE ──────────────────
//
// `crediblePageTitle` (decomposition/page-title.ts) already answers exactly this question for
// the sourcing path: is a fetched <title> trustworthy enough to replace a stored one? It
// carries the interstitial list (Khan serves a 200 titled "Client Challenge"; a naive pass
// would overwrite 171 good titles with bot-wall text and re-embed every one onto garbage),
// the site-suffix trimming, the `(video)`/`(article)` marker strip, and the shared-word
// anchor test against the stored title AND the URL's own path. Re-deriving any of that here
// would be a second copy of a rule that has already been tuned against this exact host.
//
// ⚠️ THE REPAIR IS VERIFIED BY THE CLASSIFIER, NOT BY THIS DRIVER'S IDEA OF EQUALITY, and
// that check is the reason the driver is trustworthy rather than merely plausible. The two
// modules normalize titles DIFFERENTLY on purpose — `cleanPageTitle` keeps up to two segments
// so a page keeps its section context, while `metadata-integrity`'s comparison folds a Khan
// title down to its first segment — so a candidate can be a genuine improvement and still
// leave the finding firing. Writing it would produce a driver that reports success and an
// audit that never clears: the row is rewritten on every pass, forever, and each pass costs a
// re-embed. So every candidate is re-classified as if it had been stored, and one that does
// not CLEAR the finding is not applied. Idempotence is then structural rather than hoped for
// — the same property `--apply` is checked against by re-running the dry run.
//
// A row whose candidate does not settle is reported under `UNSETTLED` with both titles, which
// is a real and much smaller review list rather than a silent partial repair.
//
// ── THE WRITE SEAM ────────────────────────────────────────────────────────────────────────
//
// `updateResource`, whose whitelist includes `title`. It bumps `updatedAt`, which leaves
// `embeddedAt < updatedAt` and so hands the row to the embedding backfill — the embedding
// covers title + summary + conceptsTaught, so a retitled row MUST be re-embedded or retrieval
// keeps matching against the old name. The seam reports that as `embeddingStale`, counted
// below; run `scripts/embed-resources.ts` afterwards.
//
// ⚠️ Not `applyPendingReview` — that seam DROPS ConceptResource links and recomputes Path
// readiness, which is right for a removal and catastrophic here: 51 of these rows are
// attached, and a title correction must leave every one of them attached. A field update does
// not touch links, which is the whole reason it is the right seam.
//
// ⚠️ EVIDENCE IS NOT REPRODUCIBLE FROM A FRESH CLONE. The rendered titles come from the probe
// artifacts in `docs/audits/khan-batch-*.json*` via `sweep-serveability.ts`'s own
// `readBatches`, and that directory is git-ignored. A row with no artifact is simply not in
// the population — this driver never guesses a title it has not seen.

import type { ResourceStatus, ResourceType } from '@prisma/client';
import { classifyMetadataIntegrity } from '../src/lib/curation/metadata-integrity';
import { crediblePageTitle } from '../src/lib/agents/decomposition/page-title';
import { isKhanUrl, urlKind } from '../src/lib/curation/serveability';
import { updateResource } from '../src/lib/curation/update-resource';
import type { ProbeEvidence } from '../src/lib/curation/serveability-probe';
import { prisma } from '../src/lib/db';
import { readBatches } from './sweep-serveability';
import { requireTargetAck } from './target-guard';

// The window this driver may write in. A `deprecated` row has already been decided, and
// correcting the title of a row nobody can be served is work with no reader.
const ACTIONABLE: ResourceStatus[] = ['active', 'pending_review'];

type Row = {
  id: string;
  url: string;
  title: string;
  type: ResourceType;
  status: ResourceStatus;
};

type Plan =
  | { action: 'retitle'; to: string }
  | { action: 'skip'; reason: string; rendered: string | null };

export type Planned = { row: Row; plan: Plan };

// Does the classifier still report a stale title for this row?
function titleContradictsPage(row: Row, probe: ProbeEvidence | null): boolean {
  const meta = classifyMetadataIntegrity(row, probe);
  const found = meta.pageChecked ? meta.discrepancies : meta.rowDiscrepancies;
  return found.some((d) => d.kind === 'title-contradicts-page');
}

export function planFor(row: Row, probe: ProbeEvidence | null): Plan {
  const rendered = probe?.title ?? null;

  if (!ACTIONABLE.includes(row.status)) {
    return { action: 'skip', reason: `already decided (status=${row.status})`, rendered };
  }

  // Two candidates, tried in order, and BOTH are run through `crediblePageTitle` so neither
  // can bypass the interstitial list or the shared-word anchor. The second exists only
  // because the two modules fold a title differently (see the header) and is deliberately
  // narrower — see `lessonSegment`.
  for (const fetched of [rendered ?? undefined, lessonSegment(row, rendered)]) {
    const candidate = crediblePageTitle(fetched, row.title, row.url);
    if (candidate === null) continue;
    // See the header: a candidate that leaves the finding firing would be rewritten on every
    // pass, and each pass costs a re-embed.
    if (titleContradictsPage({ ...row, title: candidate }, probe)) continue;
    return { action: 'retitle', to: candidate };
  }

  // Either the shipped rule declined both candidates — an interstitial, or a title sharing
  // no word with the stored title or the URL's own path, in which case KEEP what we have —
  // or neither cleared the finding. Both are review rows, not silent partial repairs.
  return { action: 'skip', reason: 'no candidate clears the finding', rendered };
}

// The rendered title reduced to the page's OWN name — Khan writes `Name (kind) | Section |
// Khan Academy`, and this is the first segment.
//
// ⚠️ WHY THIS IS NEEDED AT ALL, and why it is not a fix to `cleanPageTitle`. That module
// keeps up to two segments on purpose: on the sourcing path the section is real context and
// the title feeds an embedding, so `Name | Section` is the better record. But
// `metadata-integrity`'s comparison 4 folds a Khan title to its FIRST segment, so the
// two-segment form never clears the finding it is repairing — 19 production rows, every one
// of them a page whose title carries a section. Changing `cleanPageTitle` to match would
// change what every future ingestion stores, on the authority of a repair driver. So the
// narrowing lives here.
//
// ⚠️ AND IT IS GATED ON THE URL'S OWN CONTENT KIND, which is the whole safety argument. On a
// `/a/` or `/v/` URL Khan is stating the page is ONE lesson, so its first segment is that
// lesson's name and the section is redundant with the concept the row is attached to. On a
// unit or landing page it is not: `Functions | Algebra 1` reduced to `Functions` clears the
// finding by making the record LESS accurate, which is a clause-6 defect created by a
// clause-6 repair. Those rows stay on the review list, where they belong.
function lessonSegment(row: Row, rendered: string | null): string | undefined {
  if (rendered === null) return undefined;
  if (!isKhanUrl(row.url)) return undefined;
  const kind = urlKind(row.url);
  if (kind !== 'a' && kind !== 'v') return undefined;
  const first = rendered.split('|')[0].trim();
  return first.length > 0 ? first : undefined;
}

export async function collectPlans(
  probes: Map<string, ProbeEvidence | null> = readBatches(),
): Promise<Planned[]> {
  const rows = await prisma.resource.findMany({
    select: { id: true, url: true, title: true, type: true, status: true },
    orderBy: { id: 'asc' },
  });

  return rows
    .filter((row) => titleContradictsPage(row, probes.get(row.id) ?? null))
    .map((row) => ({ row, plan: planFor(row, probes.get(row.id) ?? null) }));
}

export async function applyPlan({ row, plan }: Planned): Promise<{ ok: boolean; detail: string }> {
  if (plan.action !== 'retitle') return { ok: false, detail: 'skipped — not applied' };
  const result = await updateResource(row.id, { title: plan.to });
  return result.kind === 'updated'
    ? { ok: true, detail: `title → '${result.resource.title}'${result.embeddingStale ? '  (re-embed pending)' : ''}` }
    : { ok: false, detail: result.kind === 'refused' ? result.reason : result.kind };
}

function report(planned: Planned[]) {
  const retitle = planned.filter((p) => p.plan.action === 'retitle');
  const skipped = planned.filter((p) => p.plan.action === 'skip');

  console.log(`\n${planned.length} row(s) reported \`title-contradicts-page\``);
  console.log(`\n  ${String(retitle.length).padStart(4)}  RETITLE  — a credible page title that CLEARS the finding`);
  console.log(`  ${String(skipped.length).padStart(4)}  SKIP     — left for review, nothing written`);

  const reasons = new Map<string, number>();
  for (const p of skipped) {
    if (p.plan.action === 'skip') reasons.set(p.plan.reason, (reasons.get(p.plan.reason) ?? 0) + 1);
  }
  for (const [reason, n] of [...reasons].sort()) console.log(`        ${String(n).padStart(4)}  ${reason}`);

  if (retitle.length > 0) {
    console.log(`\n${'─'.repeat(100)}\nRETITLE — ${retitle.length} row(s)`);
    for (const { row, plan } of retitle) {
      if (plan.action !== 'retitle') continue;
      console.log(`  ${row.id}  status=${row.status}`);
      console.log(`      from  ${row.title}`);
      console.log(`      to    ${plan.to}`);
      console.log(`      ${row.url}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${'─'.repeat(100)}\nSKIPPED — ${skipped.length} row(s), a review list`);
    for (const { row, plan } of skipped) {
      if (plan.action !== 'skip') continue;
      console.log(`  ${row.id}  ⚠ ${plan.reason}`);
      console.log(`      stored   ${row.title}`);
      console.log(`      rendered ${plan.rendered ?? '—'}`);
      console.log(`      ${row.url}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('repair-stale-titles', apply, 'REPAIR');
  console.log(`\n=== repair-stale-titles (${apply ? 'APPLY' : 'DRY RUN'}) ===`);

  const planned = await collectPlans();
  report(planned);

  const actionable = planned.filter((p) => p.plan.action === 'retitle');
  if (!apply) {
    console.log(`\nDry run — nothing written. Re-run with --apply to repair ${actionable.length} row(s).`);
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const p of actionable) {
    const outcome = await applyPlan(p);
    if (outcome.ok) ok += 1;
    else failed.push(`  ${p.row.id} → ${outcome.detail}`);
  }

  console.log(`\n${'─'.repeat(100)}\nAPPLIED\n  ${String(ok).padStart(5)}  retitle`);
  if (failed.length > 0) console.log(`\nnot applied:\n${failed.join('\n')}`);
  console.log(
    `\n⚠ ${ok} row(s) now have a stale embedding (the vector still carries the old title).` +
      `\n  Re-embed with:  npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/embed-resources.ts`,
  );
}

// Guarded so a test can import the planning seam without the driver running against whatever
// DATABASE_URL the suite is pointed at.
if (process.argv[1]?.endsWith('repair-stale-titles.ts')) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
