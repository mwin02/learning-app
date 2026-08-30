import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { describeError } from '@/lib/ai/describe-error';

// The real nesting the AI SDK produces for a generateObject schema failure:
// NoObjectGeneratedError → TypeValidationError → ZodError. Built from the SDK's
// own constructors so this test fails if that shape changes under us.
function schemaFailure(text: string) {
  const schema = z.object({ conceptsTaught: z.array(z.string()).min(1) });
  const parsed = schema.safeParse({ conceptsTaught: [] });
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    cause: TypeValidationError.wrap({ value: text, cause: parsed.error }),
    text,
    response: { id: 'r1', timestamp: new Date(0), modelId: 'gemini-2.5-flash' },
    usage: {
      inputTokens: 100,
      outputTokens: 8192,
      totalTokens: 8292,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: 6300, reasoningTokens: 1892 },
    },
    finishReason: 'length',
  });
}

describe('describeError', () => {
  it('keeps the top-level message', () => {
    expect(describeError(new Error('boom')).error).toBe('boom');
  });

  it('handles non-Error throws', () => {
    expect(describeError('plain string').error).toBe('plain string');
    expect(describeError(undefined).error).toBe('undefined');
  });

  it('surfaces finishReason and outputTokens from a generateObject failure', () => {
    const d = describeError(schemaFailure('{"results":['));
    expect(d.finishReason).toBe('length');
    expect(d.outputTokens).toBe(8192);
  });

  it('extracts the zod issue path from the nested cause chain', () => {
    const d = describeError(schemaFailure('{"results":['));
    expect(d.schemaIssues).toBeDefined();
    expect(d.schemaIssues!.join(' ')).toContain('conceptsTaught');
  });

  it('captures the raw response text and flags truncation', () => {
    const short = describeError(schemaFailure('{"a":1}'));
    expect(short.responseText).toBe('{"a":1}');
    expect(short.responseTextTruncated).toBeUndefined();

    const long = describeError(schemaFailure('x'.repeat(2000)));
    expect(long.responseText).toHaveLength(600);
    expect(long.responseTextTruncated).toBe(true);
  });

  it('walks a plain wrapped cause chain (TrackBuildError shape)', () => {
    const inner = new Error('remediation aborted: job deadline exceeded');
    const outer = new Error("Failed to build Track for Path 'p1'.", { cause: inner });

    const d = describeError(outer);
    expect(d.error).toBe("Failed to build Track for Path 'p1'.");
    expect(d.causes).toEqual(['remediation aborted: job deadline exceeded']);
  });

  it('omits absent fields rather than emitting undefined keys', () => {
    expect(describeError(new Error('bare'))).toEqual({ error: 'bare' });
  });

  it('caps cause messages and skips the node whose issues it already structured', () => {
    const d = describeError(schemaFailure('{"a":1}'));

    // The ZodError node is represented by schemaIssues, not repeated as prose.
    expect(d.causes).toHaveLength(1);
    expect(d.causes![0].length).toBeLessThanOrEqual(200);
    expect(d.causes![0]).toContain('Type validation failed');
  });

  it('terminates on a self-referential cause', () => {
    const err: Error & { cause?: unknown } = new Error('loop');
    err.cause = err;
    expect(describeError(err).causes).toEqual(['loop']);
  });
});
