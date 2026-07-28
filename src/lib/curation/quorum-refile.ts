// Topic filing T4b — the quorum seed/mint pass.
//
// T4a re-scored the backlog but deliberately NEVER refiled: detection works, correction
// does not, because the right shelf frequently did not exist or was empty. It left the
// evidence behind in two fields — `unvouchable` (the classifier named an EXISTING
// canonical whose shelf is empty) and `newTopic` (it named a subject the vocabulary
// LACKS). This block is what acts on them, and it is the ONLY pass in the plan that moves
// a primary.
//
// ⚠️ THE DEADLOCK THIS EXISTS TO BREAK. k-NN can only vouch for a topic that holds a
// plurality among 10 neighbours, so a topic with fewer than MIN_VOUCHABLE_POOL members
// can never be vouched for — and a shelf that is never vouched for never fills. Filing
// one or two rows onto an empty shelf therefore strands them somewhere the guardrail
// permanently distrusts. The way out is not a lower bar but a BIGGER MOVE: refile the
// whole cohort at once, so the shelf clears MIN_VOUCHABLE_POOL the moment it is created.
// That is why quorum is `MIN_VOUCHABLE_POOL` and not a tuned number — below the bar the
// move is pointless, at or above it the move is self-justifying.
//
// The two channels differ only in whether the slug exists yet; once the topic gate has
// produced a canonical for a `newTopic` label, a mint IS a seed. Hence one decision path.
//
// ⚠️ Read `decideRefile`'s note on the vacated topic before changing anything here: the
// old primary membership is retained as an UNCONTESTED SECONDARY, which is both what
// keeps the vacated shelf's live Paths whole and what finally satisfies T4d's
// precondition (T4a wrote zero uncontested secondaries — see its As-built item 3).

import type { MembershipWrite } from '@/lib/curation/reclassify';
import { MIN_VOUCHABLE_POOL } from '@/lib/curation/topic-knn';

// One literal, not two. Below this a shelf cannot be vouched for, which is the entire
// argument for the quorum — so the bar IS that constant, and re-tuning k in T4e moves
// this in lockstep rather than leaving a stale 10 behind.
export const QUORUM = MIN_VOUCHABLE_POOL;

// The subset of a T4a audit row this pass reads. Structurally typed rather than imported
// from the driver so the module stays free of file-format concerns.
export type RefileRecord = {
  id: string;
  title: string;
  currentTopic: string;
  // Purity of the row's neighbourhood against `currentTopic`, measured by T4a. Becomes
  // the retained secondary's relevance — already on the row, so nothing re-measures it.
  relevance: number | null;
  // An existing canonical with an empty shelf.
  unvouchable: string | null;
  // A subject absent from the vocabulary; needs the topic gate before it can be a target.
  newTopic: string | null;
};

export type RefileChannel = 'seed' | 'mint';

export type QuorumCandidate = {
  channel: RefileChannel;
  // The label as recorded. For `mint` this is a raw model-proposed slug that has NOT yet
  // been through the gate — never file under it directly.
  label: string;
  rows: RefileRecord[];
};

export type QuorumSlate = {
  // At or above the bar: worth moving.
  clears: QuorumCandidate[];
  // Below it. Reported so the tally is auditable, never acted on — the rows keep the
  // primary T4a left them with.
  below: QuorumCandidate[];
};

// PURE. Group the record into per-label cohorts and split them on the quorum bar.
//
// Precedence: a row carrying BOTH signals counts toward its SEED label only. Same
// principle as T3's "evidence beats a mint" — an existing canonical outranks inventing a
// new one, and a row voting in two cohorts could push a label over quorum on strength it
// does not exclusively have. (Measured 2026-07-27: 2 rows of 1,152, both of whose mint
// labels are below quorum anyway. The rule is here so that can't change silently.)
//
// Case-folded, since the model's casing is not load-bearing and two spellings of one
// subject should pool their votes rather than each miss the bar alone.
export function selectQuorumSlate(records: RefileRecord[], quorum = QUORUM): QuorumSlate {
  const cohorts = new Map<string, QuorumCandidate>();

  const add = (channel: RefileChannel, raw: string, row: RefileRecord) => {
    const label = raw.trim().toLowerCase();
    if (!label) return;
    const key = `${channel}:${label}`;
    const cohort = cohorts.get(key) ?? { channel, label, rows: [] };
    cohort.rows.push(row);
    cohorts.set(key, cohort);
  };

  for (const row of records) {
    if (row.unvouchable) add('seed', row.unvouchable, row);
    else if (row.newTopic) add('mint', row.newTopic, row);
  }

  const clears: QuorumCandidate[] = [];
  const below: QuorumCandidate[] = [];
  // Largest cohort first: the report reads as a priority list, and `--only` runs pick off
  // the top deterministically.
  for (const c of [...cohorts.values()].sort((a, b) => b.rows.length - a.rows.length)) {
    (c.rows.length >= quorum ? clears : below).push(c);
  }
  return { clears, below };
}

export type RefileDecision = {
  primary: MembershipWrite;
  // Always empty. `applyReclassification` takes the same shape, and the vacated topic
  // needs no write at all (see below), so there is nothing to add.
  secondaries: MembershipWrite[];
};

// Why a row is not moved. Every one of these is a SKIP, never a partial write.
export type RefileSkip =
  // The row's live primary is no longer what T4a recorded — something moved it since.
  // Re-running this pass is the common cause and a clean no-op, which is the point.
  | 'drifted'
  // Already filed under the target.
  | 'already-filed'
  // The gate declined the label, or coerced it to nothing.
  | 'no-target';

// PURE. One row's refile.
//
// ⚠️ THE VACATED TOPIC IS RETAINED, AND NOT BY ACCIDENT. `setPrimaryTopic` clears
// `isPrimary` on the old membership but leaves the ROW — with the origin, the measured
// relevance and the uncontested flag T4a wrote. So the move converts the old primary into
// an uncontested secondary for free, and that is load-bearing twice over:
//
//   - `probability-and-statistics` has a LIVE Path and loses 254 of its 445 rows to the
//     `statistics` seed. Retained as secondaries they stay retrievable under T1's
//     predicate (which hides only CONTESTED secondaries), so the split costs that Path
//     nothing.
//   - T4d's narrowing precondition is "cross-topic memberships exist". T4a wrote 58
//     secondaries, all contested — i.e. none that widen reachability. This pass writes
//     ~445 uncontested ones, which is what finally satisfies it (As-built T4a item 3).
//
// So there is deliberately no secondary write here: adding one would either duplicate the
// row that already exists or overwrite its measured relevance with a guess.
export function decideRefile(record: RefileRecord, target: string): RefileDecision | RefileSkip {
  if (record.currentTopic === target) return 'already-filed';
  return {
    primary: {
      topic: target,
      // ZERO, and honest. Purity against an empty shelf is 0 by construction — the shelf
      // is empty precisely because nothing is filed there yet — so no measurement taken
      // BEFORE the cohort lands can say anything else. `settleRefile` replaces this with
      // a real number once the whole cohort is in place; a run that stops here leaves
      // rows carrying a measured-looking 0.0, which is why the settle phase is part of
      // this block rather than deferred.
      relevance: 0,
      origin: 'classifier',
      // Nothing has vouched for this topic at the instant of the write — same treatment
      // T3 gives a freshly minted topic and T2b gives an unvouchable pool. A contested
      // PRIMARY stays retrievable, so flagging costs no reachability.
      contested: true,
    },
    secondaries: [],
  };
}

export type Settlement = {
  relevance: number;
  contested: boolean;
};

// PURE. Phase 2 — what the refiled shelf is actually worth, measured after the fact.
//
// This is the block's acceptance measurement, not cleanup. The claim being tested is that
// moving a whole cohort at once retires the bootstrapping deadlock: if it worked, the new
// topic now holds the plurality of its own rows' neighbourhoods and the guardrail vouches
// for what it could not vouch for an hour earlier.
//
// Expect it to fail for the thin cohorts, and do not tune it until it doesn't — a 14-row
// topic embedded inside a 200-row adjacent one cannot hold a plurality in any 10-neighbour
// window, which is As-built T4a item 7 and a T4e input, not a bug in this pass.
//
// Takes the tally rather than the raw neighbour list so the caller's `purity`/`plurality`
// stay the single source of both numbers.
export function decideSettlement(
  topic: string,
  measured: { purity: number; plurality: string | null },
  neighbourCount: number,
): Settlement {
  // Too few neighbours to read anything from — leave the doubt in place rather than
  // recording a 0.0 that would look measured.
  if (neighbourCount === 0) return { relevance: 0, contested: true };
  return {
    relevance: measured.purity,
    // Vouched exactly when the guardrail's own instrument says so: the topic holds the
    // plurality. A TIE is not a verdict (`plurality` returns null), which is precisely
    // the case the contested flag exists for.
    contested: measured.plurality !== topic,
  };
}
