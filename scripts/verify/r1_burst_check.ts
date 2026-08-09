// R1 verification: exercise reportBurst against the real DB, and the upsert's
// reopen semantics, using throwaway rows on the dev user. Self-cleaning.
import { prisma } from '@/lib/db';
import { reportBurst } from '@/lib/services/report-limits';
import { REPORT_BURST_PER_HOUR } from '@/lib/config';

const DEV_USER = 'f7cc2f1e-745b-48c7-a8a4-9f56a4e45b21';

async function main() {
  await prisma.resourceReport.deleteMany({ where: { userId: DEV_USER } });

  const resources = await prisma.resource.findMany({
    where: { status: 'active' },
    select: { id: true },
    take: REPORT_BURST_PER_HOUR + 2,
  });

  const before = await reportBurst(DEV_USER);

  const first = await prisma.resourceReport.create({
    data: { userId: DEV_USER, resourceId: resources[0].id, category: 'low_quality', note: 'v1' },
  });
  // Operator resolves it...
  await prisma.resourceReport.update({
    where: { id: first.id },
    data: { state: 'resolved', resolution: 'checked, fine', resolvedAt: new Date() },
  });
  // ...and the learner re-reports the same (resource, category): same row, reopened.
  const reopened = await prisma.resourceReport.upsert({
    where: {
      userId_resourceId_category: {
        userId: DEV_USER,
        resourceId: resources[0].id,
        category: 'low_quality',
      },
    },
    update: { note: 'v2', state: 'open', resolution: null, resolvedAt: null },
    create: { userId: DEV_USER, resourceId: resources[0].id, category: 'low_quality' },
  });

  const rowsForPair = await prisma.resourceReport.count({
    where: { userId: DEV_USER, resourceId: resources[0].id, category: 'low_quality' },
  });

  // Fill to the cap.
  for (const r of resources.slice(1, REPORT_BURST_PER_HOUR)) {
    await prisma.resourceReport.create({
      data: { userId: DEV_USER, resourceId: r.id, category: 'low_quality' },
    });
  }
  const atCap = await reportBurst(DEV_USER);

  // Rows outside the window must not count.
  await prisma.resourceReport.updateMany({
    where: { userId: DEV_USER },
    data: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  });
  const afterWindow = await reportBurst(DEV_USER);

  console.log(
    JSON.stringify(
      {
        emptyStart: before,
        reopen: {
          sameRow: reopened.id === first.id,
          rowsForPair,
          state: reopened.state,
          note: reopened.note,
          resolution: reopened.resolution,
          resolvedAt: reopened.resolvedAt,
        },
        atCap,
        afterWindowSlides: afterWindow,
      },
      null,
      2
    )
  );

  await prisma.resourceReport.deleteMany({ where: { userId: DEV_USER } });
  console.log(JSON.stringify({ cleanedUp: await prisma.resourceReport.count() }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
