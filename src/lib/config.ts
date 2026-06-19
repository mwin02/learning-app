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

// Phase 2.5f: targeted per-concept sourcing (sourceForConcept) budgets — the
// thickener's spine-hole remediation. Deliberately smaller than the topic-level
// FALLBACK_* above: a single narrow concept has far fewer good resources on the
// open web, so we ask for a handful of teaches candidates, not a topic's worth.
export const REMEDIATION_SOURCE_TARGET_COUNT = 3;
export const REMEDIATION_DISCOVERY_OVERSAMPLE = 6;
export const REMEDIATION_MAX_DISCOVERY_ITERATIONS = 2;

// Phase 2.5f-3a: hole-legitimacy classifier (gap vs conflation). A spine hole is
// a CONFLATION (over-coarse concept → split, not source) only when ≥
// REMEDIATION_CONFLATION_MIN_TEACHES `teaches` candidates sit in the sub-floor
// band [BAND_MIN, MAP_SPINE_MIN_PRIMARY_COVERAGE) AND cover distinct slices. A
// `teaches` below BAND_MIN is noise (excluded as conflation evidence); a lone
// sub-floor `teaches`, or several covering the SAME slice, is a GAP (source a
// better resource, relax on exhaustion) — splitting finer wouldn't help.
export const REMEDIATION_CONFLATION_BAND_MIN = 0.3;
export const REMEDIATION_CONFLATION_MIN_TEACHES = 2;
// Two sub-floor `teaches` are the "same slice" when their conceptsTaught Jaccard
// similarity is at or above this — so they cluster into one slice rather than
// counting as two. Conflation needs ≥2 distinct slices.
export const REMEDIATION_CONFLATION_SLICE_SIMILARITY = 0.6;

// Phase 2.5f-4a: splitting a conflation concept must yield at least this many
// finer nodes (a split into one isn't a split) and at most this many (a sane
// fan-out; the author declines or we reject beyond it). Bounds the authored
// decomposition, NOT the whole spine (so it's separate from SPINE_*_CONCEPTS).
export const REMEDIATION_SPLIT_MIN_NODES = 2;
export const REMEDIATION_SPLIT_MAX_NODES = 6;

// Phase 2.5f-4b: hard ceiling on remediation passes per run. A pass fixes the
// current holes (source gaps, split conflations); a split creates finer nodes
// that become next pass's holes, so remediation iterates. The loop also stops on
// no-holes or a no-progress pass; this caps pathological re-splitting regardless.
export const MAX_REMEDIATION_PASSES = 3;

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

// Phase 2.5b: a container that would decompose into MORE than this many atomic
// children is NOT auto-decomposed — it's routed to human_review instead (with
// the projected count logged). Rationale (2.5b-4): silently keeping "the first
// N" is arbitrary (the right N of a 200-item playlist may not be the first N),
// and an oversized result is usually either a legit mega-course worth a human's
// "yes, decompose it" or a channel-dump / over-selection that shouldn't
// decompose at all. The gate fires BEFORE the expensive per-child concept
// derivation, so suspect resources cost almost nothing. Shared by the playlist
// and doc-TOC routers.
export const DECOMPOSITION_MAX_AUTO_CHILDREN = 50;

// Recursive decomposition: how many levels of container nesting decompose() will
// expand before parking any still-container leaves as atomic. A doc tree can be
// a container of containers (a path → its courses → their lessons), so a single
// layer leaves the intermediate "unit" pages mis-marked atomic and never drilled
// into. This caps the recursion: root children are level 1, their children level
// 2, etc. — a node at the deepest level is kept whole even if it looks like a
// further container. Bounds runaway fan-out and cycles together with the
// per-node DECOMPOSITION_MAX_AUTO_CHILDREN gate. Only the doc-TOC router nests;
// YouTube playlist children (single videos) are always atomic leaves.
export const DECOMPOSITION_MAX_DEPTH = 3;

// Recursive decomposition: a hard cap on how many container nodes one tree may
// expand (i.e. how many recursive fetch + TOC-extract passes a single top-level
// decompose runs). The depth cap and per-node DECOMPOSITION_MAX_AUTO_CHILDREN
// gate alone still permit a combinatorial blowup (50 × 50 × … per level), so
// this bounds the total cost/fan-out of one decomposition. Once the budget is
// spent, any remaining container-shaped sections are kept whole as atomic leaves
// rather than drilled further. `force` (curation) lifts it, like the per-node
// gate, for a tree an operator has vouched for.
export const DECOMPOSITION_MAX_TOTAL_NODES = 250;

// Phase 2.5b-2: children are batched this many per concept-derivation LLM call
// so a large container stays within the model's output-token budget.
export const CONCEPT_DERIVATION_CHUNK_SIZE = 25;

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

// Phase 2.5d-1 (map-builder spine author): the spine is the required backbone of
// a topic's concept map — coarse enough to stay a stable skeleton, fine enough
// that each node maps to teachable resources. These bound the authored concept
// count; the author prompt targets this range and the validator rejects an
// out-of-range spine into the repair loop. Starting heuristic — ROADMAP defers
// the empirical granularity policy to this phase.
export const SPINE_MIN_CONCEPTS = 8;
export const SPINE_MAX_CONCEPTS = 15;

// Max times the spine author re-runs after the DAG validator rejects its output
// (a cycle, a self-loop, a dangling edge endpoint, or an out-of-range concept
// count). Each repair is one extra author call fed the specific defects; total
// author calls = 1 + up to this many. Mirrors CRITIC_MAX_REVISIONS' bounded loop.
export const SPINE_MAX_REPAIRS = 2;

// Phase 2.5d (spine hardening): max times the semantic reviewer (review-spine.ts)
// re-runs the author after a structurally-valid spine is judged incomplete (a cold
// open / missing onboarding root, an assumed-but-absent foundation, an orphan
// concept, a backbone gap, or an over-coarse/conflated node). Separate from
// SPINE_MAX_REPAIRS so semantic revisions don't starve the structural-repair budget.
// Set to 3: the reviewer now hunts five finding kinds (onboarding, missing-
// foundation, connectivity, completeness, granularity), so a single revision often
// can't land them all — and crucially, every revision below the budget IS re-
// reviewed (the budget check sits before the review call), so a higher bar buys
// genuine convergence + verification of the fix, not just more blind re-authors.
// Still advisory (never gates spine_ready — the resource gate does) and bounded, so
// the worst-case extra cost is 3 author + 3 review Pro calls. The loop's
// maxIterations (SPINE_MAX_REPAIRS + SPINE_MAX_REVIEW_REPAIRS + 1) scales with this.
export const SPINE_MAX_REVIEW_REPAIRS = 3;

// Phase 2.5d-2 (candidate attachment): per spine concept, how many pickable
// library resources to pull as candidates before the LLM judge scores them.
// Small — the Track builder only needs a primary + a few frozen alternates per
// concept, and each candidate costs judge tokens. The async thickener (2.5f)
// widens this later; the synchronous spine build stays lean.
export const MAP_CANDIDATES_PER_CONCEPT = 6;

// How many concepts' candidate sets to judge concurrently. Each concept is one
// independent Flash call (its concept + that concept's candidates), so we fan
// out — but bounded, so a wide spine doesn't open dozens of Vertex calls at once.
export const MAP_JUDGE_CONCURRENCY = 4;

// Phase 2.5d-3 (spine-ready gate): the minimum coverageScore a `teaches`
// candidate must clear to count as a usable primary for a spine concept. A Path
// becomes `spine_ready` only when EVERY spine concept has such a candidate —
// the gate is honest about "can we actually teach every backbone concept". A
// concept with only `uses` candidates, or only weak `teaches`, is a spine hole;
// the Path stays `building` and later blocks (thickener 2.5f, edit surface) fill
// it. Modest so we're not brittle against a thin library.
export const MAP_SPINE_MIN_PRIMARY_COVERAGE = 0.5;

// Phase 2.5d-7c (inspector attach-resource picker): max pickable candidates the
// resource-search endpoint returns to the attach picker. Small — the operator is
// scanning for one resource to attach to a concept, not browsing the library.
export const MAP_RESOURCE_PICKER_LIMIT = 20;

// Phase 2.5e-3 (Track builder): how many times the builder may invoke the spine
// thickener and rebuild within one build when the composer judges resources
// insufficient for the target mastery. Each attempt = one extra compose call, so
// this bounds cost/latency on the per-request hot path. 1 today (the thickener is
// a 2.5f stub that always reports "couldn't"), so the builder falls through to a
// best-effort weaker Track. Raise once the real thickener can actually fill holes.
export const TRACK_MAX_THICKEN_ATTEMPTS = 1;

// Phase 2.5g-1: a CourseRequest left `running` longer than this is treated as a
// dead worker's abandoned claim and reclaimed (→ `queued`) by the g-3 worker on
// its next tick. Generous — a cold-topic run (spine author + review + remediation
// web-sourcing) legitimately takes minutes; this is the "the worker process died"
// threshold, not a per-stage timeout. 15 minutes.
export const COURSE_REQUEST_STALE_MS = 15 * 60 * 1000;

// Phase 2.5e (track sections): a built Track with FEWER than this many lessons is
// not sectioned — it renders as a flat list. Chaptering a 2–3 lesson Track buys
// nothing (the headers would outnumber the content), so the post-build sectioner
// (section-track.ts) skips the LLM call entirely below this floor.
export const TRACK_MIN_LESSONS_FOR_SECTIONS = 4;
