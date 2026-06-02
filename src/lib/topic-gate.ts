// Topic-validity gate. Runs at the HTTP boundary (POST /api/generate-path)
// to keep junk and out-of-domain topics from reaching the curriculum agent —
// and, more importantly, from triggering web fallback that would otherwise
// stuff garbage Resources into the library.
//
// Three-tier check:
//   1. If the topic matches a curated TopicSlug, accept immediately (no LLM
//      call). The curated launch topics are trusted by definition.
//   2. If the normalized phrasing is already in the TopicAlias registry, reuse
//      the canonical slug it resolved to before — no LLM call, and stable
//      across runs (see src/lib/topic-registry.ts).
//   3. Otherwise call Gemini Flash with structured output, grounded on the
//      canonical slugs already in use, to either map onto an existing slug or
//      mint a new one (or reject). The result is persisted so this phrasing
//      short-circuits at tier 2 forever after.
//
// Tiers 2-3 are what stop slug drift ("go" vs "golang") from fragmenting the
// Resource library, which keys on an exact `topic` match.
//
// Subject domain is currently {mathematics, natural sciences, computer
// science}, matching the locked niche in CLAUDE.md (tech upskillers +
// math/science students).

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/models';
import { TOPIC_SLUGS } from '@/types/resource';
import {
  normalizeTopic,
  lookupAlias,
  listCanonicals,
  recordCanonicalization,
  type TopicSubject,
} from '@/lib/topic-registry';

export type TopicGateResult =
  | { valid: true; canonical: string; subject: 'math' | 'science' | 'cs' | 'known' }
  | { valid: false; reason: string };

const VerdictSchema = z.object({
  valid: z.boolean(),
  subject: z.enum(['math', 'science', 'cs']).nullable(),
  canonical: z.string().nullable(),
  reason: z.string().nullable(),
});

const SYSTEM_PROMPT = [
  'You are a topic-validity classifier for a learning-path app.',
  'Decide whether the given topic is a legitimate learning topic within one of:',
  '  - mathematics (e.g. calculus, linear algebra, statistics)',
  '  - the natural sciences (e.g. organic chemistry, classical mechanics, cell biology)',
  '  - computer science (e.g. python, react, distributed systems, machine learning)',
  '',
  'Reject:',
  '  - vague or meta phrases ("learning", "studying", "self-improvement")',
  '  - jokes, slurs, harmful or illegal content',
  '  - topics outside math / natural sciences / computer science (e.g. cooking, finance, dating)',
  '  - empty or single-character inputs',
  '',
  'You will be given a list of canonical slugs already in use. If the topic is the',
  'SAME concept as one of them (differing only in phrasing, abbreviation, casing, or',
  'separators — e.g. "golang" vs "go"), return that existing slug verbatim as',
  '`canonical`. Be conservative: only reuse a slug for a genuinely identical concept.',
  'Do NOT merge distinct topics (e.g. "java" is not "javascript", "probability" is not',
  '"statistics", "linear algebra" is not "calculus"). When the topic is new, mint a',
  'fresh kebab-case `canonical` slug (lowercase, hyphens, no spaces).',
  '',
  'Always return the matching `subject`. When invalid, set `valid:false`, leave',
  'subject/canonical as null, and put a one-sentence explanation in `reason`.',
].join('\n');

export async function validateTopic(topic: string): Promise<TopicGateResult> {
  const normalized = normalizeTopic(topic);

  // Tier 1: short-circuit curated slugs. No LLM call for the hot path.
  if ((TOPIC_SLUGS as readonly string[]).includes(normalized)) {
    return { valid: true, canonical: normalized, subject: 'known' };
  }

  // Tier 2: a phrasing we've already canonicalized. Stable and LLM-free.
  const cached = await lookupAlias(normalized);
  if (cached) {
    return { valid: true, canonical: cached.canonical, subject: cached.subject as TopicSubject };
  }

  // Tier 3: Gemini Flash verdict, grounded on the slugs already in use so it
  // maps onto an existing one rather than minting a near-duplicate.
  const canonicals = await listCanonicals();
  const { model, temperature, maxOutputTokens } = getModel('topicGate');
  const result = await generateObject({
    model,
    temperature,
    maxOutputTokens,
    schema: VerdictSchema,
    system: SYSTEM_PROMPT,
    prompt: [
      `Canonical slugs already in use: ${canonicals.length > 0 ? canonicals.join(', ') : '(none yet)'}`,
      `Topic: ${JSON.stringify(normalized)}`,
    ].join('\n'),
  });

  console.log('[topic-gate] call', { topic: normalized, usage: result.usage, verdict: result.object });

  const v = result.object;
  if (!v.valid) {
    return { valid: false, reason: v.reason?.trim() || 'topic rejected without explanation' };
  }
  if (!v.subject || !v.canonical) {
    return { valid: false, reason: 'classifier returned valid=true without subject or canonical slug' };
  }

  // Persist so this phrasing (and the canonical itself) short-circuits next
  // time. Best-effort: a write failure shouldn't fail an otherwise-valid topic.
  try {
    await recordCanonicalization({ alias: normalized, canonical: v.canonical, subject: v.subject });
  } catch (err) {
    console.error('[topic-gate] failed to persist canonicalization', { normalized, canonical: v.canonical, err });
  }

  return { valid: true, canonical: v.canonical, subject: v.subject };
}
