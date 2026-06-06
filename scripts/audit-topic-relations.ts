// Read-only audit: surface topic pairs that look related but aren't in
// TOPIC_RELATIONS — the maintenance backstop for the topic-partition redesign.
// As the gate mints new topics autonomously, a foundational/specialization
// overlap (the javascript vs javascript-react situation) can silently recur;
// this ranks every unrelated pair so a human can eyeball candidates and add an
// edge. It surfaces, it does not decide. Makes no writes.
//
//   npx tsx --env-file=.env.local scripts/audit-topic-relations.ts
//
// Signals (computed from the current library, no LLM):
//   - concept overlap coefficient (PRIMARY) — shared conceptsTaught divided by
//     the smaller topic's vocabulary. Picks out "one topic's concepts are
//     largely a subset of the other's", the foundational/specialization tell.
//     Caveat: concepts are canonicalized PER topic, so the same idea can be
//     phrased differently across topics — string overlap is a LOWER BOUND on
//     true overlap. High overlap is strong evidence; low overlap is weak
//     evidence of unrelatedness.
//   - centroid cosine (SECONDARY, display only) — cosine of the topics' mean
//     embeddings. A whole technical corpus clusters tightly (observed ~0.6–0.85
//     even for unrelated pairs), so its dynamic range is too low to threshold
//     on; shown for context, not used to flag.
// Future, more discriminative signals (not snapshot-derivable today): per-row
// cross-topic nearest-neighbour density, and a persisted cross-topic URL-
// collision counter (URL is globally unique, so collisions aren't in a snapshot).

import type { ResourceStatus, DecompositionStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { relatedTopics } from '../src/types/resource';

const MIN_ROWS = 3; // ignore topics too small to characterize
const OVERLAP_FLAG = 0.2; // concept overlap coefficient above which to flag for review
const STATUSES: ResourceStatus[] = ['active', 'pending_review'];
const DECOMP: DecompositionStatus = 'atomic';
const ATOMIC = { decompositionStatus: DECOMP, status: { in: STATUSES } };

function overlap(a: Set<string>, b: Set<string>): { coef: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { coef: 0, shared: 0 };
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return { coef: inter / Math.min(a.size, b.size), shared: inter };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function centroid(topic: string): Promise<number[] | null> {
  const rows = await prisma.$queryRaw<{ v: string }[]>`
    SELECT embedding::text AS v FROM "Resource"
    WHERE topic = ${topic} AND "decompositionStatus"::text = 'atomic'
      AND status::text IN ('active', 'pending_review') AND embedding IS NOT NULL`;
  if (rows.length === 0) return null;
  const sum = (JSON.parse(rows[0].v) as number[]).slice();
  for (let r = 1; r < rows.length; r++) {
    const vec = JSON.parse(rows[r].v) as number[];
    for (let i = 0; i < sum.length; i++) sum[i] += vec[i];
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= rows.length;
  return sum;
}

async function main() {
  const grp = await prisma.resource.groupBy({ by: ['topic'], where: ATOMIC, _count: { _all: true } });
  const counts = new Map(grp.map((g) => [g.topic, g._count._all]));
  const topics = grp.filter((g) => g._count._all >= MIN_ROWS).map((g) => g.topic).sort();
  console.log(`[audit] ${topics.length} topics with >= ${MIN_ROWS} atomic rows: ` +
    topics.map((t) => `${t}(${counts.get(t)})`).join(', '));

  const concepts = new Map<string, Set<string>>();
  const centroids = new Map<string, number[]>();
  for (const t of topics) {
    const rows = await prisma.resource.findMany({ where: { topic: t, ...ATOMIC }, select: { conceptsTaught: true } });
    const s = new Set<string>();
    for (const r of rows) for (const c of r.conceptsTaught) s.add(c);
    concepts.set(t, s);
    const c = await centroid(t);
    if (c) centroids.set(t, c);
  }

  const aliases = await prisma.topicAlias.findMany({ distinct: ['canonical'], select: { canonical: true, subject: true } });
  const subjectOf = new Map(aliases.map((a) => [a.canonical, a.subject]));
  const subj = (t: string) => subjectOf.get(t) ?? '?';

  type Pair = { a: string; b: string; coef: number; shared: number; cos: number; related: boolean; xsubj: boolean };
  const pairs: Pair[] = [];
  for (let i = 0; i < topics.length; i++) {
    for (let k = i + 1; k < topics.length; k++) {
      const a = topics[i];
      const b = topics[k];
      const { coef, shared } = overlap(concepts.get(a)!, concepts.get(b)!);
      const ca = centroids.get(a);
      const cb = centroids.get(b);
      const cos = ca && cb ? cosine(ca, cb) : 0;
      const sa = subjectOf.get(a);
      const sb = subjectOf.get(b);
      pairs.push({ a, b, coef, shared, cos, related: relatedTopics(a).includes(b), xsubj: Boolean(sa && sb && sa !== sb) });
    }
  }
  pairs.sort((x, y) => y.coef - x.coef || y.shared - x.shared);

  const fmt = (p: Pair) =>
    `${p.a} × ${p.b}`.padEnd(38) +
    `overlap=${p.coef.toFixed(3)}  shared=${String(p.shared).padStart(3)}  cos=${p.cos.toFixed(3)}  ` +
    `[${subj(p.a)}×${subj(p.b)}]` + (p.related ? '  (related)' : '') + (p.xsubj ? '  (cross-subject)' : '');

  console.log('\nALL PAIRS (by concept overlap coefficient):');
  for (const p of pairs) console.log('  ' + fmt(p));

  const candidates = pairs.filter((p) => !p.related && !p.xsubj && p.coef >= OVERLAP_FLAG);
  console.log(`\nCANDIDATE RELATIONS (unrelated, overlap >= ${OVERLAP_FLAG}): ${candidates.length}`);
  for (const p of candidates) console.log('  ⚠ ' + fmt(p));
  if (candidates.length === 0) console.log('  (none — no unrelated pair clears the concept-overlap bar; review the ranked list above for borderline cases)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
