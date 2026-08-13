// Q10 — the file contract between `resolve-unknowns.ts` and the confirmation page.
//
// The proposals are the slug-key matches that may NOT be written unattended (Q6b
// measured that key ~4% confidently wrong), so they sit outside the database until
// a human agrees with one. A file, not a table, because the plan allows this block
// no migration — and because a proposal is a run artefact next to the channel index
// it was derived from, not library state.
//
// Parsed with zod like any other boundary: the file is written by a script, is
// git-ignored, and may be absent, stale or half-written, none of which may reach
// the page as an unvalidated shape.

import { z } from 'zod';

export const slugProposalSchema = z.object({
  resourceId: z.string().min(1),
  title: z.string(),
  url: z.string(),
  slugKey: z.string(),
  videoId: z.string(),
  videoTitle: z.string(),
  proposedMin: z.number().int().positive(),
});

export const slugProposalsSchema = z.array(slugProposalSchema);

export type SlugProposalRecord = z.infer<typeof slugProposalSchema>;
