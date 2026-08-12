// The reviewer's refile seam — an operator's free-text topic, canonicalized and
// checked against the registry, then written through `setPrimaryTopic`.
//
// Extracted from report-triage.ts (Reports F3b) at Q9, when the pending-review
// queue became the second reviewer surface that can refile a row. Both go through
// here rather than each calling `setPrimaryTopic` with a raw string, because the
// guard is the whole point of the seam:
//
// `Resource.topic` is matched EXACTLY by the library (sourcing, `relatedTopics`,
// retrieval), so an operator's free text is the one input on this path that can
// mint a twin slug — "Linear Algebra" would file a row nothing searching
// `linear-algebra` can ever see, and then report success. Every other caller of
// `setPrimaryTopic` derives its target from the registry or a filing decision;
// this one canonicalizes first and refuses a slug the registry (curated ∪ learned)
// has never seen, rather than inventing vocabulary from a text box.
//
// `origin: 'review'` is the honest provenance: a human decided this filing. It is
// also what makes a reviewer-corrected membership visible as such in the queue.

import { prisma } from '@/lib/db';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';
import { listCanonicals, normalizeTopic, toCanonicalSlug } from '@/lib/agents/topic-registry';

export type RefileResult =
  | { kind: 'refiled'; topic: string }
  // Nothing was written, and why — in operator-readable words.
  | { kind: 'refused'; reason: string };

export async function refileToTopic(resourceId: string, input: string): Promise<RefileResult> {
  const topic = toCanonicalSlug(normalizeTopic(input));
  if (!topic) return { kind: 'refused', reason: `"${input}" has no usable slug` };

  const [resource, known] = await Promise.all([
    prisma.resource.findUnique({ where: { id: resourceId }, select: { topic: true } }),
    listCanonicals(),
  ]);
  if (!resource) return { kind: 'refused', reason: 'resource no longer exists' };
  // Reviewer surfaces prefill the current topic, so one click on Refile would
  // otherwise rewrite nothing but `origin` and report the row as refiled (F3d).
  if (resource.topic === topic) {
    return { kind: 'refused', reason: `already filed under "${topic}" — pick a different topic` };
  }
  if (!known.includes(topic)) {
    return { kind: 'refused', reason: `"${topic}" is not a known topic — refile onto an existing one` };
  }

  await setPrimaryTopic(resourceId, topic, { origin: 'review' });
  return { kind: 'refiled', topic };
}
