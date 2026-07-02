// Zod schema for POST /api/generate-program (Phase 2.75d). Mirrors the program
// plan inputs (Program schema + ProgramPlanInput): a free-text goal + background,
// the total weekly budget the plan pass splits across topics, and an optional
// anti-list of topics to exclude. Lives in its own file so non-route code can import
// the type without the handler.

import { z } from 'zod';

export const generateProgramInputSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  background: z.string().trim().max(2000).optional(),
  // Capped at 40 (matching the per-topic hoursPerWeek ceiling on /generate-path):
  // 40 h/wk is already full-time study, and it keeps each child topic's split within
  // the per-topic budget norm even when the whole budget lands on one topic.
  totalHoursPerWeek: z.number().int().min(1).max(40),
  totalWeeks: z.number().int().min(1).max(52),
  // Decomposition prompt constraint (topic-level exclusion). Bounded so it can't
  // bloat the decomposition prompt.
  antiList: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});

export type GenerateProgramInput = z.infer<typeof generateProgramInputSchema>;
