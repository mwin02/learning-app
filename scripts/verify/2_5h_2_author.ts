// Block 2.5h-2 verify: authorConceptBank produces a sane, well-formed bank.
// Runs LIVE against Vertex. Picks a real spine concept (with resources) from the DB
// if one exists; otherwise falls back to a synthetic concept so the agent is always
// exercised. Asserts shape; prints the bank for eyeballing quality.
import { prisma } from '@/lib/db';
import { authorConceptBank } from '@/lib/agents/content/author-concept-bank';
import { ExerciseKind } from '@prisma/client';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function main() {
  // Find a real spine concept that has at least one resource, for realistic input.
  const concept = await prisma.concept.findFirst({
    where: { membership: 'spine', resources: { some: {} } },
    select: {
      slug: true, title: true, isOnRamp: true,
      path: { select: { topic: true } },
      resources: { select: { resource: { select: { title: true, type: true } } }, take: 8 },
    },
  });

  const input = concept
    ? {
        topic: concept.path.topic,
        conceptTitle: concept.title,
        conceptSlug: concept.slug,
        isOnRamp: concept.isOnRamp,
        resources: concept.resources.map((r) => ({ title: r.resource.title, type: r.resource.type })),
      }
    : {
        topic: 'Python for data/ML',
        conceptTitle: 'List comprehensions',
        conceptSlug: 'list-comprehensions',
        isOnRamp: false,
        resources: [
          { title: 'Python List Comprehensions — Real Python', type: 'article' },
          { title: 'Comprehensions (Python docs)', type: 'doc' },
        ],
      };

  console.log(`\n--- input concept: "${input.conceptTitle}" (topic: ${input.topic}, ${concept ? 'REAL' : 'SYNTHETIC'}, ${input.resources.length} resources) ---\n`);

  const questions = await authorConceptBank({ ...input, onTrace: (e) => console.log('  trace:', e.label) });

  assert(questions.length > 0, 'expected at least one question');
  const kinds = { text: 0, mcq: 0 };
  for (const [i, q] of questions.entries()) {
    assert(q.prompt.length > 0 && q.answer.length > 0 && q.rubric.length > 0, `q${i} has an empty field`);
    assert(q.kind === ExerciseKind.text || q.kind === ExerciseKind.mcq, `q${i} bad kind`);
    if (q.kind === ExerciseKind.mcq) {
      const markers = q.prompt.match(/(^|\n)\s*[A-Z][)\.]/g) ?? [];
      assert(markers.length >= 2, `q${i} mcq has <2 options in prompt`);
    }
    kinds[q.kind]++;
    console.log(`\n[${i + 1}] (${q.kind})`);
    console.log(`Q: ${q.prompt}`);
    console.log(`A: ${q.answer}`);
    console.log(`Rubric: ${q.rubric}`);
  }
  console.log(`\n✅ block 2.5h-2 verified — ${questions.length} questions (text=${kinds.text}, mcq=${kinds.mcq}), all well-formed`);
}
main().catch((e) => { console.error('❌', e); process.exit(1); }).finally(() => prisma.$disconnect());
