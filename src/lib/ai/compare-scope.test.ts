import { describe, expect, it } from 'vitest';
import {
  agentOverride,
  compareSink,
  runWithCompareScope,
  type CompareCallRecord,
} from '@/lib/ai/compare-scope';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('compare scope', () => {
  it('is empty outside any scope', () => {
    expect(agentOverride('conceptBankAuthor')).toBeUndefined();
    expect(compareSink()).toBeUndefined();
  });

  it('exposes the override and sink inside, across an await', async () => {
    const records: CompareCallRecord[] = [];
    const sink = (record: CompareCallRecord) => records.push(record);
    await runWithCompareScope(
      { overrides: { conceptBankAuthor: { modelId: 'm-a' } }, sink },
      async () => {
        await tick();
        expect(agentOverride('conceptBankAuthor')).toEqual({ modelId: 'm-a' });
        expect(agentOverride('trackComposer')).toBeUndefined();
        expect(compareSink()).toBe(sink);
      },
    );
    expect(agentOverride('conceptBankAuthor')).toBeUndefined();
  });

  it('lets a nested scope replace the outer one, then restores it', async () => {
    const outerSink = () => {};
    await runWithCompareScope(
      { overrides: { conceptBankAuthor: { modelId: 'outer' } }, sink: outerSink },
      async () => {
        await runWithCompareScope(
          { overrides: { trackComposer: { modelId: 'inner' } } },
          async () => {
            await tick();
            expect(agentOverride('trackComposer')).toEqual({ modelId: 'inner' });
            expect(agentOverride('conceptBankAuthor')).toBeUndefined();
            expect(compareSink()).toBeUndefined();
          },
        );
        expect(agentOverride('conceptBankAuthor')).toEqual({ modelId: 'outer' });
        expect(agentOverride('trackComposer')).toBeUndefined();
        expect(compareSink()).toBe(outerSink);
      },
    );
  });

  it('isolates two concurrent scopes in one Promise.all', async () => {
    const seen = await Promise.all(
      ['m-a', 'm-b'].map((modelId) =>
        runWithCompareScope({ overrides: { conceptBankAuthor: { modelId } } }, async () => {
          const ids: (string | undefined)[] = [];
          for (let i = 0; i < 3; i += 1) {
            await tick();
            ids.push(agentOverride('conceptBankAuthor')?.modelId);
          }
          return ids;
        }),
      ),
    );
    expect(seen).toEqual([
      ['m-a', 'm-a', 'm-a'],
      ['m-b', 'm-b', 'm-b'],
    ]);
  });
});
