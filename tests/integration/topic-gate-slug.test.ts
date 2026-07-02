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

const cleanup = () => prisma.topicAlias.deleteMany({ where: { canonical: { startsWith: MARK } } });

const aliasRow = (alias: string) =>
  prisma.topicAlias.findUnique({ where: { alias }, select: { canonical: true, subject: true } });

// A classifier that mints the given (deliberately messy) canonical.
const mint =
  (canonical: string): TopicClassifier =>
  async () => ({ valid: true, subject: 'cs', canonical, reason: null });

describeDb('topic gate: tier-3 slug validation', () => {
  beforeAll(cleanup);
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

  it('rejects a verdict whose canonical normalizes to empty, persisting nothing', async () => {
    const topic = 'zz verify slug junk canonical';
    const res = await validateTopic(topic, { classify: mint('!!!') });

    expect(res.valid).toBe(false);
    // No alias row was written for the junk input.
    expect(await aliasRow('zz verify slug junk canonical')).toBeNull();
  });
});
