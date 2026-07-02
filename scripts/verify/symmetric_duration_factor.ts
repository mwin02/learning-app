// Verify (LIVE half): the symmetric (two-sided) durationFactor in candidate ranking,
// checked against real persisted rows — the operators concept's 11-min tutorial now
// outranks the ~1-min Short in candidate ordering. Reads the DB; costs no LLM.
//
// The pure Part A (fixture ordering: short-end penalty flips/holds by regime) migrated
// to src/lib/agents/map/attach-candidates.test.ts (R2). Run:
//   npx tsx --env-file=.env.local scripts/verify/symmetric_duration_factor.ts

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
  await partB();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
