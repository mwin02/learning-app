// Topic filing T4e — the §1 STRETCH, closed at zero LLM cost.
//
//   npx tsx --env-file=.env.local scripts/rescore-inherited-relevance.ts [--apply] [--limit N]
//
// T1's backfill wrote one membership per existing Resource with `relevance = 1.0`, a
// PLACEHOLDER meaning "unknown" — not "certain". That lie is why T1 §3 had to specify an
// origin-aware `minRelevance`: a flat bar would gate measured classifier memberships while
// waving through unverified inherited ones. T4a re-scored the 1,152 rows filed with the
// classifier skipped; the remaining `inherited` rows (777 as of 2026-07-27) kept the
// placeholder. This pass replaces it with measured k-NN purity.
//
// ── WHY THIS NEEDS NO CLASSIFIER, AND SO NO OPS BUDGET ──────────────────────────────
//
// The plan filed this under T4a's driver ("`scripts/reclassify-topics.ts --all --apply`"),
// which costs an LLM call per batch. That is the wrong tool. `reclassify-topics` pays for
// the classifier in order to PROPOSE topics — and per As-built T4a item 5 the reclassifier
// never refiles, so for these rows the proposals can only ever land as contested
// secondaries. What §1 actually asks for is one number: the measured worth of the
// membership the row ALREADY has, which is `purity(neighbours, currentTopic)` — a pure
// embedding computation over an index we already maintain. Zero model calls.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────────
//
// It never contests, refiles, or touches `isPrimary` / `Resource.topic` / `Resource.status`
// — only `relevance` moves. A low purity here is NOT treated as doubt, for a reason worth
// keeping: T4a contested rows on the strength of a classifier proposal DISAGREEING with the
// current label, which is a strictly stronger instrument than "the neighbourhood is mixed".
// Contesting on purity alone would apply a weaker test than the backlog got, and would grow
// a review queue that (as of T4e) still has no drainer. Low scorers are REPORTED instead, as
// an input to that queue when someone builds it.
//
// ── THE PROPERTY THIS ESTABLISHES ───────────────────────────────────────────────────
//
// Afterwards, every membership with a measurable neighbourhood carries a MEASURED
// relevance. That does more than remove a lie: it dissolves the reason `minRelevance` had
// to be origin-aware in the first place. The residue is rows k-NN cannot read at all
// (no embedding, or not atomic) — they keep 1.0, they are counted below, and they are the
// only reason a future gate still needs an escape hatch.

import { knnNeighbourTopicsOf, purity } from '../src/lib/curation/topic-knn';
import { settleMembership, checkMembershipInvariants } from '../src/lib/curation/resource-topics';
import { prisma } from '../src/lib/db';

// Measurements run concurrently — each is one indexed pgvector lookup, no model call and
// no write, so the only limit is connection pressure on the dev DB.
const CONCURRENCY = 8;
// Reported, never acted on: the low tail a review drain would want to see first.
const LOW_PURITY = 0.4;

type Target = { resourceId: string; topic: string; contested: boolean; title: string };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

  // Every membership still carrying the T1 placeholder. Ordered for a stable, resumable
  // run: re-running after a crash re-measures rows already written, which is harmless
  // because the measurement is idempotent (nothing here changes what the neighbours say).
  const targets = await prisma.$queryRaw<Target[]>`
    SELECT rt."resourceId", rt.topic, rt.contested, r.title
    FROM "ResourceTopic" rt
    JOIN "Resource" r ON r.id = rt."resourceId"
    WHERE rt.origin::text = 'inherited'
    ORDER BY rt."resourceId"
  `;
  const slice = limit ? targets.slice(0, limit) : targets;

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${slice.length} \`inherited\` memberships\n`);

  const measured: { t: Target; relevance: number }[] = [];
  const unmeasurable: Target[] = [];

  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const batch = slice.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => {
        // Leave-one-out by construction: knnNeighbourTopicsOf excludes the row itself,
        // which matters here because every target is already in the table and would
        // otherwise be its own nearest neighbour, voting for its own label.
        const neighbours = await knnNeighbourTopicsOf(t.resourceId);
        return { t, neighbours };
      }),
    );
    for (const { t, neighbours } of results) {
      // No neighbours = no reading. `purity` would return 0 for an empty list, which is
      // indistinguishable from "measured, and nothing agrees" — the exact conflation that
      // would turn a missing embedding into a maximally-distrusted membership.
      if (neighbours.length === 0) {
        unmeasurable.push(t);
        continue;
      }
      measured.push({ t, relevance: purity(neighbours, t.topic) });
    }
    process.stdout.write(`\r  measured ${Math.min(i + CONCURRENCY, slice.length)}/${slice.length}`);
  }
  console.log('\n');

  const scores = measured.map((m) => m.relevance).sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  console.log('MEASURED PURITY');
  console.log(
    `  n=${scores.length}  p10=${quantile(scores, 0.1).toFixed(2)}  ` +
      `p50=${quantile(scores, 0.5).toFixed(2)}  p90=${quantile(scores, 0.9).toFixed(2)}  ` +
      `mean=${mean.toFixed(2)}`,
  );
  console.log(`  unmeasurable (no embedded neighbourhood, keep 1.0): ${unmeasurable.length}`);
  console.log();

  const byTopic = new Map<string, number[]>();
  for (const m of measured) byTopic.set(m.t.topic, [...(byTopic.get(m.t.topic) ?? []), m.relevance]);
  console.log('PER-SHELF');
  console.log('topic                              n    p50   mean   below 0.4');
  for (const [topic, xs] of [...byTopic].sort(
    (a, b) => a[1].reduce((x, y) => x + y, 0) / a[1].length - b[1].reduce((x, y) => x + y, 0) / b[1].length,
  )) {
    const s = xs.slice().sort((a, b) => a - b);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `${topic.padEnd(34)} ${String(xs.length).padStart(3)}   ${quantile(s, 0.5).toFixed(2)}   ` +
        `${m.toFixed(2)}   ${String(xs.filter((x) => x < LOW_PURITY).length).padStart(4)}`,
    );
  }
  console.log();

  const low = measured
    .filter((m) => m.relevance < LOW_PURITY)
    .sort((a, b) => a.relevance - b.relevance);
  console.log(`LOW SCORERS (< ${LOW_PURITY}) — review-queue input, NOT contested by this pass: ${low.length}`);
  for (const m of low.slice(0, 15)) {
    console.log(`  ${m.relevance.toFixed(2)}  [${m.t.topic}]  ${m.t.title.slice(0, 62)}`);
  }
  console.log();

  if (!apply) {
    console.log('dry run — nothing written. Re-run with --apply.');
    return;
  }

  let written = 0;
  for (let i = 0; i < measured.length; i += CONCURRENCY) {
    const batch = measured.slice(i, i + CONCURRENCY);
    await Promise.all(
      // `contested` is passed through UNCHANGED — settleMembership writes both fields, and
      // this pass has no opinion on doubt (see the header). Every inherited row is
      // uncontested today; reading it rather than hardcoding false keeps that an
      // observation instead of an assumption.
      batch.map((m) =>
        settleMembership(m.t.resourceId, m.t.topic, {
          relevance: m.relevance,
          contested: m.t.contested,
        }),
      ),
    );
    written += batch.length;
    process.stdout.write(`\r  wrote ${written}/${measured.length}`);
  }
  console.log('\n');

  const inv = await checkMembershipInvariants();
  console.log('MEMBERSHIP INVARIANTS', inv);
  if (inv.noMembership || inv.badPrimaryCount || inv.mirrorDrift) {
    console.error('⚠️  invariant violation — investigate before proceeding');
    process.exitCode = 1;
  }

  // ⚠️ A measured purity of exactly 1.0 (a unanimous neighbourhood) is INDISTINGUISHABLE
  // in the column from T1's placeholder 1.0 — so "count rows at 1.0" cannot verify this
  // pass, and reporting it as leftover placeholders would be a lie. The only sound check
  // is coverage: every inherited membership was either measured or explicitly counted as
  // unmeasurable.
  const [{ c: total }] = await prisma.$queryRaw<{ c: number }[]>`
    SELECT count(*)::int AS c FROM "ResourceTopic" WHERE origin::text = 'inherited'`;
  const covered = measured.length + unmeasurable.length;
  console.log(
    `coverage: ${covered}/${total} inherited memberships accounted for ` +
      `(${measured.length} measured, ${unmeasurable.length} keep the placeholder)`,
  );
  console.log(
    `  of the measured, ${measured.filter((m) => m.relevance === 1).length} scored exactly 1.0 ` +
      `— a unanimous neighbourhood, not a placeholder`,
  );
  if (covered !== total) {
    console.error('⚠️  coverage gap — rows were added mid-run; re-run to pick them up');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
