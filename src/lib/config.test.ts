// Audit 2.1 (Block 3): the worker-queue timing constants form a strict ordering
// that IS the correctness argument for age-based reclaim at N>1 workers — age is
// the only liveness signal, so every reclaim threshold must sit between "the job
// deadline already fired" (below) and "the request's own stale-reclaim retry
// arrives" (above). If an edit reorders them, reclaims start firing on LIVE jobs
// (duplicate remediation spend, successful spine builds flipped to `failed`) or
// retried requests bounce off dead claims. See the comments on each constant.
import { afterEach, describe, it, expect, vi } from 'vitest';

// doctoc.ts pulls in @/lib/db and @/lib/ai/models, both of which validate env at
// module-eval. Stub the leaves (see .claude/rules/testing.md).
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));

import { crawlerUserAgent } from '@/lib/agents/decomposition/doctoc';
import {
  CLOUD_RUN_ORIGIN,
  COURSE_JOB_DEADLINE_MS,
  COURSE_REQUEST_STALE_MS,
  COURSE_SHUTDOWN_GRACE_MS,
  PATH_BUILD_STALE_MS,
  REMEDIATION_JOB_STALE_MS,
  resolveCrawlerContactOrigin,
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

describe('crawler User-Agent contact origin', () => {
  const ua = (appOrigin: string | undefined) =>
    crawlerUserAgent(resolveCrawlerContactOrigin(appOrigin));

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names the Cloud Run service when APP_ORIGIN is unset', () => {
    expect(CLOUD_RUN_ORIGIN).toBe('https://learning-app-sau6bxtxta-uw.a.run.app');
    expect(ua(undefined)).toBe(
      'Mozilla/5.0 (compatible; LearningPathBot/1.0; +https://learning-app-sau6bxtxta-uw.a.run.app)',
    );
    expect(ua('')).toContain(CLOUD_RUN_ORIGIN);
  });

  it('names APP_ORIGIN instead when it is set', () => {
    const header = ua('https://example.test');
    expect(header).toContain('+https://example.test)');
    expect(header).not.toContain(CLOUD_RUN_ORIGIN);
  });

  it('normalizes APP_ORIGIN to a bare origin', () => {
    expect(ua('https://example.test/some/path/')).toContain('+https://example.test)');
  });

  it('falls back to Cloud Run when APP_ORIGIN is not a parseable URL', () => {
    expect(ua('not a url')).toContain(`+${CLOUD_RUN_ORIGIN})`);
    expect(ua('https://')).toContain(`+${CLOUD_RUN_ORIGIN})`);
  });

  it('reads APP_ORIGIN from the environment at module load', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://example.test');
    vi.resetModules();
    const config = await import('@/lib/config');
    expect(config.CRAWLER_CONTACT_ORIGIN).toBe('https://example.test');
  });
});
