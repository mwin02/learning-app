// Throwaway verification for Phase 2g-1 (scope-aware duration ranking in
// selectAttachable / capCandidates).
//   npx tsx --env-file=.env.local scripts/verify-scope-ranking.ts
//
// Pure fixtures — no DB. Asserts duration only ORDERS (never gates): an over-long
// resource is demoted so a better-scoped alternative outranks it WHEN one exists, but
// the over-long one survives as the lone candidate and a qualifying primary is never
// unseated. on-ramp uses the strict regime; other concepts the soft default; rows with
// no durationMin are unpenalized.

import { selectAttachable, capCandidates } from '../src/lib/agents/map/attach-candidates';
import { MAP_DURATION_RANKING } from '../src/lib/config';
import { ConceptResourceRole } from '@prisma/client';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}
type C = { resourceId: string; role: ConceptResourceRole; coverageScore: number; trustScore?: number; durationMin?: number };
const teach = (id: string, coverageScore: number, durationMin?: number, trustScore?: number): C =>
  ({ resourceId: id, role: ConceptResourceRole.teaches, coverageScore, durationMin, trustScore });
const uses = (id: string, coverageScore: number, durationMin?: number, trustScore?: number): C =>
  ({ resourceId: id, role: ConceptResourceRole.uses, coverageScore, durationMin, trustScore });
const ids = (cs: C[]) => cs.map((c) => c.resourceId);

console.log('\n── default regime: a 3h chapter is demoted below a scoped lesson ──');
{
  // The calculus case: a high-coverage 180-min chapter page vs a slightly-lower-
  // coverage 30-min lesson scoped to the concept. Duration should flip the order.
  const out = capCandidates([teach('chapter-3h', 0.9, 180), teach('scoped-30m', 0.75, 30)]);
  check('scoped 30m primary outranks the over-long 3h chapter', ids(out)[0] === 'scoped-30m', ids(out));
}

console.log('\n── duration only ORDERS — the lone long candidate still survives ──');
{
  const out = selectAttachable([teach('only-3h', 0.9, 180)]);
  check('an over-long resource is kept when it is the only candidate', ids(out).includes('only-3h'), ids(out));
}

console.log('\n── modest overrun is NOT over-penalized (default regime) ──────');
{
  // A great 90-min comprehensive lecture should still beat a shallow 10-min video.
  const out = capCandidates([teach('lecture-90m', 0.95, 90), teach('shallow-10m', 0.5, 10)]);
  check('strong 90m lesson still outranks a shallow 10m one', ids(out)[0] === 'lecture-90m', ids(out));
}

console.log('\n── on-ramp regime is STRICTER than default ───────────────────');
{
  // A 120-min "full course" vs a 15-min orientation. Under the on-ramp regime the
  // short orientation wins; the strict curve discounts the 2h course hard.
  const cands = [teach('full-course-2h', 0.95, 120), teach('orientation-15m', 0.7, 15)];
  const onRamp = capCandidates(cands, { isOnRamp: true });
  check('on-ramp: short orientation wins the primary slot', ids(onRamp)[0] === 'orientation-15m', ids(onRamp));
  // Same inputs under the default regime: 120 min is under the default span tail, so
  // the high-coverage course is NOT demoted enough to lose — proving the regimes differ.
  const dflt = capCandidates(cands);
  check('default: the same 2h course is NOT demoted below the 15m one', ids(dflt)[0] === 'full-course-2h', ids(dflt));
}

console.log('\n── duration never GATES: sub-floor coverage still dropped ────');
{
  // A perfectly-short (factor 1) but irrelevant candidate is still dropped by the
  // coverage floor; a long but relevant one is kept (demoted, not gated).
  const out = selectAttachable([teach('relevant-long', 0.7, 240), teach('short-irrelevant', 0.2, 5)]);
  check('sub-floor coverage dropped regardless of short duration', !ids(out).includes('short-irrelevant'), ids(out));
  check('over-long but relevant candidate kept', ids(out).includes('relevant-long'), ids(out));
}

console.log('\n── qualifying primary survives the cap despite duration demotion ──');
{
  // 6 short high-coverage `uses` + one qualifying `teaches` that is long (heavily
  // duration-demoted). The only primary must not be evicted by the cap.
  const fillers = Array.from({ length: 6 }, (_, i) => uses(`f${i}`, 0.9, 10));
  const primary = teach('primary-long', 0.6, 200);
  const out = capCandidates([...fillers, primary]);
  check('the only qualifying primary kept despite being duration-demoted', ids(out).includes('primary-long'), ids(out));
}

console.log('\n── no durationMin carried → pure coverage order (back-compat) ──');
{
  const out = capCandidates([teach('a', 0.5), teach('b', 0.9), teach('c', 0.7)]);
  check('rows without durationMin sort by coverage desc', ids(out).join(',') === 'b,c,a', ids(out));
}

console.log('\n── factor curve sanity (default regime) ──────────────────────');
{
  const { targetMin, spanMin, floor } = MAP_DURATION_RANKING.default;
  // At/under target → no demotion: a target-length teach beats a longer one of equal coverage.
  const out = capCandidates([teach('at-target', 0.8, targetMin), teach('past-span', 0.8, targetMin + spanMin)]);
  check('equal coverage: at-target outranks a fully-decayed long one', ids(out)[0] === 'at-target', ids(out));
  check('floor is in (0,1)', floor > 0 && floor < 1, floor);
}

console.log(failures === 0 ? '\n✅ all scope-ranking checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
