// Tier 1 of the topic gate: a curated slug is accepted with no LLM call and no registry
// read. That short-circuit is what "first-class" means for a TOPIC_SLUGS entry, so it is
// worth a test that fails loudly if a promotion ever stops taking it — the tier-2/3 path
// costs a Gemini call per cold request and can mint a twin.
import { describe, it, expect, vi } from 'vitest';
import { validateTopic } from './topic-gate';
import { TOPIC_SLUGS } from '@/types/resource';

// The gate's tier-2 read would validate DATABASE_URL at module eval; tier 1 never gets
// there, which is precisely what these tests assert.
vi.mock('@/lib/db', () => ({ prisma: {} }));
// Same for the model registry, which validates GOOGLE_VERTEX_PROJECT at module eval.
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

// Reaching this is the failure: tiers 2 and 3 both live behind the curated check.
const explodes = () => {
  throw new Error('tier 3 classifier called for a curated slug');
};

describe('validateTopic — curated slugs short-circuit', () => {
  it('accepts every TOPIC_SLUGS entry without a classifier call', async () => {
    for (const slug of TOPIC_SLUGS) {
      expect(await validateTopic(slug, { classify: explodes })).toEqual({
        valid: true,
        canonical: slug,
        subject: 'known',
      });
    }
  });

  it('fast-accepts `database-systems`, promoted in Q7', async () => {
    // The promotion's learner-facing half. ⚠️ Only the SLUG form short-circuits:
    // `normalizeTopic` lowercases and collapses whitespace but does not kebab-case, so
    // "Database Systems" as a person types it goes to tier 2/3 and is answered from the
    // alias registry (once) rather than from this list. That is true of every curated
    // slug, not something specific to this one.
    expect(await validateTopic('  Database-Systems  ', { classify: explodes })).toEqual({
      valid: true,
      canonical: 'database-systems',
      subject: 'known',
    });
  });
});
