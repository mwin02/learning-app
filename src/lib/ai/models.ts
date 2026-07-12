import type { LanguageModel } from 'ai';
import { vertex, chatModel } from '@/lib/ai/vertex';

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
  | 'mapSpineAuthor'
  | 'mapSpineReviewer'
  | 'mapReviewer'
  | 'mapCandidateJudge'
  | 'onRampAuthor'
  | 'onRampCritic'
  | 'trackComposer'
  | 'trackSectioner'
  | 'conceptBankAuthor'
  | 'tagCanonicalizer'
  | 'topicClassifier'
  | 'conceptDeriver'
  | 'docTocExtractor'
  | 'validityAgent'
  | 'topicGate'
  | 'goalGate'
  | 'programPlanner'
  | 'programDecomposer'
  | 'intake'
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
  mapSpineAuthor: {
    // Phase 2.5d-1: authors a topic's spine concept DAG (nodes + directed prereq
    // edges). Pro, not Flash — this is the infrequent, cached-forever curriculum
    // backbone every future Track for the topic traverses; quality of the concept
    // decomposition and prerequisite structure outweighs the per-call cost (same
    // reasoning as curriculumFallback). Temperature low so the structure is
    // stable and defensible, not zero so a repair pass can vary a bad edge set.
    // 32k output: a ~15-concept spine plus its edge list plus Pro's internal
    // thinking; matches the Pro fallback budget.
    modelId: 'gemini-2.5-pro',
    temperature: 0.2,
    maxOutputTokens: 32768,
  },
  mapSpineReviewer: {
    // Phase 2.5d (spine hardening): the semantic critic over a structurally-valid
    // spine — judges completeness, missing foundations, a cold open (onboarding),
    // and connectivity, emitting advisory findings that drive one bounded author
    // revision. Pro, same tier + reasoning as the author it critiques: catching a
    // missing on-ramp or an assumed-but-absent foundation is judgment, not rule
    // application. Temperature low for stable findings. 16k output: the findings
    // array is small, but Pro spends budget on internal thinking first.
    modelId: 'gemini-2.5-pro',
    temperature: 0.2,
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
    // trackSectioner. Temperature 0 for a stable verdict. 8k output: the findings
    // array is small, but Flash 2.5 spends budget on internal thinking first.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  mapCandidateJudge: {
    // Phase 2.5d-2: scores a spine concept's candidate resources — assigns each
    // a role (teaches/uses/assesses) and a 0–1 coverageScore. Rule application
    // against the concept + each resource's own metadata, not open generation,
    // so Flash at temperature 0 (like conceptDeriver / the curriculum critic).
    // 8k output: the verdict array is small, but Flash 2.5 spends budget on
    // internal thinking first and caps mid-JSON on a tighter ceiling.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 8192,
  },
  onRampAuthor: {
    // Phase 2g-3: writes the orientation on-ramp lesson (markdown) for a topic's
    // single on-ramp concept — what the subject is, the core mental model, setup /
    // notation, prerequisite review, the very first steps. Pro, not Flash: this is a
    // learner-facing artifact authored ONCE per topic and cached forever (same
    // reasoning as mapSpineAuthor / trackComposer), and orientation prose that is
    // subtly wrong about a subject's fundamentals is worse than none. Temperature
    // mid so the prose is warm and readable, not robotic. 32k output (matches the
    // other Pro authors): the lesson itself is only ~600–900 words, but at 16k Pro
    // intermittently spent the whole budget on internal thinking and emitted nothing
    // (NoOutputGeneratedError → "No output generated"), failing the generation; the
    // larger ceiling leaves ample headroom for thinking + the lesson so that's rare.
    modelId: 'gemini-2.5-pro',
    temperature: 0.4,
    maxOutputTokens: 32768,
  },
  onRampCritic: {
    // Phase 2g-3: the accuracy self-critique pass over the authored draft — corrects
    // factual errors (a wrong definition, an off-by-one in a first-steps snippet, an
    // outdated setup instruction) while preserving the lesson's scope and structure,
    // returning the corrected lesson (unchanged when already accurate). Pro, same
    // tier as the author: catching a subtle factual slip in math/programming
    // fundamentals is judgment. Temperature low for careful, conservative
    // correction. 32k output (matches the author): it re-emits the full corrected
    // lesson after thinking, so it needs the same headroom against the
    // spend-budget-on-thinking-then-emit-nothing failure (NoOutputGeneratedError).
    modelId: 'gemini-2.5-pro',
    temperature: 0.1,
    maxOutputTokens: 32768,
  },
  trackComposer: {
    // Phase 2.5e-2: composes a learner's Track from a spine_ready map in one
    // call — prunes known concepts, ranks frontier by target mastery, picks each
    // lesson's primary (difficulty-matched), writes lesson + track framing, and
    // judges per-concept resource sufficiency. Pro, not Flash: this is the
    // judgment-heavy, learner-facing artifact (same reasoning as mapSpineAuthor),
    // and it reasons over the whole map at once. Temperature low-ish so structure
    // and selection stay stable but the prose framing isn't robotic. 32k output:
    // a lesson object per concept across a (frontier-thickened) map plus the
    // model's internal thinking; matches the spine-author budget.
    modelId: 'gemini-2.5-pro',
    temperature: 0.3,
    maxOutputTokens: 32768,
  },
  trackSectioner: {
    // Phase 2.5e (track sections): a separate post-build pass that groups an
    // already-ordered, already-trimmed lesson list into named chapters. Flash, not
    // Pro — far lighter than the composer: it sees only lesson titles/summaries (no
    // map, edges, or candidates) and just draws chapter boundaries + writes short
    // intros. Best-effort (a failure leaves the Track flat), so the cheap tier is
    // right. Temperature low-ish so chaptering is stable but intros aren't robotic.
    // 8k output: the boundaries array is small, but Flash 2.5 spends budget on
    // internal thinking first and caps mid-JSON on a tighter ceiling.
    modelId: 'gemini-2.5-flash',
    temperature: 0.2,
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
    // fine. Temperature mid for variety across the small set without drifting
    // off-concept. 32k output (matches the other Pro authors): the question array is
    // small, but Pro spends budget on internal thinking first and the larger ceiling
    // avoids the spend-then-emit-nothing failure (NoOutputGeneratedError).
    modelId: 'gemini-2.5-pro',
    temperature: 0.4,
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
    // The verdict object itself is tiny, but Flash 2.5 spends output tokens on
    // internal thinking FIRST — a 512 ceiling could cap mid-object before the
    // JSON is emitted (NoObjectGeneratedError → an unhandled throw that 500s a
    // standalone /api/generate-path). 2048 leaves ample thinking headroom for a
    // one-shot classification while staying far cheaper than the decomposer tier.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 2048,
  },
  goalGate: {
    // Goal-domain gate: a one-shot classifier that decides whether a Program GOAL is
    // a legitimate learnable objective within {math, natural science, cs} — the
    // goal-level analog of topicGate, run as Stage 0 of the plan pass so an
    // off-domain / nonsense goal is rejected BEFORE the decomposer rescues it into
    // plausible in-domain topics. Same tier + budget rationale as topicGate: the
    // verdict object is tiny, but Flash 2.5 spends output tokens on internal thinking
    // FIRST, so a 512 ceiling could cap mid-object (NoObjectGeneratedError); 2048
    // leaves thinking headroom while staying far cheaper than the decomposer tier.
    modelId: 'gemini-2.5-flash',
    temperature: 0,
    maxOutputTokens: 2048,
  },
  programPlanner: {
    // Phase 2.75b: the program plan pass — decomposes a goal into ≤N single-topic
    // learning topics with per-topic importance/gap weights, priority tier, phase
    // grouping, and cross-topic order. Flash, not Pro: the roadmap frames this as a
    // "cheap synchronous plan pass", and it's judgment over a short goal, not the
    // deep spine-authoring of mapSpineAuthor. Temperature low for a stable, defensible
    // decomposition, not zero so a re-run can vary a marginal topic. 16k output (not
    // 8k): Flash 2.5 spends the budget on internal thinking FIRST, and an 8k ceiling
    // occasionally capped mid-JSON → a `No object generated: could not parse` throw
    // that sank the whole plan pass (seen once in the 2.75 full e2e). 16k leaves ample
    // headroom for thinking + ~6 topics with rationales, matching mapSpineReviewer.
    modelId: 'gemini-2.5-flash',
    temperature: 0.2,
    maxOutputTokens: 16384,
  },
  programDecomposer: {
    // Decomposer-agent plan (Block 2): the tool-using Stage-1 decomposition agent —
    // same job as programPlanner (goal → ≤N gated single-topic tracks) but driving a
    // tool loop (get_path_map / propose_course / finalize) instead of one
    // generateObject call, and additionally deciding per-topic frontier-concept
    // requests. Starts on programPlanner's tier per the plan's ambiguity #6 default
    // (Flash; the reasoning is still judgment over a short goal, now spread across
    // steps) — bump only if tool-loop quality is weak in the Block 5 live run.
    // Same 16k budget: per-step output is small (tool args), but Flash 2.5 spends
    // output tokens on internal thinking first.
    modelId: 'gemini-2.5-flash',
    temperature: 0.2,
    maxOutputTokens: 16384,
  },
  intake: {
    // Chat intake (Block 2): one non-streaming structured call per /programs/new
    // chat turn — conversation + field extraction over a short fenced transcript.
    // Extraction + chitchat, not judgment (plan-pass reasoning stays in
    // programDecomposer), so Flash; overridable via MODEL_INTAKE. Temperature
    // above zero so replies read conversational rather than canned, low enough
    // that extraction stays literal. 4k output: the reply is a couple of
    // sentences + a small draft object, but Flash 2.5 spends output budget on
    // internal thinking first.
    modelId: 'gemini-2.5-flash',
    temperature: 0.4,
    maxOutputTokens: 4096,
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
    model: chatModel(modelId),
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
