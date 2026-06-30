// Phase 2.5i — flag a *reviewed* Concept's question bank as stale because its
// grounding resources changed, so it rejoins the discovery worklist (concept-banks
// route.ts) for manual re-curation. We do NOT auto-regenerate or invalidate
// individual questions: the bank is left exactly as-is; an operator edits it by hand
// (POST/DELETE on concept-banks/questions) and clears the flag by re-marking the bank
// reviewed (PATCH, which nulls bankStaleReason).
//
// ────────────────────────────────────────────────────────────────────────────────
// FOR FUTURE MUTATIONS: this is the single chokepoint for the "resources changed
// since review" signal. Any code that ADDS or REMOVES a Concept's ConceptResource
// rows should consider calling this. The currently-wired call sites (Phase 2.5i):
//   • playground/map-edit       — attach_resource / detach_resource
//   • curation/pending-review   — reject (deprecation drops candidate links)
//   • track/source-concept      — remediation re-source (add) + cap prune (remove)
// Build-time sites (ensure-path-map, split-concept, add-frontier-concept) create
// brand-new concepts that are never reviewed yet, so the bankReviewed guard below
// makes a call there a harmless no-op — wire them only if that ever changes.
// ────────────────────────────────────────────────────────────────────────────────
//
// Two guarantees, both enforced here so call sites stay one-liners:
//   1. GUARD — only concepts with bankReviewed=true are flagged. An unreviewed
//      concept is already on the worklist, so flagging it adds nothing; this keeps
//      bankStaleReason meaning precisely "a signed-off bank went stale".
//   2. NO DOWNGRADE — primary_changed (the `teaches`/primary material shifted) is the
//      higher-severity reason and always wins; resource_removed only fills a concept
//      that isn't already flagged, so a low-severity change can't mask a prior
//      high-severity one before the operator has triaged it.

import { BankStaleReason } from '@prisma/client';
import type { Prisma } from '@prisma/client';

// Decide the reason for one ConceptResource set-change, applying the narrowed
// trigger. Returns null when the change shouldn't flag at all — specifically when a
// NON-`teaches` (supplementary) candidate is ADDED, which can't invalidate an
// existing question. Removals always flag (the question may have been grounded in the
// removed resource); `teaches` additions flag because the main material moved.
export function staleReasonFor(args: {
  change: 'added' | 'removed';
  role: string; // ConceptResourceRole value ('teaches' | 'uses' | 'assesses')
}): BankStaleReason | null {
  const isPrimary = args.role === 'teaches';
  if (args.change === 'added') {
    return isPrimary ? BankStaleReason.primary_changed : null;
  }
  // removed
  return isPrimary ? BankStaleReason.primary_changed : BankStaleReason.resource_removed;
}

// Flag the given reviewed concepts stale. Idempotent and safe to over-call: the
// bankReviewed guard skips unreviewed concepts, and the no-downgrade rule means a
// later resource_removed never clobbers an existing primary_changed. Runs on the
// supplied transaction client so the flag commits atomically with the resource change
// that caused it. Returns the number of concepts whose flag this call set/raised.
export async function markBankStale(
  tx: Prisma.TransactionClient,
  conceptIds: string[],
  reason: BankStaleReason,
): Promise<number> {
  if (conceptIds.length === 0) return 0;

  // primary_changed overwrites anything (including an existing resource_removed);
  // resource_removed only fills concepts not already flagged.
  const where: Prisma.ConceptWhereInput =
    reason === BankStaleReason.primary_changed
      ? { id: { in: conceptIds }, bankReviewed: true }
      : { id: { in: conceptIds }, bankReviewed: true, bankStaleReason: null };

  const { count } = await tx.concept.updateMany({ where, data: { bankStaleReason: reason } });
  return count;
}
