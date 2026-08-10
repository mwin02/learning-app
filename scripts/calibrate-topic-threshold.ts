// Read-only calibration for the topic-filing guardrail proposed in
// topic-filing.md (block T2). Makes no writes.
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
//
// ── T4e (2026-07-27): TWO CORRECTIONS TO HOW THIS SCRIPT IS READ ────────────
//
// A. IT WAS SCORING THE WRONG TARGET. Everything above scores against the
//    scalar `Resource.topic`. Post-T1 that column is a denormalized MIRROR of
//    the primary membership, and the label of record is the `ResourceTopic`
//    SET. Scoring the mirror understates agreement by ~5 points, because a row
//    legitimately filed on two shelves is counted wrong whenever its
//    neighbours name the other one. The k-NN block below now reports all three
//    targets; ANY-membership is the one that matches the model T1 implements.
//
// B. AGREEMENT IS NOT COMPARABLE ACROSS RUNS WITH DIFFERENT VOCABULARIES, and
//    ours changed from 11 topics to 20 between the 2026-07-25 and 2026-07-27
//    runs (T4b seeded 6 shelves and minted 3). Splitting one shelf into two
//    adjacent shelves MECHANICALLY depresses purity: a `statistics` row's
//    neighbours are now half `probability-and-statistics`, which is right in
//    every sense that matters and still scores as a miss. The 2026-07-27 run
//    fell on every instrument for that reason, NOT because label noise rose —
//    against ANY-membership it in fact went 88.7% -> 89.4%.
//
//    So: the vocabulary size is printed in the header, and the disagreements
//    are broken out as a confusion table. Before concluding an instrument has
//    regressed, check whether the top confusions are sibling shelves that a
//    previous block deliberately created. Do NOT compare the headline number
//    to a run taken over a different vocabulary — re-derive both or neither.

import { prisma } from '../src/lib/db';
import { MIN_SECONDARY_PURITY } from '../src/lib/curation/topic-knn';

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

  // T4e (caveat A): the membership sets the k-NN block scores against. `all` is every
  // membership; `retrievable` applies T1's predicate (a primary always admits, a
  // secondary only when uncontested) so the third number answers the question a caller
  // actually cares about — "would a search for the neighbours' topic find this row?".
  const memberships = await prisma.$queryRaw<
    { resourceId: string; topic: string; isPrimary: boolean; contested: boolean }[]
  >`SELECT "resourceId", topic, "isPrimary", contested FROM "ResourceTopic"`;
  const allTopics = new Map<string, Set<string>>();
  const retrievableTopics = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!allTopics.has(m.resourceId)) allTopics.set(m.resourceId, new Set());
    allTopics.get(m.resourceId)!.add(m.topic);
    if (m.isPrimary || !m.contested) {
      if (!retrievableTopics.has(m.resourceId)) retrievableTopics.set(m.resourceId, new Set());
      retrievableTopics.get(m.resourceId)!.add(m.topic);
    }
  }

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

  // T4e (caveat B): vocabulary size is printed FIRST because it is the denominator that
  // makes agreement numbers comparable — or not — across runs.
  console.log(`rows=${rows.length} dim=${dim} topics=${topics.length} (>=${MIN_MEMBERS} members: ${big.length})`);
  console.log(
    `⚠️  agreement below is comparable only to runs over these same ${topics.length} topics ` +
      `— see caveat B in the header`,
  );
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
  // Confusion counts (caveat B) and the second-label distribution that calibrates
  // MIN_SECONDARY_PURITY — the share of neighbours held by the best NON-own label.
  const confusion = new Map<string, number>();
  const secondLabel: number[] = [];
  const rivalIsMember: number[] = [];
  let memberAgree = 0;
  let retrievableAgree = 0;
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
    // Sorted so ties break deterministically rather than on Map insertion order.
    for (const [t, n] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
      if (n > topN) { topN = n; top = t; }
    }
    knnBest.set(rows[i].id, top);

    const own = rows[i].topic;
    const mem = allTopics.get(rows[i].id) ?? new Set([own]);
    const retr = retrievableTopics.get(rows[i].id) ?? new Set([own]);
    if (mem.has(top)) memberAgree++;
    if (retr.has(top)) retrievableAgree++;
    if (top !== own) {
      const key = `${own} -> ${top}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
    // Best rival label's share, for the MIN_SECONDARY_PURITY sweep below. Whether that
    // rival is ALREADY a membership is tracked alongside the share, so the sweep can
    // report it per-bar rather than as one library-wide total.
    let rival = '';
    let rivalN = 0;
    for (const [t, n] of tally) if (t !== own && n > rivalN) { rivalN = n; rival = t; }
    if (rival) {
      secondLabel.push(rivalN / K);
      if (mem.has(rival)) rivalIsMember.push(rivalN / K);
    }
  }
  const knnAgree = rows.filter((r) => knnBest.get(r.id) === r.topic).length;
  const sortedPurity = purity.slice().sort((a, b) => a - b);
  const pct = (n: number) => `${n}/${rows.length} (${((100 * n) / rows.length).toFixed(1)}%)`;
  console.log(`INSTRUMENT 3 — k-NN LABEL PURITY (k=${K})`);
  console.log('  plurality neighbour label matches...');
  console.log(`    scalar Resource.topic        ${pct(knnAgree)}   (the pre-T4e number)`);
  console.log(`    ANY membership               ${pct(memberAgree)}   <- the T1 model; headline`);
  console.log(`    any RETRIEVABLE membership   ${pct(retrievableAgree)}`);
  console.log('                       p05    p10    p25    p50    p75    p90    p95   mean');
  line('own-label purity', sortedPurity);
  console.log();

  // Caveat B's evidence: if these are sibling shelves a previous block split apart, the
  // "disagreement" is vocabulary granularity, not label noise, and tightening the
  // guardrail in response would be a mistake.
  console.log('TOP CONFUSIONS (scalar disagreements — check for deliberately-split siblings)');
  for (const [pair, n] of [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${pair}`);
  }
  console.log();

  // MIN_SECONDARY_PURITY calibration (the plan's T4e question). The bar only bites on
  // rows the CLASSIFIER also proposed a second topic for, so compare the "clears bar"
  // column against how few are actually memberships today.
  const sortedSecond = secondLabel.slice().sort((a, b) => a - b);
  console.log(`SECOND-LABEL PURITY — best non-own neighbour label (n=${sortedSecond.length})`);
  console.log('                       p05    p10    p25    p50    p75    p90    p95   mean');
  line('rival-label share', sortedSecond);
  console.log('   bar    clears      share    already a membership');
  for (const bar of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const n = sortedSecond.filter((x) => x >= bar).length;
    const held = rivalIsMember.filter((x) => x >= bar).length;
    console.log(
      `  ${bar.toFixed(2)}   ${String(n).padStart(6)}    ${((100 * n) / sortedSecond.length).toFixed(1).padStart(5)}%` +
        `    ${String(held).padStart(6)}` +
        `${bar === MIN_SECONDARY_PURITY ? '   <- MIN_SECONDARY_PURITY today' : ''}`,
    );
  }
  // The gap between "clears" and "already a membership" is the finding: the BAR is not
  // what stops secondaries being written, the classifier's one-topic prompt rule is. A
  // topic only ever reaches this bar if the classifier proposed it in the first place.
  console.log();

  // ---- the motivating case ------------------------------------------------
  // The Khan Academy "Algebra 1: Functions" leaves, originally filed under
  // discrete-mathematics because that was the topic being built.
  //
  // ⚠️ T4e: this block is now a REGRESSION CHECK, not a detection test, and the
  // plan's §6 instruction to "check the Khan leaves have an algebra-ish topic
  // available" was aimed at the wrong mechanism. `algebra` was never the answer
  // — the leaves unanimously want `precalculus`, a curated TOPIC_SLUGS entry
  // that simply had an EMPTY POOL, so k-NN could not vouch for it and pre-T2b
  // the classifier was never asked. It was a SEEDING problem, and T4b's quorum
  // refile fixed it (49/49 refiled, relevance p50 0.8). What we watch for here
  // is the filing coming UNDONE: the leaves should now sit on their own shelf
  // with a positive margin and a low flag rate. A return to negative margins
  // means something re-broke the seeding, not that minting needs work.
  const motivating = comparable.filter((s) => s.row.id in motivatingIds);
  if (motivating.length > 0) {
    const xs = motivating.map((s) => s.own).sort((a, b) => a - b);
    const below = (t: number) => xs.filter((x) => x < t).length;
    const filed = new Map<string, number>();
    for (const s of motivating) filed.set(s.row.topic, (filed.get(s.row.topic) ?? 0) + 1);
    console.log(`MOTIVATING CASE — Khan "Functions" leaves (n=${xs.length})`);
    console.log(
      `  filed under: ${[...filed.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(' ')}`,
    );
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
