// Library quality Q8 (plan item B5, first pass) — soft-deprecate the container furniture
// already in the library.
//
//   DATABASE_URL=… npx tsx scripts/deprecate-furniture.ts
//   DATABASE_URL=… npx tsx scripts/deprecate-furniture.ts --apply
//
// The population is whatever `classifyNonTeaching` flags, not a hand-typed list: the
// classifier now runs at decomposition time, so a backfill built from a different list
// would let the two disagree the moment either changed. Every flagged row is printed with
// the rule that fired and its centroid similarity, and a dry run is the default — this
// pass is only ever as good as the operator reading its output.
//
// SOFT, always. `applyPendingReview({ action: 'reject', severity: 'soft' })` is the one
// seam that deprecates a resource, and going through it (rather than a bare update) is
// what buys the candidate-link cleanup and readiness recompute a deprecation owes the
// Path layer. Tracks are untouched by construction: nothing here writes Track, Lesson or
// LessonResource, and a built Track holds its own resource references — the invariant
// `pending-review.ts` relies on. `--tracks` re-checks that empirically anyway.
//
// Idempotent: a row that is already `deprecated` is outside the candidate population, so
// a second run finds nothing and writes nothing.

import { prisma } from '../src/lib/db';
import { requireTargetAck } from './target-guard';
import { classifyNonTeaching, type NonTeachingReason } from '../src/lib/curation/non-teaching';
import { centroidMargins } from '../src/lib/curation/topic-centroids';
import { applyPendingReview } from '../src/lib/curation/pending-review';

type Candidate = {
  id: string;
  title: string;
  url: string;
  status: string;
  decompositionStatus: string;
  reason: NonTeachingReason;
  own: number | null;
  lessonRefs: number;
};

async function findFurniture(): Promise<Candidate[]> {
  const rows = await prisma.resource.findMany({
    where: { status: { in: ['active', 'pending_review'] } },
    select: {
      id: true,
      title: true,
      url: true,
      summary: true,
      status: true,
      decompositionStatus: true,
      _count: { select: { lessonResources: true } },
    },
  });
  // The junk-leaf tier needs the absolute similarity to the row's own topic centroid —
  // the signal the TopicCentroid model documents as a junk-leaf detector. Batched through
  // the existing seam; rows with no vector or no qualifying centroid come back absent,
  // which the classifier reads as "no corroboration available".
  const margins = await centroidMargins(rows.map((r) => r.id));

  const found: Candidate[] = [];
  for (const r of rows) {
    const own = margins.get(r.id)?.own ?? null;
    const verdict = classifyNonTeaching({
      title: r.title,
      summary: r.summary,
      url: r.url,
      centroidSimilarity: own,
    });
    if (!verdict.nonTeaching) continue;
    found.push({
      id: r.id,
      title: r.title,
      url: r.url,
      status: r.status,
      decompositionStatus: r.decompositionStatus,
      reason: verdict.reason,
      own,
      lessonRefs: r._count.lessonResources,
    });
  }
  return found.sort((a, b) => a.title.localeCompare(b.title));
}

// Tracks are immutable, and this pass is supposed to leave them that way. Rather than
// assert it from the code path, count the rows: if a deprecation ever did reach a Track,
// these three numbers would move.
async function trackFingerprint(): Promise<string> {
  const [tracks, lessons, lessonResources] = await Promise.all([
    prisma.track.count(),
    prisma.lesson.count(),
    prisma.lessonResource.count(),
  ]);
  const latest = await prisma.track.aggregate({ _max: { updatedAt: true } });
  return `tracks=${tracks} lessons=${lessons} lessonResources=${lessonResources} maxTrackUpdatedAt=${
    latest._max.updatedAt?.toISOString() ?? 'none'
  }`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('deprecate-furniture', apply, 'DEPRECATE');
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}\n`);

  const before = await trackFingerprint();
  console.log(`tracks before: ${before}\n`);

  const candidates = await findFurniture();
  console.log(`furniture found (of the active + pending_review population): ${candidates.length}\n`);
  for (const c of candidates) {
    console.log(
      `  ${c.reason.padEnd(16)} [${c.status}/${c.decompositionStatus}] ` +
        `centroid=${c.own === null ? ' n/a ' : c.own.toFixed(3)} lessonRefs=${c.lessonRefs}\n` +
        `      ${c.title}\n      ${c.url}`,
    );
  }

  if (!apply) {
    console.log(`\ndry run — no writes. Re-run with --apply to soft-deprecate ${candidates.length} rows.`);
    return;
  }

  let deprecated = 0;
  let conceptLinksRemoved = 0;
  let pathsRegressed = 0;
  const skipped: string[] = [];
  for (const c of candidates) {
    // cascade: false — furniture has no subtree worth taking with it, and a cascade would
    // reach rows this pass never looked at.
    const result = await applyPendingReview({
      action: 'reject',
      resourceId: c.id,
      cascade: false,
      severity: 'soft',
    });
    if (result.kind === 'rejected') {
      deprecated += result.deprecated;
      conceptLinksRemoved += result.conceptLinksRemoved;
      pathsRegressed += result.pathsRegressed;
    } else {
      skipped.push(`${c.title} → ${result.kind}`);
    }
  }

  console.log(
    `\ndeprecated: ${deprecated} (severity soft)\n` +
      `candidate concept links removed: ${conceptLinksRemoved}\n` +
      `paths regressed to building: ${pathsRegressed}`,
  );
  if (skipped.length > 0) console.log(`\nnot applied:\n${skipped.map((s) => `  ${s}`).join('\n')}`);

  const hard = await prisma.resource.count({ where: { deprecationSeverity: 'hard' } });
  console.log(`\nrows at deprecationSeverity=hard (unchanged by this pass): ${hard}`);
  const after = await trackFingerprint();
  console.log(`tracks after:  ${after}`);
  console.log(after === before ? 'tracks unchanged ✓' : '⚠️ TRACK STATE MOVED — investigate');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
