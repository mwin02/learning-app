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

  // Keep one pooled connection alive for the whole run. $transaction's default 2s
  // maxWait covers CONNECTION ACQUISITION, and a cold handshake to the Supabase
  // pooler from a laptop takes ~1.6s — so any transaction that has to open a fresh
  // connection loses the race and dies with P2028. That happens twice here: on tx1
  // (the process's first DB call) and again on tx2, because the pg pool closes idle
  // connections after 10s while the multi-minute spine-authoring AI phase runs.
  // Pinging inside that window keeps an idle connection in the pool, so acquisition
  // is instant. In-cluster (Cloud Run, the worker VM) the handshake is fast enough
  // that neither case fires, which is why only this operator script needs it.
  const heartbeat = setInterval(() => {
    void prisma.$queryRaw`select 1`.catch(() => {});
  }, 5_000);
  heartbeat.unref(); // never hold the event loop open, including on a thrown run
  await prisma.$queryRaw`select 1`;

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
  clearInterval(heartbeat);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
