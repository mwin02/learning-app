// Tunable knobs that don't belong in env vars — small, code-reviewable
// defaults imported by agents and routes. Phase 2 introduces this file;
// later phases extend it rather than scattering magic numbers.

// Once a topic has ≥ this many `active` Resources, `pending_review`
// Resources are excluded from that topic's path generation. Below the
// gate, pending_review is included so newly-found agent Resources stay
// visible while a topic's library is still sparse.
export const PENDING_REVIEW_GATE_PER_TOPIC = 10;
