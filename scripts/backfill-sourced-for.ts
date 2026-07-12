// Library re-judge Block 5 — one-off, operator-assisted backfill of
// ResourceSourcedFor for rows already sitting in the decomposition queue (they
// predate the provenance table, so the decompose-time hook would no-op on them).
//
// For each queued row (decompositionStatus pending|human_review), ranks the
// concepts of the path(s) on the row's topic by embedding similarity to the row
// (query-embedding of the row's title/summary/concepts vs each concept title —
// neither side has a stored vector: queued containers are never embedded, and
// concepts have no embedding column), prints the proposed (resource → concept)
// pairs, and writes them only with --apply. This is a curation aid, not an
// agent: review the dry-run output before applying. Idempotent — the write is
// createMany … skipDuplicates, and rows that already carry a pair are flagged.
//
// Run:  npx tsx --env-file=.env.local scripts/backfill-sourced-for.ts [--apply]
//
// A proposed pair only makes the row VISIBLE to the decompose-time hook; the
// hook re-routes children semantically across the whole path and the candidate
// judge gates quality, so a borderline proposal is self-correcting downstream.

import { prisma } from '../src/lib/db';
import { embedQuery, embedTexts, buildEmbeddingText } from '../src/lib/ai/embeddings';
import { REJUDGE_ROUTE_MAX_DISTANCE } from '../src/lib/config';

// Concepts shown per row in the ranking printout (proposals are the ones at or
// under the distance ceiling, capped at MAX_PROPOSALS_PER_ROW).
const RANKING_SHOWN = 5;
const MAX_PROPOSALS_PER_ROW = 3;

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const apply = process.argv.includes('--apply');

  const queued = await prisma.resource.findMany({
    where: { decompositionStatus: { in: ['pending', 'human_review'] } },
    select: {
      id: true,
      topic: true,
      title: true,
      summary: true,
      conceptsTaught: true,
      durationMin: true,
      sourcedFor: { select: { conceptId: true } },
    },
    orderBy: [{ topic: 'asc' }, { createdAt: 'asc' }],
  });
  console.log(`queued rows: ${queued.length}  (mode: ${apply ? 'APPLY' : 'dry-run'})\n`);

  // Concepts of every path on a queued topic, embedded once each (batched).
  const topics = [...new Set(queued.map((r) => r.topic))];
  const paths = await prisma.path.findMany({
    where: { topic: { in: topics } },
    select: { id: true, topic: true, concepts: { select: { id: true, slug: true, title: true } } },
  });
  const conceptsByTopic = new Map<string, { id: string; slug: string; title: string }[]>();
  for (const p of paths) {
    conceptsByTopic.set(p.topic, [...(conceptsByTopic.get(p.topic) ?? []), ...p.concepts]);
  }
  const allConcepts = paths.flatMap((p) => p.concepts);
  const conceptVecs = new Map<string, number[]>();
  const vecs = await embedTexts(allConcepts.map((c) => c.title));
  allConcepts.forEach((c, i) => conceptVecs.set(c.id, vecs[i]));

  const proposals: { resourceId: string; conceptId: string }[] = [];
  for (const row of queued) {
    const concepts = conceptsByTopic.get(row.topic) ?? [];
    const existing = row.sourcedFor.length;
    console.log(`## ${row.title}  [${row.topic}, ${row.durationMin}m, ${row.id}]${existing > 0 ? `  — already has ${existing} pair(s)` : ''}`);
    if (concepts.length === 0) {
      console.log('   (no path on this topic — nothing to propose)\n');
      continue;
    }

    const rowVec = await embedQuery(buildEmbeddingText(row));
    const ranked = concepts
      .map((c) => ({ ...c, distance: cosineDistance(rowVec, conceptVecs.get(c.id)!) }))
      .sort((a, b) => a.distance - b.distance);

    const proposed = ranked
      .filter((c) => c.distance <= REJUDGE_ROUTE_MAX_DISTANCE)
      .slice(0, MAX_PROPOSALS_PER_ROW);
    const proposedIds = new Set(proposed.map((c) => c.id));
    for (const c of ranked.slice(0, RANKING_SHOWN)) {
      console.log(`   ${proposedIds.has(c.id) ? '→ PROPOSE' : '         '}  d=${c.distance.toFixed(3)}  ${c.slug}`);
    }
    if (proposed.length === 0) console.log('   (no concept under the distance ceiling)');
    console.log();
    proposals.push(...proposed.map((c) => ({ resourceId: row.id, conceptId: c.id })));
  }

  console.log(`proposed pairs: ${proposals.length}`);
  if (!apply) {
    console.log('dry-run only — re-run with --apply to write them.');
  } else if (proposals.length > 0) {
    const { count } = await prisma.resourceSourcedFor.createMany({
      data: proposals,
      skipDuplicates: true,
    });
    console.log(`written: ${count} (duplicates skipped: ${proposals.length - count})`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
