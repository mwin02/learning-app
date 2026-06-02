// PathService — orchestrates the curriculum agent + persistence so the route
// handler stays a thin HTTP boundary. Kept as a module of free functions
// rather than a class; TypeScript modules give us the same encapsulation
// without the ceremony.
//
// Single public entrypoint: createPath(input, session) →
//   1. Calls generateCurriculum (which itself runs web fallback + validation
//      when the topic library is thin).
//   2. Writes one Path row + N PathItem rows inside a single Prisma
//      transaction so a partial path is never observable.
//
// CurriculumAgentError bubbles up unchanged so the route can map it to a
// 422 (semantic failure). Prisma / infra errors bubble up as generic
// throwables → mapped to 500 at the route.

import { prisma } from '@/lib/db';
import { generateCurriculum } from '@/lib/agents/curriculum/curriculum-agent';
import type { GeneratePathInput } from '@/lib/api/generate-path-schema';
import type { Session } from '@/lib/api/with-auth';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type CreatePathResult = {
  pathId: string;
};

export async function createPath(
  input: GeneratePathInput,
  session: Session,
  opts: { onTrace?: OnTrace } = {},
): Promise<CreatePathResult> {
  const onTrace: OnTrace = opts.onTrace ?? (() => {});

  const output = await generateCurriculum(
    {
      topic: input.topic,
      difficulty: input.difficulty,
      priorKnowledge: input.priorKnowledge,
      timeframeWeeks: input.timeframeWeeks,
      hoursPerWeek: input.hoursPerWeek,
    },
    { onTrace },
  );

  onTrace({
    kind: 'stage',
    label: 'persisting path',
    detail: { title: output.title, items: output.items.length },
  });

  // One transaction so a Path is never visible without its items. The agent
  // already returns items sorted by `order`; the @@unique([pathId, order])
  // constraint catches any duplicate-order bug at write time.
  const path = await prisma.path.create({
    data: {
      topic: input.topic,
      title: output.title,
      summary: output.summary,
      difficulty: input.difficulty,
      inputPriorKnowledge: input.priorKnowledge ?? null,
      inputTimeframeWeeks: input.timeframeWeeks,
      inputHoursPerWeek: input.hoursPerWeek,
      createdById: session.userId,
      items: {
        create: output.items.map((item) => ({
          resourceId: item.resourceId,
          order: item.order,
          rationale: item.rationale,
        })),
      },
    },
    select: { id: true },
  });

  console.log('[path-service] created', {
    pathId: path.id,
    topic: input.topic,
    itemCount: output.items.length,
    userId: session.userId,
  });
  onTrace({
    kind: 'stage',
    label: 'path created',
    detail: { pathId: path.id, items: output.items.length },
  });

  return { pathId: path.id };
}
