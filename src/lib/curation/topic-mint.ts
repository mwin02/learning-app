// Topic filing T3 — discovery may mint topics.
//
// Pre-T3 a new canonical slug could only be born from a LEARNER REQUEST: the topic gate
// runs in the program plan pass, and discovery had no minting path at all (mechanic #4 of
// the plan's defect list). So a resource whose true subject was absent from the vocabulary
// had nowhere to go — the 45 Khan "Functions" leaves are correctly detected as mis-filed
// but their right answer, `algebra`, is a topic no code path could produce.
//
// This closes that loop by REUSING the topic gate rather than adding a second minting
// path: validateTopic already coerces to a safe slug (toCanonicalSlug), already grounds
// the model on the canonical list, already snaps a near-duplicate onto a curated slug
// (T1.5), already rejects out-of-domain junk, and already persists the alias so the next
// discovery short-circuits at tier 2. A freshly minted topic with no Path is harmless: it
// waits in the library until a learner asks for it.
//
// Two properties this wrapper adds on top of the gate:
//   - MEMOIZED per batch. A discovery batch commonly proposes the same missing subject for
//     several rows; the gate's tier 3 is an LLM call, so the first row pays and the rest
//     read the cache (including the negative result — a rejected label is not retried).
//   - BEST-EFFORT. A gate failure returns null and the caller keeps its unmodified filing
//     decision. Minting is an upgrade to filing, never a precondition for it: a flaky
//     structured-output call must not fail a sourcing run that already paid for discovery.

import { validateTopic } from '@/lib/agents/topic-gate';

export type TopicMinter = (label: string) => Promise<string | null>;

// One minter per discovery batch. `gate` is injectable so the wiring can be tested
// without an LLM (same `opts` seam validateTopic itself uses).
export function createTopicMinter(
  gate: (topic: string) => Promise<{ valid: boolean; canonical?: string }> = (t) =>
    validateTopic(t).then((r) => (r.valid ? { valid: true, canonical: r.canonical } : { valid: false })),
): TopicMinter {
  const cache = new Map<string, string | null>();

  return async (label: string) => {
    const key = label.trim().toLowerCase();
    if (!key) return null;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let canonical: string | null = null;
    try {
      const verdict = await gate(label);
      canonical = verdict.valid ? (verdict.canonical ?? null) : null;
      console.log('[topic-mint] gate verdict', { proposed: label, canonical, valid: verdict.valid });
    } catch (err) {
      console.warn('[topic-mint] gate failed, keeping the guardrail decision', {
        proposed: label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    cache.set(key, canonical);
    return canonical;
  };
}
