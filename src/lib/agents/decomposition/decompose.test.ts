// Unit tests for the Block 0 attachable-duration gate in decompose(): an
// `atomic` outcome (classifier fast-path OR a router's keep-whole reroute) whose
// durationMin exceeds MAX_ATTACHABLE_DURATION_MIN parks as human_review — only
// atomic units may be pickable, and a whole-course/book row is not one.
import { describe, it, expect, vi } from 'vitest';

// The real routers pull in the LLM (doctoc → getModel → vertex) and YouTube API at
// module-eval; the gate under test never runs them, so stub both router modules.
vi.mock('@/lib/agents/decomposition/youtube', () => ({ decomposePlaylist: vi.fn() }));
vi.mock('@/lib/agents/decomposition/doctoc', () => ({ decomposeDocToc: vi.fn() }));

import { decompose } from '@/lib/agents/decomposition/decompose';
import { decomposeDocToc } from '@/lib/agents/decomposition/doctoc';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';

const base = {
  title: 'T',
  topic: 'calculus',
  difficulty: 'intermediate',
  summary: 'S',
  conceptsTaught: [],
};
const OVER = MAX_ATTACHABLE_DURATION_MIN + 100;

describe('decompose — attachable duration gate on atomic outcomes', () => {
  it('classifier fast-path atomic over the ceiling → human_review with reason', async () => {
    const res = await decompose({ ...base, url: 'https://example.com/a', type: 'video', durationMin: OVER });
    expect(res.status).toBe('human_review');
    expect(res.children).toEqual([]);
    expect(res.reason).toMatch(/attachable ceiling/);
  });

  it('atomic at/under the ceiling and with no duration stays atomic', async () => {
    for (const durationMin of [MAX_ATTACHABLE_DURATION_MIN, 45, undefined]) {
      const res = await decompose({ ...base, url: 'https://example.com/a', type: 'video', durationMin });
      expect(res.status).toBe('atomic');
    }
  });

  it("doc-toc router's keep-whole atomic reroute is gated too (the OCW-course escape)", async () => {
    vi.mocked(decomposeDocToc).mockResolvedValueOnce({
      ok: false,
      outcome: 'atomic',
      reason: 'single self-contained lesson',
    } as never);
    const res = await decompose({ ...base, url: 'https://ocw.example.edu/course', type: 'course', durationMin: OVER });
    expect(res.status).toBe('human_review');
    expect(res.reason).toMatch(/attachable ceiling/);
  });

  it('a successful decomposition is untouched by the ceiling (parent duration is fine on a container)', async () => {
    vi.mocked(decomposeDocToc).mockResolvedValueOnce({
      ok: true,
      children: [{ url: 'https://ocw.example.edu/course/ch1' }],
    } as never);
    const res = await decompose({ ...base, url: 'https://ocw.example.edu/course', type: 'course', durationMin: OVER });
    expect(res.status).toBe('decomposed');
    expect(res.children.length).toBe(1);
  });

  it("doc-toc's non-atomic failure outcomes pass through ungated", async () => {
    vi.mocked(decomposeDocToc).mockResolvedValueOnce({
      ok: false,
      outcome: 'human_review',
      reason: 'fetch failed',
    } as never);
    const res = await decompose({ ...base, url: 'https://ocw.example.edu/course', type: 'course', durationMin: OVER });
    expect(res.status).toBe('human_review');
    expect(res.reason).toBe('fetch failed');
  });
});
