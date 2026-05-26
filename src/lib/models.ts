import type { LanguageModel } from 'ai';
import { vertex } from '@/lib/vertex';

// Per-agent model configuration. Each call site declares its own sampling
// params (temperature, maxOutputTokens) because those are call-site
// decisions, not deployment knobs. Only `modelId` is overridable via env
// (`MODEL_<AGENT>`), so a deployment can swap models without a redeploy
// but can't silently change generation behavior.

type AgentName = 'curriculum' | 'health';

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
