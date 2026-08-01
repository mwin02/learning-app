// Live verification for topic filing T3 (discovery-side minting + collision memberships).
//   npx tsx --env-file=.env.local scripts/verify-topic-filing-t3.ts
//
// Spends real Vertex quota (one classifier call, up to one topic-gate call, and two full
// discovery passes). Both T2a and T2b shipped bugs that only a live run exposed, so the
// two changes with live-only failure modes are exercised end to end:
//
//   A. the classifier's new `newTopic` channel — a schema + prompt change, so the risk is
//      structured-output shaped and invisible to unit tests;
//   B. the collision path — a URL rediscovered under a SECOND topic, forced by running the
//      same concept twice under two different topics.
//
// Self-cleaning: deletes the resources it inserts, the collision memberships it added to
// pre-existing rows, and any TopicAlias the mint probe minted (unless it already existed).
// ⚠️ Run with the compose workers stopped (`docker compose --profile workers stop worker`)
// — cleanup deletes agent-origin rows created during the run, and a live worker's inserts
// are indistinguishable from this run's. SKIP_DISCOVERY=1 re-runs part D alone, free.

import { prisma } from '../src/lib/db';
import { classifyDiscoveryTopics } from '../src/lib/agents/tools/classify-topic';
import { createTopicMinter } from '../src/lib/curation/topic-mint';
import { listCanonicals } from '../src/lib/agents/topic-registry';
import { sourceFromWeb } from '../src/lib/agents/tools/web-fallback';
import { checkMembershipInvariants, addCollisionMembership } from '../src/lib/curation/resource-topics';
import { knnNeighbourTopicsOf, topicPools } from '../src/lib/curation/topic-knn';

// Rung 0 (the existing library) must MISS or web discovery never runs, and its hits count
// against the target — measured 2026-07-26, `gradient descent` and `list comprehensions`
// both filled rung 0 outright, so those runs exercised nothing. This concept has ZERO
// rows within the rung-0 distance ceiling, so the discovery ladder actually runs.
const TOPIC_A = 'machine-learning';
const CONCEPT = { slug: 'isotonic-regression', title: 'isotonic regression' };
const TARGET_COUNT = 3;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function main() {
  const startedAt = new Date();
  const baseline = await checkMembershipInvariants();
  const vocabulary = await listCanonicals();
  const insertedIds: string[] = [];
  let mintedAlias: string | null = null;

  try {
    // ── A. the newTopic channel ────────────────────────────────────────────────
    console.log('\n── A. classifier: does it name a subject the vocabulary lacks? ───');
    const proposals = await classifyDiscoveryTopics(
      [
        {
          url: 'https://example.com/t3/organic-chemistry',
          title: 'Nucleophilic Substitution Reactions: SN1 and SN2 Mechanisms',
          summary:
            'A lecture on the mechanisms of nucleophilic substitution in organic chemistry, covering carbocation stability, stereochemistry, and solvent effects.',
          conceptsTaught: ['sn1 mechanism', 'sn2 mechanism', 'carbocation stability'],
        },
        {
          url: 'https://example.com/t3/list-comprehensions',
          title: 'Python List Comprehensions, Explained',
          summary: 'How to write and read list comprehensions in Python, with nested loops and conditionals.',
          conceptsTaught: ['list comprehensions', 'iterables'],
        },
      ],
      vocabulary,
      TOPIC_A,
    );
    const offVocab = proposals.get('https://example.com/t3/organic-chemistry');
    const inVocab = proposals.get('https://example.com/t3/list-comprehensions');
    console.log('   off-vocabulary row →', offVocab);
    console.log('   in-vocabulary row  →', inVocab);
    check('the classifier still returns parseable structured output', Boolean(offVocab && inVocab));
    check('it proposes a mint for a subject we have no slug for', Boolean(offVocab?.newTopic), offVocab?.newTopic);
    check('it does NOT propose a mint for a subject we do have', inVocab?.newTopic === null, inVocab?.newTopic);

    // ── B. the mint goes through the hardened gate ─────────────────────────────
    if (offVocab?.newTopic) {
      console.log('\n── B. topic gate: the proposed label becomes a canonical ─────────');
      const before = await prisma.topicAlias.findMany({ select: { alias: true } });
      const known = new Set(before.map((a) => a.alias));
      const canonical = await createTopicMinter()(offVocab.newTopic);
      check('the gate accepted the proposal and returned a canonical', Boolean(canonical), canonical);
      check(
        'the canonical is a safe kebab-case slug',
        Boolean(canonical && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(canonical)),
        canonical,
      );
      if (canonical) {
        const after = await prisma.topicAlias.findMany({ where: { canonical }, select: { alias: true } });
        const fresh = after.filter((a) => !known.has(a.alias)).map((a) => a.alias);
        check('the mint is persisted, so the next discovery short-circuits at tier 2', after.length > 0, fresh);
        if (fresh.length > 0) mintedAlias = canonical;
      }
    }

    // ── C. collisions, live ────────────────────────────────────────────────────
    // Parts A-C spend real discovery quota; D is free and deterministic. SKIP_DISCOVERY=1
    // re-runs D alone.
    console.log(`\n── C. discovery — "${CONCEPT.title}" under ${TOPIC_A} ───────────`);
    const run = process.env.SKIP_DISCOVERY
      ? { insertedIds: [], insertedCount: 0, skippedCount: 0 }
      : await sourceFromWeb({ topic: TOPIC_A, concept: CONCEPT, targetCount: TARGET_COUNT });
    insertedIds.push(...run.insertedIds);
    // A dedup hit is what reaches the collision path at all. It only becomes a MEMBERSHIP
    // when the filing verdict differs from the existing row's primary AND clears the
    // guardrail — a rediscovery that the classifier files right back where the row
    // already lives is correctly a plain skip.
    console.log('   run:', {
      inserted: run.insertedCount,
      dedupHits: run.skippedCount,
    });

    const collisions = await prisma.resourceTopic.findMany({
      where: { origin: 'collision', createdAt: { gte: startedAt } },
      select: { resourceId: true, topic: true, relevance: true, contested: true, isPrimary: true },
    });
    console.log('\n   collision memberships written this run:');
    for (const c of collisions) {
      console.log(`   • ${c.topic} relevance=${c.relevance.toFixed(2)} contested=${c.contested} (${c.resourceId})`);
    }
    // Not a failure if zero — discovery may legitimately surface only fresh URLs, or file
    // every rediscovery back where it already lives — but the run then proves nothing
    // about the collision path, so say so loudly rather than reporting a green pass.
    if (collisions.length === 0) {
      console.warn(`\n   ⚠ no collision membership was written (${run.skippedCount} dedup hit(s)) — the collision path did NOT complete.`);
    } else {
      check('collision memberships are secondaries, never the primary', collisions.every((c) => !c.isPrimary));
      check(
        'collision relevance is the measured purity, never the 1.0 schema default',
        collisions.every((c) => c.relevance < 1),
        collisions.map((c) => c.relevance),
      );
    }

    // ── D. the collision guardrail against the REAL corpus ─────────────────────
    // Whether discovery rediscovers a URL is luck; this part is not. It runs the actual
    // guardrail — real embeddings, real k-NN, real pool sizes — against a real library
    // row, once for a topic the row demonstrably sits in and once for a topic it does
    // not, and rolls the membership back afterwards.
    console.log('\n── D. collision guardrail against a real library row ─────────────');
    // Most rows sit in their own plurality, so a fixed pick has nothing to ADMIT (measured:
    // the first row sampled was 10/10 `python` under `python`). Sample until a row whose
    // neighbourhood names a different topic turns up — the ~11% disagreement the
    // calibration measured, and exactly the population a real collision lands on.
    const sample = await prisma.$queryRaw<{ id: string; title: string; topic: string }[]>`
      SELECT id, title, topic FROM "Resource"
      WHERE embedding IS NOT NULL AND "decompositionStatus"::text = 'atomic'
        AND status::text IN ('active', 'pending_review') AND origin::text <> 'generated'
      ORDER BY md5(id) LIMIT 40
    `;
    let subject: (typeof sample)[number] | undefined;
    let neighbours: string[] = [];
    let tally: [string, number][] = [];
    for (const row of sample) {
      const n = await knnNeighbourTopicsOf(row.id);
      const t = [...n.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort(
        (a, b) => b[1] - a[1],
      );
      subject ??= row; // fall back to the first row so the negative control still runs
      if (t[0] && t[0][0] !== row.topic) {
        [subject, neighbours, tally] = [row, n, t];
        break;
      }
      if (neighbours.length === 0) [neighbours, tally] = [n, t];
    }
    if (subject) {
      console.log(`   subject: [${subject.topic}] ${subject.title.slice(0, 60)}`);
      console.log('   neighbourhood:', Object.fromEntries(tally));
      check('the real row has a full k-NN neighbourhood', neighbours.length > 0, `${neighbours.length} neighbours`);

      const [plurality] = tally[0] ?? [];
      if (plurality && plurality !== subject.topic) {
        const added = await addCollisionMembership(subject.id, plurality);
        check('a topic the row demonstrably sits in is admitted', Boolean(added), added);
      } else {
        console.log('   ⚠ no sampled row disagreed with its own label — nothing to admit.');
      }

      // The negative control has to be a topic with a HEALTHY pool, or the decline would
      // be the unvouchable-pool path (which accepts, flagged) rather than a rejection.
      const pools = [...(await topicPools())].sort((a, b) => b[1] - a[1]);
      const stranger = pools.find(([t]) => t !== subject.topic && !neighbours.includes(t));
      if (stranger) {
        const declined = await addCollisionMembership(subject.id, stranger[0]);
        check(
          `a topic absent from the neighbourhood is declined (${stranger[0]}, pool ${stranger[1]})`,
          declined === null,
          declined,
        );
      }
    }

    const counts = await checkMembershipInvariants();
    check(
      'no new membership-invariant violation',
      counts.badPrimaryCount === baseline.badPrimaryCount &&
        counts.mirrorDrift === baseline.mirrorDrift &&
        counts.noMembership === baseline.noMembership,
      counts,
    );
  } finally {
    // Clean up: every row this run created (cascading their memberships), then any
    // collision row we stamped onto a pre-existing library resource, then the probe's mint.
    //
    // Deliberately a TIME WINDOW, not `insertedIds`: that list is the PICKABLE atomic ids,
    // so a container that parks `human_review` is not in it and the first version of this
    // script leaked one (scikit-learn's isotonic page, 2026-07-26). This is why the run
    // needs the compose workers stopped — the window would otherwise catch their inserts.
    const { count: removed } = await prisma.resource.deleteMany({
      where: { createdAt: { gte: startedAt }, origin: 'agent' },
    });
    const { count } = await prisma.resourceTopic.deleteMany({
      where: { origin: 'collision', createdAt: { gte: startedAt } },
    });
    if (mintedAlias) await prisma.topicAlias.deleteMany({ where: { canonical: mintedAlias } });
    console.log('\ncleanup:', {
      resources: removed,
      pickableIdsSeen: insertedIds.length,
      collisionMemberships: count,
      mintedAlias: mintedAlias ?? '(none)',
    });
  }

  console.log(failures === 0 ? '\n✅ T3 verification passed' : `\n❌ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
