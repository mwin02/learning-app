// Phase 2.5d-4: seed the launch-topic spine concept maps.
//
//   npx tsx --env-file=.env.local scripts/seed-spine-maps.ts [topic...] [--force]
//
// Drives the map-builder (ensurePathMap) for the four canonical launch topics,
// authoring each topic's spine + attaching existing library candidates.
// Idempotent: an existing Path is returned untouched (get-or-create). `--force`
// deletes the Path first (cascade clears its concepts/edges/links) so it rebuilds
// from scratch — use after improving the author prompt or growing the library.
//
// With no args, seeds all four. Pass topic slugs to seed a subset, e.g.
//   npx tsx --env-file=.env.local scripts/seed-spine-maps.ts javascript-react
//
// NOTE: the thin launch libraries (calculus, linear-algebra, python-data-ml)
// will mostly land `building` with spine holes — expected. The seed lays down
// the spine STRUCTURE + whatever candidates exist; 2.5f remediation / library
// growth fills the holes to reach `spine_ready` later.

import { prisma } from '../src/lib/db';
import { ensurePathMap } from '../src/lib/agents/map/ensure-path-map';

// Subject domain per launch topic, grounding the spine author ({math|science|cs}).
// python + machine-learning were split out of the original conflated
// python-data-ml topic (2.5d-4); python-data-ml is now the applied glue that
// draws on both via relatedTopics().
const SUBJECTS: Record<string, string> = {
  python: 'cs',
  'python-data-ml': 'cs',
  'machine-learning': 'cs',
  javascript: 'cs',
  'javascript-react': 'cs',
  calculus: 'math',
  'linear-algebra': 'math',
};
const ALL = Object.keys(SUBJECTS);

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const requested = args.filter((a) => !a.startsWith('--'));
  const topics = requested.length > 0 ? requested : ALL;

  const unknown = topics.filter((t) => !(t in SUBJECTS));
  if (unknown.length > 0) {
    console.error(`Unknown launch topic(s): ${unknown.join(', ')}. Known: ${ALL.join(', ')}`);
    process.exit(1);
  }

  for (const topic of topics) {
    const subject = SUBJECTS[topic];
    if (force) {
      const del = await prisma.path.deleteMany({ where: { topic } });
      if (del.count > 0) console.log(`[seed] --force: deleted existing Path for ${topic}`);
    }
    const start = Date.now();
    const r = await ensurePathMap({ topic, subject });
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    const tag = r.created ? 'built' : 'exists';
    console.log(
      `[seed] ${topic.padEnd(18)} ${tag.padEnd(6)} status=${r.status.padEnd(11)} ` +
        `holes=${r.holes.length}${r.holes.length ? ` (${r.holes.join(', ')})` : ''}  ${secs}s`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
