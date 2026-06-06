import type { LanguageModel } from 'ai';
import { vertex } from '@/lib/ai/vertex';

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
  | 'topicClassifier'
  | 'conceptDeriver'
  | 'docTocExtractor'
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
    // Plain JSON shape, no grounding. Deterministic mapping job, but the input
    // is the whole atomic survivor batch (oversampled discovery), so the
    // results array scales with batch size. At 4k, Flash 2.5 (which spends
    // output budget on thinking first) capped mid-JSON on realistic batches,
    // throwing AI_JSONParseError; canonicalizeTags now degrades to raw tags on
    // that failure, but 8k keeps the degradation rare rather than routine.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  topicClassifier: {
    // Phase 2.5-Block2a: files each discovered resource under its home topic,
    // chosen from a small closed set (the request topic ∪ its related topics).
    // Short closed-choice output (one slug per resource), but Flash 2.5 spends
    // budget on thinking first, so keep headroom like the canonicalizer; the
    // caller degrades to the request topic on any failure.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  conceptDeriver: {
    // Phase 2.5b-2: re-derives per-child conceptsTaught/prerequisiteConcepts for
    // the videos of a decomposed playlist from each video's own title +
    // description, canonicalized against the topic's existing vocab. Rule
    // application like tagCanonicalizer, but over more rows (chunked) and a
    // little freer output, so a larger budget than the 4k canonicalizer.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  docTocExtractor: {
    // Phase 2.5b-3: given a doc-course page's title + body snippet + the real
    // anchor links we extracted, decides whether the page is itself one lesson
    // (atomic) or an index of lessons, and SELECTS/orders the section links
    // (it never invents URLs — it picks from the provided set). 16k, not 8k:
    // large tables of contents (javascript.info, MDN Learn, Paul's Calc) starved
    // an 8k budget — Flash 2.5 spends output tokens on thinking first and caps
    // mid-object (NoObjectGeneratedError → the row parks as 'pending'). 16k
    // leaves room for thinking + a long sections array.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 16384,
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
