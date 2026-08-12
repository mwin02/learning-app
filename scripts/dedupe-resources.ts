// Library quality Q8 (plan item B5, second pass) — collapse the enumerated duplicate
// pairs to one active row each.
//
//   DATABASE_URL=… npx tsx scripts/dedupe-resources.ts
//   DATABASE_URL=… npx tsx scripts/dedupe-resources.ts --apply
//
// ⚠️ SCOPE IS THE ENUMERATION, NOT A SIMILARITY SEARCH. Every pair here comes from a
// family B5 names, and each family is matched by an IDENTITY rule (the same provider
// content id reached by two course paths), never by "these two rows look alike". A
// general near-duplicate matcher would be a different, much more dangerous pass.
//
// The loser is SOFT-DEPRECATED, not deleted, through the same reject seam
// `deprecate-furniture.ts` uses: the row keeps its provenance and its URL (so a
// rediscovery still dedups onto it), leaves the pickable pool, and its candidate links are
// cleaned up with the readiness recompute that owes. Built Tracks are untouched — nothing
// here writes Track, Lesson or LessonResource.
//
// Idempotent: both sides of a pair must be active/pending_review to qualify, so a
// deprecated loser drops the pair out of the population on the next run.

import { prisma } from '../src/lib/db';
import { requireTargetAck } from './target-guard';
import { applyPendingReview } from '../src/lib/curation/pending-review';

// A Lamar page under /CalcII/ and /CalcIII/ with the same filename is USUALLY the shared
// 3-D Space chapter served from both courses — but not always: CalcI/CalcIII `ChainRule`
// and CalcII/CalcIII `SurfaceArea` are genuinely different lessons with the same name.
// Measured on the dev library 2026-08-12, the two populations separate cleanly: true
// twins sit at 0.9925–1.0000 cosine, the false ones at 0.8660 (SurfaceArea), 0.9412
// (Differentials), 0.9439 (ChainRule). 0.99 sits inside that gap.
const LAMAR_TWIN_MIN_COSINE = 0.99;

type Pair = {
  family: string;
  survivorId: string;
  loserId: string;
  title: string;
  survivorUrl: string;
  loserUrl: string;
  why: string;
};

type PairRow = {
  survivorId: string;
  loserId: string;
  title: string;
  survivorUrl: string;
  loserUrl: string;
  detail: string | null;
};

// Both sides must still be live, which is also what makes the pass idempotent.
const LIVE = ['active', 'pending_review'];

// B5: "~40 Khan pairs (ap-calculus-ab vs calculus-1 trees, the dup always `(review)`)".
// The identity rule is the last two URL segments — Khan's content type + content id — so
// the same video reached from both course trees matches while a same-titled sibling does
// not. `(review)` was never a title suffix: it is the audit's rendering of the membership
// origin `review`, and requiring it on the loser AND its absence on the survivor is B5's
// survivor rule enforced as a preconditionrather than assumed.
async function khanCourseTwins(): Promise<PairRow[]> {
  return prisma.$queryRaw<PairRow[]>`
    SELECT ap.id AS "survivorId", c1.id AS "loserId", ap.title AS title,
           ap.url AS "survivorUrl", c1.url AS "loserUrl", NULL AS detail
    FROM "Resource" ap
    JOIN "Resource" c1
      ON regexp_replace(ap.url, '^.*/([^/]+/[^/]+)$', '\\1') =
         regexp_replace(c1.url, '^.*/([^/]+/[^/]+)$', '\\1')
    WHERE ap.url LIKE '%khanacademy.org/math/ap-calculus-ab/%'
      AND c1.url LIKE '%khanacademy.org/math/calculus-1/%'
      AND ap.status::text = ANY(${LIVE}) AND c1.status::text = ANY(${LIVE})
      AND EXISTS (SELECT 1 FROM "ResourceTopic" rt
                  WHERE rt."resourceId" = c1.id AND rt.origin::text = 'review')
      AND NOT EXISTS (SELECT 1 FROM "ResourceTopic" rt
                      WHERE rt."resourceId" = ap.id AND rt.origin::text = 'review')
    ORDER BY ap.title
  `;
}

// B5: "9 Lamar CalcII/CalcIII twins". Paul's Online Math Notes serves its 3-Dimensional
// Space chapter from both course paths, so the same .aspx filename under both is one page
// ingested twice. The CalcIII copy survives: it is the canonical home of that chapter, and
// every twin's CalcIII row is filed `multivariable-calculus` by the classifier while the
// CalcII row sits on the `calculus` dumping ground (measured 2026-08-12).
async function lamarTwins(): Promise<PairRow[]> {
  // Raw SQL because the cosine gate is a pgvector operator Prisma cannot express.
  return prisma.$queryRaw<PairRow[]>`
    SELECT c3.id AS "survivorId", c2.id AS "loserId", c3.title AS title,
           c3.url AS "survivorUrl", c2.url AS "loserUrl",
           'cosine ' || round((1 - (c2.embedding <=> c3.embedding))::numeric, 4)::text AS detail
    FROM "Resource" c2
    JOIN "Resource" c3
      ON regexp_replace(c2.url, '^.*/', '') = regexp_replace(c3.url, '^.*/', '')
    WHERE c2.url LIKE '%tutorial.math.lamar.edu/Classes/CalcII/%'
      AND c3.url LIKE '%tutorial.math.lamar.edu/Classes/CalcIII/%'
      AND c2.status::text = ANY(${LIVE}) AND c3.status::text = ANY(${LIVE})
      AND c2.embedding IS NOT NULL AND c3.embedding IS NOT NULL
      AND 1 - (c2.embedding <=> c3.embedding) >= ${LAMAR_TWIN_MIN_COSINE}
    ORDER BY c3.title
  `;
}

// B5: "Khan SQL lesson pairs". Khan's SQL course publishes a project talkthrough (`/pt/`)
// alongside the article or challenge of the same name; both were ingested. The `/pt/` copy
// loses — it arrived later with a summary that is just its own title, so it carries the
// weaker embedding of the two for the same lesson.
async function khanSqlTalkthroughs(): Promise<PairRow[]> {
  return prisma.$queryRaw<PairRow[]>`
    SELECT keep.id AS "survivorId", pt.id AS "loserId", keep.title AS title,
           keep.url AS "survivorUrl", pt.url AS "loserUrl", NULL AS detail
    FROM "Resource" pt
    JOIN "Resource" keep
      ON regexp_replace(pt.url, '^.*/', '') = regexp_replace(keep.url, '^.*/', '')
    WHERE pt.url LIKE '%khanacademy.org/computing/computer-programming/sql/%/pt/%'
      AND keep.url LIKE '%khanacademy.org/computing/computer-programming/sql/%'
      AND keep.url NOT LIKE '%/pt/%'
      AND pt.status::text = ANY(${LIVE}) AND keep.status::text = ANY(${LIVE})
    ORDER BY keep.title
  `;
}

// Q10 / Population C: 14 rows, 7 pairs, the same page ingested twice five weeks apart
// by two runs that disagreed about the path's case
// (`…/classes/calci/defnofderivative.aspx` vs `…/Classes/CalcI/DefnOfDerivative.aspx`).
//
// ⚠️ HOST-RESTRICTED ON PURPOSE, AND THE RESTRICTION IS THE WHOLE RULE. URL paths are
// case-sensitive per spec, which is why `normalizeResourceUrl` does not lowercase them
// and must not start: a global `lower(url)` identity would collapse two different
// YouTube videos (`watch?v=Abc…` vs `watch?v=abc…`) into one row. Lamar serves `.aspx`
// off IIS, which IS case-insensitive, so on THAT host — and measured 2026-08-12, only
// that host — the two spellings are one page. That is a per-host fact the normaliser
// cannot know, which is exactly why it lands here instead.
//
// Survivor: the row that carries the placements, then the concept links, then the
// memberships — a row inside a built Lesson must not be the one deprecated, or a
// learner's lesson points at a resource pulled from the pool. `active` outranks
// `pending_review` first, so the pair always leaves a LIVE row rather than a queued one.
async function lamarCaseVariants(): Promise<PairRow[]> {
  return prisma.$queryRaw<PairRow[]>`
    WITH ranked AS (
      SELECT r.id, r.url, r.title, lower(r.url) AS key,
             row_number() OVER (
               PARTITION BY lower(r.url)
               ORDER BY (r.status::text = 'active') DESC,
                        (SELECT COUNT(*) FROM "LessonResource" l WHERE l."resourceId" = r.id) DESC,
                        (SELECT COUNT(*) FROM "ConceptResource" c WHERE c."resourceId" = r.id) DESC,
                        (SELECT COUNT(*) FROM "ResourceTopic" t WHERE t."resourceId" = r.id) DESC,
                        r."createdAt" ASC
             ) AS rank
      FROM "Resource" r
      WHERE r.url LIKE '%tutorial.math.lamar.edu/%'
        AND r.status::text = ANY(${LIVE})
    )
    SELECT keep.id AS "survivorId", drop_.id AS "loserId", keep.title AS title,
           keep.url AS "survivorUrl", drop_.url AS "loserUrl",
           'case-variant of the same IIS path' AS detail
    FROM ranked keep JOIN ranked drop_ ON drop_.key = keep.key AND drop_.rank > 1
    WHERE keep.rank = 1 AND keep.url <> drop_.url
    ORDER BY keep.title
  `;
}

// The three one-off pairs B5 names individually. Written as URLs rather than as a rule
// because there is no rule — each survivor was chosen by looking at the two rows:
//
//  - predicate logic: B5 names slug `discrete-math-1-4-1-predicate-logic-7ok775` as the
//    duplicate. The two rows carry identical title, summary and concepts (cosine 1.0000)
//    against different video ids, so the second ingest described the first video.
//  - the two KA inference references: the same article reached from the confidence-interval
//    unit and the significance-test unit. The copy carrying a live concept link survives
//    ("on a mean"); where neither does, the first-ingested one survives ("on a proportion").
//  - the generated differential-equations on-ramps: two on-ramp generations five minutes
//    apart, 0.9341 cosine, neither attached. The first survives.
const EXPLICIT_PAIRS: { survivorUrl: string; loserUrl: string; why: string }[] = [
  {
    survivorUrl: 'https://www.youtube.com/watch?v=aqQj-3bSv7k',
    loserUrl: 'https://www.youtube.com/watch?v=LVBDwEAU5yY',
    why: 'B5 names the -7ok775 slug as the duplicate; identical text, cosine 1.0000',
  },
  {
    survivorUrl:
      'https://www.khanacademy.org/math/statistics-probability/significance-tests-one-sample/tests-about-population-mean/a/reference-conditions-inference-one-mean',
    loserUrl:
      'https://www.khanacademy.org/math/statistics-probability/confidence-intervals-one-sample/estimating-population-mean/a/reference-conditions-inference-one-mean',
    why: 'survivor holds the live concept link; loser has none',
  },
  {
    survivorUrl:
      'https://www.khanacademy.org/math/statistics-probability/confidence-intervals-one-sample/estimating-population-proportion/a/conditions-inference-one-proportion',
    loserUrl:
      'https://www.khanacademy.org/math/statistics-probability/significance-tests-one-sample/tests-about-population-proportion/a/conditions-inference-one-proportion',
    why: 'neither is attached; survivor was ingested first',
  },
  {
    survivorUrl: 'generated://differential-equations/intro-to-differential-equations',
    loserUrl: 'generated://differential-equations/introduction-to-differential-equations',
    why: 'neither is attached; survivor was generated first',
  },
];

async function explicitPairs(): Promise<PairRow[]> {
  const urls = EXPLICIT_PAIRS.flatMap((p) => [p.survivorUrl, p.loserUrl]);
  const rows = await prisma.resource.findMany({
    where: { url: { in: urls }, status: { in: ['active', 'pending_review'] } },
    select: { id: true, url: true, title: true },
  });
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const out: PairRow[] = [];
  for (const p of EXPLICIT_PAIRS) {
    const survivor = byUrl.get(p.survivorUrl);
    const loser = byUrl.get(p.loserUrl);
    // Either side missing means the pair is already resolved (or the row is gone) —
    // reported by the caller as a skip, never guessed at.
    if (!survivor || !loser) continue;
    out.push({
      survivorId: survivor.id,
      loserId: loser.id,
      title: survivor.title,
      survivorUrl: survivor.url,
      loserUrl: loser.url,
      detail: p.why,
    });
  }
  return out;
}

async function collectPairs(): Promise<Pair[]> {
  const families: [string, () => Promise<PairRow[]>][] = [
    ['khan-course-twin', khanCourseTwins],
    ['lamar-3d-twin', lamarTwins],
    ['khan-sql-talkthrough', khanSqlTalkthroughs],
    ['lamar-case-variant', lamarCaseVariants],
    ['b5-one-off', explicitPairs],
  ];
  const pairs: Pair[] = [];
  const claimed = new Set<string>();
  for (const [family, find] of families) {
    for (const row of await find()) {
      // A row may be the loser of one pair and the survivor of another (a triple). Taking
      // the first claim keeps at least one active row per content id — the acceptance
      // criterion — instead of chaining deprecations across a group.
      if (claimed.has(row.loserId) || claimed.has(row.survivorId)) continue;
      claimed.add(row.loserId);
      claimed.add(row.survivorId);
      pairs.push({ family, ...row, why: row.detail ?? '' });
    }
  }
  return pairs;
}

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('dedupe-resources', apply, 'DEPRECATE');
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}\n`);

  const pairs = await collectPairs();
  const byFamily = new Map<string, Pair[]>();
  for (const p of pairs) byFamily.set(p.family, [...(byFamily.get(p.family) ?? []), p]);

  for (const [family, group] of byFamily) {
    console.log(`\n=== ${family} — ${group.length} pairs ===`);
    for (const p of group) {
      console.log(
        `  ${p.title}${p.why ? `  (${p.why})` : ''}\n` +
          `    keep  ${p.survivorUrl}\n    drop  ${p.loserUrl}`,
      );
    }
  }
  console.log(`\ntotal pairs: ${pairs.length}`);

  if (!apply) {
    console.log(`\ndry run — no writes. Re-run with --apply to soft-deprecate ${pairs.length} losers.`);
    return;
  }

  let deprecated = 0;
  let conceptLinksRemoved = 0;
  let pathsRegressed = 0;
  const skipped: string[] = [];
  for (const p of pairs) {
    const result = await applyPendingReview({
      action: 'reject',
      resourceId: p.loserId,
      cascade: false,
      severity: 'soft',
    });
    if (result.kind === 'rejected') {
      deprecated += result.deprecated;
      conceptLinksRemoved += result.conceptLinksRemoved;
      pathsRegressed += result.pathsRegressed;
    } else {
      skipped.push(`${p.title} (${p.family}) → ${result.kind}`);
    }
  }

  console.log(
    `\ndeprecated losers: ${deprecated} (severity soft)\n` +
      `candidate concept links removed: ${conceptLinksRemoved}\n` +
      `paths regressed to building: ${pathsRegressed}`,
  );
  if (skipped.length > 0) console.log(`\nnot applied:\n${skipped.map((s) => `  ${s}`).join('\n')}`);

  const survivorsStillLive = await prisma.resource.count({
    where: { id: { in: pairs.map((p) => p.survivorId) }, status: { in: ['active', 'pending_review'] } },
  });
  console.log(`\nsurvivors still live: ${survivorsStillLive}/${pairs.length}`);
  const hard = await prisma.resource.count({ where: { deprecationSeverity: 'hard' } });
  console.log(`rows at deprecationSeverity=hard (unchanged by this pass): ${hard}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
