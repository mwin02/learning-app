// Unit tests for the reviewer refile seam (Q9). The two guards here are the whole
// reason this is a seam rather than a bare `setPrimaryTopic` call, and until now
// neither was under test in `npm run verify` — they were only ever exercised by
// hand. Both are verified correct at runtime; these pin them so a later block
// reworking the correction paths cannot quietly drop one.
//
// The DB seam is stubbed (module-eval gotcha: @/lib/db validates env at import),
// so this runs secret-free. `listCanonicals` is stubbed as the DB-backed half of
// the registry while `normalizeTopic` / `toCanonicalSlug` stay REAL — the
// canonicalisation is the guard's first step, and mocking it would test nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `update` is stubbed even though the seam must never call it — an absent method
// would make the "no direct write" test below assert a property of this mock
// rather than of the code.
vi.mock('@/lib/db', () => ({
  prisma: { resource: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock('@/lib/curation/resource-topics', () => ({ setPrimaryTopic: vi.fn() }));
vi.mock('@/lib/agents/topic-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/topic-registry')>()),
  listCanonicals: vi.fn(),
}));

import { prisma } from '@/lib/db';
import { setPrimaryTopic } from '@/lib/curation/resource-topics';
import { listCanonicals } from '@/lib/agents/topic-registry';
import { refileToTopic } from '@/lib/curation/refile-topic';

const findUnique = vi.mocked(prisma.resource.findUnique);
const setPrimary = vi.mocked(setPrimaryTopic);
const canonicals = vi.mocked(listCanonicals);

beforeEach(() => {
  vi.clearAllMocks();
  // The row currently sits under `calculus`; the registry knows two other topics.
  findUnique.mockResolvedValue({ topic: 'calculus' } as never);
  canonicals.mockResolvedValue(['calculus', 'linear-algebra', 'differential-equations']);
});

describe('refileToTopic', () => {
  it('refiles onto a known topic through setPrimaryTopic, stamped origin review', async () => {
    const result = await refileToTopic('res_1', 'linear-algebra');
    expect(result).toEqual({ kind: 'refiled', topic: 'linear-algebra' });
    expect(setPrimary).toHaveBeenCalledWith('res_1', 'linear-algebra', { origin: 'review' });
  });

  // `Resource.topic` is a MIRROR of the primary membership. Writing it here would
  // move the mirror without the flag it mirrors — the exact rot setPrimaryTopic
  // exists to prevent — so the seam must never reach for a Resource update itself.
  it('never writes Resource.topic directly', async () => {
    await refileToTopic('res_1', 'linear-algebra');
    expect(vi.mocked(prisma.resource.update)).not.toHaveBeenCalled();
    expect(setPrimary).toHaveBeenCalledTimes(1);
  });

  // F3b: an operator's free text is the one input on this path that can mint a twin
  // slug — a row filed under a topic nothing searching the canonical one can see.
  it('refuses a slug the registry has never seen, naming the offending slug', async () => {
    const result = await refileToTopic('res_1', 'Totally Made Up Nonexistent Topic Xyz');
    expect(result).toEqual({
      kind: 'refused',
      reason:
        '"totally-made-up-nonexistent-topic-xyz" is not a known topic — refile onto an existing one',
    });
    expect(setPrimary).not.toHaveBeenCalled();
  });

  // F3d: reviewer surfaces prefill the current topic, so an unguarded click would
  // rewrite nothing but `origin` and report the row as refiled.
  it('refuses a topic the row is already filed under', async () => {
    const result = await refileToTopic('res_1', 'calculus');
    expect(result).toEqual({
      kind: 'refused',
      reason: 'already filed under "calculus" — pick a different topic',
    });
    expect(setPrimary).not.toHaveBeenCalled();
  });

  // The unchanged-topic guard runs on the CANONICAL form, not the raw text, or odd
  // casing would slip past it and rewrite provenance for no filing change.
  it('canonicalises before the unchanged-topic check', async () => {
    const result = await refileToTopic('res_1', '  Calculus  ');
    expect(result).toMatchObject({ kind: 'refused' });
    expect(setPrimary).not.toHaveBeenCalled();
  });

  it('canonicalises free text before the registry lookup', async () => {
    for (const typed of ['Linear Algebra', '  linear algebra ', 'LINEAR_ALGEBRA']) {
      vi.clearAllMocks();
      findUnique.mockResolvedValue({ topic: 'calculus' } as never);
      canonicals.mockResolvedValue(['calculus', 'linear-algebra']);
      expect(await refileToTopic('res_1', typed)).toEqual({
        kind: 'refiled',
        topic: 'linear-algebra',
      });
      expect(setPrimary).toHaveBeenCalledWith('res_1', 'linear-algebra', { origin: 'review' });
    }
  });

  it('refuses free text with no usable slug at all', async () => {
    const result = await refileToTopic('res_1', '///');
    expect(result).toEqual({ kind: 'refused', reason: '"///" has no usable slug' });
    expect(canonicals).not.toHaveBeenCalled();
    expect(setPrimary).not.toHaveBeenCalled();
  });

  it('refuses when the row vanished between queue render and click', async () => {
    findUnique.mockResolvedValue(null as never);
    const result = await refileToTopic('gone', 'linear-algebra');
    expect(result).toEqual({ kind: 'refused', reason: 'resource no longer exists' });
    expect(setPrimary).not.toHaveBeenCalled();
  });
});
