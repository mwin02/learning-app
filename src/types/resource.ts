import type { Prisma } from '@prisma/client';

export type TopicSlug =
  | 'python-data-ml'
  | 'javascript-react'
  | 'calculus'
  | 'linear-algebra'
  | 'machine-learning'
  | 'statistics'
  | 'go';

export const TOPIC_SLUGS: readonly TopicSlug[] = [
  'python-data-ml',
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

// Shape used by the seed script. Curators set `sourceSlug` (resolved by the
// seed script to a real sourceId); `trustScore` is omitted because it's
// inherited from the source's trustScore at create time.
export type ResourceSeedInput = Omit<
  Prisma.ResourceCreateInput,
  'id' | 'createdAt' | 'updatedAt' | 'source' | 'trustScore'
> & { topic: TopicSlug; sourceSlug: string };
