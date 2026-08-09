// R1 manual-verification helper: print ids the route driver needs, and clean up
// the reports this session's testing leaves behind (`--clean`).
import { prisma } from '@/lib/db';

const DEV_USER = 'f7cc2f1e-745b-48c7-a8a4-9f56a4e45b21';

async function main() {
  if (process.argv.includes('--clean')) {
    const { count } = await prisma.resourceReport.deleteMany({ where: { userId: DEV_USER } });
    console.log(JSON.stringify({ deletedReports: count }));
    return;
  }

  const resources = await prisma.resource.findMany({
    where: { status: 'active' },
    select: { id: true, title: true, url: true },
    take: 3,
  });
  const lesson = await prisma.lesson.findFirst({ select: { id: true, title: true } });
  const existing = await prisma.resourceReport.count({ where: { userId: DEV_USER } });

  console.log(JSON.stringify({ resources, lesson, existingReportsForDevUser: existing }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
