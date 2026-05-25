import type { Prisma } from '@prisma/client';

// Shape used by the seed script: every field set by hand, no auto fields.
export type SourceSeedInput = Omit<
  Prisma.SourceCreateInput,
  'id' | 'createdAt' | 'updatedAt' | 'resources'
>;
