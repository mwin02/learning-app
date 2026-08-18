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
  durationSource: 'reviewer',
  difficulty: 'beginner',
  requiresPurchase: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'atomic' } as never);
});

describe('updateResource', () => {
  it('returns not_found for an unknown id', async () => {
    findUnique.mockResolvedValue(null as never);
    const result = await updateResource('nope', { durationMin: 90 });
    expect(result.kind).toBe('not_found');
    expect(update).not.toHaveBeenCalled();
  });

  // Q9: the stamp travels with the number. Before it, a hand-measured duration was
  // written and still read `unknown` — indistinguishable from one nobody checked.
  it('applies a durationMin correction, stamping reviewer provenance', async () => {
    update.mockResolvedValue(row({ durationMin: 90 }) as never);
    const result = await updateResource('res_1', { durationMin: 90 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res_1' },
        data: { durationMin: 90, durationSource: 'reviewer' },
      }),
    );
    expect(result).toMatchObject({
      kind: 'updated',
      changed: ['durationMin'],
      embeddingStale: false,
    });
    expect(result).not.toHaveProperty('warning');
  });

  // The stamp is derived from the edit, not copied from the caller: an edit that
  // does not touch the duration must not relabel whatever provenance is stored.
  it('leaves durationSource alone when the edit does not touch durationMin', async () => {
    update.mockResolvedValue(row({ title: 'Better Title' }) as never);
    await updateResource('res_1', { title: 'Better Title' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res_1' }, data: { title: 'Better Title' } }),
    );
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

  // requiresPurchase is an access flag, not embedded text (buildEmbeddingText
  // reads title + summary + conceptsTaught only), so correcting it must not send
  // the row through the re-embedding backfill.
  it('applies a requiresPurchase correction without flagging embeddingStale', async () => {
    update.mockResolvedValue(row({ requiresPurchase: false }) as never);
    const result = await updateResource('res_1', { requiresPurchase: false });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res_1' }, data: { requiresPurchase: false } }),
    );
    expect(result).toMatchObject({
      kind: 'updated',
      changed: ['requiresPurchase'],
      embeddingStale: false,
    });
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

  // S6: a cleared duration is a retraction, not a measurement. `reviewer` is the
  // highest authority in the enum — no automated pass may overwrite it — so
  // stamping it here would freeze the row at "a human measured it as nothing".
  it('stamps unknown, not reviewer, when durationMin is cleared to null', async () => {
    update.mockResolvedValue(row({ durationMin: null, durationSource: 'unknown' }) as never);
    const result = await updateResource('res_1', { durationMin: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res_1' },
        data: { durationMin: null, durationSource: 'unknown' },
      }),
    );
    expect(result).toMatchObject({ kind: 'updated', changed: ['durationMin'] });
    expect(result).not.toHaveProperty('warning');
  });

  // The clear stays reachable on a row a reviewer already stamped: `reviewer` is
  // an authority over automated passes, not a lock against the next reviewer.
  it('clears a reviewer-stamped duration back to unknown', async () => {
    findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'atomic' } as never);
    update.mockResolvedValue(
      row({ durationMin: null, durationSource: 'unknown', type: 'video' }) as never,
    );
    const result = await updateResource('res_1', { type: 'video', durationMin: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { type: 'video', durationMin: null, durationSource: 'unknown' },
      }),
    );
    expect(result).toMatchObject({ kind: 'updated' });
    if (result.kind === 'updated') expect(result.resource.durationSource).toBe('unknown');
  });

  it('does not warn for an over-ceiling container (not directly attachable)', async () => {
    update.mockResolvedValue(
      row({ decompositionStatus: 'decomposed', durationMin: 1200 }) as never,
    );
    const result = await updateResource('res_1', { durationMin: 1200 });
    expect(result).not.toHaveProperty('warning');
  });

  // S6: the whole safety argument for a type edit is that an atomic row is
  // already in the never-examined state. A container's label has been acted on —
  // children exist — so correcting it there is a re-decompose decision.
  it.each(['decomposed', 'pending', 'unsupported', 'human_review'] as const)(
    'refuses a type edit on a %s row and writes nothing',
    async (decompositionStatus) => {
      findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus } as never);
      const result = await updateResource('res_1', { type: 'article' });
      expect(result).toEqual({
        kind: 'refused',
        reason: expect.stringContaining(decompositionStatus),
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('refuses a type edit on a container even when other fields are valid', async () => {
    findUnique.mockResolvedValue({ id: 'res_1', decompositionStatus: 'decomposed' } as never);
    const result = await updateResource('res_1', { type: 'video', title: 'Fine Title' });
    expect(result.kind).toBe('refused');
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['article', 'video'] as const)('retypes an atomic row to %s', async (type) => {
    update.mockResolvedValue(row({ type }) as never);
    const result = await updateResource('res_1', { type });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res_1' }, data: { type } }),
    );
    expect(result).toMatchObject({ kind: 'updated', changed: ['type'] });
    if (result.kind === 'updated') expect(result.resource.type).toBe(type);
  });

  // type is not in buildEmbeddingText (title + summary + conceptsTaught), so a
  // re-type must not send the row through the re-embedding backfill.
  it('does not flag embeddingStale for a type-only edit', async () => {
    update.mockResolvedValue(row({ type: 'video' }) as never);
    const result = await updateResource('res_1', { type: 'video' });
    expect(result).toMatchObject({ kind: 'updated', embeddingStale: false });
  });

  // A type edit carries no provenance stamp — there is no per-field provenance
  // column outside duration, and none is invented here.
  it('does not touch durationSource on a type-only edit', async () => {
    update.mockResolvedValue(row({ type: 'video' }) as never);
    await updateResource('res_1', { type: 'video' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res_1' }, data: { type: 'video' } }),
    );
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

  it('accepts requiresPurchase in both directions', () => {
    for (const value of [true, false]) {
      const parsed = resourceUpdateSchema.parse({
        resourceId: 'res_1',
        fields: { requiresPurchase: value },
      });
      expect(parsed.fields).toEqual({ requiresPurchase: value });
    }
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

  // S6: `type` left the exclusion list, narrowed to the two targets clause 6
  // needs. The container types stay out — that is decomposition's decision, and
  // `interactive` is excluded from the library as a class.
  it.each(['article', 'video'] as const)('accepts type: %s', (type) => {
    const parsed = resourceUpdateSchema.safeParse({ resourceId: 'r', fields: { type } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fields).toEqual({ type });
  });

  it.each(['book', 'course', 'docs', 'interactive'] as const)('rejects type: %s', (type) => {
    expect(resourceUpdateSchema.safeParse({ resourceId: 'r', fields: { type } }).success).toBe(
      false,
    );
  });

  // S6: null is "nobody has measured this; re-measure me" — the state a retyped
  // row needs when its number belonged to the wrong form.
  it('accepts a null durationMin as a retraction', () => {
    const parsed = resourceUpdateSchema.safeParse({
      resourceId: 'r',
      fields: { durationMin: null },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.fields).toEqual({ durationMin: null });
  });

  it('rejects a missing/blank resourceId', () => {
    expect(() => resourceUpdateSchema.parse({ fields: { durationMin: 5 } })).toThrow();
    expect(() =>
      resourceUpdateSchema.parse({ resourceId: '  ', fields: { durationMin: 5 } }),
    ).toThrow();
  });
});
