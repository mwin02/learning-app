// Followup verify: on-ramp concepts are skipped, normal concepts generate ~5 via Pro.
// Also cleans up pre-existing on-ramp question banks to match the new policy.
import { prisma } from '@/lib/db';
import { generateConceptBank } from '@/lib/agents/content/generate-concept-bank';
import { CONCEPT_BANK_TARGET_QUESTIONS } from '@/lib/config';

function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function main() {
  console.log('CONCEPT_BANK_TARGET_QUESTIONS =', CONCEPT_BANK_TARGET_QUESTIONS, '(expect 5)');
  assert(CONCEPT_BANK_TARGET_QUESTIONS === 5, 'target should be 5');

  // 1) on-ramp skip
  const onramp = await prisma.concept.findFirst({ where: { isOnRamp: true }, select: { id: true, title: true } });
  if (onramp) {
    const r = await generateConceptBank({ conceptId: onramp.id });
    console.log(`on-ramp "${onramp.title}":`, r);
    assert(r.outcome === 'onramp' && r.generated === 0, 'on-ramp should be skipped');
    console.log('on-ramp skip ✓');
  }

  // 2) normal concept generates ~5 via Pro (delete existing first to force generation)
  const normal = await prisma.concept.findFirst({
    where: { isOnRamp: false, resources: { some: {} }, path: { topic: 'linear-algebra' } },
    select: { id: true, title: true },
  });
  if (normal) {
    await prisma.conceptQuestion.deleteMany({ where: { conceptId: normal.id } });
    const r = await generateConceptBank({ conceptId: normal.id });
    console.log(`normal "${normal.title}":`, r);
    assert(r.outcome === 'generated', 'normal concept should generate');
    assert(r.generated >= 1 && r.generated <= CONCEPT_BANK_TARGET_QUESTIONS + 1, `expected ~5, got ${r.generated}`);
    console.log(`normal generate ✓ — ${r.generated} questions (target ${CONCEPT_BANK_TARGET_QUESTIONS})`);
  }

  // 3) policy cleanup: drop ALL pre-existing on-ramp questions everywhere
  const del = await prisma.conceptQuestion.deleteMany({ where: { concept: { isOnRamp: true } } });
  console.log(`cleanup: deleted ${del.count} pre-existing on-ramp questions across all paths`);
  const remain = await prisma.conceptQuestion.count({ where: { concept: { isOnRamp: true } } });
  assert(remain === 0, 'on-ramp questions should be 0 after cleanup');

  console.log('\n✅ followup tuning verified');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
