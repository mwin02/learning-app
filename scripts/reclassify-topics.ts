// Block 3 — one-time topic backfill.
//
// Pre-Block-2a discovery stamped the requesting path's topic onto every find,
// so resources whose content is broader/other than that label are mis-filed
// (e.g. a generic JavaScript tutorial filed under `javascript-react`, invisible
// to a `javascript` path). Block 2a fixed this going forward; this relabels the
// rows that already exist, reusing the same classifier.
//
//   Preview:  npx tsx --env-file=.env.local scripts/reclassify-topics.ts --dry-run
//   Apply:    npx tsx --env-file=.env.local scripts/reclassify-topics.ts
//
// Scope: every row (atomic AND containers) under a topic that HAS a related
// topic — that relation bound is the subject ceiling (a calculus row can't
// become linear-algebra). Each row is classified independently on its own
// title/summary/concepts: a decomposed container and its children may land on
// different topics when their content differs, which is correct. Containers are
// included on purpose — a mislabeled course (e.g. a JS-fundamentals course filed
// under javascript-react) is itself mis-filed, and excluding it would leave it
// inconsistent with its relabeled children. Idempotent: a correctly-filed row is
// re-confirmed and stays put. Relabeling only changes `topic`, which is in no
// unique constraint and doesn't affect the embedding (built from
// title+summary+concepts), so no re-embed is needed.

import type { ResourceStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { classifyDiscoveryTopics } from '../src/lib/agents/tools/classify-topic';
import { relatedTopics, TOPIC_RELATIONS } from '../src/types/resource';

const CHUNK = 40;
const STATUSES: ResourceStatus[] = ['active', 'pending_review'];

// Every topic that participates in a relation (either side) — the only topics
// whose rows are eligible to move.
function relatableTopics(): string[] {
  const s = new Set<string>();
  for (const [k, vs] of Object.entries(TOPIC_RELATIONS)) {
    s.add(k);
    for (const v of vs) s.add(v);
  }
  return [...s];
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  console.log(`[reclassify] mode=${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}`);

  const topics = relatableTopics();
  if (topics.length === 0) {
    console.log('[reclassify] no related topics defined; nothing to do.');
    return;
  }

  const rows = await prisma.resource.findMany({
    where: { topic: { in: topics }, status: { in: STATUSES } },
    select: { id: true, topic: true, url: true, title: true, summary: true, conceptsTaught: true },
  });
  console.log(`[reclassify] ${rows.length} rows across topics: ${topics.join(', ')}`);

  type Row = (typeof rows)[number];
  const byTopic = new Map<string, Row[]>();
  for (const r of rows) {
    const g = byTopic.get(r.topic);
    if (g) g.push(r);
    else byTopic.set(r.topic, [r]);
  }

  const moves: { id: string; title: string; from: string; to: string }[] = [];
  for (const [topic, group] of byTopic) {
    const candidates = relatedTopics(topic);
    if (candidates.length <= 1) continue; // no alternative home; can't move
    for (const part of chunk(group, CHUNK)) {
      const filed = await classifyDiscoveryTopics(
        part.map((r) => ({ url: r.url, title: r.title, summary: r.summary, conceptsTaught: r.conceptsTaught })),
        candidates,
        topic, // keep the current topic when the classifier is unsure
      );
      for (const r of part) {
        const to = filed.get(r.url) ?? topic;
        if (to !== topic) moves.push({ id: r.id, title: r.title, from: topic, to });
      }
    }
  }

  const tally: Record<string, number> = {};
  for (const mv of moves) {
    const key = `${mv.from} -> ${mv.to}`;
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`  [${mv.from} -> ${mv.to}] ${mv.id} ${mv.title.slice(0, 56)}`);
  }
  console.log(`[reclassify] ${moves.length} proposed move(s) of ${rows.length} rows:`, JSON.stringify(tally));

  if (dryRun) {
    console.log('[reclassify] DRY-RUN — no rows were modified.');
    return;
  }

  let applied = 0;
  for (const mv of moves) {
    await prisma.resource.update({ where: { id: mv.id }, data: { topic: mv.to } });
    applied += 1;
  }
  console.log(`[reclassify] applied ${applied} relabel(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
