// Read-only calibration for the topic-filing guardrail proposed in
// docs/topic-filing-plan.md (block T2). Makes no writes.
//
//   npx tsx --env-file=.env.local scripts/calibrate-topic-threshold.ts
//
// T2 proposes accepting a topic membership when the resource's embedding is
// within TOPIC_FILING_THRESHOLD cosine similarity of that topic's centroid.
// This script asks whether such a threshold exists at all, using the current
// library as (noisy) ground truth:
//
//   - POSITIVE  = similarity of a resource to its OWN topic's centroid,
//                 computed LEAVE-ONE-OUT (the row contributed to that centroid,
//                 so including it inflates the score — badly for small topics).
//   - NEGATIVE  = similarity of the same resource to every OTHER topic's
//                 centroid; the per-row MAX is the hard negative.
//
// Caveats, both material:
//   1. The labels are the current `Resource.topic`, which we know is partly
//      wrong — that's the defect this plan fixes. Mislabeled rows sit in the
//      positive set and depress its left tail. That is arguably the signal we
//      want (they SHOULD score low), but it means "accuracy" here is agreement
//      with the status quo, not correctness.
//   2. scripts/audit-topic-relations.ts already observed that a technical
//      corpus clusters tightly (topic-centroid pairs cosine ~0.6-0.85 even when
//      unrelated). If resource-to-centroid separation is similarly compressed,
//      the centroid guardrail is not viable as specified and T2 needs a
//      different instrument (per-row k-NN label density is the fallback).

import type { ResourceStatus } from '@prisma/client';
import { prisma } from '../src/lib/db';

const STATUSES: ResourceStatus[] = ['active', 'pending_review'];
// Topics smaller than this can't characterize a centroid; reported separately.
const MIN_MEMBERS = 5;

type Row = { id: string; topic: string; title: string; v: Float64Array };

function parseVec(text: string): Float64Array {
  const parts = text.slice(1, -1).split(',');
  const out = new Float64Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

function normalize(v: Float64Array): Float64Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Both inputs must already be unit vectors: cosine reduces to the dot product.
function dot(a: Float64Array, b: Float64Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : '  -  ';
}

async function main() {
  const raw = await prisma.$queryRaw<{ id: string; topic: string; title: string; v: string }[]>`
    SELECT id, topic, title, embedding::text AS v
    FROM "Resource"
    WHERE embedding IS NOT NULL
      AND "decompositionStatus"::text = 'atomic'
      AND status::text IN ('active', 'pending_review')
      AND origin::text <> 'generated'`;

  const rows: Row[] = raw.map((r) => ({
    id: r.id,
    topic: r.topic,
    title: r.title,
    v: normalize(parseVec(r.v)),
  }));
  if (rows.length === 0) {
    console.log('no embedded rows — run scripts/embed-resources.ts first');
    return;
  }
  const dim = rows[0].v.length;

  // Per-topic sum vectors (unnormalized) + counts.
  const sums = new Map<string, Float64Array>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    let s = sums.get(r.topic);
    if (!s) {
      s = new Float64Array(dim);
      sums.set(r.topic, s);
    }
    for (let i = 0; i < dim; i++) s[i] += r.v[i];
    counts.set(r.topic, (counts.get(r.topic) ?? 0) + 1);
  }

  const topics = [...counts.keys()].sort();
  const big = topics.filter((t) => (counts.get(t) ?? 0) >= MIN_MEMBERS);
  const centroids = new Map<string, Float64Array>();
  for (const t of topics) centroids.set(t, normalize(sums.get(t)!));

  console.log(`rows=${rows.length} dim=${dim} topics=${topics.length} (>=${MIN_MEMBERS} members: ${big.length})`);
  console.log();

  // ---- per-row scores -----------------------------------------------------
  type Scored = {
    row: Row;
    own: number; // leave-one-out similarity to own centroid
    bestOther: string;
    bestOtherSim: number;
    margin: number; // own - bestOtherSim
  };
  const scored: Scored[] = [];
  const perTopicOwn = new Map<string, number[]>();

  for (const r of rows) {
    const n = counts.get(r.topic)!;
    let own = NaN;
    if (n >= 2) {
      // Leave-one-out centroid: (sum - v) / (n - 1), then normalized.
      const s = sums.get(r.topic)!;
      const loo = new Float64Array(dim);
      for (let i = 0; i < dim; i++) loo[i] = s[i] - r.v[i];
      own = dot(r.v, normalize(loo));
    }
    let bestOther = '';
    let bestOtherSim = -Infinity;
    for (const t of big) {
      if (t === r.topic) continue;
      const sim = dot(r.v, centroids.get(t)!);
      if (sim > bestOtherSim) {
        bestOtherSim = sim;
        bestOther = t;
      }
    }
    scored.push({ row: r, own, bestOther, bestOtherSim, margin: own - bestOtherSim });
    if (Number.isFinite(own)) {
      const arr = perTopicOwn.get(r.topic) ?? [];
      arr.push(own);
      perTopicOwn.set(r.topic, arr);
    }
  }

  // ---- distributions ------------------------------------------------------
  const pos = scored.map((s) => s.own).filter(Number.isFinite).sort((a, b) => a - b);
  const negMax = scored.map((s) => s.bestOtherSim).filter(Number.isFinite).sort((a, b) => a - b);

  console.log('DISTRIBUTIONS (cosine similarity)');
  console.log('                       p05    p10    p25    p50    p75    p90    p95   mean');
  const line = (label: string, xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `${label.padEnd(20)} ${[0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
        .map((q) => fmt(quantile(xs, q)))
        .join('  ')}  ${fmt(mean)}`,
    );
  };
  line('own topic (LOO)', pos);
  line('best OTHER topic', negMax);
  console.log();

  // ---- separation ---------------------------------------------------------
  // Top-1 agreement: would nearest-centroid reproduce the current label?
  const comparable = scored.filter((s) => Number.isFinite(s.own) && Number.isFinite(s.bestOtherSim));
  const top1 = comparable.filter((s) => s.margin > 0).length;
  console.log(
    `TOP-1 AGREEMENT: nearest centroid == current topic for ${top1}/${comparable.length} ` +
      `(${((100 * top1) / comparable.length).toFixed(1)}%)`,
  );
  console.log();

  // Threshold sweep. TPR = fraction of correctly-labeled rows admitted;
  // FPR = fraction of rows a WRONG topic's centroid would also admit.
  console.log('THRESHOLD SWEEP (t = accept membership when similarity >= t)');
  console.log('   t     TPR(own)   FPR(other)   Youden J');
  let bestT = 0;
  let bestJ = -Infinity;
  for (let t = 0.3; t <= 0.95001; t += 0.025) {
    const tpr = pos.filter((x) => x >= t).length / pos.length;
    const fpr = negMax.filter((x) => x >= t).length / negMax.length;
    const j = tpr - fpr;
    if (j > bestJ) {
      bestJ = j;
      bestT = t;
    }
    console.log(`  ${t.toFixed(3)}   ${fmt(tpr)}      ${fmt(fpr)}       ${fmt(j)}`);
  }
  console.log();
  console.log(`best Youden J = ${fmt(bestJ)} at t = ${bestT.toFixed(3)}`);
  console.log();

  // ---- per-topic ----------------------------------------------------------
  console.log('PER-TOPIC own-centroid similarity (leave-one-out)');
  console.log('topic                              n     p10    p50    p90   mean');
  for (const t of topics) {
    const xs = (perTopicOwn.get(t) ?? []).slice().sort((a, b) => a - b);
    if (xs.length === 0) {
      console.log(`${t.padEnd(34)} ${String(counts.get(t)).padStart(4)}   (too small)`);
      continue;
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `${t.padEnd(34)} ${String(xs.length).padStart(4)}  ` +
        `${fmt(quantile(xs, 0.1))}  ${fmt(quantile(xs, 0.5))}  ${fmt(quantile(xs, 0.9))}  ${fmt(mean)}`,
    );
  }
  console.log();

  // ---- worst-scoring rows: what a threshold would actually park ------------
  console.log('WORST 15 BY OWN-CENTROID SIMILARITY (candidates a guardrail would park)');
  const worst = comparable.slice().sort((a, b) => a.own - b.own).slice(0, 15);
  for (const s of worst) {
    console.log(
      `  ${fmt(s.own)}  [${s.row.topic}]  ${s.row.title.slice(0, 58)}` +
        `   -> nearest: ${s.bestOther} (${fmt(s.bestOtherSim)})`,
    );
  }
  console.log();

  // ---- instrument 2: relative margin --------------------------------------
  // An ABSOLUTE threshold conflates "is this about topic X" with "how tight is
  // topic X's cluster". The relative form asks the discriminating question:
  // does any other centroid claim this row more strongly than its own?
  const margins = comparable.map((s) => s.margin).sort((a, b) => a - b);
  console.log('INSTRUMENT 2 — RELATIVE MARGIN (own - bestOther)');
  console.log('                       p05    p10    p25    p50    p75    p90    p95   mean');
  line('margin', margins);
  console.log();
  console.log('  delta   flagged(margin < -delta)   share');
  for (const d of [0.0, 0.02, 0.05, 0.075, 0.1, 0.15, 0.2]) {
    const n = margins.filter((m) => m < -d).length;
    console.log(
      `  ${d.toFixed(3)}   ${String(n).padStart(6)}                   ${((100 * n) / margins.length).toFixed(1)}%`,
    );
  }
  console.log();

  // ---- instrument 3: k-NN label purity ------------------------------------
  // The fallback named in the header: instead of a cluster mean, ask what the
  // row's actual nearest neighbours are filed as. Robust to non-spherical /
  // multi-modal topics, which is what a mean vector handles badly.
  const K = 10;
  const purity: number[] = [];
  const knnBest = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const best: { sim: number; topic: string }[] = [];
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      const sim = dot(rows[i].v, rows[j].v);
      if (best.length < K) {
        best.push({ sim, topic: rows[j].topic });
        if (best.length === K) best.sort((a, b) => a.sim - b.sim);
      } else if (sim > best[0].sim) {
        best[0] = { sim, topic: rows[j].topic };
        best.sort((a, b) => a.sim - b.sim);
      }
    }
    const tally = new Map<string, number>();
    for (const b of best) tally.set(b.topic, (tally.get(b.topic) ?? 0) + 1);
    purity.push((tally.get(rows[i].topic) ?? 0) / K);
    let top = '';
    let topN = -1;
    for (const [t, n] of tally) if (n > topN) { topN = n; top = t; }
    knnBest.set(rows[i].id, top);
  }
  const knnAgree = rows.filter((r) => knnBest.get(r.id) === r.topic).length;
  const sortedPurity = purity.slice().sort((a, b) => a - b);
  console.log(`INSTRUMENT 3 — k-NN LABEL PURITY (k=${K})`);
  console.log(
    `  plurality neighbour label == current topic for ${knnAgree}/${rows.length} ` +
      `(${((100 * knnAgree) / rows.length).toFixed(1)}%)`,
  );
  console.log('                       p05    p10    p25    p50    p75    p90    p95   mean');
  line('own-label purity', sortedPurity);
  console.log();

  // ---- the motivating case ------------------------------------------------
  // The Khan Academy "Algebra 1: Functions" leaves, filed under
  // discrete-mathematics because that was the topic being built. Would the
  // guardrail have caught them?
  const motivating = comparable.filter((s) => s.row.id in motivatingIds);
  if (motivating.length > 0) {
    const xs = motivating.map((s) => s.own).sort((a, b) => a - b);
    const below = (t: number) => xs.filter((x) => x < t).length;
    console.log(`MOTIVATING CASE — Khan "Functions" leaves filed under discrete-mathematics (n=${xs.length})`);
    console.log(
      `  own-centroid sim: p10=${fmt(quantile(xs, 0.1))} p50=${fmt(quantile(xs, 0.5))} ` +
        `p90=${fmt(quantile(xs, 0.9))}`,
    );
    console.log(
      `  would be parked at t=${bestT.toFixed(3)}: ${below(bestT)}/${xs.length}` +
        `   | library-wide park rate at that t: ${((100 * pos.filter((x) => x < bestT).length) / pos.length).toFixed(1)}%`,
    );
    const nearest = new Map<string, number>();
    for (const s of motivating) nearest.set(s.bestOther, (nearest.get(s.bestOther) ?? 0) + 1);
    console.log(
      `  nearest OTHER centroid: ${[...nearest.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(' ')}`,
    );
    const ms = motivating.map((s) => s.margin).sort((a, b) => a - b);
    console.log(
      `  margin: p10=${fmt(quantile(ms, 0.1))} p50=${fmt(quantile(ms, 0.5))} p90=${fmt(quantile(ms, 0.9))}` +
        `  | flagged at delta=0.0: ${ms.filter((m) => m < 0).length}/${ms.length}`,
    );
  }
}

// Resolved before main() so the filter above stays a cheap lookup.
const motivatingIds: Record<string, true> = {};
async function loadMotivating() {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE s AS (
      SELECT id FROM "Resource" WHERE id = 'cmrd4rot5007im5m5xf01ijgw'
      UNION ALL SELECT r.id FROM "Resource" r JOIN s ON r."parentResourceId" = s.id
    ) SELECT id FROM s`;
  for (const { id } of ids) motivatingIds[id] = true;
}

loadMotivating()
  .then(main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
