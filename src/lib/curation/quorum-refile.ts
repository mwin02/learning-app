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

// ── named cohorts (B3) ───────────────────────────────────────────────────────
//
// The whole-course parents B3 identified BY HAND. They are not the output of a query and
// never will be: "this Lamar chapter is really precalculus" is a judgment about a
// curriculum, and the classifier's inability to make it is the defect being repaired.
//
// What IS mechanical, and what lives here, is the SELECTOR — a declarative predicate over
// the URL and title, so every cohort is re-runnable, auditable against the live library,
// and reports its matched count against the count B3 measured (2026-07-29). A hardcoded
// list of resource ids would have neither property, and the library has changed since.
//
// Parents first, per B3: a container's children inherit its shelf, so moving the container
// makes its subtree correct for free. The selectors are URL-shaped rather than
// subtree-shaped for exactly that reason — a URL prefix catches the root AND the subtree
// in one rule, and survives a re-decomposition that would renumber parent ids.
export type CohortSelector = {
  // Case-insensitive. Every field present must match (AND); within a list, any (OR).
  urlPrefix?: string;
  urlContainsAny?: string[];
  titleContainsAny?: string[];
};

export type CohortSpec = {
  key: string;
  // Only rows currently on one of these shelves are claimed. A cohort that has already
  // been partly refiled (five of the eight had been, by 2026-08-11) then narrows to the
  // remainder instead of re-moving rows that are already right.
  from: string[];
  target: string;
  // What B3 measured on 2026-07-29, or null where it gave a description instead of a
  // count. Reported beside the live match so drift is visible rather than assumed away.
  stated: number | null;
  why: string;
  select: CohortSelector;
};

export const B3_COHORTS: readonly CohortSpec[] = [
  {
    key: 'lamar-differential-equations',
    from: ['calculus'],
    target: 'differential-equations',
    stated: 29,
    why: "Paul's Online Notes DE course — a whole course filed under calculus",
    select: { urlPrefix: 'https://tutorial.math.lamar.edu/classes/de/' },
  },
  {
    key: 'lamar-calculus-iii',
    from: ['calculus'],
    target: 'multivariable-calculus',
    stated: 31,
    why: 'Calculus III is multivariable by definition; both its roots live under /CalcIII/',
    select: { urlPrefix: 'https://tutorial.math.lamar.edu/classes/calciii/' },
  },
  {
    key: 'lamar-calculus-i-review',
    from: ['calculus'],
    // Lamar's CalcI opens with a Review chapter of prerequisite algebra/trig. Named page
    // by page rather than by `orderInParent < 10`: the ordinal is an artefact of one
    // decomposition run, the chapter's page set is the site's own published structure.
    target: 'precalculus',
    stated: 10,
    why: "the Review chapter of Paul's CalcI — prerequisite material, not calculus",
    select: {
      urlPrefix: 'https://tutorial.math.lamar.edu/classes/calci/',
      urlContainsAny: [
        '/functions.aspx',
        '/inversefunctions.aspx',
        '/trigfcns.aspx',
        '/trigequations.aspx',
        '/trigequations_calci.aspx',
        '/trigequations_calcii.aspx',
        '/expfunctions.aspx',
        '/logfcns.aspx',
        '/explogeqns.aspx',
        '/commongraphs.aspx',
      ],
    },
  },
  {
    key: 'mit-18-781-number-theory',
    from: ['discrete-mathematics'],
    target: 'number-theory',
    stated: 9,
    why: 'MIT 18.781 Theory of Numbers — the OCW course number is the selector',
    select: { urlContainsAny: ['18-781'] },
  },
  {
    key: 'mit-18-409-spectral-graph-theory',
    from: ['discrete-mathematics'],
    target: 'graph-theory',
    stated: 8,
    why: "MIT 18.409 An Algorithmist's Toolkit — spectral graph theory",
    select: { urlContainsAny: ['18-409'] },
  },
  {
    key: 'khan-cryptography',
    from: ['discrete-mathematics'],
    target: 'cryptography',
    stated: 12,
    // Deliberately NOT the whole /cryptography/ subtree: its `modarithmetic` and
    // `comp-number-theory` units really are discrete mathematics, and B3 named only the
    // ciphers journey and the RSA/Diffie-Hellman unit.
    why: 'Khan "Journey into Cryptography" (ciphers) + RSA/Diffie-Hellman (modern-crypt)',
    select: {
      urlPrefix: 'https://www.khanacademy.org/computing/computer-science/cryptography/',
      urlContainsAny: ['/ciphers/', '/modern-crypt/'],
    },
  },
  {
    key: 'khan-matrices-as-data',
    from: ['linear-algebra'],
    target: 'precalculus',
    stated: 4,
    why: 'Khan precalculus units that use matrices as data tables, not as linear algebra',
    select: {
      urlContainsAny: [
        ':model-situations-with-matrices/',
        ':using-matrices-to-manipulate-data/',
      ],
    },
  },
  {
    key: 'pca-and-linear-regression',
    from: ['linear-algebra'],
    target: 'machine-learning',
    stated: null,
    why: 'PCA / linear-regression rows filed under linear-algebra by their method, not their subject',
    select: {
      titleContainsAny: ['principal component', 'pca', 'linear regression'],
    },
  },
];

// Why a cohort is or is not safe to move, given the shelf it is moving to.
export type CohortRoute =
  // The target shelf already clears MIN_VOUCHABLE_POOL, so k-NN can vouch for these rows
  // the moment they land. No quorum question arises.
  | 'vouched'
  // The target shelf is BELOW the bar and the cohort is what lifts it over — the deadlock
  // refile-quorum-topics.ts exists to break. Only sound as one whole-cohort move.
  | 'quorum'
  // Even with the cohort the shelf stays under the bar. Moving would strand the rows
  // somewhere the guardrail permanently distrusts, so the cohort is reported, not moved.
  | 'below-quorum';

// PURE. Which of the three a cohort is.
//
// Note the bar is applied to the shelf AFTER the move, not to the cohort alone: B3's thin
// targets (`differential-equations` 9, `graph-theory` 9, `number-theory` 14) already hold
// rows, and a cohort of 5 landing on a shelf of 9 clears the bar just as honestly as a
// cohort of 14 landing on an empty one. Sizing the cohort alone against QUORUM would
// refuse exactly those merges — the deadlock again, one level up.
export function routeCohort(
  cohortSize: number,
  targetPool: number,
  quorum = QUORUM,
): { route: CohortRoute; poolAfter: number } {
  const poolAfter = targetPool + cohortSize;
  if (targetPool >= quorum) return { route: 'vouched', poolAfter };
  return { route: poolAfter >= quorum ? 'quorum' : 'below-quorum', poolAfter };
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
