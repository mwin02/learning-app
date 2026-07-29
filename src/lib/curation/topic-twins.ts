// Topic filing T1.5 — merge a drifted canonical into the slug it should have been.
//
// Two twins exist (docs/topic-filing-plan.md T4 §2, pulled forward to T1.5 so the
// open-vocabulary classifier never runs against a polluted vocabulary):
//   data-structures-and-algorithms → data-structures-algorithms  (a twin of a CURATED slug)
//   probability                    → probability-and-statistics  (a twin of a LEARNED one)
// Each is two canonicals over one pool: `relatedTopics` keys off the exact slug and the
// library keys off an exact `topic` match, so a twin silently splits a shelf in half.
//
// snapToKnownSlug (topic-registry.ts) stops the NEXT one; this cleans up these two.
//
// Measured on the dev DB 2026-07-25, both dead slugs hold zero resources and zero
// memberships, so the membership/mirror branches below are no-ops there. They are written
// and tested anyway: this is meant to be re-runnable, including against the Supabase DB
// after the free-beta D2 cutover, where the data will differ.

import { prisma } from '@/lib/db';
import { repointCanonical } from '@/lib/agents/topic-registry';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';

export type TwinMergePlan = {
  from: string;
  to: string;
  aliases: number;
  primaryMemberships: number;
  secondaryMemberships: number;
  mirrorsOnly: number; // Resource.topic = from with no membership under it (pre-T1 rows)
  blockingRefs: { paths: number; courseRequests: number };
};

// The two live merges. Direction is not arbitrary: the dead slug is the empty one, and
// where a curated slug is involved it is always the survivor.
export const TOPIC_TWINS: { from: string; to: string }[] = [
  { from: 'data-structures-and-algorithms', to: 'data-structures-algorithms' },
  { from: 'probability', to: 'probability-and-statistics' },
];

export async function planTwinMerge(from: string, to: string): Promise<TwinMergePlan> {
  const [aliases, memberships, mirrorsOnly, paths, courseRequests] = await Promise.all([
    prisma.topicAlias.count({ where: { canonical: from } }),
    prisma.resourceTopic.findMany({ where: { topic: from }, select: { isPrimary: true } }),
    prisma.resource.count({
      where: { topic: from, topics: { none: { topic: from } } },
    }),
    prisma.path.count({ where: { topic: from } }),
    prisma.courseRequest.count({ where: { topic: from } }),
  ]);
  return {
    from,
    to,
    aliases,
    primaryMemberships: memberships.filter((m) => m.isPrimary).length,
    secondaryMemberships: memberships.filter((m) => !m.isPrimary).length,
    mirrorsOnly,
    blockingRefs: { paths, courseRequests },
  };
}

// Applies one merge. Idempotent: a second run finds nothing to move and returns zeroes.
//
// Refuses when a Path or CourseRequest still names the dead slug — those are request-side
// topics (which this plan deliberately leaves scalar), and repointing the library out from
// under a live Path would strand it. Resolve by hand, then re-run.
export async function applyTwinMerge(from: string, to: string): Promise<TwinMergePlan> {
  const plan = await planTwinMerge(from, to);
  const { paths, courseRequests } = plan.blockingRefs;
  if (paths > 0 || courseRequests > 0) {
    throw new Error(
      `refusing to merge ${from} → ${to}: still referenced by ${paths} Path(s) and ` +
        `${courseRequests} CourseRequest(s). Repoint those first.`,
    );
  }

  // 1. Aliases: every phrasing that resolved to the dead slug now resolves to the survivor
  // (F7's repointCanonical — a deliberate override of first-writer-wins, as here).
  await repointCanonical(from, to);

  // 2. Primary memberships + their mirrors, through the T1 write seam so `Resource.topic`
  // moves in the same transaction as the flag.
  //
  // All three evidence fields ride along — `origin` included. A merge RENAMES a topic; it
  // gathers no new evidence, so the moved membership must keep the provenance it had.
  // Dropping it would let setPrimaryTopic's schema default apply on the created row and
  // silently promote an `inherited` backfill membership to `classifier`, claiming a
  // verdict nothing ever produced — precisely the mislabel T4's origin-aware
  // `minRelevance` will read (see the relevance note on the ResourceTopic model).
  // Symmetric with the secondary branch below, which preserves origin by moving the row.
  const primaries = await prisma.resourceTopic.findMany({
    where: { topic: from, isPrimary: true },
    select: { resourceId: true, relevance: true, origin: true, contested: true },
  });
  for (const m of primaries) {
    // ⚠️ ONLY WHEN THE SURVIVOR HAS NO EVIDENCE OF ITS OWN. A resource can hold `from` as
    // its primary AND `to` as a secondary — for these two twins that is one pool split in
    // half, so either row's numbers describe the same shelf and it does not matter. It
    // matters the moment this module is reused for a merge where the shelves genuinely
    // differed: setPrimaryTopic's UPDATE branch writes whatever opts it is given, so
    // carrying the dead slug's evidence across would overwrite a measured relevance/origin
    // on the surviving membership with one taken against a different topic. The seam with
    // no evidence opts sets `isPrimary` and the mirror and nothing else, which is exactly
    // "promote what is already there". Symmetric with the secondary branch below, which
    // resolves the same collision by dropping the dead row rather than merging over it.
    const existing = await prisma.resourceTopic.findUnique({
      where: { resourceId_topic: { resourceId: m.resourceId, topic: to } },
      select: { id: true },
    });
    // One transaction: setPrimaryTopic clears `isPrimary` on the dead row but leaves it
    // (the retention mechanic), so a crash between the two statements would strand the
    // resource holding both memberships with neither primary. A re-run repairs that — the
    // pass is idempotent — but the window is free to close.
    await prisma.$transaction(async (tx) => {
      await setPrimaryTopic(
        m.resourceId,
        to,
        existing
          ? { tx }
          : { relevance: m.relevance, origin: m.origin, contested: m.contested, tx },
      );
      await tx.resourceTopic.deleteMany({ where: { resourceId: m.resourceId, topic: from } });
    });
  }

  // 3. Secondary memberships: move the row's topic, preserving its filing evidence. Safe
  // to write directly — this touches neither `isPrimary` nor the mirror, so the seam's
  // contract is untouched. A resource already holding `to` just loses the duplicate.
  const secondaries = await prisma.resourceTopic.findMany({
    where: { topic: from, isPrimary: false },
    select: { id: true, resourceId: true, relevance: true, origin: true, contested: true },
  });
  for (const m of secondaries) {
    const existing = await prisma.resourceTopic.findUnique({
      where: { resourceId_topic: { resourceId: m.resourceId, topic: to } },
      select: { id: true },
    });
    if (existing) {
      await prisma.resourceTopic.delete({ where: { id: m.id } });
    } else {
      await prisma.resourceTopic.update({ where: { id: m.id }, data: { topic: to } });
    }
  }

  // 4. Any row whose scalar mirror still names the dead slug without a membership for it
  // (a pre-T1 leftover, or a row created in the gap before T3 writes memberships).
  const stranded = await prisma.resource.findMany({
    where: { topic: from, topics: { none: { topic: from } } },
    select: { id: true },
  });
  for (const r of stranded) await setPrimaryTopic(r.id, to, { origin: 'review' });

  return plan;
}
