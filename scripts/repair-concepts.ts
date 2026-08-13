// Library-quality B1 + B2 — the one-time repair of the concepts P1 corrupted,
// followed by the re-embed and centroid refresh that repair invalidates.
//
//   npx tsx --env-file=.env.local scripts/repair-concepts.ts               # dry run
//   npx tsx --env-file=.env.local scripts/repair-concepts.ts --apply
//   npx tsx --env-file=.env.local scripts/repair-concepts.ts --apply --no-backfill
//   npx tsx --env-file=.env.local scripts/repair-concepts.ts --shared-arrays  # dry run only, see below
//
// Two passes with different risk profiles, separately flaggable on purpose:
//
//   REPAIR (--no-repair to skip). The 306 children whose `conceptsTaught` is
//   byte-for-byte their parent's — one silently-failed 25-item derivation batch
//   each. Re-runs deriveChildConcepts, which now carries Q1's retry/bisect, so a
//   batch that fails on one poisoned item recovers the other 24 instead of
//   inheriting wholesale again. Whatever still fails is written back with an
//   `inherited` stamp: honest, findable, and excluded from grounding — and NOT
//   re-attempted on the next run, because a row the model has already declined
//   at batch size 1 will decline again (`--retry-inherited` forces it, for when
//   the row's title/summary has since been improved).
//
//   BACKFILL (--no-backfill to skip). Q1's column defaults to `inherited` and
//   loadTopicVocab grounds only on `derived`, so until something stamps them,
//   ALL ~2,000 pre-Q1 rows are excluded from grounding — not just the 306.
//   This pass stamps (never rewrites) on the evidence each row already carries;
//   the decision table and its reasoning are in curation/concept-repair.ts.
//
// Then re-embed and refresh centroids, in that order and never the other way:
// a centroid is a mean over these very vectors, so refreshing before the embed
// would average the pre-repair library and leave the filing guardrail's
// pre-filter summarizing a corpus that no longer exists. Both writes are
// self-selecting — embedMissing takes `embeddedAt < updatedAt`, and every row
// either pass touched has a fresh `updatedAt`.
//
// ⚠️ Stop the compose workers first (`docker compose --profile workers stop
// worker`) — they poll the same DB and decompose into the rows this rewrites.
//
// `--shared-arrays` widens selection to siblings sharing an identical array
// (B1's wider set). It is implemented and deliberately NOT run: some sharing is
// legitimate — a genuine 4-part series on one concept — so it needs
// spot-checking first (open question 3). Use it for a dry run.

import { prisma } from '../src/lib/db';
import { CONCEPT_DERIVATION_CHUNK_SIZE } from '../src/lib/config';
import type { ConceptOrigin } from '@prisma/client';
import {
  deriveChildConcepts,
  resolveConcepts,
  type ResolvedConcepts,
} from '../src/lib/agents/decomposition/concepts';
import { embedMissing } from '../src/lib/ai/embeddings';
import { refreshTopicCentroids } from '../src/lib/curation/topic-centroids';
import {
  selectContaminated,
  selectRepairTargets,
  findChunkAlignedRuns,
  classifyExistingOrigin,
  type RepairRow,
} from '../src/lib/curation/concept-repair';
import { requireTargetAck } from './target-guard';

type Row = RepairRow & {
  slug: string;
  title: string;
  summary: string;
  parentSlug: string | null;
  parentTopic: string | null;
};

async function loadRows(): Promise<Row[]> {
  const rows = await prisma.resource.findMany({
    select: {
      id: true,
      slug: true,
      topic: true,
      title: true,
      summary: true,
      conceptsTaught: true,
      conceptOrigin: true,
      orderInParent: true,
      parentResourceId: true,
      parent: { select: { slug: true, topic: true, conceptsTaught: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    topic: r.topic,
    title: r.title,
    summary: r.summary,
    conceptsTaught: r.conceptsTaught,
    conceptOrigin: r.conceptOrigin,
    orderInParent: r.orderInParent,
    parentResourceId: r.parentResourceId,
    parentConcepts: r.parent ? r.parent.conceptsTaught : null,
    parentSlug: r.parent?.slug ?? null,
    parentTopic: r.parent?.topic ?? null,
  }));
}

// One transaction per row so a mid-run model failure leaves a partially repaired
// library rather than an all-or-nothing rollback of work that is already paid
// for — every write is independently correct, and a re-run picks up the rest.
async function writeRepair(id: string, stamp: ResolvedConcepts): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.resource.update({
      where: { id },
      data: {
        conceptsTaught: stamp.conceptsTaught,
        prerequisiteConcepts: stamp.prerequisiteConcepts,
        conceptOrigin: stamp.conceptOrigin,
      },
    });
    // This row's tags just changed, so every per-concept judge verdict recorded
    // against it was reached on the corrupted array. The schema comment on
    // ConceptCandidateRejection names this driver explicitly: rejection memory
    // has no TTL, invalidation follows the CAUSE, and nothing else will ever
    // give a repaired row a fresh judge.
    await tx.conceptCandidateRejection.deleteMany({ where: { resourceId: id } });
  });
}

async function repairPass(
  rows: Row[],
  opts: { apply: boolean; shared: boolean; retryInherited: boolean },
) {
  const { targets, unrecoverable } = selectRepairTargets(rows, opts);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const containers = new Map<string, Row[]>();
  for (const t of targets) {
    const full = byId.get(t.id);
    if (!full || full.parentResourceId === null) continue;
    const bucket = containers.get(full.parentResourceId);
    if (bucket) bucket.push(full);
    else containers.set(full.parentResourceId, [full]);
  }

  console.log(`\n[repair] ${targets.length} row(s) to repair across ${containers.size} container(s)`);
  if (unrecoverable.length > 0) {
    console.log(
      `[repair] ${unrecoverable.length} row(s) already attempted and undeducible — left stamped ` +
        `inherited. Their titles/summaries carry no concept signal; --retry-inherited re-attempts.`,
    );
  }
  for (const [parentId, kids] of containers) {
    const runs = findChunkAlignedRuns(
      kids.map((k) => k.orderInParent),
      CONCEPT_DERIVATION_CHUNK_SIZE,
    );
    console.log(
      `  ${kids[0].parentSlug ?? parentId}: ${kids.length} child(ren)` +
        (runs.length ? `  batch-runs ${runs.map((r) => `${r.start}-${r.end}`).join(', ')}` : ''),
    );
  }
  const byOrigin: Partial<Record<ConceptOrigin, number>> = {};
  if (!opts.apply) return { repaired: 0, byOrigin };

  let repaired = 0;
  for (const [, kids] of containers) {
    const topic = kids[0].parentTopic ?? kids[0].topic;
    const parentConcepts = kids[0].parentConcepts ?? [];
    const derived = await deriveChildConcepts({
      topic,
      parentConcepts,
      items: kids.map((k) => ({ ref: k.id, title: k.title, description: k.summary })),
    });
    for (const kid of kids) {
      const resolved = resolveConcepts({
        derived: derived.get(kid.id),
        parentConcepts,
        topic: kid.topic,
      });
      await writeRepair(kid.id, resolved);
      byOrigin[resolved.conceptOrigin] = (byOrigin[resolved.conceptOrigin] ?? 0) + 1;
      repaired += 1;
    }
    console.log(`  ${kids[0].parentSlug}: derived ${derived.size}/${kids.length}`);
  }
  return { repaired, byOrigin };
}

async function backfillPass(rows: Row[], apply: boolean) {
  // Reloaded by the caller after the repair pass, so a row the repair rewrote is
  // classified on its NEW array — which is what makes the two passes agree and a
  // second run a no-op.
  const want = rows.map((r) => ({ id: r.id, origin: classifyExistingOrigin(r) }));

  const current = new Map(
    (await prisma.resource.findMany({ select: { id: true, conceptOrigin: true } })).map((r) => [
      r.id,
      r.conceptOrigin,
    ]),
  );
  const changes = want.filter((w) => current.get(w.id) !== w.origin);

  const tally: Partial<Record<ConceptOrigin, number>> = {};
  for (const c of changes) tally[c.origin] = (tally[c.origin] ?? 0) + 1;
  console.log(`\n[backfill] ${changes.length} row(s) need a stamp change`, tally);
  if (!apply || changes.length === 0) return { changed: 0, tally };

  for (const origin of Object.keys(tally) as ConceptOrigin[]) {
    const ids = changes.filter((c) => c.origin === origin).map((c) => c.id);
    // Chunked so one statement never carries thousands of ids.
    for (let i = 0; i < ids.length; i += 500) {
      await prisma.resource.updateMany({
        where: { id: { in: ids.slice(i, i + 500) } },
        data: { conceptOrigin: origin },
      });
    }
  }
  return { changed: changes.length, tally };
}

async function report() {
  const rows = await loadRows();
  const echoes = selectContaminated(rows);
  const unstamped = echoes.filter((r) => r.conceptOrigin !== 'inherited');
  const byParent = new Map<string, (number | null)[]>();
  for (const e of echoes) {
    const key = e.parentResourceId ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), e.orderInParent]);
  }
  let runs = 0;
  for (const orders of byParent.values()) {
    runs += findChunkAlignedRuns(orders, CONCEPT_DERIVATION_CHUNK_SIZE).length;
  }
  const byOrigin = await prisma.resource.groupBy({ by: ['conceptOrigin'], _count: true });
  const stale = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "Resource"
    WHERE embedding IS NULL OR "embeddedAt" IS NULL OR "embeddedAt" < "updatedAt"`;
  console.log('\n=== post-run state ===');
  console.log({
    parentEchoRows: echoes.length,
    parentEchoRowsWithoutInheritedStamp: unstamped.length,
    batchRunsRemaining: runs,
    rowsNeedingReEmbed: stale[0].n,
  });
  console.table(Object.fromEntries(byOrigin.map((r) => [r.conceptOrigin, r._count])));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const shared = process.argv.includes('--shared-arrays');
  const retryInherited = process.argv.includes('--retry-inherited');
  const doRepair = !process.argv.includes('--no-repair');
  const doBackfill = !process.argv.includes('--no-backfill');
  const skipEmbed = process.argv.includes('--skip-embed');

  console.log(`\n=== repair-concepts (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  requireTargetAck('repair-concepts', apply, 'REWRITE concepts');
  if (shared) {
    console.log(
      '[repair] --shared-arrays: the wider set includes LEGITIMATE sharing (open question 3).',
    );
  }

  let touched = 0;
  if (doRepair) {
    const { repaired, byOrigin } = await repairPass(await loadRows(), {
      apply,
      shared,
      retryInherited,
    });
    if (apply) console.log(`[repair] rewrote ${repaired} row(s)`, byOrigin);
    touched += repaired;
  }
  if (doBackfill) {
    const { changed } = await backfillPass(await loadRows(), apply);
    if (apply) console.log(`[backfill] stamped ${changed} row(s)`);
    touched += changed;
  }

  if (apply && touched > 0 && !skipEmbed) {
    const embedded = await embedMissing();
    // Strictly after the embed — see the header.
    const { topics, removed } = await refreshTopicCentroids();
    console.log(
      `[embed] re-embedded ${embedded} row(s), refreshed ${topics} centroid(s)` +
        `${removed ? `, removed ${removed} stale` : ''}`,
    );
  } else if (apply && touched > 0) {
    console.log('[embed] SKIPPED (--skip-embed) — centroids are now stale.');
  }

  await report();
  if (!apply) console.log('\nDry run only. Re-run with --apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
