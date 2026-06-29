// Throwaway verification for Phase 2g-5 (enforceGeneratedPrimary): the generated
// on-ramp lesson is promoted to its lesson's primary, ordered first.
//   npx tsx scripts/verify-onramp-primary.ts
//
// Pure fixtures — no DB. Asserts a generated candidate becomes mandatory[0] (pulled
// from the optional pool if needed), other mandatory resources are preserved after it,
// and lessons without a generated candidate (and the empty-set case) are untouched.

import { enforceGeneratedPrimary } from '../src/lib/agents/track/build-track';
import type { ValidatedLesson } from '../src/lib/agents/track/validate-composition';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, detail ?? ''); }
}

const lesson = (over: Partial<ValidatedLesson>): ValidatedLesson => ({
  conceptSlugs: ['c'], timeWeight: 'standard' as ValidatedLesson['timeWeight'],
  mandatoryResourceIds: [], optionalResourceIds: [], title: 't', summary: 's',
  isFrontier: false, masteryRelevant: false, ...over,
});

console.log('\n── generated in the OPTIONAL pool → promoted to mandatory[0] ──');
{
  const [out] = enforceGeneratedPrimary([lesson({ mandatoryResourceIds: ['sourced'], optionalResourceIds: ['gen', 'other'] })], new Set(['gen']));
  check('gen becomes mandatory[0]', out.mandatoryResourceIds[0] === 'gen', out.mandatoryResourceIds);
  check('prior mandatory preserved after it', out.mandatoryResourceIds.includes('sourced'), out.mandatoryResourceIds);
  check('gen removed from optional', !out.optionalResourceIds.includes('gen'), out.optionalResourceIds);
  check('other optional kept', out.optionalResourceIds.includes('other'), out.optionalResourceIds);
}

console.log('\n── generated already mandatory but NOT first → moved to front ──');
{
  const [out] = enforceGeneratedPrimary([lesson({ mandatoryResourceIds: ['sourced', 'gen'] })], new Set(['gen']));
  check('gen moved to mandatory[0]', out.mandatoryResourceIds[0] === 'gen', out.mandatoryResourceIds);
  check('no duplication', out.mandatoryResourceIds.filter((i) => i === 'gen').length === 1, out.mandatoryResourceIds);
}

console.log('\n── generated already leading → unchanged (no-op) ──');
{
  const input = [lesson({ mandatoryResourceIds: ['gen', 'sourced'] })];
  const out = enforceGeneratedPrimary(input, new Set(['gen']));
  check('returns the same lesson object (untouched)', out[0] === input[0]);
}

console.log('\n── merged on-ramp + X lesson: X stays a secondary primary ──');
{
  const [out] = enforceGeneratedPrimary([lesson({ conceptSlugs: ['on-ramp', 'jsx'], mandatoryResourceIds: ['jsx-res'], optionalResourceIds: ['gen'] })], new Set(['gen']));
  check('order is [gen, jsx-res]', JSON.stringify(out.mandatoryResourceIds) === JSON.stringify(['gen', 'jsx-res']), out.mandatoryResourceIds);
}

console.log('\n── no generated candidate / empty set → untouched ──');
{
  const input = [lesson({ mandatoryResourceIds: ['a'], optionalResourceIds: ['b'] })];
  check('lesson without a gen id is unchanged', enforceGeneratedPrimary(input, new Set(['gen']))[0] === input[0]);
  check('empty generatedIds returns input as-is', enforceGeneratedPrimary(input, new Set()) === input);
}

console.log(failures === 0 ? '\n✅ all on-ramp-primary checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
