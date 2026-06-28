import { seedSources } from '../data/seed-sources';
import { prisma } from '../src/lib/db';

// Seeds the curated `Source` rows only. Resources are no longer hand-seeded —
// the curriculum agent sources them naturally during path generation. The Source
// table stays seeded because the curated publishers are load-bearing at runtime:
// they carry the trust-score priors (resolveSource in decomposition/upsert-resource.ts)
// and define the open-web discovery allowlist (loadAllowlistDomains in
// agents/tools/web-fallback.ts).
async function main() {
  for (const s of seedSources) {
    await prisma.source.upsert({
      where: { slug: s.slug },
      create: s,
      update: s,
    });
  }
  console.log(`seed: upserted ${seedSources.length} sources`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
