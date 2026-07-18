// Unit tests for the resource-update lib (metadata-edit axis) and its Zod
// schema. Prisma is stubbed (module-eval gotcha: @/lib/db validates env at
// import), so these run secret-free — the live path is covered by the manual
// PATCH verification against the dev server.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    resource: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';
import { updateResource, type UpdatedResource } from '@/lib/curation/update-resource';
import { resourceUpdateSchema } from '@/lib/api/resource-update-schema';

const findUnique = vi.mocked(prisma.resource.findUnique);
const update = vi.mocked(prisma.resource.update);

const row = (over: Partial<UpdatedResource> = {}): UpdatedResource => ({
  id: 'res_1',
  title: 'A Resource',
  url: 'https://example.com/a',
  type: 'article',
  status: 'pending_review',
  decompositionStatus: 'atomic',
  durationMin: 45,
  difficulty: 'beginner',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ id: 'res_1' } as never);
});

describe('updateResource', () => {
  it('returns not_found for an unknown id', async () => {
    findUnique.mockResolvedValue(null as never);
    const result = await updateResource('nope', { durationMin: 90 });
    expect(result.kind).toBe('not_found');
    expect(update).not.toHaveBeenCalled();
  });

  it('applies a durationMin correction with no embedding or ceiling flags', async () => {
    update.mockResolvedValue(row({ durationMin: 90 }) as never);
    const result = await updateResource('res_1', { durationMin: 90 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res_1' }, data: { durationMin: 90 } }),
    );
    expect(result).toMatchObject({
      kind: 'updated',
      changed: ['durationMin'],
      embeddingStale: false,
    });
    expect(result).not.toHaveProperty('warning');
  });

  it('flags embeddingStale when title changes', async () => {
    update.mockResolvedValue(row({ title: 'Better Title' }) as never);
    const result = await updateResource('res_1', { title: 'Better Title' });
    expect(result).toMatchObject({ kind: 'updated', embeddingStale: true });
  });

  it('flags embeddingStale when summary changes', async () => {
    update.mockResolvedValue(row() as never);
    const result = await updateResource('res_1', { summary: 'A much better summary.' });
    expect(result).toMatchObject({ kind: 'updated', embeddingStale: true });
  });

  it('does not flag embeddingStale for difficulty', async () => {
    update.mockResolvedValue(row({ difficulty: 'advanced' }) as never);
    const result = await updateResource('res_1', { difficulty: 'advanced' });
    expect(result).toMatchObject({ kind: 'updated', embeddingStale: false });
  });

  it('warns when the update leaves an atomic row over the attach ceiling', async () => {
    const over = MAX_ATTACHABLE_DURATION_MIN + 100;
    update.mockResolvedValue(row({ durationMin: over }) as never);
    const result = await updateResource('res_1', { durationMin: over });
    expect(result.kind).toBe('updated');
    if (result.kind === 'updated') {
      expect(result.warning).toContain('attachable ceiling');
      expect(result.warning).toContain('do not approve');
    }
  });

  it('warns off the post-update row even when durationMin was not the edited field', async () => {
    update.mockResolvedValue(
      row({ title: 'Whole Book', durationMin: MAX_ATTACHABLE_DURATION_MIN + 1 }) as never,
    );
    const result = await updateResource('res_1', { title: 'Whole Book' });
    if (result.kind === 'updated') expect(result.warning).toContain('attachable ceiling');
  });

  it('does not warn at exactly the ceiling', async () => {
    update.mockResolvedValue(row({ durationMin: MAX_ATTACHABLE_DURATION_MIN }) as never);
    const result = await updateResource('res_1', { durationMin: MAX_ATTACHABLE_DURATION_MIN });
    expect(result).not.toHaveProperty('warning');
  });

  it('does not warn for an over-ceiling container (not directly attachable)', async () => {
    update.mockResolvedValue(
      row({ decompositionStatus: 'decomposed', durationMin: 1200 }) as never,
    );
    const result = await updateResource('res_1', { durationMin: 1200 });
    expect(result).not.toHaveProperty('warning');
  });
});

describe('resourceUpdateSchema', () => {
  it('accepts a valid single-field update', () => {
    const parsed = resourceUpdateSchema.parse({ resourceId: 'res_1', fields: { durationMin: 90 } });
    expect(parsed.fields).toEqual({ durationMin: 90 });
  });

  it('accepts multiple whitelisted fields', () => {
    const parsed = resourceUpdateSchema.parse({
      resourceId: 'res_1',
      fields: { title: 'T', summary: 'A summary long enough.', difficulty: 'advanced' },
    });
    expect(Object.keys(parsed.fields)).toHaveLength(3);
  });

  it('rejects empty fields (at least one required)', () => {
    expect(() => resourceUpdateSchema.parse({ resourceId: 'res_1', fields: {} })).toThrow();
  });

  it('rejects non-whitelisted fields instead of silently stripping them', () => {
    for (const bad of [{ url: 'https://x.com' }, { status: 'active' }, { type: 'book' }, { decompositionStatus: 'atomic' }]) {
      expect(() => resourceUpdateSchema.parse({ resourceId: 'res_1', fields: bad })).toThrow();
    }
  });

  it('enforces the discovery clamp on durationMin', () => {
    for (const bad of [0, 6001, 2.5]) {
      expect(() =>
        resourceUpdateSchema.parse({ resourceId: 'res_1', fields: { durationMin: bad } }),
      ).toThrow();
    }
    expect(() =>
      resourceUpdateSchema.parse({ resourceId: 'res_1', fields: { durationMin: 6000 } }),
    ).not.toThrow();
  });

  it('rejects a missing/blank resourceId', () => {
    expect(() => resourceUpdateSchema.parse({ fields: { durationMin: 5 } })).toThrow();
    expect(() =>
      resourceUpdateSchema.parse({ resourceId: '  ', fields: { durationMin: 5 } }),
    ).toThrow();
  });
});
