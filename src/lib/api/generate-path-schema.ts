// Zod schema for POST /api/generate-path. Lives in its own file so the
// PathService (2d.2) can re-import GeneratePathInput without pulling in the
// route handler. Mirrors CurriculumInput from src/lib/curriculum-agent.ts —
// the inferred type is structurally compatible.

import { z } from 'zod';

export const generatePathInputSchema = z.object({
  topic: z.string().trim().min(1).max(120),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  priorKnowledge: z.string().trim().max(500).optional(),
  timeframeWeeks: z.number().int().min(1).max(52),
  hoursPerWeek: z.number().int().min(1).max(40),
});

export type GeneratePathInput = z.infer<typeof generatePathInputSchema>;
