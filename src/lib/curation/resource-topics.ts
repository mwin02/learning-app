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
import type { ReclassifyDecision } from '@/lib/curation/reclassify';

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
  // rediscovery at a time. This read is only the CHEAP EARLY-OUT — it saves the k-NN and
  // pool queries below; the binding check is the one inside the transaction.
  if (existing.length >= MAX_MEMBERSHIPS) {
    logCapReached(resourceId, topic, existing.length);
    return null;
  }

  const [neighbourTopics, pools] = await Promise.all([
    knnNeighbourTopicsOf(resourceId),
    topicPools(),
  ]);
  const membership = decideCollision(topic, neighbourTopics, pools);
  if (!membership) return null;

  // ⚠️ THE CAP IS RE-CHECKED UNDER A ROW LOCK, because the read above and this write are
  // separated by two DB round-trips. Two workers rediscovering the same URL under two
  // different topics both saw 2/3 and both wrote, leaving a resource on 4 memberships —
  // the exact "one rediscovery at a time" accumulation the cap exists to stop, just
  // arriving concurrently instead of serially. The lock is the same `FOR UPDATE` on the
  // Resource that setPrimaryTopic takes, so collision writes also serialize against
  // refiles rather than racing them.
  const written = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Resource" WHERE id = ${resourceId} FOR UPDATE
    `;
    // The row was deleted while the guardrail ran. Nothing to join.
    if (locked.length === 0) return false;

    const held = await tx.resourceTopic.count({ where: { resourceId } });
    if (held >= MAX_MEMBERSHIPS) {
      logCapReached(resourceId, topic, held);
      return false;
    }

    // skipDuplicates so a concurrent rediscovery of the same URL under the same topic
    // races harmlessly (the unique [resourceId, topic] would otherwise throw).
    const { count } = await tx.resourceTopic.createMany({
      data: [{ resourceId, topic, relevance: membership.relevance, origin: 'collision', contested: membership.contested, isPrimary: false }],
      skipDuplicates: true,
    });
    return count > 0;
  });

  // Nothing written means the caller must not report a membership it does not have —
  // `membership_added` drives the discovery counters and the outcome upsertResource returns.
  return written ? membership : null;
}

function logCapReached(resourceId: string, topic: string, memberships: number): void {
  console.log('[resource-topics] collision membership skipped: cap reached', {
    resourceId,
    topic,
    memberships,
  });
}

// ── bulk reclassification (T4a) ──────────────────────────────────────────────
//
// The write half of one row's reclassification; the decision half is pure and lives in
// src/lib/curation/reclassify.ts. Here rather than in the driver so it is reachable from
// an integration test, and so the transaction boundary is stated once.
//
// ONE transaction for the re-score and the new memberships together. Split, a crash
// between them would leave the primary re-scored — and therefore no longer `inherited`,
// which is the driver's resume selector — so the run would skip the row forever and its
// secondaries would be silently lost.
//
// Never moves the primary: `decision.primary.topic` is the row's current topic by
// construction (see the reclassify module header). setPrimaryTopic is still the right
// seam for a same-topic re-score — it is the only path allowed to touch the mirror, and
// going around it for "just an update" is how mirrors rot.
export async function applyReclassification(
  resourceId: string,
  decision: Pick<ReclassifyDecision, 'primary' | 'secondaries'>,
): Promise<void> {
  const { primary, secondaries } = decision;
  // `no-evidence`: nothing measured, so the inherited placeholder stays. Replacing it
  // with a measured-looking 0.0 would be worse than leaving it unknown.
  if (!primary) return;

  await prisma.$transaction(async (tx) => {
    await setPrimaryTopic(resourceId, primary.topic, {
      relevance: primary.relevance,
      origin: primary.origin,
      contested: primary.contested,
      tx,
    });
    if (secondaries.length === 0) return;
    // skipDuplicates so a re-run — or a concurrent discovery that filed the same topic —
    // races harmlessly against the unique [resourceId, topic].
    await tx.resourceTopic.createMany({
      data: secondaries.map((s) => ({
        resourceId,
        topic: s.topic,
        relevance: s.relevance,
        origin: s.origin,
        contested: s.contested,
        isPrimary: false,
      })),
      skipDuplicates: true,
    });
  });
}

// ── quorum refile settlement (T4b) ───────────────────────────────────────────
//
// Phase 2 of the seed/mint pass: the measured worth of a membership, written after the
// whole cohort has landed. Deliberately NOT `setPrimaryTopic` — nothing about the primary
// or the mirror changes here, and routing a relevance update through the refile seam
// would take a row lock and rewrite the mirror for no reason.
//
// `updateMany` rather than `update` so a membership that vanished between the write and
// the measurement (a concurrent refile, a deleted resource) is a no-op instead of a throw:
// this runs across hundreds of rows at the end of a long pass, and the settlement is a
// refinement of an already-correct row, never a correctness requirement.
//
// `client` lets a caller enlist this in its own interactive transaction — the review
// drain's `--apply` settles and refiles in one all-or-nothing batch, same seam
// `setPrimaryTopic` and `storeEmbedding` offer.
export async function settleMembership(
  resourceId: string,
  topic: string,
  settlement: { relevance: number; contested: boolean },
  client: TxClient = prisma,
): Promise<void> {
  await client.resourceTopic.updateMany({
    where: { resourceId, topic },
    data: { relevance: settlement.relevance, contested: settlement.contested },
  });
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
