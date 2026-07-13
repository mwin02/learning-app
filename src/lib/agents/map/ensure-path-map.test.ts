// Unit tests for isReclaimable (Phase 2.5g-2) and isBuildInFlight (Workers-A2) — the
// pure predicates deciding whether an EXISTING Path should be rebuilt, or is another
// worker's build plausibly mid-flight. No DB, no LLM. Added in R3.
import { describe, it, expect, vi } from 'vitest';
import { PathStatus } from '@prisma/client';

// ensure-path-map.ts pulls in @/lib/db and (via build-spine / attach-candidates) the
// Vertex model, both of which throw at module-eval without their env vars. isReclaimable
// is pure and touches neither, so stub the leaves to keep this in the unit project.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  geminiFlash: {},
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import { isReclaimable, isBuildInFlight } from '@/lib/agents/map/ensure-path-map';
import { PATH_BUILD_STALE_MS } from '@/lib/config';

const stale = () => new Date(Date.now() - PATH_BUILD_STALE_MS - 1000); // safely past the age gate
const fresh = () => new Date(); // just claimed

describe('isReclaimable', () => {
  it('failed → always rebuildable, regardless of concepts or age', () => {
    expect(isReclaimable(PathStatus.failed, 0, fresh())).toBe(true);
    expect(isReclaimable(PathStatus.failed, 12, fresh())).toBe(true);
  });

  it('building + 0 concepts + stale → reclaimable (crashed claim)', () => {
    expect(isReclaimable(PathStatus.building, 0, stale())).toBe(true);
  });

  it('building + 0 concepts + fresh → left alone (build may still be in flight)', () => {
    expect(isReclaimable(PathStatus.building, 0, fresh())).toBe(false);
  });

  it('building WITH concepts → left alone even when stale (holes are remediation, not rebuild)', () => {
    expect(isReclaimable(PathStatus.building, 5, stale())).toBe(false);
  });

  it('spine_ready → never reclaimed', () => {
    expect(isReclaimable(PathStatus.spine_ready, 0, stale())).toBe(false);
    expect(isReclaimable(PathStatus.spine_ready, 10, stale())).toBe(false);
  });

  it('draft → never reclaimed', () => {
    expect(isReclaimable(PathStatus.draft, 0, stale())).toBe(false);
  });
});

// Workers-A2 (D2): the contention signal — an existing Path whose build another
// worker plausibly has mid-flight (between its tx1 claim and tx2 populate). The
// worker requeues the request with backoff on `true`. Complement of isReclaimable
// within the empty-`building` state: fresh = in flight, stale = crashed claim.
describe('isBuildInFlight', () => {
  it('building + 0 concepts + fresh → in flight (the tx1→tx2 window)', () => {
    expect(isBuildInFlight(PathStatus.building, 0, fresh())).toBe(true);
  });

  it('building + 0 concepts + stale → NOT in flight (crashed claim — reclaim, not backoff)', () => {
    expect(isBuildInFlight(PathStatus.building, 0, stale())).toBe(false);
  });

  it('building WITH concepts → not in flight (a holey spine is remediation, not contention)', () => {
    expect(isBuildInFlight(PathStatus.building, 5, fresh())).toBe(false);
    expect(isBuildInFlight(PathStatus.building, 5, stale())).toBe(false);
  });

  it('settled statuses → never in flight', () => {
    expect(isBuildInFlight(PathStatus.spine_ready, 0, fresh())).toBe(false);
    expect(isBuildInFlight(PathStatus.failed, 0, fresh())).toBe(false);
    expect(isBuildInFlight(PathStatus.draft, 0, fresh())).toBe(false);
  });

  it('is disjoint from isReclaimable on every empty-building case', () => {
    for (const at of [fresh(), stale()]) {
      expect(
        isBuildInFlight(PathStatus.building, 0, at) && isReclaimable(PathStatus.building, 0, at),
      ).toBe(false);
    }
  });
});
