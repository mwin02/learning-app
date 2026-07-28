// DB helper for the review-topic-filing skill. Run from the repo root with the app's env
// so it reuses the SAME Prisma client and the app's own k-NN / centroid instruments (no
// reimplementation, so it can't drift from production):
//   npx tsx --env-file=.env.local .claude/skills/review-topic-filing/scripts/topic-review.ts <cmd>
//
//   queue [n] [--topic <slug>] [--kind primary|secondary|all]
//       The contested-membership review queue, grouped by root container and ordered by
//       review priority. `n` limits GROUPS, not rows — a container is one decision.
//       Read-only.
//
// ⚠️ THIS FILE WRITES NOTHING. D1 is the read side of the drain; the verdict-apply half
// (which calls setPrimaryTopic / settleMembership) lands in D2. Keep it that way: a
// helper that can both propose and apply in one command is one typo from an unreviewed
// bulk refile of live Path material.

import { prisma } from '@/lib/db';
import { centroidMargins } from '@/lib/curation/topic-centroids';
import { knnNeighbourTopicsOf, purity, plurality, KNN_K } from '@/lib/curation/topic-knn';
import {
  groupQueue,
  queuePriority,
  filingHistogram,
  type DrainRow,
  type ParentLink,
} from '@/lib/curation/review-drain';

type Kind = 'primary' | 'secondary' | 'all';

// Enough of the page to judge filing without opening it. The rubric's escape hatch is a
// browser, but it should almost never be needed: "is this calculus or linear algebra" is
// answerable from what the row already asserts about itself plus what its container is.
const SUMMARY_CHARS = 400;

async function loadQueue(limitGroups: number, topic: string | null, kind: Kind) {
  const memberships = await prisma.resourceTopic.findMany({
    where: {
      contested: true,
      ...(kind === 'all' ? {} : { isPrimary: kind === 'primary' }),
      ...(topic ? { topic } : {}),
    },
    select: {
      id: true,
      resourceId: true,
      topic: true,
      isPrimary: true,
      relevance: true,
      origin: true,
    },
  });
  if (memberships.length === 0) return { groups: [], resources: new Map(), total: 0 };

  const resourceIds = memberships.map((m) => m.resourceId);
  const resources = await prisma.resource.findMany({
    where: { id: { in: resourceIds } },
    select: {
      id: true,
      title: true,
      url: true,
      type: true,
      topic: true,
      summary: true,
      conceptsTaught: true,
      difficulty: true,
      durationMin: true,
      status: true,
      decompositionStatus: true,
      parentResourceId: true,
      source: { select: { name: true, trustScore: true } },
    },
  });
  const byId = new Map(resources.map((r) => [r.id, r]));

  const margins = await centroidMargins(resourceIds);

  // Ancestor chains. The queue's rows are mostly leaves whose containers are NOT contested
  // and so are absent from `resources` — without this the grouping would see every row as
  // top-level and the container-level verdict (the lesson the cfml block exists to teach)
  // would be unavailable.
  const chains = await prisma.$queryRaw<{ id: string; parentId: string | null; title: string; topic: string }[]>`
    WITH RECURSIVE up AS (
      SELECT r.id, r."parentResourceId", r.title, r.topic
      FROM "Resource" r WHERE r.id = ANY(${resourceIds}::text[])
      UNION
      SELECT p.id, p."parentResourceId", p.title, p.topic
      FROM "Resource" p JOIN up ON up."parentResourceId" = p.id
    )
    SELECT id, "parentResourceId" AS "parentId", title, topic FROM up
  `;
  const parents: Map<string, ParentLink> = new Map(
    chains.map((c) => [c.id, { parentId: c.parentId }]),
  );
  const chainById = new Map(chains.map((c) => [c.id, c]));

  const rows: DrainRow[] = memberships.map((m) => ({
    membershipId: m.id,
    resourceId: m.resourceId,
    title: byId.get(m.resourceId)?.title ?? '(missing)',
    topic: m.topic,
    isPrimary: m.isPrimary,
    relevance: m.relevance,
    origin: m.origin,
    parentId: byId.get(m.resourceId)?.parentResourceId ?? null,
    margin: margins.get(m.resourceId)?.margin ?? null,
  }));

  const groups = groupQueue(rows, parents).slice(0, limitGroups);
  return { groups, resources: byId, chainById, margins, total: rows.length };
}

// Every membership the row holds BESIDES the contested one — the rival proposals T4a
// recorded when it disagreed. This is the refile candidate list: measured 2026-07-27, 72
// of the 131 contested primaries carry one, and the other 59 were contested with no
// alternative named at all (which is itself evidence — see the rubric).
async function rivalsFor(resourceIds: string[]) {
  const all = await prisma.resourceTopic.findMany({
    where: { resourceId: { in: resourceIds } },
    select: { resourceId: true, topic: true, relevance: true, origin: true, contested: true, isPrimary: true },
  });
  const out = new Map<string, typeof all>();
  for (const m of all) {
    const bucket = out.get(m.resourceId) ?? [];
    bucket.push(m);
    out.set(m.resourceId, bucket);
  }
  return out;
}

// How the container's OTHER children are filed. ⚠️ This is the anti-circularity evidence
// and the reason the queue is grouped at all: k-NN cannot adjudicate a large mis-filed
// shelf because the shelf IS its own neighbourhood (cfml item 1). A container whose 40
// uncontested children all sit on one topic says something its contested children's own
// neighbourhood cannot, because that neighbourhood is largely those same siblings.
async function siblingFilings(rootIds: string[]) {
  const rows = await prisma.$queryRaw<{ root: string; topic: string; contested: boolean }[]>`
    WITH RECURSIVE down AS (
      SELECT r.id, r.id AS root FROM "Resource" r WHERE r.id = ANY(${rootIds}::text[])
      UNION ALL
      SELECT c.id, down.root FROM "Resource" c JOIN down ON c."parentResourceId" = down.id
    )
    SELECT down.root, rt.topic, rt.contested
    FROM down JOIN "ResourceTopic" rt ON rt."resourceId" = down.id AND rt."isPrimary"
  `;
  const out = new Map<string, { uncontested: string[]; subtreeSize: number }>();
  for (const r of rows) {
    const e = out.get(r.root) ?? { uncontested: [], subtreeSize: 0 };
    e.subtreeSize += 1;
    if (!r.contested) e.uncontested.push(r.topic);
    out.set(r.root, e);
  }
  return out;
}

async function queue(limitGroups: number, topic: string | null, kind: Kind) {
  const { groups, resources, chainById, margins, total } = await loadQueue(limitGroups, topic, kind);
  if (groups.length === 0) {
    console.log(JSON.stringify({ total: 0, groups: [] }, null, 1));
    return;
  }

  const shownIds = groups.flatMap((g) => g.rows.map((r) => r.resourceId));
  const [rivals, siblings] = await Promise.all([
    rivalsFor(shownIds),
    siblingFilings(groups.map((g) => g.rootId)),
  ]);

  // One k-NN query per row. Fine for a review batch (tens of rows); deliberately not
  // batched, since the per-row leave-one-out neighbourhood is what the rubric reads.
  const neighbourhoods = new Map<string, string[]>();
  for (const id of shownIds) neighbourhoods.set(id, await knnNeighbourTopicsOf(id));

  const out = groups.map((g) => {
    const root = chainById.get(g.rootId);
    const sib = siblings.get(g.rootId);
    return {
      container: {
        id: g.rootId,
        title: root?.title ?? '(unknown)',
        topic: root?.topic ?? null,
        // A group of one whose root IS the row means a loose top-level row: no container
        // verdict is available, it is a genuine row-by-row decision.
        isContainer: (sib?.subtreeSize ?? 0) > 1,
        subtreeSize: sib?.subtreeSize ?? 0,
        siblingFilings: filingHistogram(sib?.uncontested ?? []),
      },
      priority: g.priority,
      rows: g.rows.map((r) => {
        const res = resources.get(r.resourceId);
        const nb = neighbourhoods.get(r.resourceId) ?? [];
        const m = margins.get(r.resourceId);
        const chain: string[] = [];
        for (let c = res?.parentResourceId ?? null; c; c = chainById.get(c)?.parentId ?? null) {
          const node = chainById.get(c);
          chain.unshift(node ? `${node.title} [${node.topic}]` : c);
        }
        return {
          resourceId: r.resourceId,
          membershipId: r.membershipId,
          kind: r.isPrimary ? 'contested-primary' : 'contested-secondary',
          heldTopic: r.topic,
          relevance: r.relevance,
          origin: r.origin,
          content: {
            title: res?.title,
            url: res?.url,
            type: res?.type,
            difficulty: res?.difficulty,
            durationMin: res?.durationMin,
            status: res?.status,
            decompositionStatus: res?.decompositionStatus,
            source: res?.source ? `${res.source.name} (trust ${res.source.trustScore})` : null,
            conceptsTaught: res?.conceptsTaught ?? [],
            summary: res?.summary?.slice(0, SUMMARY_CHARS) ?? null,
          },
          provenance: { ancestors: chain },
          embedding: {
            neighbourhood: filingHistogram(nb),
            k: KNN_K,
            plurality: plurality(nb),
            purityForHeldTopic: purity(nb, r.topic),
            margin: m?.margin ?? null,
            ownCentroidSim: m?.own ?? null,
            nearestRival: m?.best ?? null,
            nearestRivalSim: m?.bestSim ?? null,
          },
          rivalMemberships: (rivals.get(r.resourceId) ?? [])
            .filter((x) => x.topic !== r.topic)
            .map((x) => ({
              topic: x.topic,
              relevance: x.relevance,
              origin: x.origin,
              contested: x.contested,
              isPrimary: x.isPrimary,
            })),
        };
      }),
    };
  });

  console.log(
    JSON.stringify(
      { total, groupsShown: out.length, rowsShown: shownIds.length, groups: out },
      null,
      1,
    ),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : null;
  };

  if (cmd !== 'queue') {
    console.error(
      'usage: topic-review.ts queue [n] [--topic <slug>] [--kind primary|secondary|all]',
    );
    process.exit(1);
  }
  const n = Number(rest[0]);
  const kindArg = (flag('kind') ?? 'all') as Kind;
  if (!['primary', 'secondary', 'all'].includes(kindArg)) {
    console.error(`unknown --kind '${kindArg}'`);
    process.exit(1);
  }
  await queue(Number.isFinite(n) && n > 0 ? n : 10, flag('topic'), kindArg);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
