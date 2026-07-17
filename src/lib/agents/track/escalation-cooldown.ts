// Audit 3.1: the pure decision behind remediation's escalation fast-fail — should
// this run skip the whole pass loop (and its per-hole sourcing ladder) because a
// recent run already escalated these same holes?
//
// The record consulted is the Path's most recent TERMINAL RemediationJob (no new
// column — the escalated row already carries what/when). Deliberately keyed on the
// LATEST terminal job, whatever its state: a `succeeded` or `failed` run after an
// escalation means the situation changed (or errored) and a fresh run is warranted.
// Fast-fail only when all three hold:
//   1. the latest terminal job is `escalated`,
//   2. it's younger than REMEDIATION_ESCALATION_COOLDOWN_MS,
//   3. the CURRENT holes are a subset of what it escalated — a new hole (frontier
//      add, map edit, resource deprecation) is new information and remediates
//      normally; likewise an operator fix that removes holes hits the no-holes
//      exit before this check.
// Kept pure (no prisma import) so it unit-tests without stubs.

import { RemediationState } from '@prisma/client';
import { REMEDIATION_ESCALATION_COOLDOWN_MS } from '@/lib/config';

export type TerminalJobSnapshot = {
  state: RemediationState;
  updatedAt: Date;
  escalatedConceptSlugs: string[];
};

export function shouldFastFailEscalated(
  currentHoles: string[],
  latestTerminalJob: TerminalJobSnapshot | null,
  now: Date = new Date(),
  coolDownMs: number = REMEDIATION_ESCALATION_COOLDOWN_MS,
): boolean {
  if (!latestTerminalJob) return false;
  if (latestTerminalJob.state !== RemediationState.escalated) return false;
  if (now.getTime() - latestTerminalJob.updatedAt.getTime() >= coolDownMs) return false;
  const escalated = new Set(latestTerminalJob.escalatedConceptSlugs);
  return currentHoles.length > 0 && currentHoles.every((slug) => escalated.has(slug));
}
