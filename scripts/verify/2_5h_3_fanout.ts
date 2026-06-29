// Block 2.5h-3 verify:
//  (A) synthetic path — generateConceptBank persists + is idempotent; backfill fans
//      out over only bank-less concepts and reports an accurate summary.
//  (B) LIVE — backfill a real spine_ready Path end to end (the exact call the worker
//      makes), asserting every concept ends up with a bank.
import { prisma } from '@/lib/db';
import { generateConceptBank, backfillConceptBanks } from '@/lib/agents/content/generate-concept-bank';

function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function partA() {
  console.log('\n=== (A) synthetic path: persistence + idempotency + fan-out summary ===');
  await prisma.path.deleteMany({ where: { topic: '__verify_2_5h_3__' } });
  const path = await prisma.path.create({ data: { topic: '__verify_2_5h_3__', status: 'spine_ready' } });
  const slugs = ['recursion-basics', 'big-o-notation', 'hash-tables'];
  const concepts = [];
  for (const slug of slugs) {
    concepts.push(await prisma.concept.create({
      data: { pathId: path.id, slug, title: slug.replace(/-/g, ' '), membership: 'spine' },
      select: { id: true, slug: true },
    }));
  }

  // single-concept generate
  const g1 = await generateConceptBank({ conceptId: concepts[0].id });
  console.log('generate concept[0]:', g1);
  assert(g1.outcome === 'generated' && g1.generated > 0, 'expected generated bank');
  const persisted = await prisma.conceptQuestion.count({ where: { conceptId: concepts[0].id } });
  assert(persisted === g1.generated, `persisted (${persisted}) != reported (${g1.generated})`);

  // idempotent re-run
  const g2 = await generateConceptBank({ conceptId: concepts[0].id });
  console.log('regenerate concept[0]:', g2);
  assert(g2.outcome === 'skipped' && g2.generated === 0, 'expected skip on re-run');
  const afterReRun = await prisma.conceptQuestion.count({ where: { conceptId: concepts[0].id } });
  assert(afterReRun === persisted, 'idempotent re-run added rows!');

  // backfill — should pick up only the 2 remaining bank-less concepts
  const bf = await backfillConceptBanks({ pathId: path.id });
  console.log('backfill:', bf);
  assert(bf.candidates === 2, `expected 2 candidates, got ${bf.candidates}`);
  assert(bf.generated + bf.empty === 2, 'generated+empty should cover candidates');

  // re-backfill — nothing left
  const bf2 = await backfillConceptBanks({ pathId: path.id });
  assert(bf2.candidates === 0, `expected 0 candidates on re-backfill, got ${bf2.candidates}`);
  console.log('re-backfill candidates:', bf2.candidates, '(idempotent ✓)');

  await prisma.path.delete({ where: { id: path.id } });
  console.log('(A) ✓');
}

async function partB() {
  console.log('\n=== (B) LIVE: backfill a real spine_ready Path ===');
  const path = await prisma.path.findFirst({
    where: { status: 'spine_ready', topic: 'linear-algebra', concepts: { some: { questions: { none: {} } } } },
    select: { id: true, topic: true, _count: { select: { concepts: true } } },
  });
  if (!path) { console.log('(skip — no eligible real path)'); return; }
  console.log(`path "${path.topic}" — ${path._count.concepts} concepts`);

  const bf = await backfillConceptBanks({ pathId: path.id });
  console.log('backfill summary:', bf);
  assert(bf.failed === 0, `${bf.failed} concept(s) failed generation`);

  // On-ramp concepts are excluded from backfill by design (2.5i), so they stay
  // bankless legitimately — count only the non-on-ramp ones the backfill covers.
  const bankless = await prisma.concept.count({ where: { pathId: path.id, isOnRamp: false, questions: { none: {} } } });
  console.log('non-on-ramp concepts still bankless:', bankless, '(expect only the "empty" ones:', bf.empty, ')');
  assert(bankless === bf.empty, 'non-on-ramp bankless count should equal the empty-author count');

  // spot-check one persisted bank
  const sample = await prisma.concept.findFirst({
    where: { pathId: path.id, questions: { some: {} } },
    select: { title: true, questions: { take: 2, select: { kind: true, prompt: true } } },
  });
  console.log(`\nspot-check "${sample?.title}":`);
  for (const q of sample?.questions ?? []) console.log(`  (${q.kind}) ${q.prompt.split('\n')[0].slice(0, 90)}`);
  console.log('(B) ✓');
}

async function main() {
  await partA();
  await partB();
  console.log('\n✅ block 2.5h-3 verified');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
