// Block 2.5i-2 verify: the live mutation sites flag a *reviewed* bank stale.
// Covers map-edit attach/detach (HTTP — needs dev server, DEV_AUTH=1) and
// pending-review reject (direct call). source-concept (remediation re-source) shares
// the same markBankStale helper and is left to 2_5i_1 + the guard; driving it needs
// the LLM judge/web-fallback. Own throwaway Path/Source; cleans up at the end.
import { prisma } from '@/lib/db';
import { applyPendingReview } from '@/lib/curation/pending-review';
import { BankStaleReason } from '@prisma/client';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000/api/playground';
const TAG = '__verify_2_5i_2__';
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const reasonOf = async (id: string) =>
  (await prisma.concept.findUniqueOrThrow({ where: { id }, select: { bankStaleReason: true } })).bankStaleReason;
const clearFlag = (id: string) => prisma.concept.update({ where: { id }, data: { bankStaleReason: null } });

async function main() {
  // Path first: it cascades Concepts + their ConceptResource links, which FK-reference
  // Resource — so resources can't be deleted until those links are gone.
  await prisma.path.deleteMany({ where: { topic: TAG } });
  await prisma.resource.deleteMany({ where: { topic: TAG } });
  await prisma.source.deleteMany({ where: { slug: TAG } });

  const path = await prisma.path.create({ data: { topic: TAG, status: 'spine_ready' } });
  const source = await prisma.source.create({ data: { slug: TAG, name: TAG, url: 'https://x.test', kind: 'community' } });
  const concept = (await prisma.concept.create({
    data: { pathId: path.id, slug: 'hooks-concept', title: 'Hooks Concept', membership: 'spine', bankReviewed: true },
    select: { id: true },
  })).id;
  const mkResource = async (n: number) =>
    (await prisma.resource.create({
      data: {
        slug: `${TAG}-${n}`, topic: TAG, title: `R${n}`, url: `https://x.test/${n}`, type: 'article',
        durationMin: 10, summary: 's', difficulty: 'beginner', status: 'active', decompositionStatus: 'atomic',
        sourceId: source.id,
      },
      select: { id: true },
    })).id;
  const rTeach = await mkResource(1);
  const rUses = await mkResource(2);
  const rDep = await mkResource(3);

  try {
    // map-edit attach (teaches) → primary_changed.
    await fetch(`${BASE}/map-edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attach_resource', conceptId: concept, resourceId: rTeach, role: 'teaches', coverageScore: 0.9 }),
    });
    assert((await reasonOf(concept)) === BankStaleReason.primary_changed, 'attach teaches → primary_changed');
    await clearFlag(concept);
    console.log('map-edit attach (teaches) ✓ — primary_changed');

    // map-edit attach (non-teaches) → NO flag (the narrowed trigger).
    await fetch(`${BASE}/map-edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attach_resource', conceptId: concept, resourceId: rUses, role: 'uses', coverageScore: 0.4 }),
    });
    assert((await reasonOf(concept)) === null, 'attach non-teaches must NOT flag');
    console.log('map-edit attach (uses) ✓ — not flagged');

    // map-edit detach (the teaches link) → primary_changed.
    await fetch(`${BASE}/map-edit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'detach_resource', conceptId: concept, resourceId: rTeach }),
    });
    assert((await reasonOf(concept)) === BankStaleReason.primary_changed, 'detach teaches → primary_changed');
    await clearFlag(concept);
    console.log('map-edit detach (teaches) ✓ — primary_changed');

    // pending-review reject — deprecate a resource linked as `teaches`, dropping the
    // link → primary_changed, and the link is gone.
    await prisma.conceptResource.create({ data: { conceptId: concept, resourceId: rDep, role: 'teaches', coverageScore: 0.8 } });
    const res = await applyPendingReview({ action: 'reject', resourceId: rDep, cascade: false, severity: 'hard' });
    assert(res.kind === 'rejected', `expected rejected, got ${res.kind}`);
    assert((await reasonOf(concept)) === BankStaleReason.primary_changed, 'reject of a teaches link → primary_changed');
    assert((await prisma.conceptResource.count({ where: { conceptId: concept, resourceId: rDep } })) === 0, 'link removed');
    console.log('pending-review reject ✓ — primary_changed, link dropped');

    console.log('\n✅ block 2.5i-2 verified');
  } finally {
    await prisma.path.delete({ where: { id: path.id } });
    await prisma.resource.deleteMany({ where: { topic: TAG } });
    await prisma.source.delete({ where: { id: source.id } });
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
