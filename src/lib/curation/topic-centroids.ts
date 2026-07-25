// Topic filing T2a — maintenance of the `TopicCentroid` table.
//
// One row per topic holding the mean embedding of that topic's pool. It is the cheap
// PRE-FILTER input for the T2b filing guardrail (margin = own-centroid similarity minus
// the best other centroid); the expensive k-NN purity check only runs for rows the
// margin leaves contested. See docs/topic-filing-plan.md § "Centroid table".
//
// `TopicCentroid.centroid` is a required pgvector column Prisma can't model, so — like
// `Resource.embedding` — every read and write is raw SQL and lives here.

import { prisma } from '@/lib/db';

// The pool a centroid is computed over. This deliberately MATCHES the query
// scripts/calibrate-topic-threshold.ts ran on 2026-07-25, which is where δ=0.05 / k=10
// come from: calibrating on one population and operating on another would silently move
// the operating point. It is wider than the plan's one-line "the topic's `active`
// embeddings" — active-only drops `machine-learning` to 19 members (under T2b's
// MIN_CENTROID_MEMBERS) and admits leftover `__verify_*` test topics, while ~60% of the
// library is `pending_review` discovery that legitimately characterizes its topic.
//
//   - embedded, atomic, non-`generated` (generated rows are our own text, not sources)
//   - status active | pending_review
//   - grouped by MEMBERSHIP (`ResourceTopic`), not the `Resource.topic` mirror: identical
//     today, but from T2b/T3 a resource's secondary topics are real memberships that
//     should feed those topics' centroids.
//   - contested SECONDARIES excluded (same rule retrieval applies); a contested primary
//     still counts, since we never orphan a row.
export type CentroidRefresh = { topics: number; removed: number };

export async function refreshTopicCentroids(): Promise<CentroidRefresh> {
  // One stamp for the whole run: rows that don't carry it afterwards are topics whose
  // pool has emptied, so their centroid is stale and gets deleted. Saves recomputing the
  // aggregate a second time just to know which topics still exist.
  const stamp = new Date();

  const [topics, removed] = await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "TopicCentroid" (topic, centroid, "memberCount", "computedAt")
      SELECT rt.topic, AVG(r.embedding)::vector, count(*)::int, ${stamp}
      FROM "ResourceTopic" rt
      JOIN "Resource" r ON r.id = rt."resourceId"
      WHERE r.embedding IS NOT NULL
        AND r."decompositionStatus"::text = 'atomic'
        AND r.status::text IN ('active', 'pending_review')
        AND r.origin::text <> 'generated'
        AND NOT (rt.contested AND NOT rt."isPrimary")
      GROUP BY rt.topic
      ON CONFLICT (topic) DO UPDATE SET
        centroid = EXCLUDED.centroid,
        "memberCount" = EXCLUDED."memberCount",
        "computedAt" = EXCLUDED."computedAt"
    `,
    prisma.$executeRaw`DELETE FROM "TopicCentroid" WHERE "computedAt" <> ${stamp}`,
  ]);

  return { topics, removed };
}
