export type TopicSlug =
  | 'python'
  | 'python-data-ml'
  | 'javascript'
  | 'javascript-react'
  | 'data-structures-algorithms'
  | 'sql'
  | 'precalculus'
  | 'calculus'
  | 'linear-algebra'
  | 'machine-learning'
  | 'statistics'
  | 'physics-mechanics'
  | 'database-systems'
  | 'go'
  | 'discrete-mathematics'
  | 'differential-equations'
  | 'multivariable-calculus'
  | 'probability'
  | 'cryptography'
  | 'rust'
  | 'reinforcement-learning'
  | 'number-theory'
  | 'convex-optimization';

// Curated topics. Membership here is what makes a topic first-class: the topic
// gate fast-accepts it without an LLM call, and the planner/registry canonical
// lists union it. The free-beta warm set (C1) is this list minus `go` —
// off-niche, kept available on demand but not warmed.
//
// ⚠️ CURATED IS NOT THE SAME AS LIVE, and the gap is large: measured 2026-08-11 the
// library holds 23 shelves while this list names 13, two of which (`go`, `javascript`)
// hold zero rows. Minting works without this list (topic gate T3 → createTopicMinter), so
// a shelf never needs promotion to exist or to be filed into — promotion is about the
// LEARNER-facing half: an LLM-free gate answer, a canonical the planner unions, and a
// warm path. Promote a shelf when a learner would plausibly type its name, never merely
// because rows landed there. Q7 promoted `database-systems` on that test and deliberately
// left the other eleven minted shelves alone; the standing question of what to do with
// them (`probability-and-statistics` is the loudest at 206 primaries) is P7's, open.
export const TOPIC_SLUGS: readonly TopicSlug[] = [
  'python',
  'python-data-ml',
  'javascript',
  'javascript-react',
  'data-structures-algorithms',
  'sql',
  'precalculus',
  'calculus',
  'linear-algebra',
  'machine-learning',
  'statistics',
  'physics-mechanics',
  // Promoted 2026-08-11 (Q7). Minted during Q5's reclassification pass, where 15 rows —
  // mostly normalization/transactions/indexing material sitting on the `sql` shelf —
  // named it and cleared the mint quorum. `reinforcement-learning` (3) and `nosql` (1)
  // came out of the same pass and were deliberately NOT promoted: both are far below
  // MIN_VOUCHABLE_POOL, so promoting them would create curated shelves that cannot vouch
  // for a filing — the exact pathology Q7's guardrail fix exists to stop. They promote
  // themselves by reaching quorum.
  // ⚠️ THE SHELF IS EMPTY OF LIVE MATERIAL. Measured when the 15 rows were filed: all 15
  // are `status: deprecated` (soft — a reviewer's quality reject), so the shelf's POOL is
  // 0 and candidate search cannot see any of it. Promotion here is the learner-facing
  // call — the gate, the canonical lists, the warm set — and a warm run for this topic
  // will web-source from nothing, like any cold topic. It is not backed by a library yet.
  'database-systems',
  'go',

  // Promoted 2026-08-22, all nine warmed to `spine_ready` the day before
  // (docs/audits/topic-expansion-2026-08-21.md). Every one has a Path and clears
  // MIN_VOUCHABLE_POOL on LIVE rows — the check `database-systems` above failed, where a
  // 15-row shelf was entirely `deprecated` and the promotion bought a curated topic
  // backed by nothing. Live pools measured at promotion: discrete-mathematics 112,
  // differential-equations 81, multivariable-calculus 64, rust 53, cryptography 42,
  // reinforcement-learning 32, convex-optimization 29, number-theory 27, probability 15.
  // (`reinforcement-learning` is the shelf Q7 declined to promote at 3 rows; its own
  // warm run is what carried it past the floor, which is the "promote themselves by
  // reaching quorum" path that note describes.)
  'discrete-mathematics',
  'differential-equations',
  'multivariable-calculus',
  // ⚠️ THINNEST OF THE NINE, AND THE ONE TO WATCH. 15 live rows against a 21-concept
  // spine, because the 207-row `probability-and-statistics` shelf next door is
  // unreachable until a directed `probability` -> `probability-and-statistics` edge is
  // MEASURED into TOPIC_RELATIONS below. Promoted anyway — it clears the floor and the
  // Path is `spine_ready` — but it is the weakest curated topic in the list until that
  // edge lands.
  'probability',
  'cryptography',
  'rust',
  'reinforcement-learning',
  'number-theory',
  'convex-optimization',
] as const;

// DIRECTED relatedness among topics (topic filing T4d, 2026-07-27 — was symmetric).
// An edge `A: [B]` means "a request for A may surface B's shelf", and says NOTHING
// about whether a request for B should reach A. UNRELATED topics never bleed —
// calculus and linear-algebra have no edge by design. Keys may be agent-minted slugs
// (e.g. `javascript`), not only curated TOPIC_SLUGS.
//
// ⚠️ WHY DIRECTED. Widening is a subject-boundary question and the answer is genuinely
// asymmetric: precalculus needs calculus (it supplies 76 of that Path's 77 attachments)
// while calculus does not need precalculus. Under the old symmetric closure one
// declaration bought both directions, so every edge was priced at its more defensible
// half. Making direction explicit is what let T4d narrow `calculus` (431 -> 383 rows)
// and `sql` (166 -> 93) without touching a single call site — the narrowing lives in
// this data, not in the queries. Every direction below is justified on RETRIEVAL
// grounds only ("should a request for A surface B's shelf?"), never on filing: T2b
// removed this list's second job (it used to BOUND filing via classifyDiscoveryTopics)
// and nothing outside relatedTopics() reads it now.
//
// Evidence for each call is the live per-concept candidate re-search in
// `scripts/verify-topic-narrowing.ts`. Measure before adding or removing a direction —
// attachment archaeology alone is NOT sufficient evidence about a shelf that was
// populated after the Path was built (T4b seeded `precalculus` and
// `data-structures-algorithms` after every Path was mapped).
export const TOPIC_RELATIONS: Record<string, readonly string[]> = {
  // React draws on JS foundations. The reverse (`javascript` -> `javascript-react`) is
  // NOT declared: there is no `javascript` Path, so it was never exercised. Inert
  // either way today — the `javascript` shelf holds 0 rows — and kept as declared so
  // the edge is live the moment that shelf fills.
  'javascript-react': ['javascript'],
  // "Python for data/ML" is the applied glue that draws on two foundations: the Python
  // language and (largely language-agnostic) ML theory. Split out of a single conflated
  // `python-data-ml` topic — the language tutorials moved to `python`, StatQuest's ML
  // theory to `machine-learning` — so the applied topic composes both.
  // Load-bearing, measured 2026-07-27: `machine-learning` supplies 20 of this Path's
  // attachments and `python` 1. Narrowing python-data-ml to itself opens 2 spine holes
  // (introduction-to-neural-networks, nlp-fundamentals), which is why T4d did NOT take
  // plan §5's call-site narrowing here.
  'python-data-ml': ['python', 'machine-learning'],
  // The reverse of the applied-glue edge, and weaker but real: 5 attachments on the
  // `python` Path are pandas material shelved under `python-data-ml`
  // (data-analysis-with-pandas would lose its last `teaches` row without it).
  // Declared separately now that direction is explicit — under the old symmetric
  // closure this came free with the line above.
  python: ['python-data-ml'],
  // Precalculus is calculus's direct prerequisite and the shelves genuinely overlap
  // (functions, trig, intro-to-limits sit in both curricula).
  // ⚠️ THE STANDING RE-EVALUATION NOTE IS NOW ANSWERED — KEEP THIS EDGE. It asked
  // whether this edge was merely compensating for precalculus material mis-filed as
  // calculus. Measured 2026-07-27, post-T4a/T4b: it is doing both jobs, and the
  // mis-filing half is NOT fixed. 76 of the precalculus Path's 77 attachments come
  // through this edge, and 60 of those rows carry no `precalculus` membership at all —
  // not even a contested one. Dropping it takes the Path from 5 spine holes to 23 of 24
  // concepts. T4b's quorum refile gave precalculus a 47-row shelf of its own, but that
  // came off the `discrete-mathematics` shelf; the genuinely-precalculus material
  // sitting on the CALCULUS shelf was never re-scored (calculus had an edge, so its 395
  // rows fell outside T4a's "topics with no relations" backlog and are still 100%
  // `inherited`). Re-evaluate again only after those rows are re-scored AND the
  // resulting contested memberships are drained through review — a re-score alone does
  // not help, because its disagreements land as contested secondaries, which T1's
  // retrieval predicate deliberately excludes.
  // Separately: warming `precalculus` cold (2026-07-25) showed the library rung reaching
  // 76 calculus rows and skipping web discovery entirely, starving divergent concepts
  // (conic-sections, systems-of-equations-and-matrices, combining-functions) into hollow
  // relaxed primaries. That was read at the time as a locked cost tradeoff. It was not —
  // it was a defect: the rung counted RAW search hits rather than judged survivors, so
  // rows the judge threw away suppressed web discovery permanently. Fixed by
  // rung0-starvation R1/R2 (rung0-starvation.md); the budget now comes from
  // what attached, and a spine hole is guaranteed at least one web look. Either way it
  // was never an argument about this edge — the same starvation hit topics with no
  // relations at all.
  precalculus: ['calculus'],
  // The stats pool lives under TWO canonicals and topic-filing T4 deliberately kept
  // both as sibling shelves rather than merging them (T4b's split; the 31-row
  // `probability-and-statistics` <-> `statistics` confusion is that split, not
  // mis-filing). Only `statistics` is a curated TOPIC_SLUG, so only it gets warmed —
  // and without this edge a warm `statistics` Path sees a little over half its own
  // subject.
  // Measured on PRODUCTION 2026-07-31: `statistics` holds 254 memberships,
  // `probability-and-statistics` 459, and the 254 are a STRICT SUBSET — every
  // `statistics` member also carries a `probability-and-statistics` membership. So
  // 205 rows are reachable through this edge and no other.
  // The reverse is NOT declared: `probability-and-statistics` is not in TOPIC_SLUGS,
  // has no Path, and (being the superset) would gain nothing it does not already hold.
  statistics: ['probability-and-statistics'],
  // Same far shelf as the line above, now reached from the `probability` Path too
  // (warmed 2026-08-21). MEASURED 2026-08-22 with
  // `verify-topic-narrowing.ts --topic=probability --extra=probability-and-statistics`:
  // without this edge the Path loses 8 attached `teaches` rows and 110 of 126 top-6
  // candidate slots churn. No concept is EMPTIED, so the Path is serveable either way —
  // the edge is about retrieval quality, not readiness.
  //
  // What the churn detail actually shows, and the reason this is not a marginal call: on
  // its own 15-row shelf, ranked search returns essentially THE SAME dozen generic rows
  // for every concept — `expected-value`, `markov-chains`, `variance` and
  // `combinatorial-methods` all get back the same "Law of large numbers | Probability
  // Density Functions | Lecture 16: Markov Chains" list. A shelf that thin cannot
  // discriminate between its own concepts. With the edge each concept retrieves its own
  // material. The reverse is NOT declared, for the same reason it is not declared for
  // `statistics`: the far shelf is the superset and gains nothing.
  probability: ['probability-and-statistics'],
  // DSA is taught THROUGH a language, and both curated language topics carry real DSA
  // pools. One-hop only, so this does NOT connect python and javascript to each other.
  // These edges were inert until topic-filing T1.5: `TopicAlias` held the drifted
  // canonical `data-structures-and-algorithms` (note the extra "and") and relatedTopics()
  // keys off the exact slug, so a request canonicalizing to the twin got no edges. The
  // twin was merged into this curated slug (scripts/merge-topic-twins.ts) and
  // snapToKnownSlug now stops the gate re-minting it, so the edges apply. There is no DSA
  // Path yet, so these directions are declared on reasoning, not measurement.
  'data-structures-algorithms': ['python', 'javascript'],

  // ── Directions deliberately NOT declared (T4d, all measured 2026-07-27) ────────────
  //
  // calculus -> precalculus (was free via the symmetric closure). Dropped: 4 of 132
  //   candidate slots churn and NO concept loses an attached `teaches` row. The residual
  //   cost is on `foundations-functions-and-graphs`, where three precalculus
  //   function-notation rows are replaced by limits material — noted, judged acceptable.
  //   This is the direction the note above was really worried about; it is gone now.
  // sql -> python-data-ml (was declared) and python-data-ml -> sql (was free). Dropped
  //   BOTH: the far shelf was already populated when each Path was built, so the fact
  //   that neither Path took a single attachment through this edge (0 of 95 and 0 of 84)
  //   is real evidence, not an artifact. Worth 166 -> 93 rows on `sql`. The old rationale
  //   ("data-analysis material covers both SQL and pandas") did not survive contact with
  //   the corpus.
  // python -> data-structures-algorithms (was free). Dropped, and this one was actively
  //   HARMFUL: every row it contributed was the same generic MIT "Lecture 2x: Advanced
  //   Topics (cont.)" cluster, displacing on-topic Python docs ("More Control Flow
  //   Tools", "Errors and Exceptions", "Modules") from 8 candidate slots across 5
  //   concepts.
  // machine-learning -> python-data-ml, javascript -> javascript-react (both were free).
  //   Dropped: neither has a Path, so neither direction has ever been exercised. Declare
  //   them if and when a learner asks and the measurement supports it.
  // sql -> database-systems. The hypothesis when `database-systems` was promoted (Q7,
  //   2026-08-11) was that a SQL learner benefits from normalization and crash recovery
  //   while the reverse does not hold. MEASURED and NOT declared: with the edge in place,
  //   0 of 126 candidate slots across the sql Path's 21 concepts change
  //   (verify-topic-narrowing.ts --topic=sql --drop=database-systems). The edge is inert
  //   because the whole 15-row shelf is `deprecated` — soft-rejected MIT OCW 6.830 reading
  //   pages — and candidate search takes only active rows. Re-measure if that shelf ever
  //   holds live material; the reasoning may well be right, but it has no evidence yet.
  // physics-mechanics stays EDGELESS. Calculus is the only plausible neighbor, but
  //   calculus-based mechanics and calculus proper are distinct resource ecosystems
  //   (MIT 8.01 vs 18.01) and the overlap is thin — same call, and same reasoning, as
  //   the calculus/linear-algebra non-edge.
};

// {topic} ∪ the topics it may widen INTO, deduplicated. Directed (T4d): only edges
// declared ON `topic` count, so `relatedTopics('precalculus')` reaches calculus while
// `relatedTopics('calculus')` does not reach precalculus. A topic with no outbound
// edges returns just itself.
export function relatedTopics(topic: string): string[] {
  return [...new Set<string>([topic, ...(TOPIC_RELATIONS[topic] ?? [])])];
}
