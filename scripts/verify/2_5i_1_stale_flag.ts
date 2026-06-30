// Block 2.5i-1 verify: the bank-staleness signal — markBankStale (guard + reason +
// no-downgrade) and the discovery surface (GET worklist includes stale banks with a
// `reason`; PATCH clears the flag). HTTP parts need the dev server (npm run dev,
// DEV_AUTH=1). Own throwaway Path; cleans up at the end.
import { prisma } from '@/lib/db';
import { markBankStale, staleReasonFor } from '@/lib/agents/content/mark-bank-stale';
import { BankStaleReason } from '@prisma/client';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000/api/playground/concept-banks';
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const j = (r: Response) => r.json();
const reasonOf = async (id: string) =>
  (await prisma.concept.findUniqueOrThrow({ where: { id }, select: { bankStaleReason: true } })).bankStaleReason;

async function main() {
  // staleReasonFor — the narrowed trigger, pure mapping.
  assert(staleReasonFor({ change: 'added', role: 'teaches' }) === BankStaleReason.primary_changed, 'add teaches → primary_changed');
  assert(staleReasonFor({ change: 'added', role: 'uses' }) === null, 'add non-teaches → no flag');
  assert(staleReasonFor({ change: 'removed', role: 'teaches' }) === BankStaleReason.primary_changed, 'remove teaches → primary_changed');
  assert(staleReasonFor({ change: 'removed', role: 'uses' }) === BankStaleReason.resource_removed, 'remove non-teaches → resource_removed');
  console.log('staleReasonFor ✓ — narrowed trigger maps correctly');

  await prisma.path.deleteMany({ where: { topic: '__verify_2_5i_1__' } });
  const path = await prisma.path.create({ data: { topic: '__verify_2_5i_1__', status: 'spine_ready' } });
  const mk = async (slug: string, reviewed: boolean) =>
    (await prisma.concept.create({
      data: { pathId: path.id, slug, title: slug, membership: 'spine', bankReviewed: reviewed },
      select: { id: true },
    })).id;

  const unreviewed = await mk('unreviewed-concept', false);
  const reviewed = await mk('reviewed-concept', true);

  try {
    // GUARD — markBankStale skips an unreviewed concept, flags a reviewed one.
    await prisma.$transaction((tx) => markBankStale(tx, [unreviewed, reviewed], BankStaleReason.resource_removed));
    assert((await reasonOf(unreviewed)) === null, 'unreviewed concept must NOT be flagged (guard)');
    assert((await reasonOf(reviewed)) === BankStaleReason.resource_removed, 'reviewed concept flagged resource_removed');
    console.log('markBankStale ✓ — guard skips unreviewed, flags reviewed');

    // NO-DOWNGRADE — primary_changed overwrites resource_removed...
    await prisma.$transaction((tx) => markBankStale(tx, [reviewed], BankStaleReason.primary_changed));
    assert((await reasonOf(reviewed)) === BankStaleReason.primary_changed, 'primary_changed must overwrite resource_removed');
    // ...but a later resource_removed must NOT clobber the standing primary_changed.
    await prisma.$transaction((tx) => markBankStale(tx, [reviewed], BankStaleReason.resource_removed));
    assert((await reasonOf(reviewed)) === BankStaleReason.primary_changed, 'resource_removed must not downgrade primary_changed');
    console.log('markBankStale ✓ — no-downgrade (primary_changed sticks)');

    // GET worklist — the reviewed-but-stale concept rejoins it with its reason; the
    // unreviewed one shows as 'unreviewed'.
    const list = await j(await fetch(`${BASE}?pathId=${path.id}`));
    const byId = Object.fromEntries(list.concepts.map((c: { conceptId: string }) => [c.conceptId, c]));
    assert(byId[reviewed]?.reason === 'primary_changed', 'GET: stale reviewed concept surfaces reason=primary_changed');
    assert(byId[reviewed]?.bankStaleReason === 'primary_changed', 'GET: exposes bankStaleReason field');
    assert(byId[unreviewed]?.reason === 'unreviewed', 'GET: never-reviewed concept reason=unreviewed');
    console.log('GET ✓ — stale bank rejoins worklist with reason; unreviewed shows reason=unreviewed');

    // PATCH mark-reviewed — clears the flag, drops it off the worklist.
    const patch = await j(await fetch(BASE, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conceptId: reviewed }) }));
    assert(patch.bankStaleReason === null, 'PATCH should null bankStaleReason');
    const after = await j(await fetch(`${BASE}?pathId=${path.id}`));
    assert(!after.concepts.some((c: { conceptId: string }) => c.conceptId === reviewed), 'cleared concept drops off worklist');
    console.log('PATCH ✓ — clears stale flag, drops off worklist');

    console.log('\n✅ block 2.5i-1 verified');
  } finally {
    await prisma.path.delete({ where: { id: path.id } });
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
