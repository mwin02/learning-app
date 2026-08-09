// R4 verification safety net: snapshot / restore the library rows the triage
// actions mutate, so driving each action in the browser doesn't leave the dev
// library degraded. `--save` writes the snapshot, `--restore` puts it back.
import { writeFileSync, readFileSync } from 'node:fs';
import { prisma } from '@/lib/db';

const FILE = '/tmp/r4-snapshot.json';

async function main() {
  const mode = process.argv.includes('--restore') ? 'restore' : 'save';

  if (mode === 'save') {
    const ids = (
      await prisma.resourceReport.findMany({ select: { resourceId: true }, distinct: ['resourceId'] })
    ).map((r) => r.resourceId);

    const resources = await prisma.resource.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        topic: true,
        status: true,
        deprecationSeverity: true,
        durationMin: true,
        difficulty: true,
        title: true,
        summary: true,
      },
    });
    const conceptLinks = await prisma.conceptResource.findMany({
      where: { resourceId: { in: ids } },
    });
    const resourceTopics = await prisma.resourceTopic.findMany({ where: { resourceId: { in: ids } } });

    writeFileSync(FILE, JSON.stringify({ resources, conceptLinks, resourceTopics }, null, 2));
    console.log(JSON.stringify({ saved: FILE, resources: resources.length, conceptLinks: conceptLinks.length, resourceTopics: resourceTopics.length }));
    return;
  }

  const snap = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const r of snap.resources) {
    const { id, ...data } = r;
    await prisma.resource.update({ where: { id }, data });
  }
  const ids = snap.resources.map((r: { id: string }) => r.id);
  await prisma.conceptResource.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.conceptResource.createMany({ data: snap.conceptLinks, skipDuplicates: true });
  await prisma.resourceTopic.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceTopic.createMany({ data: snap.resourceTopics, skipDuplicates: true });

  console.log(JSON.stringify({ restored: snap.resources.length, conceptLinks: snap.conceptLinks.length }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
