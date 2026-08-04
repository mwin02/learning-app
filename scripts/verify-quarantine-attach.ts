// End-to-end driver for the non-destructive liveness gate: a URL the validator
// SUSPECTS is dead must still be created and reach the review queue, must never
// be attached to a path, and must attach when a reviewer approves it.
//
// A verify-* driver rather than a Vitest test because it drives the real network,
// the real Vertex embeddings and the real judge LLM (.claude/rules/testing.md).
// Nothing here is mocked.
//
// Run against the LOCAL dev DB (it writes Path/Concept/Resource rows):
//   npx tsx --env-file=.env.local scripts/verify-quarantine-attach.ts
//
// The specimen is deliberately a REAL page, not a fixture: MIT OCW's "Lecture 8:
// Sampling and Standard Error" is live, on-topic, and the loosened DEAD_PAGE_TITLE
// patterns match its title. So it exercises the exact case the design exists for —
// a false positive that must cost a review instead of a resource.
//
// Self-cleaning: every row carries the __verify_qa__ marker.

import { setTimeout as sleep } from 'node:timers/promises';

const MARKER = '__verify_qa__';

// The quarantine specimen: live page, title matches an over-broad pattern.
const SUSPECT_URL =
  'https://ocw.mit.edu/courses/6-0002-introduction-to-computational-thinking-and-data-science-fall-2016/resources/lecture-8-sampling-and-standard-error';
const SUSPECT_TITLE = 'Lecture 8: Sampling and Standard Error';
const SUSPECT_SUMMARY =
  'MIT 6.0002 lecture on sampling from a population, the distribution of sample means, ' +
  'standard error of the mean, and how sample size affects confidence in an estimate.';

// Resource.url is @unique and the dev DB already holds the real OCW row, so the
// seeded copy carries a fragment. Servers ignore fragments, so it is the same page
// — stage 1 still probes the bare URL over the network.
const SUSPECT_ROW_URL = `${SUSPECT_URL}#${MARKER}`;

const LIVE_URL = 'https://docs.python.org/3/tutorial/introduction.html';
const HARD_404_URL = 'https://react.dev/learn/this-page-does-not-exist-xyz';

const CONCEPT_TITLE = 'Sampling Distributions and Standard Error';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail)}`);
  }
}

async function main() {
  const { prisma } = await import('@/lib/db');
  const { runValidationPipeline } = await import('@/lib/agents/validation');
  const { livenessValidator } = await import('@/lib/agents/validation/validators/liveness');
  const { rulesAgentValidator } = await import('@/lib/agents/validation/validators/rules-agent');
  const { deriveSourcedForPairs } = await import('@/lib/agents/tools/sourced-for');
  const { listPendingReview, applyPendingReview } = await import('@/lib/curation/pending-review');
  const { rejudgeForDemandingPaths } = await import('@/lib/agents/decomposition/rejudge-sourced-for');
  const { embedTexts, buildEmbeddingText, storeEmbedding } = await import('@/lib/ai/embeddings');

  // This driver WRITES. Refuse to touch production.
  const target = process.env.DATABASE_URL ?? '';
  if (target.includes('pooler.supabase.com') || target.includes('supabase.co')) {
    throw new Error('refusing to run against production Supabase — this driver writes rows');
  }
  console.log(`db: ${target.replace(/:\/\/[^@]*@/, '://***@') || '(unset)'}\n`);

  const cleanup = async () => {
    await prisma.path.deleteMany({ where: { topic: MARKER } });
    await prisma.resource.deleteMany({ where: { topic: MARKER } });
    await prisma.source.deleteMany({ where: { slug: { startsWith: MARKER } } });
  };
  await cleanup();

  try {
    // ---------------------------------------------------------------- stage 1
    // The real gate, over the real network, with the real validator array
    // (mirrors VALIDATORS in web-fallback.ts:135).
    console.log('STAGE 1 — the gate splits three ways (live network)');
    const rows = [SUSPECT_URL, LIVE_URL, HARD_404_URL].map((url) => ({
      url,
      title: url === SUSPECT_URL ? SUSPECT_TITLE : 'Some page',
      summary: url === SUSPECT_URL ? SUSPECT_SUMMARY : 'A programming documentation page.',
      type: 'article',
    }));
    const pipeline = await runValidationPipeline(rows, [livenessValidator, rulesAgentValidator]);
    const q = pipeline.quarantined.map((x) => x.row.url);
    const v = pipeline.valid.map((x) => x.url);
    const rj = pipeline.rejected.map((x) => x.row.url);
    console.log(`        valid=${v.length} quarantined=${q.length} rejected=${rj.length}`);
    for (const x of pipeline.quarantined) console.log(`        quarantine reason: ${x.reason}`);
    check('the live OCW lecture is QUARANTINED, not rejected', q.includes(SUSPECT_URL), { q, rj });
    check('the suspect never reaches the valid set', !v.includes(SUSPECT_URL), v);
    check('a hard 404 is REJECTED outright, not quarantined', rj.includes(HARD_404_URL), { q, rj });

    // ---------------------------------------------------------------- stage 2
    // A quarantined row is persisted, queued for review, and NOT attached.
    console.log('\nSTAGE 2 — the quarantined row persists unattached, with provenance');
    const source = await prisma.source.create({
      data: { slug: `${MARKER}src`, name: 'QA source', url: 'https://ocw.mit.edu', kind: 'course_platform' },
      select: { id: true },
    });
    const path = await prisma.path.create({
      data: {
        topic: MARKER,
        concepts: { create: [{ slug: 'qa-standard-error', title: CONCEPT_TITLE }] },
      },
      select: { id: true, concepts: { select: { id: true, slug: true } } },
    });
    const conceptId = path.concepts[0].id;

    const suspect = await prisma.resource.create({
      data: {
        slug: `${MARKER}-suspect`,
        topic: MARKER,
        title: SUSPECT_TITLE,
        url: SUSPECT_ROW_URL,
        type: 'course',
        durationMin: 50,
        summary: SUSPECT_SUMMARY,
        difficulty: 'intermediate',
        prerequisiteConcepts: [],
        conceptsTaught: ['sampling', 'standard-error', 'sample-mean'],
        // The state web-fallback leaves a quarantined row in: written, queued,
        // never promoted (it was withheld from insertedIds, so nothing judged it).
        status: 'pending_review',
        decompositionStatus: 'atomic',
        sourceId: source.id,
      },
      select: { id: true, title: true, summary: true, conceptsTaught: true },
    });

    // Real Vertex embedding — rejudge's pgvector routing needs it.
    const [vec] = await embedTexts([buildEmbeddingText(suspect)]);
    await storeEmbedding(suspect.id, vec);

    // The REAL derivation, given the shape persistDiscovered now produces.
    const pairs = deriveSourcedForPairs(conceptId, [
      { resourceId: suspect.id, decompositionStatus: 'atomic', quarantined: true },
    ]);
    check('deriveSourcedForPairs emits a pair for a quarantined ATOMIC row', pairs.length === 1, pairs);
    await prisma.resourceSourcedFor.createMany({ data: pairs, skipDuplicates: true });

    const linksBefore = await prisma.conceptResource.count({ where: { resourceId: suspect.id } });
    check('the quarantined row is attached to NOTHING', linksBefore === 0, linksBefore);
    const stateBefore = await prisma.resource.findUniqueOrThrow({
      where: { id: suspect.id },
      select: { status: true },
    });
    check('it sits in pending_review (never promoted)', stateBefore.status === 'pending_review', stateBefore);

    const queue = await listPendingReview();
    check(
      'it SURFACES in the review queue a human works',
      queue.some((r) => r.id === suspect.id),
      queue.map((r) => r.id).slice(0, 5),
    );

    // ---------------------------------------------------------------- stage 3
    // Approving it attaches it — the mechanism that did not exist before.
    console.log('\nSTAGE 3 — approve attaches it (real judge LLM)');
    const approved = await applyPendingReview({ action: 'approve', resourceId: suspect.id, cascade: false });
    check('approve applied', approved.kind === 'approved', approved);

    const rejudge = await rejudgeForDemandingPaths(suspect.id);
    console.log(`        pairs=${rejudge.pairs} candidates=${rejudge.candidates} attachments=${JSON.stringify(rejudge.attachments)}`);
    check('the hook found the demand recorded at sourcing time', rejudge.pairs === 1, rejudge.pairs);
    check('it offered the row itself as a candidate', rejudge.candidates === 1, rejudge.candidates);

    const linksAfter = await prisma.conceptResource.findMany({
      where: { resourceId: suspect.id },
      select: { conceptId: true, role: true, coverageScore: true },
    });
    check('ATTACHED on approve', linksAfter.length === 1, linksAfter);
    check('attached to the demanding concept', linksAfter[0]?.conceptId === conceptId, linksAfter);
    const stateAfter = await prisma.resource.findUniqueOrThrow({
      where: { id: suspect.id },
      select: { status: true },
    });
    check('now active', stateAfter.status === 'active', stateAfter);

    // ---------------------------------------------------------------- stage 4
    // The gate on the hook: an approve with no recorded demand must not attach.
    console.log('\nSTAGE 4 — an ordinary approve does not attach (the hook self-gates)');
    const ordinary = await prisma.resource.create({
      data: {
        slug: `${MARKER}-ordinary`,
        topic: MARKER,
        title: 'An unrelated pending resource',
        url: 'https://example.com/__verify_qa__/ordinary',
        type: 'article',
        durationMin: 10,
        summary: 'Nothing demanded this row; it was never quarantined.',
        difficulty: 'beginner',
        prerequisiteConcepts: [],
        conceptsTaught: [],
        status: 'pending_review',
        decompositionStatus: 'atomic',
        sourceId: source.id,
      },
      select: { id: true },
    });
    const ordinaryApproved = await applyPendingReview({ action: 'approve', resourceId: ordinary.id, cascade: false });
    check('approve applied', ordinaryApproved.kind === 'approved', ordinaryApproved);
    const ordinaryRejudge = await rejudgeForDemandingPaths(ordinary.id);
    check(
      'hook no-ops on zero provenance (no judge call, no attach)',
      ordinaryRejudge.pairs === 0 && ordinaryRejudge.candidates === 0 && ordinaryRejudge.attachments.length === 0,
      ordinaryRejudge,
    );
    check(
      'nothing attached',
      (await prisma.conceptResource.count({ where: { resourceId: ordinary.id } })) === 0,
    );

    // ---------------------------------------------------------------- stage 5
    console.log('\nSTAGE 5 — re-approving is idempotent');
    const again = await rejudgeForDemandingPaths(suspect.id);
    check(
      're-run attaches nothing new',
      again.attachments.every((a) => a.attached === 0),
      again.attachments,
    );
    check(
      'still exactly one link',
      (await prisma.conceptResource.count({ where: { resourceId: suspect.id } })) === 1,
    );
  } finally {
    await sleep(50);
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
