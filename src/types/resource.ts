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

// Symmetric relatedness among topics. An edge means "these topics legitimately
// share resources" (React draws on JS foundations), so search widens a topic to
// its related set. UNRELATED topics never bleed — calculus and linear-algebra
// have no edge by design. Keys may be agent-minted slugs (e.g. `javascript`),
// not only curated TOPIC_SLUGS. Extend in code as new related pairs emerge.
//
// This list currently does TWO jobs: it widens RETRIEVAL (searchResources /
// the web-fallback library rung), and it bounds FILING — classifyDiscoveryTopics
// may only return a member of relatedTopics(requestTopic). docs/topic-filing-plan.md
// removes the second job: filing becomes evidence-based multi-membership
// (`ResourceTopic` + a centroid guardrail), and `minRelevance` takes over as the
// bleed control. Edges below are therefore justified on RETRIEVAL grounds only —
// "should a request for A be allowed to surface B's shelf?" — not on filing.
export const TOPIC_RELATIONS: Record<string, readonly string[]> = {
  'javascript-react': ['javascript'],
  // "Python for data/ML" is the applied glue that draws on two foundations:
  // the Python language and (largely language-agnostic) ML theory. Split out of
  // a single conflated `python-data-ml` topic — the language tutorials moved to
  // `python`, StatQuest's ML theory to `machine-learning` — so the applied topic
  // composes both via relatedTopics() (symmetric, so python/machine-learning
  // requests also reach the applied resources).
  'python-data-ml': ['python', 'machine-learning'],
  // Free-beta warm topics (C1). Each edge decided on its own merits — widening
  // is not free, so "adjacent in a curriculum" is NOT sufficient.
  //
  // Precalculus is calculus's direct prerequisite and the shelves genuinely
  // overlap (functions, trig, intro-to-limits sit in both curricula).
  // ⚠️ Measured 2026-07-25, warming `precalculus` cold: the library rung reached
  // 76 calculus-filed resources through this edge and web discovery was skipped
  // entirely (`[web-fallback] library rung filled the target`) — the rung counts
  // raw hits, not judged-`teaches` survivors (that gate is a locked tradeoff, see
  // web-fallback.ts:171-173). Concepts where precalculus DIVERGES from calculus
  // (conic-sections, systems-of-equations-and-matrices, combining-functions) were
  // starved of discovery and relaxed to hollow. The root cause is mis-filing, not
  // this edge — most of those 76 are genuinely precalculus material stamped
  // `calculus` because that was the topic being built when discovery found them.
  // Re-evaluate this edge after docs/topic-filing-plan.md T4: once memberships are
  // real, "does precalculus need calculus?" stops being a proxy for "is precalc
  // material mis-filed as calculus?" and becomes answerable on its own terms.
  precalculus: ['calculus'],
  // SQL's overlap is with the APPLIED data topic, not the Python language:
  // data-analysis material routinely covers both SQL and pandas. Deliberately a
  // single edge — no edge to `python` (a SQL request has no business reaching
  // language tutorials) and none to `statistics`.
  sql: ['python-data-ml'],
  // DSA is taught THROUGH a language, and both curated language topics carry
  // real DSA pools (Python most of all, JS second). One-hop only, so this does
  // NOT connect python and javascript to each other.
  // These edges were inert until topic-filing T1.5: `TopicAlias` held the drifted
  // canonical `data-structures-and-algorithms` (note the extra "and") and
  // relatedTopics() keys off the exact slug, so a request canonicalizing to the twin
  // got no edges. The twin was merged into this curated slug (scripts/merge-topic-twins.ts)
  // and snapToKnownSlug now stops the gate re-minting it, so the edges apply. Note the
  // shelf itself is still empty — 0 resources are filed here today.
  'data-structures-algorithms': ['python', 'javascript'],
  // `physics-mechanics` is deliberately EDGELESS. Calculus is the only plausible
  // neighbor, but calculus-based mechanics and calculus proper are distinct
  // resource ecosystems (MIT 8.01 vs 18.01) and the overlap is thin — same call,
  // and same reasoning, as the calculus/linear-algebra non-edge above.
};

// {topic} ∪ its related topics, deduplicated. Symmetric: an edge counts in both
// directions, so a `javascript` request reaches `javascript-react` and vice
// versa. A topic with no edges returns just itself.
export function relatedTopics(topic: string): string[] {
  const set = new Set<string>([topic]);
  for (const t of TOPIC_RELATIONS[topic] ?? []) set.add(t);
  for (const [k, vs] of Object.entries(TOPIC_RELATIONS)) {
    if (vs.includes(topic)) set.add(k);
  }
  return [...set];
}
