// Topic filing T1 — the ONE write seam for a resource's primary topic.
//
// `Resource.topic` is a denormalized mirror of the primary `ResourceTopic` membership
// (see the model comment in schema.prisma). Two fields therefore have to move together
// or the mirror rots: `ResourceTopic.isPrimary` and `Resource.topic`. This function is
// the only code path allowed to write either one. Everything that refiles a resource —
// the classifier (T2b), collision handling (T3), the T4 reclassifier, the review
// surface — goes through here.
//
// The one deliberate exception is the T1 backfill (scripts/backfill-resource-topics.ts),
// which derives memberships FROM the mirror rather than writing to it: there is nothing
// to rot, and per-row transactions would buy 1,926 round-trips for no invariant.
//
// ⚠️ Why "exactly one primary" is not a partial unique index. Prisma can't model
// `... WHERE "isPrimary"`, so it would become a third permanent entry in AGENTS.md's
// never-drop table, re-added by hand on every future migration. It isn't needed because
// this seam takes a row lock on the Resource before touching anything, so two concurrent
// refiles of the same resource serialize instead of interleaving. (Without that lock
// there IS a race: under read-committed, a `updateMany(where: { isPrimary: true })` clear
// does not match — and so does not block on — the row a concurrent transaction just
// flipped to true, and both transactions can leave a primary behind.)

import { prisma } from '@/lib/db';
import type { PrismaClient, TopicFilingOrigin } from '@prisma/client';
import {
  decideCollision,
  knnNeighbourTopicsOf,
  topicPools,
  MAX_MEMBERSHIPS,
  type FilingMembership,
} from '@/lib/curation/topic-knn';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export type SetPrimaryTopicOptions = {
  // Only the fields supplied here are written on an EXISTING membership — promoting a
  // secondary to primary keeps its measured relevance/origin unless the caller has a
  // better value. On a newly created membership the schema defaults apply.
  relevance?: number;
  origin?: TopicFilingOrigin;
  contested?: boolean;
  // Pass the interactive-transaction client to enlist in a caller's transaction (T3
  // sets the primary inside the same transaction that creates the Resource). Omitted,
  // the seam opens its own.
  tx?: TxClient;
};

export async function setPrimaryTopic(
  resourceId: string,
  topic: string,
  opts: SetPrimaryTopicOptions = {},
): Promise<void> {
  const { tx } = opts;
  if (tx) return writePrimary(tx, resourceId, topic, opts);
  await prisma.$transaction((client) => writePrimary(client, resourceId, topic, opts));
}

async function writePrimary(
  tx: TxClient,
  resourceId: string,
  topic: string,
  opts: SetPrimaryTopicOptions,
): Promise<void> {
  // Serialize concurrent refiles of this resource (see the header note). Doubles as the
  // existence check: a missing id is a caller bug, not a silent no-op.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Resource" WHERE id = ${resourceId} FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new Error(`setPrimaryTopic: resource ${resourceId} not found`);
  }

  // Unconditional (not `where: { isPrimary: true }`) so the statement takes a lock on
  // every membership row of this resource, including one a concurrent writer just set.
  await tx.resourceTopic.updateMany({ where: { resourceId }, data: { isPrimary: false } });

  await tx.resourceTopic.upsert({
    where: { resourceId_topic: { resourceId, topic } },
    create: {
      resourceId,
      topic,
      isPrimary: true,
      ...(opts.relevance !== undefined ? { relevance: opts.relevance } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.contested !== undefined ? { contested: opts.contested } : {}),
    },
    update: {
      isPrimary: true,
      ...(opts.relevance !== undefined ? { relevance: opts.relevance } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.contested !== undefined ? { contested: opts.contested } : {}),
    },
  });

  // The mirror, in the same transaction as the flag it mirrors.
  await tx.resource.update({ where: { id: resourceId }, data: { topic } });
}

// ── collisions (T3) ──────────────────────────────────────────────────────────
//
// A URL rediscovered under a second topic. Pre-T3 this was a dead end: upsertResource
// logged `skip cross-topic URL collision` and returned, so the rediscovering topic could
// never reach the row — mechanic #5 of the plan's defect list, and the reason a mislabel
// stayed permanent even once the right topic existed.
//
// It is NOT, however, a free membership: the searched topic asserting relevance is exactly
// the signal the whole plan rejects, so the claim goes through the same k-NN guardrail a
// fresh filing does — against THIS row's embedding, since this row (not the incoming
// metadata) is what is being labelled.
//
// Never touches `isPrimary` or the mirror: a collision membership is a secondary by
// definition, so it needs no `setPrimaryTopic` and cannot refile the row. Returns the
// membership written, or null when nothing was written (already a member, cap reached, or
// the guardrail declined).
export async function addCollisionMembership(
  resourceId: string,
  topic: string,
): Promise<FilingMembership | null> {
  const existing = await prisma.resourceTopic.findMany({
    where: { resourceId },
    select: { topic: true },
  });
  // Already filed here — the "collision" is just a rediscovery under the same topic.
  if (existing.some((m) => m.topic === topic)) return null;
  // The cap is per RESOURCE, and collision rows count against it (locked decision): the
  // guard against a generic "intro to programming" page joining every CS topic, one
  // rediscovery at a time.
  if (existing.length >= MAX_MEMBERSHIPS) {
    console.log('[resource-topics] collision membership skipped: cap reached', {
      resourceId,
      topic,
      memberships: existing.length,
    });
    return null;
  }

  const [neighbourTopics, pools] = await Promise.all([
    knnNeighbourTopicsOf(resourceId),
    topicPools(),
  ]);
  const membership = decideCollision(topic, neighbourTopics, pools);
  if (!membership) return null;

  // skipDuplicates so a concurrent rediscovery of the same URL under the same topic
  // races harmlessly (the unique [resourceId, topic] would otherwise throw).
  await prisma.resourceTopic.createMany({
    data: [{ resourceId, topic, relevance: membership.relevance, origin: 'collision', contested: membership.contested, isPrimary: false }],
    skipDuplicates: true,
  });
  return membership;
}

// The three properties T1 carries by assertion instead of by DB constraint. Shared by the
// backfill driver and the differential harness so there is one definition of "healthy",
// and cheap enough (three aggregates) to run after any bulk membership write.
export type MembershipInvariants = {
  noMembership: number; // resources retrieval can no longer reach at all
  badPrimaryCount: number; // resources with zero or several primaries
  mirrorDrift: number; // Resource.topic disagreeing with its primary membership
};

export async function checkMembershipInvariants(): Promise<MembershipInvariants> {
  type Count = { c: number };
  const [{ c: noMembership }] = await prisma.$queryRaw<Count[]>`
    SELECT count(*)::int AS c FROM "Resource" r
    WHERE NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt WHERE rt."resourceId" = r.id)
  `;
  const [{ c: badPrimaryCount }] = await prisma.$queryRaw<Count[]>`
    SELECT count(*)::int AS c FROM (
      SELECT r.id
      FROM "Resource" r
      LEFT JOIN "ResourceTopic" rt ON rt."resourceId" = r.id
      GROUP BY r.id
      HAVING count(rt.*) FILTER (WHERE rt."isPrimary") <> 1
    ) bad
  `;
  const [{ c: mirrorDrift }] = await prisma.$queryRaw<Count[]>`
    SELECT count(*)::int AS c FROM "Resource" r
    JOIN "ResourceTopic" rt ON rt."resourceId" = r.id AND rt."isPrimary"
    WHERE rt.topic <> r.topic
  `;
  return { noMembership, badPrimaryCount, mirrorDrift };
}

export async function assertMembershipInvariants(): Promise<MembershipInvariants> {
  const counts = await checkMembershipInvariants();
  console.log(
    `resources with no membership: ${counts.noMembership}\n` +
      `resources whose primary count <> 1: ${counts.badPrimaryCount}\n` +
      `mirror drift (Resource.topic <> primary membership): ${counts.mirrorDrift}`,
  );
  if (counts.noMembership || counts.badPrimaryCount || counts.mirrorDrift) {
    throw new Error('ResourceTopic membership invariants violated — see counts above');
  }
  return counts;
}
