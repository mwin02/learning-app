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

// Shape used by the seed script. Curators set `sourceSlug` (resolved by the
// seed script to a real sourceId); `trustScore` is omitted because it's
// inherited from the source's trustScore at create time.
export type ResourceSeedInput = Omit<
  Prisma.ResourceCreateInput,
  'id' | 'createdAt' | 'updatedAt' | 'source' | 'trustScore'
> & { topic: TopicSlug; sourceSlug: string };
