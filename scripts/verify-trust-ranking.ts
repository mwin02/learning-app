// Throwaway verification for Phase 2.5h block 2e (trustScore in selection ranking).
//   npx tsx --env-file=.env.local scripts/verify-trust-ranking.ts
//
// Pure fixtures — no DB. Asserts selectAttachable/capCandidates use the coverage+
// trust blend for ORDERING while coverage remains the only GATE: trust breaks ties,
// can flip a near-coverage-tie, but never admits a sub-floor candidate nor unseats a
// qualifying primary; rows without trust fall back to pure coverage.

import { selectAttachable, capCandidates } from '../src/lib/agents/map/attach-candidates';
import { ConceptResourceRole } from '@prisma/client';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}
type C = { resourceId: string; role: ConceptResourceRole; coverageScore: number; trustScore?: number };
const teach = (id: string, coverageScore: number, trustScore?: number): C => ({ resourceId: id, role: ConceptResourceRole.teaches, coverageScore, trustScore });
const uses = (id: string, coverageScore: number, trustScore?: number): C => ({ resourceId: id, role: ConceptResourceRole.uses, coverageScore, trustScore });
const ids = (cs: C[]) => cs.map((c) => c.resourceId);

console.log('\n── trust breaks a coverage tie ────────────────────────────────');
{
  const out = selectAttachable([teach('lo', 0.8, 0.5), teach('hi', 0.8, 0.95)]);
  check('equal coverage → higher trust ranks first', ids(out)[0] === 'hi', ids(out));
}

console.log('\n── trust can flip a near-coverage tie ─────────────────────────');
{
  // cov 0.60 / trust 0.95  → 0.705   vs   cov 0.65 / trust 0.40 → 0.575
  const out = selectAttachable([teach('lowcov-hitrust', 0.6, 0.95), teach('hicov-lotrust', 0.65, 0.4)]);
  check('a 0.05 coverage edge is overridden by much higher trust', ids(out)[0] === 'lowcov-hitrust', ids(out));
}

console.log('\n── coverage is still the only GATE ────────────────────────────');
{
  // high trust but sub-floor coverage (< MAP_ATTACH_MIN_COVERAGE 0.3) → dropped.
  const out = selectAttachable([teach('great', 0.7, 0.5), teach('irrelevant', 0.2, 0.99)]);
  check('sub-floor coverage dropped despite 0.99 trust', !ids(out).includes('irrelevant'), ids(out));
}

console.log('\n── qualifying primary still survives the cap ──────────────────');
{
  // 6 high-coverage high-trust `uses` (NOT primaries) + one modest qualifying
  // `teaches` primary (coverage ≥ 0.5) with low trust → the only primary must not be
  // evicted by the cap even though all 6 uses outrank it on selection score.
  const fillers = Array.from({ length: 6 }, (_, i) => uses(`f${i}`, 0.9, 0.95));
  const primary = teach('primary', 0.55, 0.2);
  const out = capCandidates([...fillers, primary]);
  check('the only qualifying primary kept within the cap despite low trust', ids(out).includes('primary'), ids(out));
}

console.log('\n── no trust carried → pure coverage order (back-compat) ───────');
{
  const out = capCandidates([teach('a', 0.5), teach('b', 0.9), teach('c', 0.7)]);
  check('rows without trustScore sort by coverage desc', ids(out).join(',') === 'b,c,a', ids(out));
}

console.log(failures === 0 ? '\n✅ all trust-ranking checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
