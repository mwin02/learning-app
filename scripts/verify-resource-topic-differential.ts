// Topic filing T1 — differential harness for the ResourceTopic cutover.
//
// Runs the OLD scalar predicate (`topic IN (…)`) and the NEW membership predicate
// (buildConditions' EXISTS over ResourceTopic) over the same params, for every topic in
// the library plus the multi-topic sets real call sites request, and asserts the new side
// is a JUSTIFIED SUPERSET of the old. Also asserts the mirror invariant (the drift check
// for the setPrimaryTopic write seam) and, on the paths Vitest can't afford, that no row
// comes back twice.
//
// ⚠️ THE ASSERTION IS ONE-SIDED, AND WAS NOT ALWAYS. As written for T1 this asserted the
// two id sets were IDENTICAL, which was correct only while the membership table was
// exactly the mirror (one inherited primary per resource). That expired at **T4b**, whose
// quorum refile retains each vacated topic as an uncontested SECONDARY — 441 of them, the
// thing that made T4d's precondition real. The scalar column only ever sees the primary,
// so it structurally cannot return those rows, and the identity assertion started
// reporting the feature working as 6 failures. Restoring identity would mean deleting
// T4b's retention; the assertion is what was wrong, not the data.
//
// What is still checked, and is the property that actually matters:
//   - `missing` must be EMPTY — the membership predicate may never LOSE a row the scalar
//     returns. That is the no-regression half of the cutover and it is unconditional.
//   - every `extra` row must be EXPLAINED by an admitting non-primary membership in one
//     of the requested topics. An extra with no such membership is a real defect (a stray
//     membership, a contested-secondary leak, or a mirror that has drifted), so extras are
//     verified rather than tolerated.
//
// ⚠️ Scope, stated honestly: this validates the SQL REWRITE and the shape of the extras.
// It says nothing about whether any given filing is CORRECT — a green run is not evidence
// about T2+ filing behaviour.
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

// Extras are legitimate exactly when the membership table explains them: the row is
// reachable under one of the requested topics through a membership the scalar mirror
// cannot represent — a NON-PRIMARY, non-contested one. Returns the extras that have no
// such explanation, i.e. the genuine defects.
//
// Mirrors buildConditions' admission rule (`isPrimary OR NOT contested`) restricted to
// its secondary half; a contested secondary is excluded there, so it must not justify an
// extra here either.
async function unexplainedExtras(topics: string[], extra: string[]): Promise<string[]> {
  if (extra.length === 0) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "Resource" r
    WHERE r.id IN (${Prisma.join(extra)})
      AND EXISTS (
        SELECT 1 FROM "ResourceTopic" rt
        WHERE rt."resourceId" = r.id
          AND rt.topic IN (${Prisma.join(topics)})
          AND NOT rt."isPrimary"
          AND NOT rt.contested
      )
  `;
  const explained = new Set(rows.map((r) => r.id));
  return extra.filter((id) => !explained.has(id));
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
  const unexplained = await unexplainedExtras(topics, extra);

  const detail = [
    missing.length ? `missing=${missing.length}` : '',
    // A secondary-only extra is the expected post-T4b shape, so it is reported as
    // information rather than scored — but silently dropping the count would hide a
    // sudden jump in membership fan-out, which is worth seeing.
    extra.length ? `+${extra.length} via secondary${unexplained.length ? ` (${unexplained.length} UNEXPLAINED)` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  check(`${label} (${oldIds.length} rows)`, missing.length === 0 && unexplained.length === 0, detail);
  if (missing.length) console.log(`        missing sample:     ${missing.slice(0, 3).join(', ')}`);
  if (unexplained.length) console.log(`        unexplained sample: ${unexplained.slice(0, 3).join(', ')}`);
}

async function main() {
  const skipRanked = process.argv.includes('--skip-ranked');

  console.log('\n── mirror invariant (write-seam drift check) ──');
  await assertMembershipInvariants();

  // `, topic` is a DETERMINISM tiebreaker, not cosmetics: the playground-style section
  // below samples `slice(0, 3)`, and `probability-and-statistics` / `linear-algebra` are
  // currently tied at exactly 202 rows. With no tiebreaker Postgres returns ties in
  // arbitrary order, so that section silently tested a different topic run to run —
  // making a regression on the unlucky topic a coin flip.
  const topicRows = await prisma.$queryRaw<{ topic: string; c: number }[]>`
    SELECT topic, count(*)::int AS c FROM "Resource" GROUP BY topic ORDER BY c DESC, topic
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
