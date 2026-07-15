// DB integration tests for the CourseRequest queue primitives (Phase 2.5g-1;
// retry primitives Workers-A1): enqueueCourseRequest / claimNextQueued /
// finishCourseRequest / requeueCourseRequest / reclaimStale. Real DB, no LLM.
// Self-cleaning: rows are marked with a __verify_queue__ topic prefix and
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
  requeueCourseRequest,
  reclaimStale,
  queueDepth,
} from '@/lib/services/course-request';
import { COURSE_REQUEST_MAX_ATTEMPTS } from '@/lib/config';
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
async function claimMine(workerId?: string): Promise<CourseRequest | null> {
  for (;;) {
    const r = await claimNextQueued(workerId);
    if (!r) return null;
    if (r.topic.startsWith(MARK)) return r;
    quarantined.push(r.id);
  }
}

// Directly insert a marker row in a chosen state (bypasses enqueue's queued-only path),
// so ordering/aging is deterministic. buildUsage is excluded: Prisma's read-side
// JsonValue type isn't assignable to the Json create input, and no test sets it.
function makeRow(suffix: string, over: Partial<Omit<CourseRequest, 'buildUsage'>> = {}) {
  return prisma.courseRequest.create({
    data: { topic: `${MARK}${suffix}`, ...over },
  });
}

describeDb('CourseRequest queue', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    for (const id of quarantined) {
      // Undo the accidental claim fully: our claim burned an attempt and stamped
      // claimedBy on a row we don't own — put both back along with the status.
      await prisma.courseRequest.updateMany({
        where: { id, status: CourseRequestStatus.running },
        data: {
          status: CourseRequestStatus.queued,
          claimedAt: null,
          claimedBy: null,
          attempts: { decrement: 1 },
        },
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
    expect(oldAfter.nextAttemptAt).toBeNull(); // dead worker's request retries immediately
    expect(freshAfter.status).toBe(CourseRequestStatus.running); // within cutoff → left alone

    await prisma.courseRequest.deleteMany({ where: { id: { in: [old.id, fresh.id] } } });
  });

  it('N CONCURRENT claims take N distinct rows, one attempt each (FOR UPDATE SKIP LOCKED)', async () => {
    // Audit 2.11(a), pulled forward with Block 3: the sequential double-claim test
    // above would also pass with a plain non-locking query — only genuinely
    // concurrent claims pin the SKIP LOCKED property the N>1 rollout rests on.
    // Drain any foreign queued rows first (quarantined + restored in afterAll) so
    // the parallel claims can only land on our seeded rows.
    while ((await claimMine()) !== null) { /* drained our own leftovers too, if any */ }

    const rows = await Promise.all([makeRow('par-a'), makeRow('par-b'), makeRow('par-c')]);
    const claimed = await Promise.all([
      claimNextQueued('worker-par-1'),
      claimNextQueued('worker-par-2'),
      claimNextQueued('worker-par-3'),
    ]);

    const ids = claimed.map((c) => c?.id).sort();
    expect(ids).toEqual(rows.map((r) => r.id).sort()); // 3 claims, 3 DISTINCT rows, none missed
    for (const c of claimed) {
      expect(c?.status).toBe(CourseRequestStatus.running);
      expect(c?.attempts).toBe(1); // each row claimed exactly once — no double-increment
    }

    await prisma.courseRequest.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });

  // ——— Workers-A1 retry primitives ———

  it('claimNextQueued skips a row with a future nextAttemptAt, claims it once past due', async () => {
    const backedOff = await makeRow('backoff', { nextAttemptAt: new Date(Date.now() + 60_000) });

    expect(await claimMine()).toBeNull(); // future nextAttemptAt → ineligible

    await prisma.courseRequest.update({
      where: { id: backedOff.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const claimed = await claimMine();
    expect(claimed?.id).toBe(backedOff.id); // past due → eligible again
    expect(claimed?.status).toBe(CourseRequestStatus.running);

    await prisma.courseRequest.delete({ where: { id: backedOff.id } });
  });

  it('claimNextQueued increments attempts and stamps claimedBy', async () => {
    const row = await makeRow('stamp');

    const claimed = await claimMine('worker-test-1');
    expect(claimed?.id).toBe(row.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedBy).toBe('worker-test-1');

    // A requeue + second claim burns a second attempt and restamps claimedBy.
    await requeueCourseRequest(row.id, { delayMs: 0, reason: 'test bounce' });
    const reclaimed = await claimMine('worker-test-2');
    expect(reclaimed?.id).toBe(row.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.claimedBy).toBe('worker-test-2');

    await prisma.courseRequest.delete({ where: { id: row.id } });
  });

  it('requeueCourseRequest under cap → queued with delayed nextAttemptAt', async () => {
    const row = await makeRow('requeue', { status: CourseRequestStatus.running, claimedAt: new Date(), attempts: 1 });

    const before = Date.now();
    const res = await requeueCourseRequest(row.id, { delayMs: 60_000, reason: 'contention' });
    expect(res).toEqual({ requeued: true, failedAtCap: false });

    const after = await prisma.courseRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(CourseRequestStatus.queued);
    expect(after.claimedAt).toBeNull();
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000);

    await prisma.courseRequest.delete({ where: { id: row.id } });
  });

  it('requeueCourseRequest at cap → terminal failed with a max-attempts diagnostic', async () => {
    const row = await makeRow('requeue-cap', {
      status: CourseRequestStatus.running,
      claimedAt: new Date(),
      attempts: COURSE_REQUEST_MAX_ATTEMPTS,
    });

    const res = await requeueCourseRequest(row.id, { delayMs: 60_000, reason: 'contention' });
    expect(res).toEqual({ requeued: false, failedAtCap: true });

    const after = await prisma.courseRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(CourseRequestStatus.failed);
    expect(after.error).toContain('max attempts');
    expect(after.error).toContain('contention'); // the last reason is in the diagnostic

    await prisma.courseRequest.delete({ where: { id: row.id } });
  });

  it('requeueCourseRequest is a no-op on a non-running row', async () => {
    const row = await makeRow('requeue-noop', { status: CourseRequestStatus.queued });

    const res = await requeueCourseRequest(row.id, { delayMs: 60_000, reason: 'late bounce' });
    expect(res).toEqual({ requeued: false, failedAtCap: false });

    const after = await prisma.courseRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(CourseRequestStatus.queued);
    expect(after.nextAttemptAt).toBeNull(); // untouched

    await prisma.courseRequest.delete({ where: { id: row.id } });
  });

  it('reclaimStale requeues under-cap stale rows and fails at-cap ones', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000);
    const underCap = await makeRow('reclaim-under', {
      status: CourseRequestStatus.running,
      claimedAt: staleAt,
      attempts: COURSE_REQUEST_MAX_ATTEMPTS - 1,
    });
    const atCap = await makeRow('reclaim-cap', {
      status: CourseRequestStatus.running,
      claimedAt: staleAt,
      attempts: COURSE_REQUEST_MAX_ATTEMPTS,
    });

    await reclaimStale(5 * 60_000); // asserts on MY rows, not the global count

    const underAfter = await prisma.courseRequest.findUniqueOrThrow({ where: { id: underCap.id } });
    const capAfter = await prisma.courseRequest.findUniqueOrThrow({ where: { id: atCap.id } });
    expect(underAfter.status).toBe(CourseRequestStatus.queued);
    expect(underAfter.nextAttemptAt).toBeNull(); // immediate retry, no backoff
    expect(capAfter.status).toBe(CourseRequestStatus.failed);
    expect(capAfter.error).toContain('max attempts');

    await prisma.courseRequest.deleteMany({ where: { id: { in: [underCap.id, atCap.id] } } });
  });

  // ——— Workers-D queue-depth gauge ———

  it('queueDepth counts queued/running and ages the oldest queued row', async () => {
    // The gauge scans the whole table (like reclaimStale), so assert deltas
    // against a baseline rather than absolute values — foreign rows may exist.
    const base = await queueDepth();

    const oldMs = 5 * 60_000;
    const oldQueued = await makeRow('depth-old', { createdAt: new Date(Date.now() - oldMs) });
    const newQueued = await makeRow('depth-new');
    const running = await makeRow('depth-run', { status: CourseRequestStatus.running, claimedAt: new Date() });
    // Backed-off rows are still backlog: counted in queued, eligible for oldest.
    const backedOff = await makeRow('depth-backoff', { nextAttemptAt: new Date(Date.now() + 60_000) });

    const depth = await queueDepth();
    expect(depth.queued).toBe(base.queued + 3);
    expect(depth.running).toBe(base.running + 1);
    // Our 5-minute-old row is queued, so the oldest queued row is at least that old.
    expect(depth.oldestQueuedAgeMs).not.toBeNull();
    expect(depth.oldestQueuedAgeMs!).toBeGreaterThanOrEqual(oldMs - 1_000);

    await prisma.courseRequest.deleteMany({
      where: { id: { in: [oldQueued.id, newQueued.id, running.id, backedOff.id] } },
    });

    // Terminal rows never count.
    const done = await makeRow('depth-done', { status: CourseRequestStatus.fulfilled });
    const after = await queueDepth();
    expect(after.queued).toBe(base.queued);
    expect(after.running).toBe(base.running);
    await prisma.courseRequest.delete({ where: { id: done.id } });
  });
});
