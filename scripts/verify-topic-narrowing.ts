// Live verification for topic filing T4d (retrieval narrowing via directed relatedness).
//   npx tsx --env-file=.env.local scripts/verify-topic-narrowing.ts
//   npx tsx --env-file=.env.local scripts/verify-topic-narrowing.ts --topic=calculus --extra=precalculus
//
// Read-only. Spends embedding quota only (two ranked searches per concept, no judge
// calls), so it is safe to re-run and safe to run mid-drain.
//
// WHY A LIVE RE-SEARCH AND NOT ATTACHMENT ARCHAEOLOGY. The obvious cheap check — "does
// every currently-attached resource survive the narrower topic set?" — is only evidence
// about an edge when the far shelf was POPULATED at the time that Path was built. T4b
// seeded `precalculus` (48 rows) and `data-structures-algorithms` (34) AFTER every Path
// was mapped, so for the directions reaching those shelves a clean archaeology result is
// trivially true and says nothing. This driver instead re-runs the real per-concept
// search under both topic sets and diffs the ranked candidate lists, which measures what
// a map build or a remediation run would actually see today.
//
// Mirrors attach-candidates' search EXACTLY (same query construction incl. the on-ramp
// rewrite, same statuses/pickability/limit/excludeGenerated) — a divergence here would
// measure a query this codebase never issues.

import { prisma } from '../src/lib/db';
import { searchResources } from '../src/lib/agents/tools/search-resources';
import { onRampQuery } from '../src/lib/agents/map/attach-candidates';
import { MAP_CANDIDATES_PER_CONCEPT } from '../src/lib/config';
import { relatedTopics } from '../src/types/resource';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

// The pre-T4d baseline, FROZEN — a verbatim copy of TOPIC_RELATIONS as it stood before
// T4d, not a derivation from the live table.
//
// ⚠️ Deriving the baseline from the current `TOPIC_RELATIONS` is the obvious shortcut and
// it is WRONG: it reproduces edges T4d merely made one-way, but silently misses edges
// T4d DELETED outright (sql <-> python-data-ml), reporting them as no-ops because
// neither the wide nor the narrow set can see them any more. Freezing the table is what
// makes this a true before/after rather than a comparison of the change with itself.
const PRE_T4D_RELATIONS: Record<string, readonly string[]> = {
  'javascript-react': ['javascript'],
  'python-data-ml': ['python', 'machine-learning'],
  precalculus: ['calculus'],
  sql: ['python-data-ml'],
  'data-structures-algorithms': ['python', 'javascript'],
};

// The pre-T4d SYMMETRIC closure over that frozen table: {topic} ∪ declared edges ∪
// topics declaring an edge TO it.
function symmetricClosure(topic: string): string[] {
  const set = new Set<string>([topic]);
  for (const t of PRE_T4D_RELATIONS[topic] ?? []) set.add(t);
  for (const [k, vs] of Object.entries(PRE_T4D_RELATIONS)) {
    if (vs.includes(topic)) set.add(k);
  }
  return [...set];
}

async function searchFor(topics: string[], title: string, isOnRamp: boolean) {
  return searchResources({
    query: isOnRamp ? onRampQuery(title) : title,
    topics,
    statuses: ['active'],
    pickableOnly: true,
    limit: MAP_CANDIDATES_PER_CONCEPT,
    excludeGenerated: true,
  });
}

type ConceptRow = {
  slug: string;
  title: string;
  membership: string;
  isOnRamp: boolean;
  attached: Set<string>;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function auditPath(topic: string, wide: string[], narrow: string[]) {
  const path = await prisma.path.findUnique({
    where: { topic },
    select: {
      concepts: {
        select: {
          slug: true,
          title: true,
          membership: true,
          isOnRamp: true,
          resources: { select: { resourceId: true, role: true } },
        },
        orderBy: { slug: 'asc' },
      },
    },
  });
  if (!path) {
    console.log(`\n### ${topic}: no Path — skipped`);
    return;
  }

  const concepts: ConceptRow[] = path.concepts.map((c) => ({
    slug: c.slug,
    title: c.title,
    membership: c.membership,
    isOnRamp: c.isOnRamp,
    // Only `teaches` links matter for the hole question — a lost `uses` row is a
    // thinner lesson, a lost `teaches` row is a spine hole.
    attached: new Set(c.resources.filter((r) => r.role === 'teaches').map((r) => r.resourceId)),
  }));

  console.log(`\n### ${topic}`);
  console.log(`    wide=[${wide.join(', ')}]  ->  narrow=[${narrow.join(', ')}]`);
  if (wide.length === narrow.length) {
    console.log('    (identical sets — nothing to measure)');
    return;
  }

  let emptiedConcepts = 0;
  let lostAttached = 0;
  let churnedSlots = 0;
  let totalWideSlots = 0;
  const detail: string[] = [];

  for (const c of concepts) {
    const [w, n] = await Promise.all([
      searchFor(wide, c.title, c.isOnRamp),
      searchFor(narrow, c.title, c.isOnRamp),
    ]);
    const nIds = new Set(n.map((r) => r.id));
    const wIds = new Set(w.map((r) => r.id));
    totalWideSlots += w.length;
    const dropped = w.filter((r) => !nIds.has(r.id));
    churnedSlots += dropped.length;

    // The two failure modes, in severity order.
    if (w.length > 0 && n.length === 0) {
      emptiedConcepts++;
      detail.push(`    EMPTIED  ${c.slug} (${c.membership}) — wide returned ${w.length}, narrow 0`);
    }
    const lost = [...c.attached].filter((id) => wIds.has(id) && !nIds.has(id));
    if (lost.length > 0) {
      lostAttached += lost.length;
      const titles = w.filter((r) => lost.includes(r.id)).map((r) => r.title.slice(0, 48));
      detail.push(`    LOST-ATTACHED  ${c.slug} (${c.membership}) — ${titles.join(' | ')}`);
    }
    // A concept whose narrow set is strictly worse but not empty: report the
    // replacement so a human can judge whether the far-shelf row was doing work.
    if (dropped.length > 0 && lost.length === 0 && n.length > 0) {
      const gained = n.filter((r) => !wIds.has(r.id));
      detail.push(
        `    churn ${c.slug}: -${dropped.length} (${dropped.map((r) => `${r.topic}:${r.title.slice(0, 32)}`).join(' | ')})` +
          (gained.length ? ` +${gained.length} (${gained.map((r) => r.title.slice(0, 32)).join(' | ')})` : ' +0'),
      );
    }
  }

  for (const d of detail) console.log(d);
  console.log(
    `    -- ${concepts.length} concepts | emptied=${emptiedConcepts} | attached-teaches lost=${lostAttached} | ` +
      `top-${MAP_CANDIDATES_PER_CONCEPT} slots churned=${churnedSlots}/${totalWideSlots}`,
  );
  check(`${topic}: narrowing empties no concept`, emptiedConcepts === 0, `emptied=${emptiedConcepts}`);
  check(`${topic}: narrowing drops no attached teaches row`, lostAttached === 0, `lost=${lostAttached}`);
}

async function main() {
  const only = arg('topic');
  // `--drop` probes ONE direction ahead of the edge-table change: wide is whatever the
  // code reaches today, narrow is that minus the named topics. This is how the two
  // weakly-evidenced directions (calculus->precalculus, python->data-structures-algorithms)
  // were settled while `relatedTopics` was still symmetric.
  const drop = arg('drop')?.split(',').map((t) => t.trim()).filter(Boolean);

  const topics = only
    ? [only]
    : (await prisma.path.findMany({ select: { topic: true }, orderBy: { topic: 'asc' } })).map((p) => p.topic);

  console.log(`topic filing T4d — live candidate re-search (limit ${MAP_CANDIDATES_PER_CONCEPT}/concept)`);
  console.log(`mode: ${drop ? `probe (-${drop.join(',')})` : 'sweep (symmetric closure vs relatedTopics)'}`);

  for (const t of topics) {
    const wide = drop ? relatedTopics(t) : symmetricClosure(t);
    const narrow = drop ? wide.filter((x) => !drop.includes(x)) : relatedTopics(t);
    await auditPath(t, wide, narrow);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
