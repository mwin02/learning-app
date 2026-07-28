// DB integration test for F2: a tier-3 mint persists the slugified canonical, and an
// unusable slug is rejected. The LLM classifier is injected (opts.classify) so we
// exercise the gate's post-verdict slug coercion + persistence without a model call.
//
// Self-cleaning: rows use a slug-safe `zz-verify-slug` marker (must survive
// toCanonicalSlug), deleted in before/after. Both the alias row and the canonical
// self-alias row share canonical=<slug>, so deleting by canonical prefix catches both.
//
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { validateTopic, type TopicClassifier } from '@/lib/agents/topic-gate';
import { describeDb } from './db';

const MARK = 'zz-verify-slug';
// The snap test's mint resolves to a REAL curated slug, so its alias row is not caught by
// the canonical-prefix sweep — match the input phrasing too. And its canonical self-alias
// ('data-structures-algorithms' → itself) is a legitimate registry row we must not delete
// if it predates the test: quarantine-and-restore, per the pattern in CLAUDE.md.
const SNAP_CANONICAL = 'data-structures-algorithms';
let snapSelfAliasPreexisted = false;

async function cleanup() {
  await prisma.topicAlias.deleteMany({
    where: {
      OR: [{ canonical: { startsWith: MARK } }, { alias: { startsWith: 'zz verify slug' } }],
    },
  });
  if (!snapSelfAliasPreexisted) {
    await prisma.topicAlias.deleteMany({ where: { alias: SNAP_CANONICAL } });
  }
}

const aliasRow = (alias: string) =>
  prisma.topicAlias.findUnique({ where: { alias }, select: { canonical: true, subject: true } });

// A classifier that mints the given (deliberately messy) canonical.
const mint =
  (canonical: string): TopicClassifier =>
  async () => ({ valid: true, subject: 'cs', canonical, reason: null });

describeDb('topic gate: tier-3 slug validation', () => {
  beforeAll(async () => {
    snapSelfAliasPreexisted = (await aliasRow(SNAP_CANONICAL)) !== null;
    await cleanup();
  });
  afterAll(cleanup);

  it('persists a mixed-case / spaced mint as a slugified canonical', async () => {
    const topic = 'ZZ Verify Slug MixedCase Topic';
    const normalized = 'zz verify slug mixedcase topic'; // normalizeTopic(topic)
    const slug = 'zz-verify-slug-mixedcase-topic'; // toCanonicalSlug of the minted canonical

    // The classifier returns the raw, unslugified phrasing — the gate must slugify it.
    const res = await validateTopic(topic, { classify: mint('ZZ Verify Slug MixedCase Topic') });

    expect(res).toEqual({ valid: true, canonical: slug, subject: 'cs' });

    // The alias row maps the input phrasing → slug, and the canonical self-alias exists.
    expect(await aliasRow(normalized)).toEqual({ canonical: slug, subject: 'cs' });
    expect(await aliasRow(slug)).toEqual({ canonical: slug, subject: 'cs' });
  });

  // T1.5: the anti-drift guard, end to end through the gate. The unit tests
  // (topic-registry.test.ts) pin snapToKnownSlug's rule; this pins that the gate applies
  // it, and — the part that actually matters — that the SNAPPED slug is what gets frozen
  // into TopicAlias. This is a replay of the real defect: the gate minted
  // `data-structures-and-algorithms` alongside the curated `data-structures-algorithms`.
  it('snaps a near-duplicate mint onto the curated slug before persisting it', async () => {
    const topic = 'zz verify slug and twin';
    const normalized = 'zz verify slug and twin';
    // The mint differs from a curated slug only by a filler token.
    const res = await validateTopic(topic, {
      classify: mint('data structures and algorithms'),
    });

    expect(res).toEqual({ valid: true, canonical: 'data-structures-algorithms', subject: 'cs' });
    // The twin was never written: the phrasing resolves straight to the curated slug.
    expect(await aliasRow(normalized)).toEqual({
      canonical: 'data-structures-algorithms',
      subject: 'cs',
    });
    expect(await prisma.topicAlias.count({ where: { canonical: 'data-structures-and-algorithms' } })).toBe(0);
  });

  it('rejects a verdict whose canonical normalizes to empty, persisting nothing', async () => {
    const topic = 'zz verify slug junk canonical';
    const res = await validateTopic(topic, { classify: mint('!!!') });

    expect(res.valid).toBe(false);
    // No alias row was written for the junk input.
    expect(await aliasRow('zz verify slug junk canonical')).toBeNull();
  });
});
