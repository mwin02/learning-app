// Phase 2.5h block 2f: cold pre-warm — drive ONE topic through the real build
// chain against the freshly-emptied library, so we can observe what the NEW
// sourcing pipeline (allowlisted ladder + engagement trust) actually generates.
//
//   npx tsx --env-file=.env.local scripts/prewarm.ts [topic]   # default: python
//
//   ensurePathMap(topic)  — author the spine; on an empty library every concept is
//                           a spine hole, so the Path stays `building`.
//   remediatePath(pathId) — fill the holes via the ladder (YouTube prong +
//                           allowlisted grounded prong → open-web relaxation),
//                           re-judge + attach, relax/escalate the leftovers.
// Then report the library the run produced, grouped by Source — the whole point is
// to SEE that resources come from the curated set with sane trust.

import { prisma } from '../src/lib/db';
import { ensurePathMap } from '../src/lib/agents/map/ensure-path-map';
import { remediatePath } from '../src/lib/agents/track/remediate-path';

async function reportLibrary(topic: string) {
  const rows = await prisma.resource.findMany({
    where: { topic },
    select: { type: true, trustScore: true, viewCount: true, source: { select: { slug: true, kind: true } } },
  });
  const bySource = new Map<string, { n: number; trust: number; videos: number }>();
  for (const r of rows) {
    const k = `${r.source.slug} (${r.source.kind})`;
    const e = bySource.get(k) ?? { n: 0, trust: 0, videos: 0 };
    e.n += 1; e.trust += r.trustScore; e.videos += r.type === 'video' ? 1 : 0;
    bySource.set(k, e);
  }
  const table = Object.fromEntries(
    [...bySource.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, { count: v.n, videos: v.videos, avgTrust: +(v.trust / v.n).toFixed(2) }]),
  );
  console.log(`\n── library for "${topic}": ${rows.length} resources ──`);
  console.table(table);
}

async function main() {
  const topic = process.argv.find((a) => !a.startsWith('-') && !a.includes('/') && a !== 'tsx' && !a.endsWith('.ts')) ?? 'python';
  console.log(`\n=== cold pre-warm: ${topic} ===`);

  const t0 = Date.now();
  const map = await ensurePathMap({ topic });
  console.log(`[prewarm] ensurePathMap → status=${map.status} pathId=${map.pathId}`);
  const concepts = await prisma.concept.count({ where: { pathId: map.pathId } });
  console.log(`[prewarm] spine authored: ${concepts} concepts`);

  if (map.status === 'building') {
    console.log('[prewarm] remediating spine holes via the new ladder (this sources from the web — minutes)…');
    const rem = await remediatePath(map.pathId);
    console.log('[prewarm] remediate →', { outcome: rem.outcome, status: rem.status, holes: rem.holes.length, relaxed: rem.relaxedConceptSlugs.length, escalated: rem.escalatedConceptSlugs.length });
  }

  const final = await prisma.path.findUnique({ where: { id: map.pathId }, select: { status: true } });
  console.log(`\n[prewarm] final Path status: ${final?.status}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  await reportLibrary(topic);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
