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
