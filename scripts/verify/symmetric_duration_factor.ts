// Verify: the symmetric (two-sided) durationFactor in candidate ranking — a too-thin
// resource is now demoted in capCandidates/selectAttachable ordering, mirroring the
// existing over-long penalty. Regime-aware: the `default` regime penalizes sub-5-min
// resources; the `onRamp` regime does not (orientation should be short).
//
//   Part A — pure fixtures (no DB): ordering flips/holds as expected.
//   Part B — real data: the operators concept's 11-min tutorial now outranks the
//            ~1-min Short in candidate ordering.
//
// Run: npx tsx --env-file=.env.local scripts/verify/symmetric_duration_factor.ts

import { ConceptResourceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { capCandidates } from '@/lib/agents/map/attach-candidates';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

type Cand = {
  id: string;
  role: ConceptResourceRole;
  coverageScore: number;
  trustScore?: number;
  durationMin?: number;
};
const teach = ConceptResourceRole.teaches;

function partA() {
  console.log('\n--- Part A: pure fixtures ---');

  // A thin clip with a HIGHER blend (coverage+trust) than a longer teacher. Without a
  // short-end penalty the thin one would rank first; the penalty must flip the order.
  const thin: Cand = { id: 'thin', role: teach, coverageScore: 0.95, trustScore: 0.9, durationMin: 1 };
  const long: Cand = { id: 'long', role: teach, coverageScore: 0.85, trustScore: 0.7, durationMin: 11 };

  // 1. default regime: thin demoted below the longer teacher despite higher blend.
  {
    const out = capCandidates([thin, long]); // isOnRamp defaults false
    check('1 default: longer teacher outranks higher-blend thin clip', out[0].id === 'long');
  }

  // 2. onRamp regime: short is desirable → no thinness penalty → thin keeps its lead.
  {
    const out = capCandidates([thin, long], { isOnRamp: true });
    check('2 onRamp: thin clip not penalized (orientation should be short)', out[0].id === 'thin');
  }

  // 3. Boundary: a resource AT shortTargetMin (5min) is unpenalized; an equal-blend
  //    1-min clip is penalized below it.
  {
    const five: Cand = { id: 'five', role: teach, coverageScore: 0.8, trustScore: 0.8, durationMin: 5 };
    const one: Cand = { id: 'one', role: teach, coverageScore: 0.8, trustScore: 0.8, durationMin: 1 };
    const out = capCandidates([one, five]);
    check('3 boundary: 5-min (healthy band) outranks equal-blend 1-min clip', out[0].id === 'five');
  }

  // 4. Null duration (persisted re-cap rows) gets factor 1 — unchanged, so it outranks
  //    an equal-blend thin clip.
  {
    const nul: Cand = { id: 'null', role: teach, coverageScore: 0.8, trustScore: 0.8 };
    const one: Cand = { id: 'one', role: teach, coverageScore: 0.8, trustScore: 0.8, durationMin: 1 };
    const out = capCandidates([one, nul]);
    check('4 null-duration unpenalized: outranks equal-blend thin clip', out[0].id === 'null');
  }
}

// --- Part B: real data — operators concept candidate ordering --------------
const PATH_ID = 'cmqxtruaq002o3em5pgd4u45n';
const SHORT_ID = 'cmqwlgn69002m6fm5w3vatm8h'; // ~1-min Short
const LONG_ID = 'cmqwlgorz002o6fm5n12yyos8'; //  11-min tutorial

async function partB() {
  console.log('\n--- Part B: real operators-and-expressions candidates ---');
  const cpt = await prisma.concept.findFirst({
    where: { pathId: PATH_ID, slug: 'operators-and-expressions' },
    select: {
      resources: {
        select: {
          role: true,
          coverageScore: true,
          resource: { select: { id: true, durationMin: true, trustScore: true } },
        },
      },
    },
  });
  if (!cpt) {
    console.log('SKIP  Part B: operators concept not found');
    return;
  }
  const cands: Cand[] = cpt.resources.map((r) => ({
    id: r.resource.id,
    role: r.role,
    coverageScore: r.coverageScore,
    trustScore: r.resource.trustScore ?? undefined,
    durationMin: r.resource.durationMin ?? undefined,
  }));
  const ordered = capCandidates(cands).map((c) => c.id);
  const idxShort = ordered.indexOf(SHORT_ID);
  const idxLong = ordered.indexOf(LONG_ID);
  check(
    `B: 11-min tutorial (idx ${idxLong}) outranks ~1-min Short (idx ${idxShort})`,
    idxLong !== -1 && (idxShort === -1 || idxLong < idxShort),
  );
}

async function main() {
  partA();
  await partB();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
