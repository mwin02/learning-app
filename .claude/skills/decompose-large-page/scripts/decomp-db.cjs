// DB helper for the decompose-large-page skill. Run from the repo root with the
// app's env so it reuses the same Prisma + pg-adapter setup as src/lib/db.ts:
//   node --env-file=.env.local .claude/skills/decompose-large-page/scripts/decomp-db.cjs <cmd> <resourceId>
//
//   lookup <id>   → the target row's url/topic/difficulty/type/status
//   verify <id>   → post-decomposition state (parent status, child count, types,
//                   how many embedded, how many children with no concepts)
//   requeue <id>  → move a decided row (e.g. rejected → 'unsupported') back to
//                   'human_review' so decompose_manual can act on it. The curation
//                   API is one-directional OUT of the queue by design, so this
//                   local admin nudge is the only way back in for the bandaid.
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL);
if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('uselibpqcompat', 'true');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });

const [cmd, id] = process.argv.slice(2);

(async () => {
  if (cmd === 'lookup') {
    const r = await prisma.resource.findUnique({
      where: { id },
      select: { id: true, title: true, url: true, topic: true, difficulty: true, type: true, decompositionStatus: true },
    });
    console.log(JSON.stringify(r));
  } else if (cmd === 'verify') {
    const parent = await prisma.resource.findUnique({ where: { id }, select: { decompositionStatus: true, title: true } });
    const children = await prisma.resource.findMany({
      where: { parentResourceId: id },
      select: { type: true, embeddedAt: true, orderInParent: true, conceptsTaught: true },
      orderBy: { orderInParent: 'asc' },
    });
    console.log(JSON.stringify({
      parentStatus: parent?.decompositionStatus ?? null,
      childCount: children.length,
      byType: children.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {}),
      embedded: children.filter((c) => c.embeddedAt).length,
      emptyConcepts: children.filter((c) => !c.conceptsTaught || c.conceptsTaught.length === 0).length,
    }));
  } else if (cmd === 'requeue') {
    const r = await prisma.resource.update({
      where: { id },
      data: { decompositionStatus: 'human_review' },
      select: { id: true, decompositionStatus: true },
    });
    console.log(JSON.stringify(r));
  } else {
    console.error('usage: decomp-db.cjs <lookup|verify|requeue> <resourceId>');
    process.exit(1);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
