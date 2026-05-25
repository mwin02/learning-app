import { seedResources } from '../data/seed-resources';
import { seedSources } from '../data/seed-sources';
import { prisma } from '../src/lib/db';

async function main() {
  // Sources must exist before Resources can reference them (block C wires up
  // sourceId on each Resource; for now Resource.sourceId stays null).
  for (const s of seedSources) {
    await prisma.source.upsert({
      where: { slug: s.slug },
      create: s,
      update: s,
    });
  }
  console.log(`seed: upserted ${seedSources.length} sources`);

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
