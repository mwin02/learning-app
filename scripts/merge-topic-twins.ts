// Topic filing T1.5 — driver for the twin merge. Logic (and its tests) live in
// src/lib/curation/topic-twins.ts; this is the operator surface.
//
// Idempotent: re-running after a successful merge reports zeroes and writes nothing.
//
// Run:  npx tsx --env-file=.env.local scripts/merge-topic-twins.ts [--apply]

import { prisma } from '../src/lib/db';
import { TOPIC_TWINS, planTwinMerge, applyTwinMerge } from '../src/lib/curation/topic-twins';
import { assertMembershipInvariants } from '../src/lib/curation/resource-topics';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`mode: ${apply ? 'APPLY' : 'dry-run'}\n`);

  for (const { from, to } of TOPIC_TWINS) {
    const plan = apply ? await applyTwinMerge(from, to) : await planTwinMerge(from, to);
    const { paths, courseRequests } = plan.blockingRefs;
    console.log(`${from} → ${to}`);
    console.log(`  alias rows repointed:    ${plan.aliases}`);
    console.log(`  primary memberships:     ${plan.primaryMemberships}  (mirror moves with each)`);
    console.log(`  secondary memberships:   ${plan.secondaryMemberships}`);
    console.log(`  stranded scalar mirrors: ${plan.mirrorsOnly}`);
    console.log(`  blocking refs:           ${paths} Path(s), ${courseRequests} CourseRequest(s)`);
    if (!apply && (paths > 0 || courseRequests > 0)) {
      console.log('  ⚠️  --apply would REFUSE this merge until those are repointed.');
    }
    console.log('');
  }

  // The merge moves primaries and mirrors, so the T1 invariants are the correctness check.
  await assertMembershipInvariants();
  console.log('\ninvariants OK');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
