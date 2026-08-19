// The escalation `sweep-serveability.ts` refuses, decided by the one signal it does not read.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/resolve-type-url-conflicts.ts
//   … scripts/resolve-type-url-conflicts.ts --apply --target-host=<hostname>
//
// DRY RUN IS THE DEFAULT AND THERE IS NO `--yes`, inherited from the sweep along with
// `requireTargetAck` and the rule that matters most:
//
// THE POPULATION IS WHATEVER THE CLASSIFIER SAYS. Not one resource id is written down here.
// A row is in scope iff `classifyMetadataIntegrity` reports `type-url-page-conflict` — the
// exact set the sweep prints under `⚠ ESCALATION` and leaves untouched, so the two drivers
// partition that population the same way the sweep and `repoint-khan-pt.ts` do.
//
// ── WHY THE CONFLICT IS UNRESOLVABLE AS A RE-TYPE, AND RESOLVABLE AS A URL ────────────────
//
// C3's finding says the row's URL kind and its page's declared kind contradict EACH OTHER: a
// Khan `/a/` URL that client-side redirects to a `/v/` video. No stored `type` satisfies
// both, which is why applying either re-type flipped three production rows back and forth on
// every pass. The sweep therefore refuses, correctly — a re-type cannot fix a row whose two
// form signals disagree.
//
// But the disagreement is not really about the form. It is about the URL: the row points at
// an address Khan no longer serves that content from, and the probe already recorded where
// it lands. Move the URL to the landed one and BOTH signals become `video` — the conflict is
// retired rather than parked, and the row's `type` never has to move. That is the whole
// repair, and it is why this is a separate driver: it needs a write the sweep may not make.
//
// ── TWO OUTCOMES, AND THE URL COLLISION IS WHAT PICKS BETWEEN THEM ────────────────────────
//
//   repoint   — the landed URL is free. `url` moves to it. Nothing else changes.
//   deprecate — the landed URL is ALREADY a row. Then this row is a duplicate of a lesson
//               the library already files under its correct address, and the repair is
//               `applyPendingReview({ action: 'reject', severity: 'soft' })` — the only seam
//               that also drops `ConceptResource` links and recomputes Path readiness.
//               `soft`, never `hard`: the page works, we simply keep one copy.
//
// The collision is asked FIRST, ahead of every form guard below — see `planFor`, where the
// ordering is the difference between deprecating a duplicate and escalating it over a type
// the repair never touches.
//
// This is `repoint-khan-pt.ts`'s collision rule and it is load-bearing for the same reason:
// `Resource.url` is `@unique`, so the repoint is impossible against an incumbent. Checked
// BEFORE writing rather than by catching a 23505 — a constraint error names that a row
// exists, not which one, and a failed write mid-loop leaves the operator guessing which half
// of the run applied.
//
// ⚠️ AND "ALREADY FILED" IS ONLY TRUE OF AN INCUMBENT THAT CAN STILL BE SERVED, so the
// holder lookup is filtered to the actionable statuses. A DEPRECATED row at the landed URL
// blocks the repoint just as hard (the constraint does not care that it is retired) while
// making the deprecation dishonest — it would retire the second copy of a lesson whose first
// copy is already retired, leaving the content unservable from both. Such a row is an
// ESCALATION, exactly as in `repoint-khan-pt.ts`: refuse both, print loudly, touch nothing.
//
// ── THE GUARDS, AND WHY EACH ONE REFUSES RATHER THAN GUESSES ──────────────────────────────
//
//   • the row is outside the write window — `deprecated` (already decided), or sitting in
//     the decomposition queue (the reject seam refuses it, and a repoint would move the URL
//     out from under the decomposition about to run on it).
//   • no probe — the landed URL is the entire evidence base. Without it there is nothing to
//     repoint AT, and a row with no evidence has not been looked at.
//
// The last two are REPOINT-ONLY and are read after the collision, never before it:
//
//   • the landed URL is not a Khan content-kind URL — then it is not the lesson's new
//     address, it is a unit page or something else, and repointing would file a container as
//     a leaf (clause 3).
//   • the stored `type` does not match the page's declared kind — repointing would leave a
//     row whose form still disagrees with what it now points at, trading a URL defect for a
//     type defect. The re-type that would fix it is the one C3 proved untrustworthy here, so
//     the honest move is to escalate the pair rather than fix half of it.
//
// ── WHY THIS WRITES `url` DIRECTLY ────────────────────────────────────────────────────────
//
// `ResourceUpdateFields` deliberately omits `url`: it is the row's IDENTITY, the unique
// column every dedup path collapses onto, and nothing here is a reason to widen an edit
// whitelist. `repoint-khan-pt.ts` made the same call for the same repair and carries the
// same justification. The property the direct write preserves is the point: a field update
// does NOT touch `ConceptResource`, which is the opposite of `applyPendingReview` — a
// repointed row keeps its concept links, because it is still the same lesson.
//
// ⚠️ EVIDENCE IS NOT REPRODUCIBLE FROM A FRESH CLONE. The landed URLs come from the probe
// artifacts in `docs/audits/khan-batch-*.json*` via `sweep-serveability.ts`'s own
// `readBatches`, so both drivers resolve a re-probed resource identically — and that
// directory is git-ignored. Where no artifact exists a row is unresolvable, which escalates
// rather than repairs, so missing evidence is conservative.
//
// Idempotent by construction: a repointed row's URL kind now agrees with its page, so
// `type-url-page-conflict` no longer fires on it and it leaves the population; a deprecated
// row is outside the actionable statuses. A second run finds nothing.

import type { DecompositionStatus, ResourceStatus, ResourceType } from '@prisma/client';
import { classifyMetadataIntegrity } from '../src/lib/curation/metadata-integrity';
import { applyPendingReview } from '../src/lib/curation/pending-review';
import { isKhanUrl, urlKind } from '../src/lib/curation/serveability';
import type { ProbeEvidence } from '../src/lib/curation/serveability-probe';
import { prisma } from '../src/lib/db';
import { readBatches } from './sweep-serveability';
import { requireTargetAck } from './target-guard';

// The window this driver may write in, and the window an incumbent must be in to count as
// "already filed". Same set `sweep-serveability.ts` uses, and it is the same argument: a
// deprecated row has already been decided.
const ACTIONABLE: ResourceStatus[] = ['active', 'pending_review'];

// `applyPendingReview` refuses a reject on either of these (`blocked`), so the deprecate
// branch is unavailable — and repointing a row whose shape is still unsettled would move the
// URL out from under the decomposition about to run on it.
const UNRESOLVED: DecompositionStatus[] = ['pending', 'human_review'];

// The page kinds a landed URL may carry — Khan's two content kinds, mapped to the stored
// form each implies. A landing or unit page has no kind and is refused above.
const KIND_TYPE: Record<string, ResourceType> = { a: 'article', v: 'video' };

type Row = {
  id: string;
  url: string;
  title: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
};

type Plan =
  | { action: 'repoint'; to: string }
  | { action: 'deprecate'; holderId: string; holderTitle: string; to: string }
  | { action: 'escalate'; reason: string };

export type Planned = { row: Row; landed: string | null; plan: Plan };

export function planFor(
  row: Row,
  probe: ProbeEvidence | null,
  holder: { id: string; title: string; status: ResourceStatus } | null,
): Plan {
  // Whether this driver may write at all, asked before anything about the repair. A
  // `deprecated` row has already been decided, and re-deciding it would let a classifier
  // change silently re-open a closed call — the same argument, and the same window, as
  // `sweep-serveability.ts`.
  if (!ACTIONABLE.includes(row.status)) {
    return { action: 'escalate', reason: `already decided (status=${row.status})` };
  }
  if (UNRESOLVED.includes(row.decompositionStatus)) {
    return { action: 'escalate', reason: `in the decomposition queue (${row.decompositionStatus})` };
  }

  // Guards on the EVIDENCE, which both outcomes need: without a landed Khan URL there is
  // neither an address to move to nor an incumbent to be a duplicate of.
  if (!probe) return { action: 'escalate', reason: 'no probe — nothing to repoint at' };

  const landed = probe.url;
  if (!isKhanUrl(landed)) return { action: 'escalate', reason: `landed off Khan: ${landed}` };

  // ⚠️ THE COLLISION IS CHECKED BEFORE THE FORM GUARDS BELOW, and the order is the whole
  // correctness of this function. Those guards ask whether a REPOINT would leave the row
  // describing itself wrongly — a question the deprecate branch never asks, because a
  // duplicate is a duplicate whatever it is typed and the incumbent is the row that gets
  // served either way. Read first, they escalate rows that need no judgment at all: the
  // production `interactive` duplicate came back as an escalation on a type the repair was
  // never going to touch. This is `library-enforcement.md`'s composition warning in one
  // function — two individually-correct refusals refusing a row neither of them meant to.
  if (holder !== null) {
    if (!ACTIONABLE.includes(holder.status)) {
      return {
        action: 'escalate',
        reason: `landed URL is held by DEPRECATED row ${holder.id} — repoint blocked by the unique constraint, deprecation dishonest`,
      };
    }
    return { action: 'deprecate', holderId: holder.id, holderTitle: holder.title, to: landed };
  }

  // Repoint-only from here: the row is about to CLAIM the landed URL, so it has to be able
  // to describe it honestly once it does.
  const landedKind = urlKind(landed);
  const landedType = landedKind === null ? undefined : KIND_TYPE[landedKind];
  if (!landedType) {
    return { action: 'escalate', reason: `landed URL names no content kind: ${landed}` };
  }
  if (row.type !== landedType) {
    return {
      action: 'escalate',
      reason: `stored type '${row.type}' but the landed page is a ${landedType} — a repoint would leave the form wrong`,
    };
  }

  return { action: 'repoint', to: landed };
}

export async function collectPlans(
  probes: Map<string, ProbeEvidence | null> = readBatches(),
): Promise<Planned[]> {
  const rows = await prisma.resource.findMany({
    select: { id: true, url: true, title: true, type: true, status: true, decompositionStatus: true },
    orderBy: { id: 'asc' },
  });

  // The classifier decides membership, over the same artifacts the sweep reads, so the set
  // below is the sweep's `⚠ ESCALATION` block and nothing else.
  const inScope = rows.filter((row) => {
    const meta = classifyMetadataIntegrity(row, probes.get(row.id) ?? null);
    const found = meta.pageChecked ? meta.discrepancies : meta.rowDiscrepancies;
    return found.some((d) => d.kind === 'type-url-page-conflict');
  });

  const landedUrls = inScope
    .map((row) => probes.get(row.id)?.url)
    .filter((u): u is string => typeof u === 'string');
  const holders = new Map(
    (
      await prisma.resource.findMany({
        where: { url: { in: landedUrls } },
        select: { id: true, url: true, title: true, status: true },
      })
    ).map((h) => [h.url, h]),
  );

  return inScope.map((row) => {
    const probe = probes.get(row.id) ?? null;
    const landed = probe?.url ?? null;
    // A row can only collide with a DIFFERENT row; its own URL is never the incumbent.
    const holder = landed === null ? null : holders.get(landed) ?? null;
    return {
      row,
      landed,
      plan: planFor(row, probe, holder && holder.id !== row.id ? holder : null),
    };
  });
}

export async function applyPlan({ row, plan }: Planned): Promise<{ ok: boolean; detail: string }> {
  if (plan.action === 'repoint') {
    // Direct write, not `updateResource` — see the header. Conditional on the URL this run
    // planned against, so a row edited between the dry run and the apply is skipped rather
    // than overwritten.
    const { count } = await prisma.resource.updateMany({
      where: { id: row.id, url: row.url },
      data: { url: plan.to },
    });
    return count === 1 ? { ok: true, detail: `url → ${plan.to}` } : { ok: false, detail: 'raced' };
  }
  if (plan.action === 'deprecate') {
    // cascade: false — the population is per-row by construction, and a cascade would reach
    // rows no classifier looked at.
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
  return { ok: false, detail: 'escalation — not applied' };
}

function report(planned: Planned[]) {
  const by = (a: Plan['action']) => planned.filter((p) => p.plan.action === a);
  console.log(`\n${planned.length} row(s) reported \`type-url-page-conflict\` — the sweep's escalation set`);
  console.log(`\n  ${String(by('repoint').length).padStart(3)}  REPOINT   — the landed URL is free; url moves, nothing else`);
  console.log(`  ${String(by('deprecate').length).padStart(3)}  DEPRECATE — the landed URL is already filed; this row is the duplicate (soft)`);
  console.log(`  ${String(by('escalate').length).padStart(3)}  ⚠ ESCALATE — left untouched`);

  for (const action of ['repoint', 'deprecate', 'escalate'] as const) {
    const rows = by(action);
    if (rows.length === 0) continue;
    console.log(`\n${'─'.repeat(100)}\n${action.toUpperCase()} — ${rows.length} row(s)`);
    for (const { row, plan } of rows) {
      console.log(`  ${row.id}  status=${row.status}  type=${row.type}`);
      console.log(`      ${row.title}`);
      console.log(`      from  ${row.url}`);
      if (plan.action === 'repoint') console.log(`      to    ${plan.to}`);
      if (plan.action === 'deprecate') {
        console.log(`      lands ${plan.to}`);
        console.log(`      held by ${plan.holderId}  "${plan.holderTitle}"`);
      }
      if (plan.action === 'escalate') console.log(`      ⚠ ${plan.reason}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('resolve-type-url-conflicts', apply, 'REPAIR');
  console.log(`\n=== resolve-type-url-conflicts (${apply ? 'APPLY' : 'DRY RUN'}) ===`);

  const planned = await collectPlans();
  report(planned);

  const actionable = planned.filter((p) => p.plan.action !== 'escalate');
  if (!apply) {
    console.log(`\nDry run — nothing written. Re-run with --apply to repair ${actionable.length} row(s).`);
    return;
  }

  const tally = new Map<string, number>();
  const failed: string[] = [];
  for (const p of actionable) {
    const outcome = await applyPlan(p);
    const key = outcome.ok ? p.plan.action : `${p.plan.action} FAILED`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (!outcome.ok) failed.push(`  ${p.plan.action} ${p.row.id} → ${outcome.detail}`);
  }

  console.log(`\n${'─'.repeat(100)}\nAPPLIED`);
  for (const [k, v] of [...tally].sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
  if (failed.length > 0) console.log(`\nnot applied:\n${failed.join('\n')}`);
}

// Guarded so a test can import the planning seam without the driver running against whatever
// DATABASE_URL the suite is pointed at.
if (process.argv[1]?.endsWith('resolve-type-url-conflicts.ts')) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
