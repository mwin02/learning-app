import type { GoogleLanguageModelOptions } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { vertex, chatModel } from '@/lib/ai/vertex';
import { withCallTiming } from '@/lib/ai/call-middleware';
import { agentOverride, type AgentOverride } from '@/lib/ai/compare-scope';

// Per-agent model configuration. Sampling params (temperature, thinkingLevel,
// maxOutputTokens) are per-agent decisions, not deployment knobs. Only
// `modelId` is overridable via env (`MODEL_<AGENT>`), so a deployment can swap
// models without a redeploy but can't silently change generation behavior.

export const AGENT_NAMES = [
  'curriculumFallback',
  'discoveryDescriber',
  'mapSpineAuthor',
  'mapSpineReviewer',
  'mapReviewer',
  'mapCandidateJudge',
  'onRampAuthor',
  'onRampCritic',
  'trackComposer',
  'trackSectioner',
  'conceptBankAuthor',
  'tagCanonicalizer',
  'topicClassifier',
  'conceptDeriver',
  'docTocExtractor',
  'validityAgent',
  'topicGate',
  'goalGate',
  'programPlanner',
  'programDecomposer',
  'intake',
  'health',
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

// Taken from the provider's own options type so the union tracks the SDK.
// @ai-sdk/google is a transitive dependency via @ai-sdk/google-vertex, which
// does not re-export its language-model options type; this import is type-only.
export type ThinkingLevel = NonNullable<
  NonNullable<GoogleLanguageModelOptions['thinkingConfig']>['thinkingLevel']
>;

export type ModelConfig = {
  modelId: string;
  // Omitted → the model's own default is used (nothing is sent).
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens: number;
  // Per-attempt bound; a timed-out attempt is retried once. Omitted → unbounded.
  callTimeoutMs?: number;
};

// The Vertex provider reads its options under `vertex` and falls back to
// `google`, so one key serves both the regional and global providers.
export type GoogleThinkingProviderOptions = {
  google: { thinkingConfig: { thinkingLevel: ThinkingLevel } };
};

// The only callable Pro-tier id: the GA ids `gemini-3-pro` and `gemini-3.1-pro`
// both 404 against this project (re-probed 2026-09-27). Retarget when one lands.
export const PRO_MODEL_ID = 'gemini-3.1-pro-preview';
export const FLASH_MODEL_ID = 'gemini-3.7-flash';

// The background Flash agents normally answer in seconds, but single calls have
// stalled silently for 2–3.75 min and held up a whole serial build behind them
// (`build-speed.md`, Diagnosis). 90 s cuts only the stalls. Pro agents and the
// request-path Flash agents get none until there are measured latencies to set it from.
const FLASH_CALL_TIMEOUT_MS = 90_000;

// No entry sets `temperature`. Gemini 3 is tuned for its default (1.0), and
// Google warns of looping and degraded reasoning below it; one structured-output
// probe on the Pro id at temperature 0 took 112s against 4.5s at the default.
//
// Thinking tokens count against `maxOutputTokens` (recorded outputTokens include
// them), so each ceiling has to cover thinking plus the answer. Unless an entry
// says otherwise, its number is inherited from tuning against the previous model
// generation, where a ceiling reached mid-thought returned no output at all, and
// is untested against 3.x.
//
// `thinkingLevel: 'low'` is set on the gate/classifier tier — agents that apply
// rules rather than reason — and on curriculumFallback (see its entry). On
// FLASH_MODEL_ID it cut a structured-output call from 385 output tokens (343
// thinking) to 31 (0 thinking). The authoring agents keep the model default
// until there are production numbers to tune to.
const REGISTRY: Record<AgentName, ModelConfig> = {
  curriculumFallback: {
    // Grounded Google Search discovery call. Pro because this is the
    // rare-but-important call that compounds the library; spending tokens here
    // saves them on every future request for the same topic.
    //
    // `low` thinking because a cold build runs one of these per remediation hole,
    // serially, and at the default each took 45 s – 2.6 min, 80–95% of its output
    // thinking — enough to push a cold topic past COURSE_JOB_DEADLINE_MS. The call
    // picks pages out of search results, which is judgement, not deep reasoning.
    // Measured 2026-09-29 on the real discovery call, same concept, same session:
    // 17.5 s / 680 thinking at `low` against 48.3 s / 4,263 at the default, with
    // 8 attested citations at both levels, so grounding is not traded away. An
    // earlier discovery-shaped probe agreed (13.0 s / 774 against 24.8 s / 2,275;
    // `medium` 21.9 s / 1,951 barely differs). Detail in `cold-build-deadline.md`.
    modelId: PRO_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 32768,
  },
  discoveryDescriber: {
    // Second half of the split discovery call: turns the grounded prose from
    // curriculumFallback into per-resource metadata, keyed by INDEX into the
    // attested URL set (tools/grounding.ts). No search tool and no URL field —
    // asking a grounded call for JSON is what disabled grounding in the first
    // place, and this call must never be in a position to write a URL at all.
    // Flash: restructuring text it was handed, not judging.
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 16384,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  mapSpineAuthor: {
    // Phase 2.5d-1: authors a topic's spine concept DAG (nodes + directed prereq
    // edges). Pro, not Flash — this is the infrequent, cached-forever curriculum
    // backbone every future Track for the topic traverses; quality of the concept
    // decomposition and prerequisite structure outweighs the per-call cost (same
    // reasoning as curriculumFallback). 32k output: a ~15-concept spine plus its
    // edge list plus thinking; matches the Pro fallback budget.
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 32768,
  },
  mapSpineReviewer: {
    // Phase 2.5d (spine hardening): the semantic critic over a structurally-valid
    // spine — judges completeness, missing foundations, a cold open (onboarding),
    // and connectivity, emitting advisory findings that drive one bounded author
    // revision. Pro, same tier + reasoning as the author it critiques: catching a
    // missing on-ramp or an assumed-but-absent foundation is judgment, not rule
    // application. 16k output: the findings array is small; the rest is thinking
    // headroom.
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 16384,
  },
  mapReviewer: {
    // Pre-Freeze Map Review (Block 1): the whole-map, resource-aware critic run
    // ONCE at the `building → spine_ready` freeze boundary. Sees the final assembled
    // map — every concept (spine + frontier), its edges, and each concept's chosen
    // primary resource — and emits `duplication` / `granularity` findings the
    // spine-only reviewer structurally can't (it runs pre-frontier/pre-split/pre-
    // resource). Flash, not Pro: this is rule-ish application over a pre-filtered
    // candidate set (the pure detector already found the similar pairs; the model
    // confirms/rejects), not open authoring — cheaper tier like mapCandidateJudge /
    // trackSectioner. 8k output: the findings array is small; the rest is thinking
    // headroom.
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 8192,
  },
  mapCandidateJudge: {
    // Phase 2.5d-2: scores a spine concept's candidate resources — assigns each
    // a role (teaches/uses/assesses) and a 0–1 coverageScore. Rule application
    // against the concept + each resource's own metadata, not open generation
    // (like conceptDeriver). 8k output: the verdict array is small; a tighter
    // ceiling capped mid-JSON under the previous model's thinking.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 8192,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  onRampAuthor: {
    // Phase 2g-3: writes the orientation on-ramp lesson (markdown) for a topic's
    // single on-ramp concept — what the subject is, the core mental model, setup /
    // notation, prerequisite review, the very first steps. Pro, not Flash: this is a
    // learner-facing artifact authored ONCE per topic and cached forever (same
    // reasoning as mapSpineAuthor / trackComposer), and orientation prose that is
    // subtly wrong about a subject's fundamentals is worse than none. 32k output
    // (matches the other Pro authors): the lesson itself is only ~600–900 words,
    // but at 16k the previous Pro model intermittently thought through the whole
    // budget and emitted nothing (NoOutputGeneratedError).
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 32768,
  },
  onRampCritic: {
    // Phase 2g-3: the accuracy self-critique pass over the authored draft — corrects
    // factual errors (a wrong definition, an off-by-one in a first-steps snippet, an
    // outdated setup instruction) while preserving the lesson's scope and structure,
    // returning the corrected lesson (unchanged when already accurate). Pro, same
    // tier as the author: catching a subtle factual slip in math/programming
    // fundamentals is judgment. 32k output (matches the author): it re-emits the
    // full corrected lesson after thinking.
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 32768,
  },
  trackComposer: {
    // Phase 2.5e-2: composes a learner's Track from a spine_ready map in one
    // call — prunes known concepts, ranks frontier by target mastery, picks each
    // lesson's primary (difficulty-matched), writes lesson + track framing, and
    // judges per-concept resource sufficiency. Pro, not Flash: this is the
    // judgment-heavy, learner-facing artifact (same reasoning as mapSpineAuthor),
    // and it reasons over the whole map at once. 32k output: a lesson object per
    // concept across a (frontier-thickened) map plus thinking; matches the
    // spine-author budget.
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 32768,
  },
  trackSectioner: {
    // Phase 2.5e (track sections): a separate post-build pass that groups an
    // already-ordered, already-trimmed lesson list into named chapters. Flash, not
    // Pro — far lighter than the composer: it sees only lesson titles/summaries (no
    // map, edges, or candidates) and just draws chapter boundaries + writes short
    // intros. Best-effort (a failure leaves the Track flat), so the cheap tier is
    // right. 8k output: the boundaries array is small; a tighter ceiling capped
    // mid-JSON under the previous model's thinking.
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 8192,
  },
  conceptBankAuthor: {
    // Phase 2.5h: authors a small question bank (text + MCQ) for ONE concept,
    // generated once near spine-readiness and later sampled into per-Lesson
    // exercises at Track build. Pro, not Flash — the hard part is JUDGMENT, not
    // volume: the author sees only the concept title + its resource titles (not the
    // resource content), so it must reason carefully about what those resources
    // plausibly cover and NOT over-reach into deep specifics they don't establish.
    // Flash over-reached at 8 questions; Pro authors a tighter, better-calibrated
    // set of 5. Off-the-hot-path (best-effort, once per concept), so the Pro cost is
    // fine. 32k output (matches the other Pro authors): the question array is
    // small; the rest is thinking headroom.
    modelId: PRO_MODEL_ID,
    maxOutputTokens: 32768,
  },
  tagCanonicalizer: {
    // Plain JSON shape, no grounding. Deterministic mapping job, but the input
    // is the whole atomic survivor batch (oversampled discovery), so the
    // results array scales with batch size. At 4k the previous model capped
    // mid-JSON on realistic batches, throwing AI_JSONParseError;
    // canonicalizeTags degrades to raw tags on that failure, and 8k keeps the
    // degradation rare rather than routine.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 8192,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  topicClassifier: {
    // Phase 2.5-Block2a: files each discovered resource under its home topic,
    // chosen from a small closed set (the request topic ∪ its related topics).
    // Short closed-choice output (one slug per resource), with the canonicalizer's
    // headroom; the caller degrades to the request topic on any failure.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 8192,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  conceptDeriver: {
    // Phase 2.5b-2: re-derives per-child conceptsTaught/prerequisiteConcepts for
    // the videos of a decomposed playlist from each video's own title +
    // description, canonicalized against the topic's existing vocab. Rule
    // application like tagCanonicalizer, but over more rows (chunked) and a
    // little freer output.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 8192,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  docTocExtractor: {
    // Phase 2.5b-3: given a doc-course page's title + body snippet + the real
    // anchor links we extracted, decides whether the page is itself one lesson
    // (atomic) or an index of lessons, and SELECTS/orders the section links
    // (it never invents URLs — it picks from the provided set). 16k, not 8k:
    // large tables of contents (javascript.info, MDN Learn, Paul's Calc) starved
    // an 8k budget under the previous model, capping mid-object
    // (NoObjectGeneratedError → the row parks as 'pending').
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 16384,
  },
  validityAgent: {
    // Content-rule check over a batch of ~12 URLs at a time. Flash + a sharp
    // prompt is the right tier — this is rule application, not reasoning.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 4096,
    callTimeoutMs: FLASH_CALL_TIMEOUT_MS,
  },
  topicGate: {
    // One-shot subject-domain classifier ({math, science, cs} or reject).
    // Cheap, deterministic; runs at the HTTP boundary for off-library topics.
    // The verdict object is tiny; the 2048 ceiling is thinking headroom — at 512
    // the previous model could cap mid-object (NoObjectGeneratedError → an
    // unhandled throw that fails the generate-program plan pass).
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 2048,
  },
  goalGate: {
    // Goal-domain gate: a one-shot classifier that decides whether a Program GOAL is
    // a legitimate learnable objective within {math, natural science, cs} — the
    // goal-level analog of topicGate, run as Stage 0 of the plan pass so an
    // off-domain / nonsense goal is rejected BEFORE the decomposer rescues it into
    // plausible in-domain topics. Same tier + budget rationale as topicGate.
    modelId: FLASH_MODEL_ID,
    thinkingLevel: 'low',
    maxOutputTokens: 2048,
  },
  programPlanner: {
    // Phase 2.75b: the program plan pass — decomposes a goal into ≤N single-topic
    // learning topics with per-topic importance/gap weights, priority tier, phase
    // grouping, and cross-topic order. Flash, not Pro: the roadmap frames this as a
    // "cheap synchronous plan pass", and it's judgment over a short goal, not the
    // deep spine-authoring of mapSpineAuthor. 16k output (not 8k): under the
    // previous model an 8k ceiling occasionally capped mid-JSON → a `No object
    // generated: could not parse` throw that sank the whole plan pass (seen once
    // in the 2.75 full e2e).
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 16384,
  },
  programDecomposer: {
    // Decomposer-agent plan (Block 2): the tool-using Stage-1 decomposition agent —
    // same job as programPlanner (goal → ≤N gated single-topic tracks) but driving a
    // tool loop (get_path_map / propose_course / finalize) instead of one
    // generateObject call, and additionally deciding per-topic frontier-concept
    // requests. Starts on programPlanner's tier per the plan's ambiguity #6 default
    // (Flash; the reasoning is still judgment over a short goal, now spread across
    // steps) — bump only if tool-loop quality is weak in a live run. Same 16k
    // budget: per-step output is small (tool args); the rest is thinking headroom.
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 16384,
  },
  intake: {
    // Chat intake (Block 2): one non-streaming structured call per /programs/new
    // chat turn — conversation + field extraction over a short fenced transcript.
    // Extraction + chitchat, not judgment (plan-pass reasoning stays in
    // programDecomposer), so Flash; overridable via MODEL_INTAKE. 4k output: the
    // reply is a couple of sentences + a small draft object; the rest is thinking
    // headroom.
    modelId: FLASH_MODEL_ID,
    maxOutputTokens: 4096,
  },
  health: {
    modelId: FLASH_MODEL_ID,
    // The reply is one token ("pong"); the rest is thinking. Measured 2026-09-27,
    // a one-word reply spent at most 96 thinking tokens on any callable 3.x id,
    // so 512 also covers a MODEL_HEALTH override to another 3.x model.
    maxOutputTokens: 512,
  },
};

export type ResolvedModel = {
  model: LanguageModel;
  modelId: string;
  temperature: number | undefined;
  maxOutputTokens: number;
  callTimeoutMs?: number;
  providerOptions?: GoogleThinkingProviderOptions;
};

// `envOverride` is the raw `MODEL_<AGENT>` value; blank means "no override".
export function resolveModel(
  cfg: ModelConfig,
  envOverride: string | undefined,
  agent: AgentName,
): ResolvedModel {
  const override = envOverride?.trim();
  const modelId = override && override.length > 0 ? override : cfg.modelId;
  return {
    model: withCallTiming(chatModel(modelId), agent, { timeoutMs: cfg.callTimeoutMs }),
    modelId,
    temperature: cfg.temperature,
    maxOutputTokens: cfg.maxOutputTokens,
    callTimeoutMs: cfg.callTimeoutMs,
    providerOptions:
      cfg.thinkingLevel === undefined
        ? undefined
        : { google: { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } } },
  };
}

// `null` clears an optional field back to the model default; omitted keeps the registry's.
export function applyOverride(cfg: ModelConfig, override: AgentOverride): ModelConfig {
  const pick = <T>(value: T | null | undefined, fallback: T | undefined): T | undefined =>
    value === null ? undefined : (value ?? fallback);
  return {
    ...cfg,
    modelId: override.modelId ?? cfg.modelId,
    thinkingLevel: pick(override.thinkingLevel, cfg.thinkingLevel),
    maxOutputTokens: override.maxOutputTokens ?? cfg.maxOutputTokens,
    callTimeoutMs: pick(override.callTimeoutMs, cfg.callTimeoutMs),
  };
}

// Inside a comparison scope the agent's override is applied to its registry entry,
// and its `modelId`, when set, beats `MODEL_<AGENT>` too.
export function getModel(name: AgentName): ResolvedModel {
  const envOverride = process.env[`MODEL_${name.toUpperCase()}`];
  const override = agentOverride(name);
  if (override === undefined) return resolveModel(REGISTRY[name], envOverride, name);
  return resolveModel(applyOverride(REGISTRY[name], override), override.modelId ?? envOverride, name);
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
