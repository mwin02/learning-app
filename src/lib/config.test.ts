// Audit 2.1 (Block 3): the worker-queue timing constants form a strict ordering
// that IS the correctness argument for age-based reclaim at N>1 workers — age is
// the only liveness signal, so every reclaim threshold must sit between "the job
// deadline already fired" (below) and "the request's own stale-reclaim retry
// arrives" (above). If an edit reorders them, reclaims start firing on LIVE jobs
// (duplicate remediation spend, successful spine builds flipped to `failed`) or
// retried requests bounce off dead claims. See the comments on each constant.
import { describe, it, expect } from 'vitest';
import {
  COURSE_JOB_DEADLINE_MS,
  COURSE_REQUEST_STALE_MS,
  COURSE_SHUTDOWN_GRACE_MS,
  PATH_BUILD_STALE_MS,
  REMEDIATION_JOB_STALE_MS,
} from '@/lib/config';

describe('worker timing ordering (audit 2.1/2.3)', () => {
  it('job deadline fires before any age-based reclaim can touch a live job', () => {
    expect(COURSE_JOB_DEADLINE_MS).toBeLessThan(REMEDIATION_JOB_STALE_MS);
    expect(COURSE_JOB_DEADLINE_MS).toBeLessThan(PATH_BUILD_STALE_MS);
  });

  it('stage reclaims free their slots before the request-level reclaim retries', () => {
    expect(REMEDIATION_JOB_STALE_MS).toBeLessThan(COURSE_REQUEST_STALE_MS);
    expect(PATH_BUILD_STALE_MS).toBeLessThan(COURSE_REQUEST_STALE_MS);
  });

  it('request stale-reclaim stays the outermost backstop (H4 invariant)', () => {
    expect(COURSE_JOB_DEADLINE_MS).toBeLessThan(COURSE_REQUEST_STALE_MS);
  });

  it('shutdown grace fits inside the 30s compose/Cloud Run SIGKILL budget', () => {
    // docker-compose.yml stop_grace_period (and Cloud Run's default term window)
    // is 30s; the grace race must settle well before SIGKILL lands.
    expect(COURSE_SHUTDOWN_GRACE_MS).toBeLessThan(30_000);
  });
});
