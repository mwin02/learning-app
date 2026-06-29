// Block 2.5h-6 verify: the composer sufficiency-rule tweak still produces VALID
// structured output, and on an assesses-light spine_ready Path the composer does
// not flag concepts under-resourced on an assessment basis. Live compose (Pro).
import { prisma } from '@/lib/db';
import { buildTrack } from '@/lib/agents/track/build-track';

function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function main() {
  const path = await prisma.path.findFirst({
    where: { status: 'spine_ready', topic: 'linear-algebra' },
    select: { id: true },
  });
  if (!path) { console.log('(skip — no linear-algebra spine_ready path)'); return; }

  // How assesses-light is this Path? (context for the result)
  const assessesCount = await prisma.conceptResource.count({ where: { concept: { pathId: path.id }, role: 'assesses' } });
  const teachesCount = await prisma.conceptResource.count({ where: { concept: { pathId: path.id }, role: 'teaches' } });
  console.log(`path resource roles — teaches=${teachesCount}, assesses=${assessesCount} (assesses-light)`);

  const built = await buildTrack({
    pathId: path.id,
    goal: 'foundations',
    timeframeWeeks: 4,
    hoursPerWeek: 5,
    targetMastery: 'beginner',
  });

  // Valid structured output: build completed and returned a coherent result.
  assert(built.status === 'ready', `expected ready track, got ${built.status}`);
  console.log('build status:', built.status, '| underResourced:', built.underResourced, '| budgetWeak:', built.budgetWeak);

  // The tweak's intent: assessment scarcity must not surface as under-resourcing.
  const assessCited = built.underResourced.some((s) => /assess|practice|quiz|exercise/i.test(s));
  assert(!assessCited, `underResourced cited assessment scarcity: ${built.underResourced}`);
  const assessWarn = built.warnings.filter((w) => /assess|practice/i.test(w) && /under.?resourc|insufficient/i.test(w));
  assert(assessWarn.length === 0, `a sufficiency warning cited assessment: ${assessWarn}`);

  console.log('\n✅ block 2.5h-6 verified — composer produced valid output; no assessment-based under-resourcing');
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
