export type TopicSlug =
  | 'python'
  | 'python-data-ml'
  | 'javascript'
  | 'javascript-react'
  | 'calculus'
  | 'linear-algebra'
  | 'machine-learning'
  | 'statistics'
  | 'go';

export const TOPIC_SLUGS: readonly TopicSlug[] = [
  'python',
  'python-data-ml',
  'javascript',
  'javascript-react',
  'calculus',
  'linear-algebra',
  'machine-learning',
  'statistics',
  'go',
] as const;

// Symmetric relatedness among topics. An edge means "these topics legitimately
// share resources" (React draws on JS foundations), so search widens a topic to
// its related set. UNRELATED topics never bleed — calculus and linear-algebra
// have no edge by design. Keys may be agent-minted slugs (e.g. `javascript`),
// not only curated TOPIC_SLUGS. Extend in code as new related pairs emerge.
export const TOPIC_RELATIONS: Record<string, readonly string[]> = {
  'javascript-react': ['javascript'],
  // "Python for data/ML" is the applied glue that draws on two foundations:
  // the Python language and (largely language-agnostic) ML theory. Split out of
  // a single conflated `python-data-ml` topic — the language tutorials moved to
  // `python`, StatQuest's ML theory to `machine-learning` — so the applied topic
  // composes both via relatedTopics() (symmetric, so python/machine-learning
  // requests also reach the applied resources).
  'python-data-ml': ['python', 'machine-learning'],
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
