// Topic-validity gate. Runs at the HTTP boundary (POST /api/generate-path)
// to keep junk and out-of-domain topics from reaching the curriculum agent —
// and, more importantly, from triggering web fallback that would otherwise
// stuff garbage Resources into the library.
//
// Two-tier check:
//   1. If the topic matches an existing TopicSlug, accept immediately (no
//      LLM call). The curated launch topics are trusted by definition.
//   2. Otherwise call Gemini Flash with structured output to classify the
//      topic into {math, science, cs} or reject it. One cheap call, no
//      retries — the gate fails fast on the rare bad input.
//
// Subject domain is currently {mathematics, natural sciences, computer
// science}, matching the locked niche in CLAUDE.md (tech upskillers +
// math/science students).

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/models';
import { TOPIC_SLUGS } from '@/types/resource';

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
  'When valid, return a kebab-case `canonical` slug (lowercase, hyphens, no spaces)',
  'and the matching `subject`. When invalid, set `valid:false`, leave subject/canonical',
  'as null, and put a one-sentence explanation in `reason`.',
].join('\n');

export async function validateTopic(topic: string): Promise<TopicGateResult> {
  const trimmed = topic.trim();

  // Tier 1: short-circuit curated slugs. No LLM call for the hot path.
  if ((TOPIC_SLUGS as readonly string[]).includes(trimmed)) {
    return { valid: true, canonical: trimmed, subject: 'known' };
  }

  // Tier 2: Gemini Flash verdict.
  const { model, temperature, maxOutputTokens } = getModel('topicGate');
  const result = await generateObject({
    model,
    temperature,
    maxOutputTokens,
    schema: VerdictSchema,
    system: SYSTEM_PROMPT,
    prompt: `Topic: ${JSON.stringify(trimmed)}`,
  });

  console.log('[topic-gate] call', { topic: trimmed, usage: result.usage, verdict: result.object });

  const v = result.object;
  if (!v.valid) {
    return { valid: false, reason: v.reason?.trim() || 'topic rejected without explanation' };
  }
  if (!v.subject || !v.canonical) {
    return { valid: false, reason: 'classifier returned valid=true without subject or canonical slug' };
  }
  return { valid: true, canonical: v.canonical, subject: v.subject };
}
