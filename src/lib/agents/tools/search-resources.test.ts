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

// Topic filing T1: topic scoping is a semi-join against ResourceTopic, not a test of the
// scalar mirror. The duplicate-row footgun these guard against is a JOIN instead of
// EXISTS — see the comment on the clause in search-resources.ts.
describe('buildConditions — topic membership (ResourceTopic)', () => {
  const topicSql = (params: Parameters<typeof buildConditions>[0]) =>
    buildConditions(params).map((c) => c.sql).find((s) => s.includes('ResourceTopic'));

  it('scopes a single topic through an EXISTS subquery on ResourceTopic', () => {
    const sql = topicSql({ topic: 'calculus' });
    expect(sql).toBeDefined();
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('rt."resourceId" = "Resource".id');
  });

  it('routes a topics list through the same single EXISTS clause', () => {
    const conds = buildConditions({ topics: ['javascript-react', 'javascript'] });
    const membership = conds.filter((c) => c.sql.includes('ResourceTopic'));
    // One clause, not one per topic — and its IN list carries both values, so a
    // resource matching both topics still yields a single row.
    expect(membership).toHaveLength(1);
    expect(membership[0].values).toEqual(expect.arrayContaining(['javascript-react', 'javascript']));
  });

  it('never emits a JOIN for topic scoping (the duplicate-row footgun)', () => {
    const sql = topicSql({ topics: ['javascript-react', 'javascript'] }) ?? '';
    expect(sql).not.toMatch(/\bJOIN\b/i);
  });

  it('admits a primary membership always, a secondary only when uncontested', () => {
    expect(topicSql({ topic: 'calculus' })).toContain('rt."isPrimary" OR NOT rt.contested');
  });

  it('no longer tests the scalar Resource.topic mirror', () => {
    const all = buildConditions({ topics: ['calculus'] }).map((c) => c.sql).join(' ');
    expect(all).not.toMatch(/(^|\s)topic\s*(=|IN)/);
  });

  it('emits no topic clause at all when neither topic nor topics is given', () => {
    expect(topicSql({ statuses: ['active'] })).toBeUndefined();
    expect(topicSql({ topics: [] })).toBeUndefined();
  });
});
