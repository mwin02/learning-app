// F3a: the triage `edit` payload and PATCH /api/playground/resources land on the
// same updateResource, so they must accept exactly the same fields. This file
// pins that they do — the bug it guards against is a second, looser copy of the
// bounds drifting back in, which let `durationMin: 99999` through one route and
// 400 on the other while both wrote the same column.

import { describe, it, expect } from 'vitest';

import { reportTriageSchema } from '@/lib/api/report-triage-schema';
import { resourceUpdateSchema } from '@/lib/api/resource-update-schema';

const edit = (fields: Record<string, unknown>) =>
  reportTriageSchema.safeParse({ action: 'edit', reportId: 'rep_1', fields });

describe('reportTriageSchema — edit fields', () => {
  it('accepts what the canonical schema accepts', () => {
    const parsed = edit({ durationMin: 90, difficulty: 'beginner' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.action === 'edit' && parsed.data.fields).toEqual({
      durationMin: 90,
      difficulty: 'beginner',
    });
  });

  it.each([
    ['a duration over the discovery clamp', { durationMin: 99_999 }],
    ['a summary under the canonical minimum', { summary: 'x' }],
    ['a fractional duration', { durationMin: 12.5 }],
    ['no fields at all', {}],
  ])('rejects %s, exactly as the canonical schema does', (_name, fields) => {
    expect(edit(fields).success).toBe(false);
    expect(resourceUpdateSchema.safeParse({ resourceId: 'res_1', fields }).success).toBe(false);
  });

  // strictObject, not a stripping object: a typo'd field name is a failed edit
  // the operator must see, not a silent no-op reported as success.
  it('rejects an unknown key rather than stripping it', () => {
    const parsed = edit({ durationMin: 90, url: 'https://example.com' });
    expect(parsed.success).toBe(false);
  });
});
