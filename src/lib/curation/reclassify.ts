// Topic filing T4a — re-scoring the backlog that was filed with no classification.
//
// 1,152 of 1,926 rows (60%) live under a topic with no TOPIC_RELATIONS edges, and
// pre-T2b the classifier was SKIPPED whenever `relatedTopics(requestTopic)` had one
// member — so those rows were stamped with the searched topic and never classified at
// all. Every membership in the library today is `origin: inherited`, `relevance: 1.0`,
// which means "unknown", not "certain". This module decides what to write for one such
// row, given the evidence T2b's guardrail already knows how to read.
//
// ⚠️ THE INVARIANT THAT SHAPES EVERYTHING HERE: this never refiles. `primary.topic` is
// always the row's CURRENT topic, whatever the evidence says. The plan's motivating case
// is the argument — the 45 mis-filed Khan "Functions" leaves are correctly DETECTED, but
// their nearest other centroids are `calculus-for-machine-learning` and `calculus`, both
// wrong, because the right answer (`algebra`) is not in the vocabulary. Detection works;
// correction does not. So a disagreement is recorded as doubt, never acted on:
// `Resource.status` is untouched (those rows already passed human QUALITY review, and
// some are attached to live Paths — filing doubt and quality are orthogonal axes), and
// the primary stays put with `contested = true`.
//
// Bulk minting — the one path that DOES move a primary, quorum-gated so a new topic
// arrives with a pool large enough for k-NN to vouch for it — is T4b, and it runs as a
// separate pass over the `newTopic` proposals this one collects.
//
// Deliberately WRAPS `decideFiling` rather than restating its thresholds. T4e
// recalibrates MIN_SECONDARY_PURITY and k; one filing path means one place to change.

import type { TopicFilingOrigin } from '@prisma/client';
import {
  decideFiling,
  plurality,
  purity,
  MAX_MEMBERSHIPS,
  type FilingDecision,
} from '@/lib/curation/topic-knn';

export type ReclassifyInput = {
  // The row's current primary topic. Plays the `requestTopic` role in `decideFiling`:
  // the label to fall back to and to hold the proposals against.
  currentTopic: string;
  // Ranked in-vocabulary proposals from classifyDiscoveryTopics, most confident first.
  proposals: string[];
  // A subject the classifier says the vocabulary LACKS. Carried through untouched — T4b
  // aggregates these across the run and mints only what clears the quorum.
  newTopic: string | null;
  // Primary topics of the k nearest embedded neighbours, LEAVE-ONE-OUT (the row is
  // already in the table, so it would otherwise be its own nearest neighbour at
  // distance 0 and vote for itself). See knnNeighbourTopicsOf.
  neighbourTopics: string[];
  // Live pool sizes, snapshotted once per run.
  pools: Map<string, number>;
  // Topics the row is ALREADY a member of, including the primary. Existing memberships
  // are never rewritten by a secondary and they count against the cap.
  existingTopics: string[];
  // Centroid margin (own-topic similarity − best other), or null when the row's topic
  // has no trustworthy centroid. A REVIEW-PRIORITY signal only — nothing here branches
  // on it. See the header of centroidMargins() for why it is not a cost pre-filter.
  margin: number | null;
};

export type MembershipWrite = {
  topic: string;
  relevance: number;
  origin: TopicFilingOrigin;
  contested: boolean;
};

export type ReclassifyVerdict =
  // The neighbourhood backs the row's current label.
  | 'agree'
  // The evidence points somewhere else. Primary flagged, proposal recorded, nothing moved.
  | 'disagree'
  // The classifier named a shelf that does not exist yet. NOT doubt about this row.
  | 'unvouchable-pool'
  // Q7/P4: the neighbourhood points elsewhere, but the row's own shelf is too thin for
  // that to mean anything (MIN_ADJUDICABLE_POOL). Re-scored, not flagged. Distinct from
  // `agree` so a run's verdict tally says how much of its silence is abstention.
  | 'abstain'
  // Fewer than k neighbours, or nothing proposed. Write nothing.
  | 'no-evidence';

export type ReclassifyDecision = {
  verdict: ReclassifyVerdict;
  // Always the CURRENT topic (see the header). Null when there is nothing to write —
  // `no-evidence` leaves the inherited placeholder alone rather than replacing one
  // unfounded number with another.
  primary: MembershipWrite | null;
  // New memberships only; topics already on the row are filtered out, so a second run
  // over the same row writes nothing new.
  secondaries: MembershipWrite[];
  newTopic: string | null;
  // An EXISTING canonical the classifier proposed that has too small a pool for k-NN to
  // vouch for. T4b's other quorum channel: `newTopic` needs a slug minted first, this
  // one already has the slug and only needs a pool. Measured 2026-07-27 on a 60-row
  // sample: `statistics` and `data-structures-algorithms` are CURATED slugs with zero
  // resources that the classifier repeatedly and correctly asks for.
  unvouchable: string | null;
  // Diagnostics for the review report — never written as memberships, because nothing
  // proposed them. `evidenceTopic` is the neighbourhood's plurality label (null on a
  // tie), which is the one thing a reviewer needs when a proposal was rejected because
  // some third topic holds the neighbourhood.
  evidenceTopic: string | null;
  evidencePurity: number;
  margin: number | null;
};

// PURE. One row's decision, so the whole matrix is unit-testable without a DB, an LLM,
// or an embedding.
export function decideReclassification(input: ReclassifyInput): ReclassifyDecision {
  const { currentTopic, proposals, newTopic, neighbourTopics, pools, existingTopics, margin } =
    input;

  const evidenceTopic = plurality(neighbourTopics);
  const diagnostics = {
    newTopic,
    evidenceTopic,
    evidencePurity: evidenceTopic ? purity(neighbourTopics, evidenceTopic) : 0,
    margin,
  };

  const nothing = (verdict: ReclassifyVerdict): ReclassifyDecision => ({
    verdict,
    primary: null,
    secondaries: [],
    unvouchable: null,
    ...diagnostics,
  });

  // `decideFiling` treats the current topic exactly as discovery treats the request
  // topic: the fallback, and a trailing secondary candidate held to the same purity bar.
  const filing = decideFiling({
    proposals,
    requestTopic: currentTopic,
    neighbourTopics,
    pools,
  });

  // Nothing vouched and nothing contradicted — writing a measured 0.0 here would be
  // worse than the placeholder, since it would read as "we checked and it's wrong".
  if (filing.reason === 'no-evidence') return nothing('no-evidence');

  const verdict = readVerdict(filing, currentTopic);

  // The re-scored primary. `origin` flips off `inherited` deliberately: the future
  // origin-aware `minRelevance` clause EXEMPTS `inherited` rows precisely because their
  // 1.0 is a placeholder. Leaving a MEASURED purity under that origin would park it in
  // the one bucket the gate ignores — backwards. Once re-scored, the number is real and
  // should be gated like any other classifier row.
  const primary: MembershipWrite = {
    topic: currentTopic,
    relevance: purity(neighbourTopics, currentTopic),
    origin: 'classifier',
    // A disagreement flags the PRIMARY rather than moving it. A contested primary stays
    // retrievable (T1's predicate only hides contested SECONDARIES), so flagging costs
    // no reachability — it only marks the row for review.
    //
    // ⚠️ `unvouchable-pool` deliberately does NOT flag. T2b treats that verdict as
    // "accept the proposal, contested" — which is how a new shelf starts filling at
    // discovery time. Reusing that reading here would be a category error: this pass
    // cannot refile, so the same reason would end up contesting the CURRENT label when
    // nothing contradicted it. Measured 2026-07-27 across a 60-row sample, that was
    // 10–55% of rows per topic — it would have buried ~130 real disagreements under
    // ~350 rows of "the classifier named an empty shelf". The proposal is recorded in
    // `unvouchable` for T4b's quorum instead.
    contested: verdict === 'disagree',
  };

  // Room left for new memberships after the primary and whatever the row already has.
  const taken = new Set(existingTopics);
  taken.add(currentTopic);
  const budget = MAX_MEMBERSHIPS - taken.size;

  const proposed = filing.primary.topic;
  const candidates: MembershipWrite[] = [];

  // On a disagreement the alternative is recorded as a CONTESTED secondary: invisible to
  // retrieval under T1's predicate, so it widens no bleed, but it is the hypothesis the
  // review surface needs — "the neighbourhood says this row belongs over there".
  //
  // An `unvouchable-pool` proposal gets NO membership, not even a contested one: its
  // purity is 0 by construction (the shelf is empty), so the row would carry a
  // measured-looking 0.0 that means "we couldn't check", not "we checked and it's weak".
  if (verdict === 'disagree' && proposed !== currentTopic) {
    candidates.push({
      topic: proposed,
      relevance: filing.primary.relevance,
      origin: 'classifier',
      contested: true,
    });
  }

  // The guarded secondaries `decideFiling` already cleared. These are the rows that make
  // cross-topic reachability real, and they are the prerequisite for T4d's narrowing of
  // `relatedTopics` widening.
  for (const s of filing.secondaries) candidates.push({ ...s });

  const secondaries: MembershipWrite[] = [];
  const seen = new Set(taken);
  for (const c of candidates) {
    if (secondaries.length >= budget) break;
    if (seen.has(c.topic)) continue;
    seen.add(c.topic);
    secondaries.push(c);
  }

  return {
    verdict,
    primary,
    secondaries,
    unvouchable: verdict === 'unvouchable-pool' ? proposed : null,
    ...diagnostics,
  };
}

// Map `decideFiling`'s filing-time reasons onto reclassification verdicts.
//
// ⚠️ Branch on `reason`, never on the returned topic — the same trap T3's
// `decideCollision` documents. `decideFiling` falls back to `requestTopic` (here: the
// current topic) on a REJECTED verdict, so a rejection and an agreement both come back
// naming the current topic, and reading the topic alone would silently turn every
// rejection into an agreement.
function readVerdict(filing: FilingDecision, currentTopic: string): ReclassifyVerdict {
  switch (filing.reason) {
    case 'classifier':
      // The classifier's pick cleared the guardrail. Agreement only if that pick IS the
      // current label; otherwise the evidence backs a different topic.
      return filing.primary.topic === currentTopic ? 'agree' : 'disagree';
    case 'rejected':
      // The proposal failed the plurality check. That indicts the current label only when
      // the neighbours point at some THIRD topic — `decideFiling` already encodes exactly
      // that distinction in its fallback's `contested` flag, so reuse it rather than
      // re-deriving the plurality here.
      return filing.primary.contested ? 'disagree' : 'agree';
    case 'thin-shelf':
      // The guardrail abstained (Q7). Nothing contradicted the current label, so this
      // re-scores the primary like an agreement but is reported as its own verdict — the
      // difference is real: an `agree` row was checked, an `abstain` row could not be.
      return 'abstain';
    case 'unvouchable-pool':
      return 'unvouchable-pool';
    // `minted` is unreachable: decideMintedFiling is never called on this path (T4b
    // owns minting). `no-evidence` is handled before this function.
    default:
      return 'no-evidence';
  }
}

// T4b's quorum input, both channels. They differ only in whether the slug exists yet:
//
//   mint — the classifier named a subject the vocabulary LACKS (`newTopic`). Needs the
//          topic gate to produce a canonical before anything can be filed there.
//   seed — the classifier named an EXISTING canonical whose shelf is empty. The slug is
//          already good; only the pool is missing.
//
// Both are answered the same way: below the quorum, k-NN can never vouch for that topic,
// so filing one or two rows there would strand them on a shelf the guardrail permanently
// distrusts. At or above it, refiling the whole cohort at once gives the shelf a pool
// that clears MIN_VOUCHABLE_POOL immediately — which is the self-widening property in
// the plan's locked decisions finally turning over.
//
// Case-folded, since the model's casing is not load-bearing and two spellings of one
// subject should pool their votes rather than each miss the quorum alone.
export type QuorumTally = { mint: Map<string, number>; seed: Map<string, number> };

export function tallyQuorumChannels(decisions: ReclassifyDecision[]): QuorumTally {
  const mint = new Map<string, number>();
  const seed = new Map<string, number>();
  const bump = (m: Map<string, number>, raw: string | null) => {
    const label = raw?.trim().toLowerCase();
    if (!label) return;
    m.set(label, (m.get(label) ?? 0) + 1);
  };
  for (const d of decisions) {
    bump(mint, d.newTopic);
    bump(seed, d.unvouchable);
  }
  return { mint, seed };
}
