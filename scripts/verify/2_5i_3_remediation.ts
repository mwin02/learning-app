// Block 2.5i-2 verify (MANUAL / NETWORK): drive the FULL spine-hole remediation path
// and confirm source-concept flags a reviewed bank stale when it attaches a `teaches`
// candidate. Unlike 2_5i_2 (which exercises the cheap sites), this runs the real
// remediatePath → web sourcing (Google search) → Vertex judge → attach — minutes, and
// makes live external calls. Needs the same env as scripts/remediate.ts.
//
//   npx tsx --env-file=.env.local scripts/verify/2_5i_3_remediation.ts
//
// Isolated: a throwaway `building` Path with a UNIQUE topic + one reviewed gap concept
// (no resources). upsertResource files newly-discovered rows under that unique topic,
// so cleanup deletes them by topic without touching the real corpus.
import { prisma } from '@/lib/db';
import { remediatePath } from '@/lib/agents/track/remediate-path';
import { BankStaleReason } from '@prisma/client';

// Unique enough to never collide with a real Path/Resource topic, descriptive enough
// that grounded search still finds genuine teaching resources for the concept.
const TOPIC = 'QA-Verify-2.5i Python string formatting (f-strings)';
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function main() {
  await prisma.path.deleteMany({ where: { topic: TOPIC } });
  await prisma.resource.deleteMany({ where: { topic: TOPIC } });

  const path = await prisma.path.create({ data: { topic: TOPIC, status: 'building' } });
  // A reviewed concept with NO candidates → a gap hole remediation must source.
  const concept = (await prisma.concept.create({
    data: {
      pathId: path.id, slug: 'python-f-strings', title: 'Python f-strings (string formatting)',
      membership: 'spine', isOnRamp: false, bankReviewed: true,
    },
    select: { id: true },
  })).id;

  try {
    console.log('[verify] driving remediatePath (real web + Vertex, minutes)…');
    const result = await remediatePath(path.id);
    console.log('[verify] remediation result:', result);

    const after = await prisma.concept.findUniqueOrThrow({
      where: { id: concept },
      select: { bankStaleReason: true, resources: { select: { role: true } } },
    });
    const attachedTeaches = after.resources.filter((r) => r.role === 'teaches').length;
    console.log('[verify] attached candidates:', after.resources.map((r) => r.role), '| flag:', after.bankStaleReason);

    // The proof: remediation attached at least one `teaches`, and source-concept flagged
    // the reviewed bank primary_changed via markBankStale.
    assert(attachedTeaches > 0, 'remediation should have attached a teaches candidate (check sourcing/judge)');
    assert(after.bankStaleReason === BankStaleReason.primary_changed, `expected primary_changed, got ${after.bankStaleReason}`);
    console.log('\n✅ full remediation path flags a reviewed bank primary_changed');
  } finally {
    await prisma.path.delete({ where: { id: path.id } });
    await prisma.resource.deleteMany({ where: { topic: TOPIC } });
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
