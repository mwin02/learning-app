// Zod schema for POST /api/generate-path. Phase 2.5g-4: the route no longer
// generates synchronously — it enqueues a CourseRequest the worker drains. So the
// body now mirrors the Track builder's per-learner inputs (buildTrack /
// BuildTrackInput), not the retired curriculum agent's CurriculumInput:
//   - `difficulty` (a Path-level column being retired) → `targetMastery` (optional;
//     the composer defaults a missing value to beginner)
//   - `goal` added (free-text "why"; the composer infers a coarse intent from it)
// Lives in its own file so non-route code can import the type without the handler.

import { z } from 'zod';

export const generatePathInputSchema = z.object({
  topic: z.string().trim().min(1).max(120),
  priorKnowledge: z.string().trim().max(500).optional(),
  goal: z.string().trim().max(2000).optional(),
  timeframeWeeks: z.number().int().min(1).max(52),
  hoursPerWeek: z.number().int().min(1).max(40),
  targetMastery: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
});

export type GeneratePathInput = z.infer<typeof generatePathInputSchema>;
