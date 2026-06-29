// Block 2.5h-1 verify: ConceptQuestion model round-trips, bankReviewed defaults
// false + flips, cascade delete works, and the hand-written pgvector index survived
// the migration.
import { ExerciseKind, Origin } from '@prisma/client';
import { prisma } from '@/lib/db';

async function main() {
  // Hand-index survival (AGENTS.md guard).
  const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ('Resource_embedding_idx','RemediationJob_active_per_path')`,
  );
  const names = idx.map((r) => r.indexname).sort();
  console.log('hand-indexes present:', names);
  if (names.length !== 2) throw new Error('a hand-written index was dropped by the migration!');

  // Need a Concept to hang questions off — make a throwaway Path + Concept.
  // Idempotent: clear any leftover from a prior aborted run (topic is unique).
  await prisma.path.deleteMany({ where: { topic: '__verify_2_5h_1__' } });
  const path = await prisma.path.create({ data: { topic: '__verify_2_5h_1__' } });
  const concept = await prisma.concept.create({
    data: { pathId: path.id, slug: 'verify-concept', title: 'Verify Concept' },
    select: { id: true, bankReviewed: true },
  });
  console.log('bankReviewed default:', concept.bankReviewed); // expect false
  if (concept.bankReviewed !== false) throw new Error('bankReviewed should default false');

  await prisma.conceptQuestion.createMany({
    data: [
      { conceptId: concept.id, prompt: 'Q text?', answer: 'A', rubric: 'because', kind: ExerciseKind.text },
      { conceptId: concept.id, prompt: 'Q mcq? A) x B) y', answer: 'B', rubric: 'y is right', kind: ExerciseKind.mcq, origin: Origin.user },
    ],
  });
  const qs = await prisma.conceptQuestion.findMany({ where: { conceptId: concept.id }, orderBy: { createdAt: 'asc' } });
  console.log('questions created:', qs.length, '| origins:', qs.map((q) => q.origin));

  await prisma.concept.update({ where: { id: concept.id }, data: { bankReviewed: true } });
  const flipped = await prisma.concept.findUniqueOrThrow({ where: { id: concept.id }, select: { bankReviewed: true } });
  console.log('bankReviewed after flip:', flipped.bankReviewed);

  // Cascade: deleting the Path → Concept → questions.
  await prisma.path.delete({ where: { id: path.id } });
  const orphans = await prisma.conceptQuestion.count({ where: { conceptId: concept.id } });
  console.log('orphan questions after cascade delete:', orphans); // expect 0
  if (orphans !== 0) throw new Error('cascade delete did not remove questions');

  console.log('\n✅ block 2.5h-1 schema verified');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
