import { seedResources } from '../data/seed-resources';
import { seedSources } from '../data/seed-sources';
import { prisma } from '../src/lib/db';

async function main() {
  // Sources must exist before Resources can reference them.
  for (const s of seedSources) {
    await prisma.source.upsert({
      where: { slug: s.slug },
      create: s,
      update: s,
    });
  }
  console.log(`seed: upserted ${seedSources.length} sources`);

  // Load all sources into a lookup for sourceSlug -> { id, trustScore }.
  const sources = await prisma.source.findMany({
    select: { id: true, slug: true, trustScore: true },
  });
  const sourceBySlug = new Map(sources.map((s) => [s.slug, s]));

  const counts: Record<string, number> = {};

  for (const r of seedResources) {
    const { sourceSlug, ...rest } = r;
    const source = sourceBySlug.get(sourceSlug);
    if (!source) {
      throw new Error(`unknown sourceSlug "${sourceSlug}" for resource "${r.slug}"`);
    }
    await prisma.resource.upsert({
      where: { slug: r.slug },
      // On create, inherit trustScore from the source. On update, leave
      // trustScore alone so review-based updates aren't wiped by reseeding.
      create: { ...rest, source: { connect: { id: source.id } }, trustScore: source.trustScore },
      update: { ...rest, source: { connect: { id: source.id } } },
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
