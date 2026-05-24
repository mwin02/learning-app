import type { Prisma } from '@prisma/client';

export type TopicSlug =
  | 'python-data-ml'
  | 'javascript-react'
  | 'calculus'
  | 'linear-algebra';

export const TOPIC_SLUGS: readonly TopicSlug[] = [
  'python-data-ml',
  'javascript-react',
  'calculus',
  'linear-algebra',
] as const;

// Shape used by the seed script: every field set by hand, no auto fields.
export type ResourceSeedInput = Omit<
  Prisma.ResourceCreateInput,
  'id' | 'createdAt' | 'updatedAt'
> & { topic: TopicSlug };
