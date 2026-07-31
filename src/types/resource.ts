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
  | 'go';

// Curated topics. Membership here is what makes a topic first-class: the topic
// gate fast-accepts it without an LLM call, and the planner/registry canonical
// lists union it. The free-beta warm set (C1) is this list minus `go` —
// off-niche, kept available on demand but not warmed.
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
  'go',
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
  // 76 calculus rows and skipping web discovery entirely — the rung counts raw hits, not
  // judged-`teaches` survivors (a locked tradeoff, see web-fallback.ts:171-173), so
  // divergent concepts (conic-sections, systems-of-equations-and-matrices,
  // combining-functions) were starved and relaxed to hollow. That is an argument about
  // the rung's counting, not about this edge.
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
