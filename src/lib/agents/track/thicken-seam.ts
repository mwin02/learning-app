// Phase 2.5e-3: the spine-thickener seam — a real interface with a stubbed body
// until 2.5f builds the thickener.
//
// When the composer judges a concept's resources insufficient for the target
// mastery (resourceSufficiency.enough === false), the Track builder asks the
// thickener to source more — then rebuilds. 2.5f will fill this in with the
// targeted per-concept discovery → validate/upsert/embed → re-judge → re-attach →
// recompute-readiness loop (the same machinery as spine-hole remediation; only the
// trigger differs). Until then this no-ops and reports it couldn't, so the builder
// falls through to its best-effort weaker-Track path.
//
// This is also the async boundary: today buildTrack awaits it inline; later it
// becomes "mark building → enqueue thicken job → completion re-invokes buildTrack",
// with no change to the builder's control flow.

export type ThickenRequest = {
  pathId: string;
  // The concepts the composer flagged as under-resourced for the target mastery.
  underResourced: { conceptSlug: string; reason: string }[];
};

export type ThickenResult = {
  // True only if new candidates were actually attached — the builder rebuilds when
  // true, and proceeds best-effort when false.
  thickened: boolean;
  reason: string;
};

export async function thickenSpine(req: ThickenRequest): Promise<ThickenResult> {
  console.log('[track-thicken-seam] stub invoked', {
    pathId: req.pathId,
    underResourced: req.underResourced.map((u) => u.conceptSlug),
  });
  return { thickened: false, reason: 'spine thickener not implemented (2.5f)' };
}
