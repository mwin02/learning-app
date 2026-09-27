import { describe, it, expect, vi, afterEach } from 'vitest';

// models.ts imports the vertex leaf, which throws at module-eval without
// GOOGLE_VERTEX_PROJECT; resolution itself never calls the provider.
vi.mock('@/lib/ai/vertex', () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  vertexAnthropic: {},
  vertexGlobal: {},
}));

import {
  AGENT_NAMES,
  getModel,
  resolveModel,
  type ModelConfig,
} from '@/lib/ai/models';

const base: ModelConfig = {
  modelId: 'gemini-test',
  temperature: 0.2,
  maxOutputTokens: 1024,
};

describe('getModel — registry', () => {
  it('has 22 agents', () => {
    expect(AGENT_NAMES).toHaveLength(22);
  });

  it.each(AGENT_NAMES)('%s resolves with a non-empty modelId', (name) => {
    expect(getModel(name).modelId.length).toBeGreaterThan(0);
  });
});

describe('resolveModel — thinkingLevel', () => {
  it('leaves providerOptions undefined when no thinkingLevel is set', () => {
    expect(resolveModel(base, undefined).providerOptions).toBeUndefined();
  });

  it('builds the google thinkingConfig when thinkingLevel is set', () => {
    expect(resolveModel({ ...base, thinkingLevel: 'low' }, undefined).providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
    });
  });
});

describe('resolveModel — temperature', () => {
  it('passes a configured temperature through', () => {
    expect(resolveModel(base, undefined).temperature).toBe(0.2);
  });

  it('returns undefined when the config omits temperature', () => {
    const noTemp: ModelConfig = { modelId: 'gemini-test', maxOutputTokens: 1024 };
    expect(resolveModel(noTemp, undefined).temperature).toBeUndefined();
  });
});

describe('getModel — MODEL_<AGENT> override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces the registry modelId', () => {
    vi.stubEnv('MODEL_HEALTH', 'gemini-override');
    expect(getModel('health').modelId).toBe('gemini-override');
  });

  it('trims the override', () => {
    vi.stubEnv('MODEL_HEALTH', '  gemini-override  ');
    expect(getModel('health').modelId).toBe('gemini-override');
  });

  it.each(['', '   '])('falls back to the registry for %j', (value) => {
    const registryId = getModel('health').modelId;
    vi.stubEnv('MODEL_HEALTH', value);
    expect(getModel('health').modelId).toBe(registryId);
    expect(registryId).not.toBe(value);
  });
});
