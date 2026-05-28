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

// How many resources the discovery prompt asks Gemini to return per fallback
// invocation. ~8 fits a typical path and seeds the library for next time
// without flooding pending_review.
export const FALLBACK_TARGET_COUNT = 8;
