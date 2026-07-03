// F6 unit test: buildConditions gates AI-generated on-ramp rows out of the ordinary
// candidate search only when excludeGenerated is set.
//
// search-resources imports @/lib/db (prisma) and @/lib/ai/embeddings, both of which
// validate env at module-eval and throw in the secret-free unit env — stub the leaves.
// buildConditions is pure and touches neither. (See the module-eval gotcha in CLAUDE.md.)
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/embeddings', () => ({ embedQuery: async () => [] }));

import { buildConditions } from '@/lib/agents/tools/search-resources';

const GEN_CLAUSE = "origin::text <> 'generated'";
const hasGenClause = (params: Parameters<typeof buildConditions>[0]) =>
  buildConditions(params).some((c) => c.sql.includes(GEN_CLAUSE));

describe('buildConditions — excludeGenerated', () => {
  it('adds the origin<>generated clause when excludeGenerated is set', () => {
    expect(hasGenClause({ topics: ['calculus'], statuses: ['active'], excludeGenerated: true })).toBe(true);
  });

  it('omits the clause by default, so other callers are unaffected', () => {
    expect(hasGenClause({ topics: ['calculus'], statuses: ['active'] })).toBe(false);
    expect(hasGenClause({ topics: ['calculus'], statuses: ['active'], excludeGenerated: false })).toBe(false);
  });
});
