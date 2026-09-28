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

describe('getModel — tiers', () => {
  const PRO_AGENTS = [
    'curriculumFallback',
    'mapSpineAuthor',
    'mapSpineReviewer',
    'onRampAuthor',
    'onRampCritic',
    'trackComposer',
    'conceptBankAuthor',
  ] as const;

  const LOW_THINKING_AGENTS = [
    'topicGate',
    'goalGate',
    'validityAgent',
    'tagCanonicalizer',
    'topicClassifier',
    'conceptDeriver',
    'mapCandidateJudge',
    'curriculumFallback',
  ] as const;

  const isIn = (list: readonly string[], name: string) => list.includes(name);

  // chatModel routes by prefix, and only `gemini-3*` goes to the global provider.
  it.each(AGENT_NAMES)('%s resolves to a gemini-3 id', (name) => {
    expect(getModel(name).modelId.startsWith('gemini-3')).toBe(true);
  });

  it('puts every Pro-tier agent on one id that no other agent uses', () => {
    const proIds = new Set(PRO_AGENTS.map((name) => getModel(name).modelId));
    expect(proIds.size).toBe(1);
    const [proId] = proIds;
    const others = AGENT_NAMES.filter((name) => !isIn(PRO_AGENTS, name));
    expect(others).toHaveLength(15);
    for (const name of others) expect(getModel(name).modelId).not.toBe(proId);
  });

  it.each(AGENT_NAMES)('%s sets no temperature', (name) => {
    expect(getModel(name).temperature).toBeUndefined();
  });

  it.each(AGENT_NAMES)('%s has low thinking only if it is a gate/classifier or discovery', (name) => {
    const { providerOptions } = getModel(name);
    if (isIn(LOW_THINKING_AGENTS, name)) {
      expect(providerOptions).toEqual({
        google: { thinkingConfig: { thinkingLevel: 'low' } },
      });
    } else {
      expect(providerOptions).toBeUndefined();
    }
  });
});

describe('getModel — curriculumFallback', () => {
  it('runs grounded discovery on the Pro id at low thinking', () => {
    const { modelId, providerOptions } = getModel('curriculumFallback');
    expect(modelId).toBe(getModel('mapSpineAuthor').modelId);
    expect(providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
    });
  });

  it('leaves every other Pro agent at the model default', () => {
    const otherPro = [
      'mapSpineAuthor',
      'mapSpineReviewer',
      'onRampAuthor',
      'onRampCritic',
      'trackComposer',
      'conceptBankAuthor',
    ] as const;
    for (const name of otherPro) expect(getModel(name).providerOptions).toBeUndefined();
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
