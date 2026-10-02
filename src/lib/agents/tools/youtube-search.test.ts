import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';

// concepts.ts imports @/lib/db and @/lib/ai/models, which validate env at
// module-eval. The deriver's model hangs until its signal fires, so the test can
// see whether the caller's abort reaches the model call.
const seenSignals: (AbortSignal | undefined)[] = [];
vi.mock('@/lib/db', () => ({ prisma: { resource: { findMany: async () => [] } } }));
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({
    model: new MockLanguageModelV3({
      doGenerate: ({ abortSignal }) => {
        seenSignals.push(abortSignal);
        return new Promise((_, reject) => {
          abortSignal?.addEventListener('abort', () => reject(new Error('request cancelled')));
        });
      },
    }),
    temperature: undefined,
    maxOutputTokens: 1024,
  }),
}));

import { searchYouTubeForConcept } from './youtube-search';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  seenSignals.length = 0;
});

describe('searchYouTubeForConcept', () => {
  it("passes the caller's abort signal through to the concept deriver's model call", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
    vi.stubGlobal('fetch', async (url: URL) =>
      url.pathname.endsWith('/search')
        ? jsonResponse({ items: [{ id: { videoId: 'v1' } }] })
        : jsonResponse({
            items: [
              {
                id: 'v1',
                snippet: { title: 'Eigenvalues', description: 'A lesson', channelId: 'c1' },
                statistics: { viewCount: '5000000', likeCount: '1000' },
                contentDetails: { duration: 'PT15M' },
              },
            ],
          }),
    );

    const controller = new AbortController();
    const pending = searchYouTubeForConcept({
      topic: 'linear-algebra',
      conceptTitle: 'eigenvalues',
      maxResults: 5,
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(seenSignals).toHaveLength(1));
    expect(seenSignals[0]?.aborted).toBe(false);
    controller.abort();
    const rows = await pending;

    expect(seenSignals[0]?.aborted).toBe(true);
    // The aborted derivation ends that batch; the video falls back to the searched concept.
    expect(rows.map((r) => r.conceptsTaught)).toEqual([['eigenvalues']]);
  });
});
