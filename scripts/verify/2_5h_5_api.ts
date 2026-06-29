// Block 2.5h-5 verify: the discovery API round-trip (GET / POST / PATCH / DELETE).
// Requires the dev server (npm run dev, DEV_AUTH=1). Uses its OWN throwaway Path +
// Concept so it never pollutes real data; cleans up at the end.
import { prisma } from '@/lib/db';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000/api/playground/concept-banks';
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const j = (r: Response) => r.json();

async function main() {
  await prisma.path.deleteMany({ where: { topic: '__verify_2_5h_5__' } });
  const path = await prisma.path.create({ data: { topic: '__verify_2_5h_5__', status: 'spine_ready' } });
  const concept = await prisma.concept.create({
    data: { pathId: path.id, slug: 'api-verify-concept', title: 'API Verify Concept', membership: 'spine' },
    select: { id: true },
  });
  const cid = concept.id;

  try {
    // GET — scoped to our path; concept is weak (bankReviewed=false), shows up.
    const list = await j(await fetch(`${BASE}?pathId=${path.id}`));
    assert(list.count === 1 && list.concepts[0].conceptId === cid, 'GET should list our weak concept');
    assert(Array.isArray(list.concepts[0].resources), 'GET must include resources array (URLs)');
    assert(list.concepts[0].questionCount === 0, 'fresh concept should have 0 questions');
    console.log('GET ✓ — weak concept listed with questions + resources fields');

    // POST — add a text + a valid mcq (origin=user).
    const add = await fetch(`${BASE}/questions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: cid, questions: [
        { kind: 'text', prompt: 'Explain it.', answer: 'It is...', rubric: 'mentions key idea' },
        { kind: 'mcq', prompt: 'Which?\nA) one\nB) two', answer: 'B) two', rubric: 'two is right' },
      ] }),
    });
    assert(add.status === 200 && (await add.json()).added === 2, 'POST should add 2');
    console.log('POST ✓ — added 2 user questions');

    // POST — malformed MCQ rejected.
    const bad = await fetch(`${BASE}/questions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conceptId: cid, questions: [{ kind: 'mcq', prompt: 'no opts', answer: 'x', rubric: 'y' }] }),
    });
    assert(bad.status === 400, 'malformed MCQ should be 400');
    console.log('POST ✓ — malformed MCQ rejected (400)');

    // Both persisted as origin=user.
    const persisted = await prisma.conceptQuestion.findMany({ where: { conceptId: cid }, select: { id: true, origin: true } });
    assert(persisted.length === 2 && persisted.every((q) => q.origin === 'user'), 'expected 2 user questions');

    // PATCH — mark reviewed → drops off the weak worklist.
    const patch = await j(await fetch(BASE, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conceptId: cid }) }));
    assert(patch.bankReviewed === true, 'PATCH should set reviewed');
    const weak = await j(await fetch(`${BASE}?pathId=${path.id}`));
    assert(weak.count === 0, 'reviewed concept must drop off the weak worklist');
    const all = await j(await fetch(`${BASE}?pathId=${path.id}&includeReviewed=1`));
    assert(all.count === 1, 'includeReviewed=1 should still show it');
    console.log('PATCH ✓ — marked reviewed, drops off weak list, visible with includeReviewed=1');

    // DELETE — remove one; 404 on missing.
    const del = await fetch(`${BASE}/questions?id=${persisted[0].id}`, { method: 'DELETE' });
    assert(del.status === 200, 'DELETE should 200');
    assert((await fetch(`${BASE}/questions?id=nope`, { method: 'DELETE' })).status === 404, 'missing → 404');
    assert((await prisma.conceptQuestion.count({ where: { conceptId: cid } })) === 1, 'one question should remain');
    console.log('DELETE ✓ — removed one, 404 on missing');

    console.log('\n✅ block 2.5h-5 verified');
  } finally {
    await prisma.path.delete({ where: { id: path.id } });
  }
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
