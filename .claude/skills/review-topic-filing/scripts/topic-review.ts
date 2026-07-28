// DB helper for the review-topic-filing skill. Run from the repo root with the app's env
// so it reuses the SAME Prisma client and the app's own k-NN / centroid instruments (no
// reimplementation, so it can't drift from production):
//   npx tsx --env-file=.env.local .claude/skills/review-topic-filing/scripts/topic-review.ts <cmd>
//
//   queue [n] [--topic <slug>] [--kind primary|secondary|all]
//       The contested-membership review queue, grouped by root container and ordered by
//       review priority. `n` limits GROUPS, not rows — a container is one decision.
//       Read-only.
//   apply <verdicts.json> [--apply]
//       Resolve a verdict file. Dry run unless --apply; refuses outright while the plan
//       holds any error. Writes a docs/audits/review-drain-*.json record.
//
// ⚠️ THE TWO COMMANDS ARE SEPARATE ON PURPOSE, and `apply` is a dry run by default: a
// helper that proposes and applies in one step is one typo from an unreviewed bulk refile
// of live Path material.
//
// ⚠️ NOTHING HERE WRITES `Resource.status`. Filing doubt and content quality are orthogonal
// axes (the plan's Uncertainty decision), and these rows already passed human quality
// review — 113 of 131 are `active`, some attached to live Paths. Every write below goes
// through the T1 seams and touches `ResourceTopic` only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db';
import { centroidMargins } from '@/lib/curation/topic-centroids';
import {
  knnNeighbourTopicsOf,
  purity,
  plurality,
  KNN_K,
  MAX_MEMBERSHIPS,
} from '@/lib/curation/topic-knn';
import {
  setPrimaryTopic,
  settleMembership,
  assertMembershipInvariants,
} from '@/lib/curation/resource-topics';
import {
  groupQueue,
  planVerdicts,
  filingHistogram,
  type DrainRow,
  type ParentLink,
  type Verdict,
} from '@/lib/curation/review-drain';

type Kind = 'primary' | 'secondary' | 'all';
type ChainNode = { id: string; parentId: string | null; title: string; topic: string };
type ResourceRow = Awaited<ReturnType<typeof loadResources>>[number];

function loadResources(ids: string[]) {
  return prisma.resource.findMany({
    where: { id: { in: ids } },
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
}

// Enough of the page to judge filing without opening it. The rubric's escape hatch is a
// browser, but it should almost never be needed: "is this calculus or linear algebra" is
// answerable from what the row already asserts about itself plus what its container is.
const SUMMARY_CHARS = 400;

async function loadQueue(topic: string | null, kind: Kind) {
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
  if (memberships.length === 0) {
    return {
      rows: [] as DrainRow[],
      resources: new Map<string, ResourceRow>(),
      chainById: new Map<string, ChainNode>(),
      parents: new Map<string, ParentLink>(),
      margins: new Map<string, { margin: number | null; own: number | null; best: string | null; bestSim: number | null }>(),
    };
  }

  const resourceIds = memberships.map((m) => m.resourceId);
  const resources = await loadResources(resourceIds);
  const byId = new Map(resources.map((r) => [r.id, r]));

  const margins = await centroidMargins(resourceIds);

  // Ancestor chains. The queue's rows are mostly leaves whose containers are NOT contested
  // and so are absent from `resources` — without this the grouping would see every row as
  // top-level and the container-level verdict (the lesson the cfml block exists to teach)
  // would be unavailable.
  const chains = await prisma.$queryRaw<ChainNode[]>`
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

  return { rows, resources: byId, chainById, parents, margins };
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
  const { rows: allRows, resources, chainById, parents, margins } = await loadQueue(topic, kind);
  const total = allRows.length;
  const groups = groupQueue(allRows, parents).slice(0, limitGroups);
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

// ── apply ────────────────────────────────────────────────────────────────────
//
// Dry run by default; `--apply` executes. It REFUSES to execute while the plan holds any
// error — a verdict file is authored in one pass and a single bad line usually means the
// slate was written against a stale queue, which is exactly when a partial apply is worst.
//
// Every write goes through the T1 seams (`setPrimaryTopic` / `settleMembership`) so the
// `Resource.topic` mirror and the one-primary invariant hold by construction. Nothing here
// touches `Resource.status`.
async function apply(file: string, execute: boolean) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Verdict[] | { verdicts: Verdict[] };
  const verdicts = Array.isArray(raw) ? raw : raw.verdicts;

  const { rows, parents } = await loadQueue(null, 'all');
  const counts = await prisma.resourceTopic.groupBy({
    by: ['resourceId'],
    where: { resourceId: { in: rows.map((r) => r.resourceId) } },
    _count: { _all: true },
  });
  const membershipCounts = new Map(counts.map((c) => [c.resourceId, c._count._all]));

  const plan = planVerdicts(rows, verdicts, parents, membershipCounts, MAX_MEMBERSHIPS);
  const byMembership = new Map(rows.map((r) => [r.membershipId, r]));

  // Measured purity for each destination topic. A review verdict is an operator judgement,
  // so the topic is not in question — but the RELEVANCE we record should still be the
  // honest measured number rather than a flattering default, exactly as T4c did when it
  // wrote the `differentiation` fold at its measured 1.0.
  //
  // ⚠️ The VACATED topic is re-measured too, not carried forward. `settleMembership` would
  // otherwise propagate whatever the old primary happened to store — and for the 5 rows the
  // cfml retirement folded by policy fallback that stored value is a DEFAULT of 1.0, not a
  // measurement (observed on "Linear Algebra Basics", whose retained `calculus` membership
  // read 1.0 against a measured purity of 0.1). Carrying it forward would re-introduce the
  // exact fake certainty T4e's re-score pass existed to remove.
  const purities = new Map<string, number>();
  const measure = async (resourceId: string, topic: string) => {
    const key = `${resourceId}|${topic}`;
    if (!purities.has(key)) {
      purities.set(key, purity(await knnNeighbourTopicsOf(resourceId), topic));
    }
    return purities.get(key)!;
  };
  for (const w of plan.writes) {
    if (w.targetTopic) await measure(w.resourceId, w.targetTopic);
    if (w.verdict === 'refile' && w.heldTopic !== w.targetTopic) {
      await measure(w.resourceId, w.heldTopic);
    }
  }

  const report = plan.writes.map((w) => ({
    ...w,
    relevanceToWrite: w.targetTopic
      ? purities.get(`${w.resourceId}|${w.targetTopic}`)
      : byMembership.get(w.membershipId)?.relevance,
    vacated:
      w.verdict === 'refile' && w.heldTopic !== w.targetTopic
        ? w.dropVacated
          ? `drop '${w.heldTopic}'`
          : `retain '${w.heldTopic}' uncontested @ ${purities.get(`${w.resourceId}|${w.heldTopic}`)}`
        : null,
  }));

  console.log(
    JSON.stringify(
      {
        mode: execute ? 'APPLY' : 'dry-run',
        queueSize: rows.length,
        writes: report,
        skipped: plan.skipped,
        unresolvedCount: plan.unresolved.length,
        errors: plan.errors,
        tally: report.reduce<Record<string, number>>(
          (a, w) => ({ ...a, [w.verdict]: (a[w.verdict] ?? 0) + 1 }),
          {},
        ),
      },
      null,
      1,
    ),
  );

  if (plan.errors.length > 0) {
    console.error(`\nREFUSING TO APPLY: ${plan.errors.length} error(s) in the verdict file.`);
    process.exit(1);
  }
  if (!execute) {
    console.error('\nDry run — nothing written. Re-run with --apply to execute.');
    return;
  }

  for (const w of report) {
    const row = byMembership.get(w.membershipId)!;
    if (w.verdict === 'confirm') {
      await settleMembership(w.resourceId, w.heldTopic, {
        relevance: row.relevance,
        contested: false,
      });
    } else if (w.verdict === 'refile') {
      await setPrimaryTopic(w.resourceId, w.targetTopic!, {
        origin: 'review',
        contested: false,
        relevance: w.relevanceToWrite,
      });
      // The vacated topic. Retain-but-still-contested is the one outcome that is always
      // wrong: invisible to retrieval AND permanently queued. Promotion of a contested
      // SECONDARY vacates nothing, so it is skipped.
      if (w.heldTopic !== w.targetTopic) {
        if (w.dropVacated) {
          await prisma.resourceTopic.deleteMany({
            where: { resourceId: w.resourceId, topic: w.heldTopic },
          });
        } else {
          await settleMembership(w.resourceId, w.heldTopic, {
            relevance: purities.get(`${w.resourceId}|${w.heldTopic}`) ?? row.relevance,
            contested: false,
          });
        }
      }
    } else if (w.verdict === 'add') {
      await prisma.resourceTopic.createMany({
        data: [
          {
            resourceId: w.resourceId,
            topic: w.targetTopic!,
            relevance: w.relevanceToWrite ?? 0,
            origin: 'review',
            contested: false,
            isPrimary: false,
          },
        ],
        skipDuplicates: true,
      });
    }
  }

  const invariants = await assertMembershipInvariants();
  const remaining = await prisma.resourceTopic.count({ where: { contested: true } });
  const record = {
    ran: new Date().toISOString(),
    verdictFile: file,
    writes: report,
    skipped: plan.skipped,
    invariants,
    queueAfter: remaining,
  };
  mkdirSync('docs/audits', { recursive: true });
  const path = `docs/audits/review-drain-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.error(`\nApplied ${report.length} write(s). Queue now ${remaining}. Record: ${path}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : null;
  };

  if (cmd === 'queue') {
    const n = Number(rest[0]);
    const kindArg = (flag('kind') ?? 'all') as Kind;
    if (!['primary', 'secondary', 'all'].includes(kindArg)) {
      console.error(`unknown --kind '${kindArg}'`);
      process.exit(1);
    }
    await queue(Number.isFinite(n) && n > 0 ? n : 10, flag('topic'), kindArg);
  } else if (cmd === 'apply') {
    if (!rest[0]) {
      console.error('apply needs a verdict file path');
      process.exit(1);
    }
    await apply(rest[0], rest.includes('--apply'));
  } else {
    console.error(
      'usage: topic-review.ts queue [n] [--topic <slug>] [--kind primary|secondary|all]\n' +
        '       topic-review.ts apply <verdicts.json> [--apply]',
    );
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
