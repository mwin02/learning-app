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
import { getModel } from '@/lib/ai/models';
import { recordUsage } from '@/lib/log';
import { TOPIC_SLUGS } from '@/types/resource';
import type { OnTrace } from '@/lib/agents/agent-trace';
import {
  normalizeTopic,
  lookupAlias,
  listCanonicals,
  recordCanonicalization,
  toCanonicalSlug,
  type TopicSubject,
} from '@/lib/agents/topic-registry';

export type TopicGateResult =
  | { valid: true; canonical: string; subject: 'math' | 'science' | 'cs' | 'known' }
  | { valid: false; reason: string };

const VerdictSchema = z.object({
  valid: z.boolean(),
  subject: z.enum(['math', 'science', 'cs']).nullable(),
  canonical: z.string().nullable(),
  reason: z.string().nullable(),
});

type Verdict = z.infer<typeof VerdictSchema>;

// The tier-3 classifier, injectable (same `opts` pattern as enqueueProgram's `plan`)
// so the gate's post-verdict logic — slug coercion, persistence, rejection — can be
// integration-tested without an LLM. Defaults to the real Gemini Flash call.
export type TopicClassifier = (normalized: string, canonicals: string[]) => Promise<Verdict>;

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

// The real tier-3 classifier: Gemini Flash with structured output, grounded on the
// slugs already in use. Retried once — Gemini structured output occasionally returns
// unparseable/truncated JSON (`No object generated`), a transient hiccup that must not
// hard-fail the caller (a single flaky response would otherwise 500 a standalone
// /api/generate-path request). A second failure propagates. (Mirrors decomposeProgram.)
const defaultClassify: TopicClassifier = async (normalized, canonicals) => {
  const { model, temperature, maxOutputTokens } = getModel('topicGate');
  const prompt = [
    `Canonical slugs already in use: ${canonicals.length > 0 ? canonicals.join(', ') : '(none yet)'}`,
    `Topic: ${JSON.stringify(normalized)}`,
  ].join('\n');
  let result: Awaited<ReturnType<typeof generateObject<typeof VerdictSchema>>> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await generateObject({
        model,
        temperature,
        maxOutputTokens,
        schema: VerdictSchema,
        system: SYSTEM_PROMPT,
        prompt,
      });
      break;
    } catch (err) {
      lastErr = err;
      console.warn('[topic-gate] classifier attempt failed', {
        attempt,
        topic: normalized,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!result) throw lastErr;
  recordUsage('topic-gate', result.usage);
  console.log('[topic-gate] call', { topic: normalized, usage: result.usage, verdict: result.object });
  return result.object;
};

export async function validateTopic(
  topic: string,
  opts: { onTrace?: OnTrace; classify?: TopicClassifier } = {},
): Promise<TopicGateResult> {
  const onTrace: OnTrace = opts.onTrace ?? (() => {});
  const classify = opts.classify ?? defaultClassify;
  const normalized = normalizeTopic(topic);
  onTrace({ kind: 'stage', label: 'topic gate started', detail: { topic, normalized } });

  // Tier 1: short-circuit curated slugs. No LLM call for the hot path.
  if ((TOPIC_SLUGS as readonly string[]).includes(normalized)) {
    onTrace({ kind: 'stage', label: 'topic gate: curated match', detail: { canonical: normalized } });
    return { valid: true, canonical: normalized, subject: 'known' };
  }

  // Tier 2: a phrasing we've already canonicalized. Stable and LLM-free.
  const cached = await lookupAlias(normalized);
  onTrace({ kind: 'tool', label: 'registry: lookupAlias', detail: { normalized, hit: Boolean(cached) } });
  if (cached) {
    onTrace({
      kind: 'stage',
      label: 'topic gate: registry cache hit',
      detail: { canonical: cached.canonical, subject: cached.subject },
    });
    return { valid: true, canonical: cached.canonical, subject: cached.subject as TopicSubject };
  }

  // Tier 3: Gemini Flash verdict, grounded on the slugs already in use so it
  // maps onto an existing one rather than minting a near-duplicate.
  const canonicals = await listCanonicals();
  onTrace({ kind: 'tool', label: 'registry: listCanonicals', detail: { count: canonicals.length } });

  const v = await classify(normalized, canonicals);
  onTrace({
    kind: 'stage',
    label: 'topic gate: classifier verdict',
    detail: { valid: v.valid, canonical: v.canonical, subject: v.subject },
  });
  if (!v.valid) {
    onTrace({ kind: 'stage', label: 'topic gate: rejected', detail: { reason: v.reason } });
    return { valid: false, reason: v.reason?.trim() || 'topic rejected without explanation' };
  }
  if (!v.subject || !v.canonical) {
    onTrace({
      kind: 'stage',
      label: 'topic gate: rejected',
      detail: { reason: 'valid=true without subject or canonical slug' },
    });
    return { valid: false, reason: 'classifier returned valid=true without subject or canonical slug' };
  }

  // Coerce the LLM-minted slug to a safe canonical BEFORE it's frozen as Path.topic /
  // CourseRequest.topic / a first-writer-wins TopicAlias — kebab-case is otherwise
  // only prompt-enforced. Reject when nothing usable survives (empty / all-junk).
  const canonical = toCanonicalSlug(v.canonical);
  if (!canonical) {
    onTrace({
      kind: 'stage',
      label: 'topic gate: rejected',
      detail: { reason: 'canonical slug normalized to empty', raw: v.canonical },
    });
    return { valid: false, reason: 'classifier returned an unusable canonical slug' };
  }

  // Persist so this phrasing (and the canonical itself) short-circuits next
  // time. Best-effort: a write failure shouldn't fail an otherwise-valid topic.
  try {
    await recordCanonicalization({ alias: normalized, canonical, subject: v.subject });
    onTrace({
      kind: 'tool',
      label: 'registry: recordCanonicalization',
      detail: { alias: normalized, canonical, subject: v.subject },
    });
  } catch (err) {
    console.error('[topic-gate] failed to persist canonicalization', { normalized, canonical, err });
    onTrace({
      kind: 'info',
      label: 'registry: recordCanonicalization failed',
      detail: { alias: normalized, canonical },
    });
  }

  onTrace({
    kind: 'stage',
    label: 'topic gate: minted new canonical',
    detail: { canonical, subject: v.subject },
  });
  return { valid: true, canonical, subject: v.subject };
}
