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
import { Prisma } from '@prisma/client';

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

// Below this pool size a centroid is a mean of too few vectors to characterize its
// topic, so its margin is noise. The data doesn't pin the number down (every sampled
// topic cleared 5); 20 is the plan's conservative call, and being conservative here only
// costs a margin reading, never a filing decision.
export const MIN_CENTROID_MEMBERS = 20;

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

// Topic filing T4a — the FIRST consumer of TopicCentroid (it shipped unread in T2a).
//
// The margin is own-topic centroid similarity minus the best OTHER topic's. It is the
// scale-free instrument the 2026-07-25 calibration validated at 80.8% top-1, and the one
// that catches the motivating case (38 of the 45 mis-filed Khan "Functions" leaves flag
// at δ=0, where an absolute cosine only "caught" them by parking a quarter of the
// library).
//
// ⚠️ It is a REVIEW-PRIORITY signal here, NOT the cost pre-filter the plan sketched.
// Two measurements killed that role: (a) every membership we write needs a measured
// `relevance`, and only k-NN produces one, so k-NN must run for every row we write
// regardless — the pre-filter saves nothing on the rows that matter; (b) the only real
// cost it could save is the classifier LLM call, but at δ=0.05 **95.7% of rows clear the
// margin**, so gating on it would skip classification for nearly the entire backlog,
// which is the opposite of what the reclassification pass is for. T4e revisits whether a
// δ worth wiring as a cost gate exists once the labels are clean.
//
// Batched deliberately: one query per row would be 1,152 round-trips to a remote DB for
// a signal nothing branches on.
export type CentroidMargin = {
  own: number | null; // similarity to the row's own topic centroid
  best: string | null; // the nearest OTHER topic
  bestSim: number | null;
  margin: number | null; // own − bestSim; null when either side is missing
};

export async function centroidMargins(
  resourceIds: string[],
): Promise<Map<string, CentroidMargin>> {
  const out = new Map<string, CentroidMargin>();
  if (resourceIds.length === 0) return out;

  // `1 - (a <=> b)` is cosine SIMILARITY (`<=>` is cosine distance), matching the
  // orientation the calibration script reports in.
  //
  // The own-topic side is a LEFT JOIN, so a row whose topic has no qualifying centroid
  // still comes back — with nulls — rather than vanishing from the result and silently
  // dropping out of the report. The best-other side is a LATERAL, which is what lets the
  // per-row nearest rival be picked with the ORDER BY ... LIMIT 1 the planner can serve
  // from the small centroid table.
  const rows = await prisma.$queryRaw<
    { id: string; own: number | null; best: string | null; bestSim: number | null }[]
  >`
    SELECT r.id,
           CASE WHEN own.topic IS NOT NULL THEN 1 - (r.embedding <=> own.centroid) END AS own,
           other.topic AS best,
           other.sim AS "bestSim"
    FROM "Resource" r
    LEFT JOIN "TopicCentroid" own
      ON own.topic = r.topic AND own."memberCount" >= ${MIN_CENTROID_MEMBERS}
    LEFT JOIN LATERAL (
      SELECT c.topic, 1 - (r.embedding <=> c.centroid) AS sim
      FROM "TopicCentroid" c
      WHERE c.topic <> r.topic AND c."memberCount" >= ${MIN_CENTROID_MEMBERS}
      ORDER BY r.embedding <=> c.centroid
      LIMIT 1
    ) other ON true
    WHERE r.id IN (${Prisma.join(resourceIds)})
      AND r.embedding IS NOT NULL
  `;

  for (const r of rows) {
    out.set(r.id, {
      own: r.own,
      best: r.best,
      bestSim: r.bestSim,
      margin: r.own !== null && r.bestSim !== null ? r.own - r.bestSim : null,
    });
  }
  return out;
}
