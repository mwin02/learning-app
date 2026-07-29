// Unit tests for the T3 batch minter. The gate itself is tested elsewhere
// (tests/integration/topic-gate-slug.test.ts); what matters here is the wrapper's two
// properties — memoize so a batch pays for one gate call per distinct label, and degrade
// to null so a gate failure never fails a sourcing run that already paid for discovery.
import { describe, it, expect, vi } from 'vitest';
import { createTopicMinter } from './topic-mint';

// topic-mint imports the topic gate, which pulls in the Vertex model registry; the
// injected gate below means no model is ever constructed.
vi.mock('@/lib/ai/models', () => ({ getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

describe('createTopicMinter', () => {
  it('returns the gate’s canonical', async () => {
    const mint = createTopicMinter(async () => ({ valid: true, canonical: 'algebra' }));
    expect(await mint('algebra')).toBe('algebra');
  });

  it('calls the gate once per distinct label within a batch', async () => {
    // Several rows of one batch commonly propose the same missing subject, and the gate's
    // tier 3 is an LLM call.
    const gate = vi.fn(async () => ({ valid: true, canonical: 'algebra' }));
    const mint = createTopicMinter(gate);
    await mint('algebra');
    await mint('Algebra');
    await mint(' algebra ');
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('caches a rejection too, so a junk label is not retried all batch', async () => {
    const gate = vi.fn(async () => ({ valid: false }));
    const mint = createTopicMinter(gate);
    expect(await mint('self-improvement')).toBeNull();
    expect(await mint('self-improvement')).toBeNull();
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('returns null when the gate throws, rather than propagating', async () => {
    const mint = createTopicMinter(async () => {
      throw new Error('No object generated');
    });
    expect(await mint('algebra')).toBeNull();
  });

  // A throw is not a verdict about the label. Caching it would let one rate-limit blip on
  // the first row suppress minting for every later row of the batch proposing the same
  // subject — a transport hiccup promoted to "this subject does not exist".
  it('does NOT cache a throw, so a later row can still mint the same subject', async () => {
    const gate = vi
      .fn<(t: string) => Promise<{ valid: boolean; canonical?: string }>>()
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockResolvedValue({ valid: true, canonical: 'algebra' });
    const mint = createTopicMinter(gate);
    expect(await mint('algebra')).toBeNull();
    expect(await mint('algebra')).toBe('algebra');
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty proposal without calling the gate', async () => {
    const gate = vi.fn(async () => ({ valid: true, canonical: 'algebra' }));
    const mint = createTopicMinter(gate);
    expect(await mint('   ')).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });
});
