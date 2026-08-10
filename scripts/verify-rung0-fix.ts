// Live verification for rung0-starvation R1+R2 (rung0-starvation.md, block R3).
//
//   npx tsx --env-file=.env.local scripts/verify-rung0-fix.ts [topic...]
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local scripts/verify-rung0-fix.ts precalculus
//
// Asserts the thing R1 changed and no unit test can reach: a concept whose rung 0
// SATURATES (targetCount library hits within the distance ceiling) still reaches web
// discovery, and comes out with a qualifying primary attached. Pre-R1 the web rungs
// were unreachable for exactly this concept, in every pass, forever.
//
// FIXTURE STRATEGY — a throwaway Path/Concept container around a REAL saturating shelf.
// The saturation must be real: an invented shelf only proves the judge rejects invented
// rows, and the defect lives in how genuinely-filed, semantically-close library rows
// interact with the real judge. So the script scans real Paths for a spine hole whose
// rung 0 saturates and reuses its topic/slug/title — but runs it under a fixture Path
// (`__verify_rung0__`), never the real one. That buys three things a real Path can't:
//   - no mutation of a servable Path (recomputeReadiness writes Path.status);
//   - a fresh conceptId, so R2's rejection memory on the REAL concept doesn't hide the
//     saturating rows and quietly turn the run green for the wrong reason;
//   - repeatability — the run is idempotent, and re-running re-judges the same shelf.
// The fixture Path's `topic` is deliberately NOT the real topic (Path.topic is unique);
// the real topic is passed to sourceAndAttachConcept, which is what scopes the search.
//
// Spends real quota: one query embedding per probe, then a full judge + discovery ladder
// + a second judge for the chosen concept. Self-cleaning — deletes the fixture Path
// (cascading its Concept, attachments and rejection memory) and every agent-origin row
// created during the run.
// ⚠️ Cleanup is a time window, so a live worker's agent-origin inserts are
// indistinguishable from ours — and would be DELETED. That includes the GCE worker when
// this is pointed at production, not just the local compose workers (`docker compose
// --profile workers stop worker`). The script refuses to start while any RemediationJob
// or CourseRequest is queued/running — the pending work it can see — but a poller itself
// is invisible from here, so confirm no worker is polling the target DB before running.

import { ConceptMembership } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { sourceAndAttachConcept } from '../src/lib/agents/track/source-concept';
import { libraryRungCandidates } from '../src/lib/agents/tools/web-fallback';
import { computeReadiness, hasQualifyingPrimary } from '../src/lib/agents/map/readiness';
import { REMEDIATION_SOURCE_TARGET_COUNT } from '../src/lib/config';

const FIXTURE_TOPIC = '__verify_rung0__';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

// The cleanup sweep makes live agent writes fatal, not just noisy: any worker inserting
// agent-origin rows inside the run's time window would have them deleted. Pending work is
// the proxy this script can see (the poller itself is invisible from here), so refuse to
// start while any exists rather than warn and hope.
async function assertNoActiveAgentWork() {
  const [remediation, requests] = await Promise.all([
    prisma.remediationJob.count({ where: { state: { in: ['queued', 'running'] } } }),
    prisma.courseRequest.count({ where: { status: { in: ['queued', 'running'] } } }),
  ]);
  if (remediation > 0 || requests > 0) {
    console.error(
      `\n⚠ refusing to run: ${remediation} remediation job(s) and ${requests} course request(s) are queued/running.\n` +
        '  A live worker (compose locally, the GCE worker on production) claiming them mid-run would\n' +
        '  insert agent-origin rows inside the cleanup window, and this script would delete them.\n' +
        '  Stop the workers and let the queue settle, then re-run.',
    );
    process.exit(1);
  }
}

type Subject = { topic: string; slug: string; title: string; hits: number };

// Find a spine hole whose rung 0 saturates. Probed WITHOUT a conceptId so the
// attached/rejected exclusions are off — this measures the shelf as the fixture
// concept (which has neither) will see it.
async function pickSaturatedSubject(topics: string[]): Promise<Subject | null> {
  const paths = await prisma.path.findMany({
    where: { topic: topics.length > 0 ? { in: topics } : { not: FIXTURE_TOPIC } },
    select: {
      topic: true,
      concepts: {
        select: {
          slug: true, title: true, membership: true, primaryRelaxed: true,
          resources: { select: { resourceId: true, role: true, coverageScore: true } },
        },
        orderBy: { slug: 'asc' },
      },
    },
    orderBy: { topic: 'asc' },
  });

  for (const path of paths) {
    const spine = path.concepts.filter((c) => c.membership === ConceptMembership.spine);
    const { holes } = computeReadiness(
      spine.map((c) => ({ conceptSlug: c.slug, primaryRelaxed: c.primaryRelaxed, candidates: c.resources })),
    );
    const holeSet = new Set(holes);
    for (const c of spine.filter((s) => holeSet.has(s.slug))) {
      const hits = await libraryRungCandidates({
        topic: path.topic,
        conceptTitle: c.title,
        targetCount: REMEDIATION_SOURCE_TARGET_COUNT,
      });
      console.log(`   probe [${path.topic}] ${c.slug} — rung0Hits=${hits.length}/${REMEDIATION_SOURCE_TARGET_COUNT}`);
      if (hits.length >= REMEDIATION_SOURCE_TARGET_COUNT) {
        return { topic: path.topic, slug: c.slug, title: c.title, hits: hits.length };
      }
    }
  }
  return null;
}

async function main() {
  await assertNoActiveAgentWork();
  const startedAt = new Date();
  console.log('\n── probing real Paths for a rung-0-saturated spine hole ──────────');
  const subject = await pickSaturatedSubject(process.argv.slice(2).filter((a) => !a.startsWith('--')));
  if (!subject) {
    // Not a pass and not a failure: with no saturated hole the run cannot exercise
    // the defect at all. Widen the scan (scripts/rung0-coverage.ts) or pick a DB.
    console.error('\n⚠ no rung-0-saturated spine hole found — nothing to verify. Aborting.');
    process.exit(1);
  }
  console.log(`\n   subject: [${subject.topic}] ${subject.slug} — "${subject.title}" (${subject.hits} saturating rows)`);

  // The proof web discovery ran: sourceFromWeb logs one line per rung with its label.
  // BOTH lines are captured, because they are the two exits from one pass of the same
  // loop — a rung that discovered nothing fresh logs the barren line and `continue`s,
  // never reaching the labelled one. It still RAN, so it still counts as reached;
  // matching only the labelled line would report a barren rung 1 as "the first rung was
  // open-web" and indict correct code. The barren payload carries no `rung`, so the label
  // is derived exactly as collectSurvivors' iteration log derives its `rung` field — both
  // log sites in web-fallback.ts carry a lockstep note pointing back here.
  const rungs: string[] = [];
  const realLog = console.log;
  const rungLabel = (iteration: number) => (iteration === 1 ? 'allowlisted' : 'open-web');
  console.log = (...args: unknown[]) => {
    const [first, payload] = args;
    if (payload && typeof payload === 'object') {
      if (first === '[web-fallback] iteration' && 'rung' in payload) {
        rungs.push(String(payload.rung));
      } else if (first === '[web-fallback] iteration produced no fresh URLs' && 'iteration' in payload) {
        rungs.push(`${rungLabel(Number(payload.iteration))} (barren)`);
      }
    }
    realLog(...args);
  };

  await prisma.path.deleteMany({ where: { topic: FIXTURE_TOPIC } });
  const path = await prisma.path.create({
    data: {
      topic: FIXTURE_TOPIC,
      concepts: { create: { slug: subject.slug, title: subject.title, membership: ConceptMembership.spine } },
    },
    select: { id: true, concepts: { select: { id: true } } },
  });
  const conceptId = path.concepts[0].id;

  try {
    console.log(`\n── sourcing "${subject.title}" under ${subject.topic} (requirePrimary) ──`);
    const attached = await sourceAndAttachConcept({
      pathId: path.id,
      topic: subject.topic,
      conceptId,
      slug: subject.slug,
      title: subject.title,
      requirePrimary: true,
    });

    const links = await prisma.conceptResource.findMany({
      where: { conceptId },
      select: { resourceId: true, role: true, coverageScore: true, resource: { select: { title: true, origin: true } } },
    });
    console.log('\nattached:');
    for (const l of links) {
      console.log(`   • ${l.role} coverage=${l.coverageScore.toFixed(2)} [${l.resource.origin}] ${l.resource.title.slice(0, 56)}`);
    }
    const rejections = await prisma.conceptCandidateRejection.count({ where: { conceptId } });

    // The attached count disambiguates an empty `rungs`: 0 attached means discovery was
    // skipped outright (the defect returning), anything else means it ran and this
    // harness stopped matching its log lines (drift).
    check(
      'web discovery ran despite a saturated rung 0',
      rungs.length > 0,
      rungs.join(' → ') || `(no iteration lines; ${attached} attached — 0 means discovery was SKIPPED, >0 means this script's log matching drifted)`,
    );
    check('the first rung reached was the allowlisted one', rungs[0]?.startsWith('allowlisted') === true, rungs[0]);
    check('the concept attached at least one candidate', attached > 0, attached);
    check(
      'a qualifying primary attached — the hole would now close',
      hasQualifyingPrimary({
        conceptSlug: subject.slug,
        candidates: links.map((l) => ({ resourceId: l.resourceId, role: l.role, coverageScore: l.coverageScore })),
      }),
      links.map((l) => `${l.role}:${l.coverageScore.toFixed(2)}`),
    );
    check('R2 remembered the rejected rung-0 rows, so the next run skips them', rejections > 0, `${rejections} rejection(s)`);
  } finally {
    console.log = realLog;
    // The fixture Path cascades its Concept, attachments and rejection memory; the
    // window sweep removes the rows discovery inserted (including any parked
    // non-atomic container, which never appears in an attached-id list).
    await prisma.path.deleteMany({ where: { topic: FIXTURE_TOPIC } });
    const { count } = await prisma.resource.deleteMany({ where: { createdAt: { gte: startedAt }, origin: 'agent' } });
    console.log('\ncleanup:', { fixturePath: FIXTURE_TOPIC, resources: count });
  }

  console.log(failures === 0 ? '\n✅ rung-0 fix verified\n' : `\n❌ ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
