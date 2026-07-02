// DB integration tests for the CourseRequest queue primitives (Phase 2.5g-1):
// enqueueCourseRequest / claimNextQueued / finishCourseRequest / reclaimStale. Real DB,
// no LLM. Self-cleaning: rows are marked with a __verify_queue__ topic prefix and
// deleted in before/after hooks. Added in R3.
//
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker STOPPED —
// claimNextQueued/reclaimStale scope over the whole table, so a live worker racing the
// same rows would make the ordering assertions flaky. As a safety net, any foreign
// `queued` row this test happens to claim is quarantined and restored to `queued` in
// afterAll, so a stray row is never stranded in `running`.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { CourseRequestStatus, type CourseRequest } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  enqueueCourseRequest,
  claimNextQueued,
  finishCourseRequest,
  reclaimStale,
} from '@/lib/services/course-request';
import { describeDb } from './db';

const MARK = '__verify_queue__';

async function cleanup() {
  await prisma.courseRequest.deleteMany({ where: { topic: { startsWith: MARK } } });
  await prisma.track.deleteMany({ where: { path: { topic: { startsWith: MARK } } } });
  await prisma.path.deleteMany({ where: { topic: { startsWith: MARK } } });
}

// Foreign `queued` rows this test claims by accident (claimNextQueued is global) are
// parked here and restored to `queued` in afterAll — never stranded in `running`.
const quarantined: string[] = [];
async function claimMine(): Promise<CourseRequest | null> {
  for (;;) {
    const r = await claimNextQueued();
    if (!r) return null;
    if (r.topic.startsWith(MARK)) return r;
    quarantined.push(r.id);
  }
}

// Directly insert a marker row in a chosen state (bypasses enqueue's queued-only path),
// so ordering/aging is deterministic.
function makeRow(suffix: string, over: Partial<CourseRequest> = {}) {
  return prisma.courseRequest.create({
    data: { topic: `${MARK}${suffix}`, ...over },
  });
}

describeDb('CourseRequest queue', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    for (const id of quarantined) {
      await prisma.courseRequest.updateMany({
        where: { id, status: CourseRequestStatus.running },
        data: { status: CourseRequestStatus.queued, claimedAt: null },
      });
    }
    quarantined.length = 0;
    await cleanup();
  });

  it('enqueueCourseRequest inserts a queued row', async () => {
    const { id } = await enqueueCourseRequest({ topic: `${MARK}enq`, goal: 'g' });
    const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(CourseRequestStatus.queued);
    expect(row.claimedAt).toBeNull();
    await prisma.courseRequest.delete({ where: { id } });
  });

  it('claimNextQueued takes the oldest first, running, with no double-claim; null when empty', async () => {
    const t0 = new Date(Date.now() - 60_000);
    const older = await makeRow('older', { createdAt: t0 });
    const newer = await makeRow('newer', { createdAt: new Date(t0.getTime() + 1_000) });

    const first = await claimMine();
    expect(first?.id).toBe(older.id); // oldest createdAt first
    expect(first?.status).toBe(CourseRequestStatus.running);
    expect(first?.claimedAt).not.toBeNull();

    const second = await claimMine();
    expect(second?.id).toBe(newer.id); // not the already-claimed row (no double-claim)
    expect(second?.id).not.toBe(first?.id);

    // Both mine are now running → the queue (of mine + any foreign, now quarantined) is empty.
    expect(await claimMine()).toBeNull();

    await prisma.courseRequest.deleteMany({ where: { id: { in: [older.id, newer.id] } } });
  });

  it('finishCourseRequest moves a running row to terminal, but is a no-op after a reclaim bounce', async () => {
    const running = await makeRow('finish', { status: CourseRequestStatus.running, claimedAt: new Date() });
    const ok = await finishCourseRequest(running.id, { status: 'failed', error: 'boom' });
    expect(ok.finished).toBe(true);
    expect((await prisma.courseRequest.findUniqueOrThrow({ where: { id: running.id } })).status).toBe(
      CourseRequestStatus.failed,
    );

    // Simulate a reclaimStale bounce (worker thought dead, row already back to queued),
    // then the late finish must NOT resurrect it.
    const bounced = await makeRow('bounced', { status: CourseRequestStatus.queued, claimedAt: null });
    const noop = await finishCourseRequest(bounced.id, { status: 'failed', error: 'late' });
    expect(noop.finished).toBe(false);
    expect((await prisma.courseRequest.findUniqueOrThrow({ where: { id: bounced.id } })).status).toBe(
      CourseRequestStatus.queued,
    );

    await prisma.courseRequest.deleteMany({ where: { id: { in: [running.id, bounced.id] } } });
  });

  it('reclaimStale bounces only running rows claimed before the cutoff', async () => {
    const old = await makeRow('stale', { status: CourseRequestStatus.running, claimedAt: new Date(Date.now() - 10 * 60_000) });
    const fresh = await makeRow('fresh', { status: CourseRequestStatus.running, claimedAt: new Date() });

    await reclaimStale(5 * 60_000); // cutoff = 5 min ago; asserts on MY rows, not the global count

    const oldAfter = await prisma.courseRequest.findUniqueOrThrow({ where: { id: old.id } });
    const freshAfter = await prisma.courseRequest.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(oldAfter.status).toBe(CourseRequestStatus.queued); // past cutoff → bounced
    expect(oldAfter.claimedAt).toBeNull();
    expect(freshAfter.status).toBe(CourseRequestStatus.running); // within cutoff → left alone

    await prisma.courseRequest.deleteMany({ where: { id: { in: [old.id, fresh.id] } } });
  });
});
