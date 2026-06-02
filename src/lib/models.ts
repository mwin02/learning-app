import type { LanguageModel } from 'ai';
import { vertex } from '@/lib/vertex';

// Per-agent model configuration. Each call site declares its own sampling
// params (temperature, maxOutputTokens) because those are call-site
// decisions, not deployment knobs. Only `modelId` is overridable via env
// (`MODEL_<AGENT>`), so a deployment can swap models without a redeploy
// but can't silently change generation behavior.

type AgentName =
  | 'curriculum'
  | 'curriculumRetrieval'
  | 'curriculumCritic'
  | 'curriculumFallback'
  | 'tagCanonicalizer'
  | 'validityAgent'
  | 'topicGate'
  | 'health';

type ModelConfig = {
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
};

const REGISTRY: Record<AgentName, ModelConfig> = {
  curriculum: {
    modelId: 'gemini-2.5-flash',
    temperature: 0.4,
    // Gemini 2.5 Flash consumes part of this budget on internal "thinking"
    // before emitting the response, so 4k can finish mid-JSON on a path
    // with many candidates. 16k leaves headroom for thinking + a path of
    // ~10 items with verbose rationales.
    maxOutputTokens: 16384,
  },
  curriculumRetrieval: {
    // AR-3 retrieval loop: a tool-calling Flash agent that gathers candidate
    // resources (searchResources / getResourceDetails / triggerWebFallback).
    // Slightly above zero so successive searches vary their queries rather
    // than repeating; output budget covers per-step thinking + tool-call args
    // across several steps.
    modelId: 'gemini-2.5-flash',
    temperature: 0.3,
    maxOutputTokens: 8192,
  },
  curriculumCritic: {
    // AR-6 self-review: a separate no-tools call that scores the emitted path
    // against an explicit rubric (prereq ordering, budget fit, redundancy,
    // difficulty match, rationale specificity) and returns structured findings.
    // Rule application, not creation — temperature 0 for a stable verdict.
    // The findings themselves are small (five short notes + consolidated
    // feedback), but Flash 2.5 spends the budget on internal thinking FIRST and
    // emits nothing if it caps mid-thought (NoOutputGeneratedError). Observed
    // ~2.2k reasoning tokens on the comparable select call, so a 2k budget
    // starved the critic; 8k leaves ample headroom for thinking + the verdict.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  curriculumFallback: {
    // Grounded Google Search discovery call. Upgraded to Pro for 2c.5 — this
    // is the rare-but-important call that compounds the library; spending
    // tokens here saves them on every future request for the same topic.
    // Temperature low-ish so the model sticks to authoritative URLs from the
    // search citations instead of free-styling, but not zero — we want
    // variety across deny-list retries inside one fallback loop.
    modelId: 'gemini-2.5-pro',
    temperature: 0.3,
    maxOutputTokens: 32768,
  },
  tagCanonicalizer: {
    // Plain JSON shape, no grounding. Deterministic mapping job.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 4096,
  },
  validityAgent: {
    // Content-rule check over a batch of ~12 URLs at a time. Flash + a sharp
    // prompt is the right tier — this is rule application, not reasoning.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 4096,
  },
  topicGate: {
    // One-shot subject-domain classifier ({math, science, cs} or reject).
    // Cheap, deterministic; runs at the HTTP boundary for off-library topics.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 512,
  },
  health: {
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    // The reply is one token ("pong"), but Gemini 2.5 burns part of the
    // output budget on internal thinking first. 32 was enough for Flash
    // and zero for Pro. 512 covers thinking for any 2.5-tier model.
    maxOutputTokens: 512,
  },
};

export type ResolvedModel = {
  model: LanguageModel;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
};

export function getModel(name: AgentName): ResolvedModel {
  const cfg = REGISTRY[name];
  const envKey = `MODEL_${name.toUpperCase()}`;
  const override = process.env[envKey]?.trim();
  const modelId = override && override.length > 0 ? override : cfg.modelId;
  return {
    model: vertex(modelId),
    modelId,
    temperature: cfg.temperature,
    maxOutputTokens: cfg.maxOutputTokens,
  };
}

// Embedding models are kept separate from the chat `REGISTRY` above: they have
// no temperature / maxOutputTokens, and `dimensions` must match the
// vector(N) column in the Resource migration. Overridable via MODEL_EMBEDDING,
// but a swap that changes dimensions also needs a migration + full re-embed.
const EMBEDDING_MODEL = {
  modelId: 'text-embedding-005',
  dimensions: 768,
};

export function getEmbeddingModel() {
  const override = process.env.MODEL_EMBEDDING?.trim();
  const modelId =
    override && override.length > 0 ? override : EMBEDDING_MODEL.modelId;
  return {
    model: vertex.textEmbeddingModel(modelId),
    modelId,
    dimensions: EMBEDDING_MODEL.dimensions,
  };
}
