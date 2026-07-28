// Topic filing T2b — the filing guardrail that replaces the TOPIC_RELATIONS ceiling.
//
// The old bound on filing was a hand-written edge list: a discovery could only be filed
// under `relatedTopics(requestTopic)`, which has five keys, so 60% of the library was
// stamped with the searched topic and no classification at all. T2b opens the vocabulary
// to every canonical (listCanonicals()) and replaces the edge list with EVIDENCE: does
// the resource's embedding actually sit among that topic's resources?
//
// The instrument is k-NN LABEL PURITY, chosen by measurement, not taste
// (scripts/calibrate-topic-threshold.ts, 2026-07-25, 1,832 rows / 11 topics):
//
//   absolute cosine to a topic centroid   Youden J 0.453   ❌ rejected — a technical
//                                                            corpus clusters too tightly
//                                                            (own p50 0.757 vs best-other
//                                                            0.688; the distributions
//                                                            almost completely overlap)
//   relative margin (own − best other)    80.8% top-1     ✅ viable as a flagger
//   k-NN plurality, k=10                  88.7%           ✅ strongest — adopted
//
// k-NN also handles multi-modal topics, which a single mean vector represents badly —
// and most of our topics are multi-modal.
//
// The margin pre-filter the plan proposed (skip k-NN when the margin clears δ) is NOT
// implemented here: it would leave pre-filtered memberships with no measured purity to
// record in `relevance`, and the query it saves is one indexed pgvector lookup on a
// batch of 3-10 rows. TopicCentroid (T2a) therefore stays unconsumed until T4, where
// skipping k-NN across 1,152 rows actually pays.
//
// ⚠️ This guardrail NEVER auto-refiles an existing row. Per the plan's motivating case,
// disagreement means "the current label is contested", not "the alternative is right":
// the 45 mis-filed Khan "Functions" leaves are correctly DETECTED (38/45 flagged) but
// their nearest other centroids are `calculus-for-machine-learning` and `calculus` —
// both wrong, because the right answer (`algebra`) is not in the vocabulary. Detection
// works; correction does not. T3's minting is what fixes that class.

import { prisma } from '@/lib/db';
import type { TopicFilingOrigin } from '@prisma/client';

// k from the calibration run. Re-verify after T4's backfill cleans the labels.
export const KNN_K = 10;

// A secondary membership needs this share of the k neighbours. UNCALIBRATED — the
// calibration measured top-1 plurality agreement, not a secondary-label distribution,
// so 0.2 (2 of 10 neighbours) is a deliberately conservative starting point. T4's
// recalibration is where it gets settled; until then it only ever ADDS reachability,
// and the membership cap bounds the blast radius.
export const MIN_SECONDARY_PURITY = 0.2;

// Hard cap on memberships per resource (primary + guarded secondaries; T3's collision
// rows count against it too). The guard against a generic "intro to programming" page
// joining every CS topic.
export const MAX_MEMBERSHIPS = 3;

// Below this pool size the k-NN instrument CANNOT vouch for a topic — its label can
// never hold a plurality among 10 neighbours if it has fewer than 10 members in the
// whole library. Measured 2026-07-25: 10 of the 20 canonicals have NO pool at all
// (`precalculus`, `javascript`, `statistics`, `data-structures-algorithms`, …), so
// without this row the guardrail would reject every correct proposal for half the
// vocabulary and the "self-widening" property would deadlock — an empty pool could
// never start filling. Such proposals are accepted with `contested = true` instead:
// same treatment T3 gives a freshly minted topic, and contested primaries stay
// retrievable, so the topic's pool can begin to grow while review keeps the receipts.
export const MIN_VOUCHABLE_POOL = KNN_K;

export type FilingMembership = {
  topic: string;
  relevance: number;
  origin: TopicFilingOrigin;
  contested: boolean;
};

// What upsertResource writes: exactly one primary (mirrored to Resource.topic via the
// setPrimaryTopic seam) plus zero or more guarded secondaries.
export type FilingDecision = {
  primary: FilingMembership;
  secondaries: FilingMembership[];
  // Why the primary is what it is — carried into the discovery log so a filing run is
  // auditable without re-deriving it.
  reason: 'classifier' | 'unvouchable-pool' | 'rejected' | 'no-evidence';
};

export type FilingInput = {
  // Ranked proposals from classifyDiscoveryTopics, most confident first. Empty when the
  // classifier failed or returned nothing usable.
  proposals: string[];
  // The topic whose discovery run found this resource — today's filing behaviour and
  // the fallback whenever evidence is missing or contradicts.
  requestTopic: string;
  // Primary topics of the k nearest embedded neighbours. Empty when the resource has no
  // embedding, or the library has none.
  neighbourTopics: string[];
  // Pool size per topic, live. Only membership in this map at >= MIN_VOUCHABLE_POOL
  // makes a topic vouchable.
  pools: Map<string, number>;
};

function purity(neighbourTopics: string[], topic: string): number {
  if (neighbourTopics.length === 0) return 0;
  let hits = 0;
  for (const t of neighbourTopics) if (t === topic) hits++;
  return hits / neighbourTopics.length;
}

// The plurality label, or null when the neighbours are empty or TIE. A tie is not a
// verdict — it is exactly the "we can't tell" case the contested flag exists for.
function plurality(neighbourTopics: string[]): string | null {
  const counts = new Map<string, number>();
  for (const t of neighbourTopics) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  // Sorted so the scan is deterministic regardless of neighbour ordering.
  for (const [topic, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) {
      best = topic;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

// PURE. The whole filing decision matrix, so it can be unit-tested exhaustively without
// a DB, an LLM, or an embedding. Every branch either files under an evidence-backed
// topic or degrades to the request topic — never worse than pre-T2b behaviour.
export function decideFiling(input: FilingInput): FilingDecision {
  const { proposals, requestTopic, neighbourTopics, pools } = input;

  const fallback = (
    reason: FilingDecision['reason'],
    contested: boolean,
  ): FilingDecision => ({
    primary: {
      topic: requestTopic,
      relevance: purity(neighbourTopics, requestTopic),
      origin: 'discovery',
      contested,
    },
    secondaries: [],
    reason,
  });

  // No proposal, or no evidence to test one against: file as today. `contested` records
  // that nothing vouched for this row, so T4's reclassifier revisits it.
  const proposed = proposals[0];
  if (!proposed) return fallback('no-evidence', true);
  if (neighbourTopics.length < KNN_K) return fallback('no-evidence', true);

  // A topic with too small a pool can't win a plurality, so the guardrail has no opinion
  // rather than a negative one — accept, flagged, and let the pool grow.
  if ((pools.get(proposed) ?? 0) < MIN_VOUCHABLE_POOL) {
    return {
      primary: {
        topic: proposed,
        relevance: purity(neighbourTopics, proposed),
        origin: 'classifier',
        contested: true,
      },
      secondaries: [],
      reason: 'unvouchable-pool',
    };
  }

  const winner = plurality(neighbourTopics);
  if (winner !== proposed) {
    // The evidence disagrees with the classifier. Fall back to the request topic — do
    // NOT auto-file under `winner` (detection works, correction does not). The doubt is
    // recorded unless the request topic is itself what the neighbours say.
    return fallback('rejected', winner !== requestTopic);
  }

  // Accepted. Secondaries are the REMAINING proposals that independently hold a share of
  // the neighbourhood — the classifier's opinion is necessary but never sufficient.
  //
  // The REQUEST TOPIC is a trailing candidate here, held to the same bar. Two reasons it
  // can't simply be dropped once another topic wins the primary: the run that paid to
  // discover this row would otherwise be unable to retrieve it (post-T1, retrieval is
  // EXISTS over memberships, and open-vocabulary filing can now land on a topic that
  // `relatedTopics` widening does not reach), and T3's collision rule already fixes the
  // principle — the searched topic may assert membership, it just gets no free pass.
  const candidates = [...new Set([...proposals.slice(1), requestTopic])];
  const secondaries: FilingMembership[] = candidates
    .filter((t) => t !== proposed)
    .map((topic) => ({
      topic,
      relevance: purity(neighbourTopics, topic),
      origin: 'classifier' as const,
      contested: false,
    }))
    .filter((m) => m.relevance >= MIN_SECONDARY_PURITY)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_MEMBERSHIPS - 1);

  return {
    primary: {
      topic: proposed,
      relevance: purity(neighbourTopics, proposed),
      origin: 'classifier',
      contested: false,
    },
    secondaries,
    reason: 'classifier',
  };
}

// ── DB reads (the evidence `decideFiling` runs on) ───────────────────────────────────

// The k nearest embedded neighbours' PRIMARY topics, by cosine distance over the same
// pool the centroids are computed from (src/lib/curation/topic-centroids.ts) — and the
// same pool scripts/calibrate-topic-threshold.ts measured on, so the 88.7% agreement
// figure describes this query. Labels are `Resource.topic` (the primary-membership
// mirror), one label per neighbour, exactly as calibrated: reading every membership
// instead would weight multi-filed rows more heavily than the instrument was measured on.
//
// Called pre-insert, so the row being filed is not yet in the table — the query is
// leave-one-out by construction.
export async function knnNeighbourTopics(vector: number[], k = KNN_K): Promise<string[]> {
  const literal = `[${vector.join(',')}]`;
  const rows = await prisma.$queryRaw<{ topic: string }[]>`
    SELECT topic
    FROM "Resource"
    WHERE embedding IS NOT NULL
      AND "decompositionStatus"::text = 'atomic'
      AND status::text IN ('active', 'pending_review')
      AND origin::text <> 'generated'
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${k}
  `;
  return rows.map((r) => r.topic);
}

// Live pool sizes per topic, over the same population. Deliberately NOT
// TopicCentroid.memberCount, which is only as fresh as the last embed backfill: a topic
// that just received its first resources would still read as unvouchable, which is the
// bootstrapping deadlock MIN_VOUCHABLE_POOL exists to break.
export async function topicPools(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ topic: string; n: number }[]>`
    SELECT rt.topic, count(*)::int AS n
    FROM "ResourceTopic" rt
    JOIN "Resource" r ON r.id = rt."resourceId"
    WHERE r.embedding IS NOT NULL
      AND r."decompositionStatus"::text = 'atomic'
      AND r.status::text IN ('active', 'pending_review')
      AND r.origin::text <> 'generated'
      AND NOT (rt.contested AND NOT rt."isPrimary")
    GROUP BY rt.topic
  `;
  return new Map(rows.map((r) => [r.topic, r.n]));
}
