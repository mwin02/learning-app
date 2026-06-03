// Tunable knobs that don't belong in env vars — small, code-reviewable
// defaults imported by agents and routes. Phase 2 introduces this file;
// later phases extend it rather than scattering magic numbers.

// Once a topic has ≥ this many `active` Resources, `pending_review`
// Resources are excluded from that topic's path generation. Below the
// gate, pending_review is included so newly-found agent Resources stay
// visible while a topic's library is still sparse.
export const PENDING_REVIEW_GATE_PER_TOPIC = 10;

// Below this many `active` Resources for a topic, the curriculum agent runs
// the web fallback (Vertex grounded search) to compound the library before
// composing a path. Kept strictly below PENDING_REVIEW_GATE_PER_TOPIC so the
// gate's "include pending" window keeps surfacing freshly-found rows after
// fallback fires.
export const FALLBACK_THRESHOLD = 5;

// How many *surviving-validation* resources the fallback aims to land per
// invocation. Loop retries discovery (with a growing deny-list) until either
// this many survive or FALLBACK_MAX_DISCOVERY_ITERATIONS is hit.
export const FALLBACK_TARGET_COUNT = 8;

// Per-discovery-call ask. Oversampled above FALLBACK_TARGET_COUNT to absorb
// rejections from the validation pipeline.
export const FALLBACK_DISCOVERY_OVERSAMPLE = 12;

// Hard ceiling on discovery calls per single fallback invocation. The
// fallback is the most expensive operation in the app (Pro + grounded
// search); this is the belt-and-suspenders cost guard.
export const FALLBACK_MAX_DISCOVERY_ITERATIONS = 3;

// Phase 2.5-AR: `searchResources` only spends an embedding call to rank when a
// topic's matching candidate set exceeds this size. At or below it, the set is
// small enough to hand to the agent wholesale (today's load-all behavior), so
// semantic ranking buys nothing and we skip the embed.
export const SEARCH_RANK_THRESHOLD = 30;

// Default cap on how many resources `searchResources` returns on the ranked /
// large-set paths. The fast-path (≤ SEARCH_RANK_THRESHOLD) ignores this and
// returns the whole matching set.
export const SEARCH_DEFAULT_LIMIT = 30;

// Phase 2.5-AR (AR-3): hard ceiling on steps in the curriculum agent's
// retrieval loop. One step = one model turn (which may issue several tool
// calls). Bounds cost/latency; the model normally stops earlier by ceasing to
// call tools once it has gathered enough candidates.
export const RETRIEVAL_MAX_STEPS = 6;

// Max times the model may call `triggerWebFallback` within one retrieval
// session. Fallback is the app's most expensive operation (Pro + grounded
// search), so the model gets a small budget on top of the deterministic
// pre-loop floor that already fires for thin topics.
export const RETRIEVAL_MAX_FALLBACKS = 1;

// Phase 2.5b-2: max atomic children materialized from one YouTube playlist.
// Bounds the per-child concept-derivation token spend (and the child-row count)
// on pathological playlists. Beyond this, the first N by playlist order are
// kept and the rest dropped with a logged truncation.
export const YOUTUBE_PLAYLIST_MAX_CHILDREN = 50;

// Phase 2.5b-2: children are batched this many per concept-derivation LLM call
// so a 50-video playlist stays within the model's output-token budget.
export const CONCEPT_DERIVATION_CHUNK_SIZE = 25;

// Phase 2.5b-3: max atomic children materialized from one doc-site course tree.
// Same role as the playlist cap — bounds child-row count + concept-derivation
// spend on a large table of contents.
export const DOC_TOC_MAX_CHILDREN = 50;

// Phase 2.5b-3: cap on the fetched container HTML we process (chars). Doc pages
// can be huge; we only need the title, anchor links, and a body snippet, so we
// slice before extracting to bound regex + token cost.
export const DOC_TOC_MAX_HTML_CHARS = 500_000;

// Phase 2.5-AR (AR-6): max times the curriculum agent re-runs AR-4 select after
// the rubric critic fails a path. Each revision is one extra select + critic
// pair, so total select calls = 1 + up to this many. Bounds cost/latency; the
// agent returns its best-effort path if the critic still fails after the last
// revision.
export const CRITIC_MAX_REVISIONS = 2;
