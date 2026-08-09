// R4 manual-verification fixtures: one open report per category against real
// library resources, plus a multi-reporter case so the ranking is observable.
// Self-cleaning (`--clean`, and it clears its own rows before seeding).
import { prisma } from '@/lib/db';
import type { ReportCategory } from '@prisma/client';

const DEV_USER = 'f7cc2f1e-745b-48c7-a8a4-9f56a4e45b21';

const CATEGORIES: ReportCategory[] = [
  'dead_link',
  'wrong_topic',
  'wrong_lesson_fit',
  'wrong_duration',
  'wrong_difficulty',
  'paywalled',
  'low_quality',
  'other',
];

// The fixtures sit on real library resources, so the note prefix is what identifies
// them — deleting by `userId` alone would take every report the dev user has filed.
const NOTE_PREFIX = 'verification fixture: ';

async function clean() {
  const { count } = await prisma.resourceReport.deleteMany({
    where: { userId: DEV_USER, note: { startsWith: NOTE_PREFIX } },
  });
  return count;
}

async function main() {
  if (process.argv.includes('--clean')) {
    console.log(JSON.stringify({ deletedReports: await clean() }));
    return;
  }

  await clean();

  // Reports carry lessonId so the unlink path (which needs it) is drivable.
  const lessonRows = await prisma.lessonResource.findMany({
    select: { lessonId: true, resourceId: true },
    take: 40,
  });
  const seen = new Set<string>();
  const pairs = lessonRows.filter((r) => {
    if (seen.has(r.resourceId)) return false;
    seen.add(r.resourceId);
    return true;
  });

  const created = [];
  for (const [i, category] of CATEGORIES.entries()) {
    const pair = pairs[i];
    if (!pair) break;
    const r = await prisma.resourceReport.create({
      data: {
        userId: DEV_USER,
        resourceId: pair.resourceId,
        lessonId: pair.lessonId,
        category,
        note: `${NOTE_PREFIX}${category}`,
        // R2 stamps a machine verdict on some open reports; seed one so the
        // operator-vs-probe resolution composition is observable.
        resolution: category === 'dead_link' ? 'url not reachable' : null,
      },
      select: { id: true, category: true, resourceId: true },
    });
    created.push(r);
  }

  console.log(JSON.stringify({ created, distinctResources: created.length }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
