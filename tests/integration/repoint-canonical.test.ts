// DB integration test for F7's repointCanonical — the alias-recording half of scoped-
// topic reconciliation. When reconciliation folds a minted scoped canonical
// (calculus-for-machine-learning) into an existing library topic (calculus), it must
// repoint BOTH the gate's phrasing→scoped alias and the scoped self-alias to the
// existing topic, so the same phrasing short-circuits at tier 2 next time.
//
// Self-cleaning: rows use a slug-safe zz-verify-repoint marker, deleted in before/after.
// Skips cleanly when DATABASE_URL is unset (describeDb). Run with the worker stopped.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { repointCanonical, lookupAlias } from '@/lib/agents/topic-registry';
import { describeDb } from './db';

const SCOPED = 'zz-verify-repoint-scoped';
const BASE = 'zz-verify-repoint-base';
const PHRASING = 'zz verify repoint phrasing';

const cleanup = () =>
  prisma.topicAlias.deleteMany({
    where: { OR: [{ canonical: { startsWith: 'zz-verify-repoint' } }, { alias: PHRASING }] },
  });

describeDb('repointCanonical', () => {
  beforeAll(async () => {
    await cleanup();
    // Mirror what the gate persists on a scoped mint: phrasing→scoped + scoped self-alias.
    await prisma.topicAlias.createMany({
      data: [
        { alias: PHRASING, canonical: SCOPED, subject: 'math' },
        { alias: SCOPED, canonical: SCOPED, subject: 'math' },
      ],
    });
  });
  afterAll(cleanup);

  it('repoints every alias resolving to the scoped canonical onto the base topic', async () => {
    const count = await repointCanonical(SCOPED, BASE);
    expect(count).toBe(2); // both the phrasing alias and the self-alias

    // Either form now resolves to the existing base topic at tier 2.
    expect((await lookupAlias(PHRASING))?.canonical).toBe(BASE);
    expect((await lookupAlias(SCOPED))?.canonical).toBe(BASE);
  });

  it('is a no-op when from === to', async () => {
    expect(await repointCanonical(BASE, BASE)).toBe(0);
  });
});
