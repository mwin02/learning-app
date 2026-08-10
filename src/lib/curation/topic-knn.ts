// Topic filing T2b — the filing guardrail that replaces the TOPIC_RELATIONS ceiling.
//
// The old bound on filing was a hand-written edge list: a discovery could only be filed
// under `relatedTopics(requestTopic)`, which has five keys, so 60% of the library was
// stamped with the searched topic and no classification at all. T2b opens the vocabulary
// to every canonical (listCanonicals()) and replaces the edge list with EVIDENCE: does
// the resource's embedding actually sit among that topic's resources?
//
// The instrument is k-NN LABEL PURITY, chosen by measurement, not taste
// (scripts/calibrate-topic-threshold.ts, re-run 2026-07-27, 1,832 rows / 20 topics):
//
//   absolute cosine to a topic centroid   Youden J 0.367   ❌ rejected — a technical
//                                                            corpus clusters too tightly
//                                                            (own p50 0.768 vs best-other
//                                                            0.718; the distributions
//                                                            almost completely overlap)
//   relative margin (own − best other)    77.7% top-1     ✅ viable as a flagger
//   k-NN plurality, k=10                  89.4%           ✅ strongest — adopted
//
// ⚠️ That 89.4% is agreement with ANY MEMBERSHIP, which is the label of record post-T1.
// Scored against the scalar `Resource.topic` mirror the same run reads 84.3%. And do not
// compare either figure to the 2026-07-25 run (11 topics): agreement is not comparable
// across vocabularies, and T4b's shelf splits depress purity mechanically. See As-built
// T4e items 1-2 in topic-filing.md.
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

// k from the calibration run. Re-verified 2026-07-27 (T4e) and kept at 10.
export const KNN_K = 10;

// A secondary membership needs this share of the k neighbours.
//
// T4e settled the plan's open question ("lower the bar, or loosen the classifier's
// one-topic rule?") and the answer is NEITHER, in that order. The bar was never the
// binding constraint: at 0.2, 787 of 1,106 rows (71%) have a rival neighbour label
// clearing it, yet only 207 are memberships and T4a wrote ZERO uncontested secondaries.
// What binds is the classifier's prompt rule to return one topic unless a resource
// squarely belongs on several shelves — a topic never reaches this bar unless the model
// proposed it first. So lowering 0.2 would change nothing.
//
// It stays at 0.2 because it is currently harmless (it only ever ADDS reachability, and
// MAX_MEMBERSHIPS bounds the blast radius). ⚠️ But it is NOT a safe bar on its own: if the
// one-topic prompt rule is ever loosened, RAISE this first — 0.2 admits 71% of rows, which
// is no guard at all. The measured alternatives are 0.4 (36.9%) and 0.5 (24.8%). The
// calibration script prints this sweep on every run.
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
  reason: 'classifier' | 'unvouchable-pool' | 'rejected' | 'no-evidence' | 'minted';
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
  // Live count per topic of the rows that VOTE for it — i.e. whose `Resource.topic` is
  // that topic, the same population `neighbourTopics` is drawn from (see topicPools).
  // Only an entry at >= MIN_VOUCHABLE_POOL makes a topic vouchable.
  pools: Map<string, number>;
};

// Exported for T4a, which measures purity directly rather than reading it back off a
// FilingDecision — same tally, same neighbour list, one obvious source.
export function purity(neighbourTopics: string[], topic: string): number {
  if (neighbourTopics.length === 0) return 0;
  let hits = 0;
  for (const t of neighbourTopics) if (t === topic) hits++;
  return hits / neighbourTopics.length;
}

// The plurality label, or null when the neighbours are empty or TIE. A tie is not a
// verdict — it is exactly the "we can't tell" case the contested flag exists for.
// Exported for T4a's review report: when the guardrail rejects a proposal because some
// THIRD topic holds the neighbourhood, that topic is the single most useful thing a
// reviewer can be told. Diagnostic only — it never becomes a membership, since nothing
// proposed it.
export function plurality(neighbourTopics: string[]): string | null {
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
      // ⚠️ SECONDARIES ARE HELD TO MIN_VOUCHABLE_POOL TOO — the same bar the primary
      // clears above. A thin shelf can still supply 2 of 10 neighbours, so purity alone
      // would let a topic k-NN cannot adjudicate acquire an UNCONTESTED membership, which
      // T1's retrieval predicate admits. That is the one route by which an unvouched topic
      // gains retrievable reach with no flag on it, and it read as an asymmetry with how
      // the identical topic is treated as a primary (`unvouchable-pool` → contested).
      //
      // Contested is the honest verdict rather than a drop: the proposal is recorded for
      // the review drain, which is the mechanism that promotes it. It costs the topic
      // nothing either — `topicPools` counts the scalar mirror (T4e), so a secondary of
      // any flavour never grows a pool, and dropping it would only lose the receipt.
      contested: (pools.get(topic) ?? 0) < MIN_VOUCHABLE_POOL,
    }))
    .filter((m) => m.relevance >= MIN_SECONDARY_PURITY)
    // Vouched first, then by measured purity. Ordering matters because of the cap below:
    // a hypothesis nothing can vouch for must never displace a membership that would be
    // retrievable.
    .sort((a, b) => Number(a.contested) - Number(b.contested) || b.relevance - a.relevance)
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

// PURE. Topic filing T3 — the filing that results when the classifier says none of the
// canonicals fit and the topic gate MINTED (or resolved) a slug for its proposal.
//
// Called only after `decideFiling` returned `rejected` / `no-evidence`, i.e. no existing
// canonical cleared the guardrail. The minted topic is always `contested`: a fresh topic
// has no pool, so k-NN cannot vouch for it by construction — this is the same treatment
// MIN_VOUCHABLE_POOL gives a real-but-thin topic, and a contested PRIMARY stays
// retrievable, so the new topic's pool can start filling.
//
// The request topic is kept as a secondary when the neighbourhood supports it, for the
// reason it is a trailing candidate in `decideFiling`: otherwise the run that paid to
// discover this row could not retrieve its own find, since a minted topic is by
// definition not reachable through `relatedTopics` widening either.
export function decideMintedFiling(input: FilingInput, minted: string): FilingDecision {
  const { requestTopic, neighbourTopics, pools } = input;
  const requestPurity = purity(neighbourTopics, requestTopic);
  return {
    primary: {
      topic: minted,
      relevance: purity(neighbourTopics, minted),
      origin: 'classifier',
      contested: true,
    },
    secondaries:
      minted !== requestTopic && requestPurity >= MIN_SECONDARY_PURITY
        ? [
            {
              topic: requestTopic,
              relevance: requestPurity,
              origin: 'classifier',
              // Same bar as `decideFiling`'s secondaries: a request topic whose own shelf
              // is too thin for k-NN to adjudicate is a hypothesis, not a verdict, even
              // though the neighbourhood happens to support it here.
              contested: (pools.get(requestTopic) ?? 0) < MIN_VOUCHABLE_POOL,
            },
          ]
        : [],
    reason: 'minted',
  };
}

// PURE. Topic filing T3 — a URL rediscovered under a second topic.
//
// A collision is the SEARCHED topic asserting membership, which is exactly the signal the
// plan's "modelling error" section rejects, so it gets no free pass: the claim is tested
// against the EXISTING row's own embedding neighbourhood, through the same decision matrix
// a fresh filing goes through. Deliberately reuses `decideFiling` rather than
// re-implementing the thresholds — one filing path, one place to recalibrate in T4.
//
// Note the branch is on `reason`, NOT on the returned primary: with a single proposal that
// is also the fallback, a REJECTED verdict still names that topic, and reading the topic
// alone would turn every rejection into an acceptance.
//
// Returns null when the claim fails — including when the existing row has no embedding
// (no neighbours → `no-evidence`), which is the caller's degradation path too.
export function decideCollision(
  topic: string,
  neighbourTopics: string[],
  pools: Map<string, number>,
): FilingMembership | null {
  const d = decideFiling({ proposals: [topic], requestTopic: topic, neighbourTopics, pools });
  if (d.reason !== 'classifier' && d.reason !== 'unvouchable-pool') return null;
  return {
    topic,
    // The MEASURED purity, never the schema default of 1.0 — a collision row that
    // outranked guarded classifier rows under a future minRelevance would invert the
    // whole point of guarding it.
    relevance: d.primary.relevance,
    origin: 'collision',
    // A pool too small to vouch is a hypothesis worth recording, not a verdict.
    contested: d.reason === 'unvouchable-pool',
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

// T3: the same neighbourhood, for a row that is ALREADY IN the table — the collision
// path, where the resource under test is the existing row rather than one about to be
// inserted. Two differences from `knnNeighbourTopics`, both load-bearing:
//
//   - the vector stays in Postgres (`r.embedding`), so a 768-dim round-trip through JS
//     is avoided and there is no `Unsupported("vector(768)")` column to marshal;
//   - `n.id <> r.id` makes it leave-one-out EXPLICITLY. The pre-insert path gets that
//     for free (its row does not exist yet); here the row is its own nearest neighbour
//     at distance 0, and its own label would vote for itself.
//
// Returns [] when the resource is missing or has no embedding — which `decideCollision`
// reads as "no evidence", i.e. skip.
export async function knnNeighbourTopicsOf(resourceId: string, k = KNN_K): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ topic: string }[]>`
    SELECT n.topic
    FROM "Resource" n, "Resource" r
    WHERE r.id = ${resourceId}
      AND r.embedding IS NOT NULL
      AND n.id <> r.id
      AND n.embedding IS NOT NULL
      AND n."decompositionStatus"::text = 'atomic'
      AND n.status::text IN ('active', 'pending_review')
      AND n.origin::text <> 'generated'
    ORDER BY n.embedding <=> r.embedding
    LIMIT ${k}
  `;
  return rows.map((r) => r.topic);
}

// Live pool sizes per topic, over the same population. Deliberately NOT
// TopicCentroid.memberCount, which is only as fresh as the last embed backfill: a topic
// that just received its first resources would still read as unvouchable, which is the
// bootstrapping deadlock MIN_VOUCHABLE_POOL exists to break.
//
// ⚠️ T4e — COUNTS THE SCALAR MIRROR, NOT MEMBERSHIPS. This reads like a T1 regression
// and is the opposite: the pool exists to answer exactly one question — "can k-NN ever
// vouch for this topic?" — and the only rows that can answer it are the rows that CAST A
// VOTE. `knnNeighbourTopics` / `knnNeighbourTopicsOf` select `n.topic`, the scalar
// primary, so a secondary membership contributes nothing to any neighbourhood tally. The
// membership form counted a currency the instrument never spends.
//
// T4b's retention mechanic is what made the two diverge: a vacated primary is kept as an
// uncontested secondary, so every shelf T4b split reads larger by membership than by
// votes (measured 2026-07-27: probability-and-statistics 445/196, discrete-mathematics
// 263/145, calculus-for-machine-learning 179/132, linear-algebra 211/195). Those four are
// vouchable either way, so the ONLY behavioural change in the whole library is the case
// this fix exists for: `differential-equations` read pool 10 — vouchable by the letter of
// MIN_VOUCHABLE_POOL — while just 9 rows could ever vote for it, so k-NN could never
// actually vouch and its rows stayed permanently contested (As-built T4a item 7). It now
// reads 9 and is honestly unvouchable, which routes it to the same accepted-but-contested
// treatment a new shelf gets instead of pretending the guardrail can adjudicate it.
//
// The other direction of reconciliation — letting neighbours vote with every membership —
// was rejected: a neighbour with 3 memberships would cast 3 votes and purity would no
// longer be over a denominator of k.
export async function topicPools(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ topic: string; n: number }[]>`
    SELECT r.topic, count(*)::int AS n
    FROM "Resource" r
    WHERE r.embedding IS NOT NULL
      AND r."decompositionStatus"::text = 'atomic'
      AND r.status::text IN ('active', 'pending_review')
      AND r.origin::text <> 'generated'
    GROUP BY r.topic
  `;
  return new Map(rows.map((r) => [r.topic, r.n]));
}
