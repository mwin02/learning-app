// Phase 2.5d spine-hardening verification (DRY RUN — no DB writes).
//   npx tsx --env-file=.env.local scripts/verify-spine-review.ts [topic...]
// Defaults to javascript + calculus. For each topic it:
//   1. loads the CURRENT persisted spine and runs the reviewer over it (does the
//      critic catch the cold open / gaps on what we shipped?), then
//   2. runs buildSpine fresh (author → review → bounded harden) and prints the
//      NEW spine in topo order, flagging the onboarding root.
// Reads the DB; writes nothing. Costs a few Pro calls per topic.

import { prisma } from '../src/lib/db';
import { buildSpine } from '../src/lib/agents/map/build-spine';
import { reviewSpine } from '../src/lib/agents/map/review-spine';
import { topoSort, type OrderEdge } from '../src/lib/agents/map/order';
import type { AuthoredSpine } from '../src/lib/agents/map/cycle';

const SUBJECTS: Record<string, string> = {
  javascript: 'cs', 'javascript-react': 'cs', python: 'cs', 'python-data-ml': 'cs',
  'machine-learning': 'cs', calculus: 'math', 'linear-algebra': 'math',
};

async function loadSpine(topic: string): Promise<AuthoredSpine | null> {
  const path = await prisma.path.findUnique({ where: { topic }, select: { id: true } });
  if (!path) return null;
  const rows = await prisma.concept.findMany({
    where: { pathId: path.id },
    select: { slug: true, title: true, prereqsIn: { select: { from: { select: { slug: true } } } } },
  });
  const concepts = rows.map((r) => ({ slug: r.slug, title: r.title }));
  const edges = rows.flatMap((c) => c.prereqsIn.map((e) => ({ fromSlug: e.from.slug, toSlug: c.slug })));
  return { concepts, edges };
}

function printSpine(spine: AuthoredSpine) {
  const edges: OrderEdge[] = spine.edges;
  const titleBySlug = new Map(spine.concepts.map((c) => [c.slug, c.title]));
  const roots = new Set(spine.concepts.map((c) => c.slug));
  for (const e of edges) roots.delete(e.toSlug); // a root has no incoming prereq
  const order = topoSort(spine.concepts.map((c) => ({ slug: c.slug })), edges);
  order.forEach((s, i) => {
    const tag = roots.has(s) ? '  ⟵ ROOT' : '';
    console.log(`    ${String(i + 1).padStart(2)}. ${s} — ${titleBySlug.get(s)}${tag}`);
  });
}

async function run(topic: string) {
  const subject = SUBJECTS[topic];
  console.log(`\n========== ${topic} (subject=${subject ?? '?'}) ==========`);

  const current = await loadSpine(topic);
  if (current) {
    console.log(`\n-- CURRENT persisted spine (${current.concepts.length} concepts) --`);
    printSpine(current);
    const review = await reviewSpine({ topic, subject, spine: current });
    console.log(`\n-- Reviewer verdict on CURRENT spine: ok=${review.ok} --`);
    review.findings.forEach((f, i) => console.log(`    ${i + 1}. [${f.kind}] ${f.message}`));
  } else {
    console.log('  (no persisted spine yet)');
  }

  console.log(`\n-- NEW spine from buildSpine (author → review → harden) --`);
  const built = await buildSpine({ topic, subject });
  printSpine(built);
}

async function main() {
  const topics = process.argv.slice(2);
  for (const t of topics.length > 0 ? topics : ['javascript', 'calculus']) await run(t);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
