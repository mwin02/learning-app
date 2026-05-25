import { seedResources } from '../data/seed-resources';
import { prisma } from '../src/lib/db';

async function main() {
  const counts: Record<string, number> = {};

  for (const r of seedResources) {
    await prisma.resource.upsert({
      where: { slug: r.slug },
      create: r,
      update: r,
    });
    counts[r.topic] = (counts[r.topic] ?? 0) + 1;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`seed: upserted ${total} resources`);
  for (const [topic, n] of Object.entries(counts).sort()) {
    console.log(`  ${topic}: ${n}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
