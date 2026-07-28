// Topic filing T1 — differential harness for the ResourceTopic cutover.
//
// Runs the OLD scalar predicate (`topic IN (…)`) and the NEW membership predicate
// (buildConditions' EXISTS over ResourceTopic) over the same params, for every topic in
// the library plus the multi-topic sets real call sites request, and asserts the returned
// id sets are identical. Also asserts the mirror invariant (the drift check for the
// setPrimaryTopic write seam) and, on the paths Vitest can't afford, that no row comes
// back twice.
//
// ⚠️ Scope, stated honestly: pre-T2 the membership table is EXACTLY the mirror (one
// inherited primary per resource), so an identical id set validates the SQL REWRITE and
// nothing else. It says nothing about filing behaviour, and a green run here is not
// evidence about T2+.
//
// Costs two embedding calls (the ranked path and searchNearbyResources — the two paths
// kept out of tests/integration per CLAUDE.md); pass --skip-ranked to omit them.
//
// Run:  npx tsx --env-file=.env.local scripts/verify-resource-topic-differential.ts [--skip-ranked]

import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import {
  buildConditions,
  searchResources,
  searchNearbyResources,
  type SearchParams,
} from '../src/lib/agents/tools/search-resources';
import { assertMembershipInvariants } from '../src/lib/curation/resource-topics';
import { relatedTopics } from '../src/types/resource';
import { REJUDGE_ROUTE_MAX_DISTANCE } from '../src/lib/config';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// The old predicate, preserved verbatim from the pre-T1 buildConditions so the comparison
// is against what actually shipped, not a paraphrase of it.
function legacyTopicClause(topics: string[]): Prisma.Sql {
  return Prisma.sql`topic IN (${Prisma.join(topics)})`;
}

async function idsFor(where: Prisma.Sql): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Resource" WHERE ${where} ORDER BY id
  `;
  return rows.map((r) => r.id);
}

// Everything except the topic clause, so both sides differ in exactly one predicate.
function nonTopicConditions(params: SearchParams): Prisma.Sql[] {
  return buildConditions({ ...params, topic: undefined, topics: undefined });
}

async function differential(label: string, topics: string[], params: SearchParams) {
  const rest = nonTopicConditions(params);
  const oldWhere = Prisma.join([legacyTopicClause(topics), ...rest], ' AND ');
  const newWhere = Prisma.join(buildConditions({ ...params, topics }), ' AND ');

  const [oldIds, newIds] = await Promise.all([idsFor(oldWhere), idsFor(newWhere)]);
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const missing = oldIds.filter((id) => !newSet.has(id));
  const extra = newIds.filter((id) => !oldSet.has(id));

  check(
    `${label} (${oldIds.length} rows)`,
    missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `missing=${missing.length} extra=${extra.length}` : '',
  );
  if (missing.length) console.log(`        missing sample: ${missing.slice(0, 3).join(', ')}`);
  if (extra.length) console.log(`        extra sample:   ${extra.slice(0, 3).join(', ')}`);
}

async function main() {
  const skipRanked = process.argv.includes('--skip-ranked');

  console.log('\n── mirror invariant (write-seam drift check) ──');
  await assertMembershipInvariants();

  const topicRows = await prisma.$queryRaw<{ topic: string; c: number }[]>`
    SELECT topic, count(*)::int AS c FROM "Resource" GROUP BY topic ORDER BY c DESC
  `;

  console.log('\n── differential: every topic, retrieval defaults (pickable, active+pending) ──');
  for (const { topic } of topicRows) {
    await differential(topic, [topic], {});
  }

  console.log('\n── differential: multi-topic sets, as the live call sites request them ──');
  // attach-candidates / the playground picker / the web-fallback library rung all widen
  // through relatedTopics() today, and T1 deliberately leaves that scoping unchanged.
  const widened = [...new Set(topicRows.map((r) => r.topic))]
    .map((t) => relatedTopics(t))
    .filter((set) => set.length > 1);
  for (const set of widened) {
    await differential(`relatedTopics: ${set.join(' + ')}`, set, { excludeGenerated: true });
  }

  console.log('\n── differential: playground-style params (containers, wider status window) ──');
  for (const { topic } of topicRows.slice(0, 3)) {
    await differential(`${topic} [containers]`, [topic], {
      decompositionStatuses: ['decomposed', 'pending', 'human_review'],
      statuses: ['active', 'pending_review', 'deprecated'],
    });
  }

  // Duplicate-freeness on the two embedding-spending paths. The unit test pins the clause
  // shape and the integration test covers the two free paths; these are what's left.
  if (!skipRanked) {
    const biggest = topicRows[0]?.topic;
    const set = biggest ? relatedTopics(biggest) : [];
    if (set.length > 0) {
      console.log(`\n── ranked path + nearby (2 embedding calls, topics: ${set.join(', ')}) ──`);
      const ranked = await searchResources({ topics: set, query: 'introduction to the basics', limit: 50 });
      const rankedIds = ranked.map((r) => r.id);
      check('ranked path returns no duplicate ids', new Set(rankedIds).size === rankedIds.length);

      const nearby = await searchNearbyResources({
        topics: set,
        query: 'introduction to the basics',
        maxDistance: REJUDGE_ROUTE_MAX_DISTANCE,
        limit: 50,
      });
      const nearbyIds = nearby.map((r) => r.id);
      check('searchNearbyResources returns no duplicate ids', new Set(nearbyIds).size === nearbyIds.length);
    }
  }

  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
