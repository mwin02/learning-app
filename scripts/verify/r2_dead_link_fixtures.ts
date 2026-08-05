// R2 manual-verification fixtures: throwaway Resources covering each liveness
// verdict branch, plus the two skip guards. Self-cleaning (`--clean`, and it
// clears its own rows before seeding).
import { prisma } from '@/lib/db';

const DEV_USER = 'f7cc2f1e-745b-48c7-a8a4-9f56a4e45b21';
const SLUG_PREFIX = '__verify_r2__';

const FIXTURES = [
  // Authoritative: GitHub serves a real 404 for a nonexistent repo path.
  { key: 'authoritative_404', url: 'https://github.com/mwin02/__no_such_repo__/blob/main/nope.md' },
  // Live control. example.com, not a real library URL — the library's own rows
  // are already taken by the `url` unique.
  { key: 'live', url: 'https://example.com/' },
  // Heuristic: an unresolvable host is "not reachable", which the 2026-08-03 sweep
  // showed is indistinguishable from a slow one — quarantine, never a reject.
  { key: 'unreachable', url: 'https://r2-verify-no-such-host-xyz.invalid/page' },
  // The documented gap: Khan answers 200 for a removed page.
  { key: 'khan_soft_404', url: 'https://www.khanacademy.org/math/__removed_page_probe__' },
  // Authoritative: YouTube oEmbed miss for a nonexistent video id.
  { key: 'youtube_missing', url: 'https://www.youtube.com/watch?v=__nope_nope__' },
  // Skip guard: already deprecated.
  { key: 'already_deprecated', url: 'https://example.com/__verify_r2_deprecated__' },
  // Skip guard: generated origin (no external URL to be dead).
  { key: 'generated', url: 'https://example.com/__verify_r2_generated__' },
];

async function clean() {
  const rows = await prisma.resource.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  await prisma.resourceReport.deleteMany({ where: { userId: DEV_USER } });
  await prisma.resource.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

async function main() {
  if (process.argv.includes('--clean')) {
    console.log(JSON.stringify({ deletedResources: await clean() }));
    return;
  }

  await clean();
  const source = await prisma.source.findFirstOrThrow({ select: { id: true } });

  const created = [];
  for (const f of FIXTURES) {
    const r = await prisma.resource.create({
      data: {
        slug: `${SLUG_PREFIX}${f.key}`,
        topic: '__verify_r2__',
        title: `R2 verification fixture: ${f.key}`,
        url: f.url,
        type: 'article',
        durationMin: 10,
        summary: 'Throwaway row for R2 dead-link probe verification.',
        difficulty: 'beginner',
        sourceId: source.id,
        status: f.key === 'already_deprecated' ? 'deprecated' : 'active',
        deprecationSeverity: f.key === 'already_deprecated' ? 'soft' : null,
        origin: f.key === 'generated' ? 'generated' : 'seed',
      },
      select: { id: true, url: true, status: true, origin: true },
    });
    created.push({ key: f.key, ...r });
  }
  console.log(JSON.stringify(created, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
