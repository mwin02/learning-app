// Tunable knobs that don't belong in env vars — small, code-reviewable
// defaults imported by agents and routes. Phase 2 introduces this file;
// later phases extend it rather than scattering magic numbers.

// NOTE: the topic-level web-fallback knobs (PENDING_REVIEW_GATE_PER_TOPIC,
// FALLBACK_THRESHOLD, FALLBACK_TARGET_COUNT, FALLBACK_DISCOVERY_OVERSAMPLE,
// FALLBACK_MAX_DISCOVERY_ITERATIONS) were removed in the Phase 2.5g cutover along
// with the curriculum-retrieval subsystem and runWebFallback. Library growth is
// now driven by targeted per-concept sourcing — see the REMEDIATION_* budgets below.

// Phase 2.5h (source-quality overhaul): trustScore composition seam
// (src/lib/curation/trust-score.ts). trustScore = a source-reputation prior moved
// by evidence signals (precision-weighted average). These two knobs govern the
// blend itself; signal-specific knobs (YouTube engagement thresholds, the
// selection-ranking weight) live with their callers in later blocks.
//
// TRUST_PRIOR_STRENGTH: the precision the source prior carries in the blend. At 1,
// a single full-confidence·full-weight signal counts equally with the prior (pulls
// the score halfway to the signal's value). Raise to make the prior stickier.
export const TRUST_PRIOR_STRENGTH = 1;
// TRUST_FLOOR: trustScore never drops below this. NOT a quality gate — the minimal
// liveness/garbage drop lives at admission in the sourcing prong; this just keeps a
// heavily-disliked resource's score off zero so it stays orderable.
export const TRUST_FLOOR = 0.1;

// Phase 2.5h: YouTube engagement → EvidenceSignal knobs (curation/youtube-signal.ts).
// Calibrated against live Data API data: strong educational videos cluster around a
// ~2% like ratio but it swings wildly by channel/audience (3Blue1Brown ~2%, Khan
// ~0.3% on equally-good content), so like ratio is a WEAK quality axis. We therefore
// drive the signal mostly off view count (popularity = crowd-vetting) with like ratio
// as a soft modifier, and cap the whole term's weight so it nudges the source/channel
// prior rather than overriding it.
//   value      = YT_VIEW_WEIGHT·viewScore + (1−YT_VIEW_WEIGHT)·likeScore
//   confidence = viewScore   (more views → more evidence; protects hidden gems —
//                low-view videos stay near base, lifted later by our own votes)
//   weight     = YT_SIGNAL_WEIGHT
// where viewScore = clamp(log10(views+1)/log10(YT_VIEW_SAT), 0, 1)
//       likeScore = clamp((likes/views)/YT_TARGET_LIKE_RATIO, 0, 1)
export const YT_VIEW_SAT = 1_000_000; // views at which viewScore saturates to 1
export const YT_TARGET_LIKE_RATIO = 0.025; // like/view ratio scoring full marks
export const YT_VIEW_WEIGHT = 0.7; // view vs like split inside the signal's value
export const YT_SIGNAL_WEIGHT = 0.6; // EvidenceSignal.weight — engagement nudges, prior anchors
// Minimal liveness/garbage floor: a video below this view count is dropped at
// admission (not trusted-low — dropped). Deliberately permissive per the "set low,
// just filter out bad content" decision; real quality is the soft trust signal.
export const YT_MIN_VIEWS = 1_000;

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

// Frontier authoring (map build): after the spine persists, one batch author
// call proposes the map's FRONTIER — optional enrichment concepts beyond the
// required backbone (applications, specializations, adjacent techniques).
// The prompt targets MIN–MAX; the sanitizer truncates overflow (author order is
// the author's own priority) rather than re-prompting. Frontier never gates
// spine_ready, so these bound cost, not readiness. ~40–60% of spine size.
export const FRONTIER_MIN_CONCEPTS = 5;
export const FRONTIER_MAX_CONCEPTS = 10;

// Max times the frontier author re-runs after cycle validation rejects its
// output (the only repair-worthy defect — slug/prereq hygiene is fixed
// deterministically by the sanitizer). After the budget, cycles are broken by
// dropping edges rather than failing: frontier is best-effort by design.
export const FRONTIER_MAX_REPAIRS = 2;

// Per frontier pass, how many unresourced frontier concepts (no qualifying
// `teaches` primary after library attachment) get the web-sourcing ladder.
// The ladder is the expensive half of resourcing; uncapped it would re-inflate
// the per-map sourcing cost the frontier pass is meant to avoid. Concepts past
// the cap stay unresourced — the composer simply can't spend budget on them,
// and later enrichment can fill them.
export const FRONTIER_MAX_WEB_SOURCED = 3;

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

// On-ramp magnet fix (Lever A) — attachment hygiene applied by selectAttachable
// (attach-candidates.ts), to every concept (not just the on-ramp).
//
// MAP_ATTACH_MIN_COVERAGE: drop a judged candidate below this coverageScore
// instead of attaching everything > 0. Kept at the conflation evidence-band floor
// (REMEDIATION_CONFLATION_BAND_MIN = 0.3) ON PURPOSE: a higher floor would strip
// the sub-floor [0.3, 0.5) `teaches` that classifyHole reads to tell a genuine gap
// from an over-coarse (conflation) concept — so 0.3 trims search noise without
// blinding remediation. (If you ever raise BAND_MIN, raise this in lockstep.)
//
// MAP_MAX_CANDIDATES_PER_CONCEPT: hard cap on how many candidate links one concept
// keeps, enforced on the MERGED set (via capCandidates, NOT selectAttachable) so
// repeated thickening/remediation passes can't accumulate unboundedly (the magnet
// held 45). The merged-set cap is count-only — no floor — so it drops just the
// lowest-coverage excess beyond the cap and always retains the best qualifying
// `teaches` (>= MAP_SPINE_MIN_PRIMARY_COVERAGE); it can never empty a concept or
// regress readiness (incl. a 2.5f relaxed concept whose coverage rests on sub-floor
// candidates). The floor above is admission-time only, on FRESH judge output.
export const MAP_ATTACH_MIN_COVERAGE = 0.3;
export const MAP_MAX_CANDIDATES_PER_CONCEPT = 6;

// Phase 2.5h: how much trustScore weighs in candidate RANKING (selectAttachable /
// capCandidates). selectionScore = (1−w)·coverageScore + w·trustScore. Coverage
// stays the GATE (a candidate must clear MAP_ATTACH_MIN_COVERAGE / a primary must
// clear MAP_SPINE_MIN_PRIMARY_COVERAGE — trust never gates, so it can't admit an
// irrelevant resource or drop a concept below readiness); trust only orders the
// qualifiers, so a higher-trust resource wins the primary slot and survives the cap
// among similarly-relevant candidates. Modest so relevance still dominates.
export const TRUST_SELECTION_WEIGHT = 0.3;

// Phase 2g-1: scope-aware duration ranking in selectAttachable / capCandidates.
// A resource whose duration far exceeds what a single concept warrants is over-
// broad for it (a whole-chapter or whole-course page mapped to one concept — the
// calculus 3h Paul's-Notes chapters; the python 2h "Full Course" on-ramp). Within
// the attachable band (≤ MAX_ATTACHABLE_DURATION_MIN below) we don't FILTER on
// duration (it would empty a concept whose only candidate is long, or drop it
// below readiness), so — exactly like trust — duration only ORDERS: selectionScore
// is multiplied by a durationFactor in (floor, 1], so a better-scoped alternative
// outranks the over-long one WHEN one exists, and the over-long one still survives as
// the lone candidate when it doesn't. Applied to EVERY concept; the on-ramp gets the
// strict regime (orientation should be short), every other concept a softer one that
// only bites genuine whole-course over-length.
//
// Curve per regime (two-sided): factor = `shortFloor` at ~0 min, ramping up to 1 by
// `shortTargetMin` (too-THIN penalty); flat at 1 across the healthy band
// [shortTargetMin, targetMin]; then linear decay to `floor` over the next `spanMin`
// minutes, flat at `floor` beyond (too-LONG penalty). `shortTargetMin: 0` disables the
// short end. Rows with no durationMin (the persisted DB re-cap path) get factor 1 —
// unchanged, like trust-less rows.
//
// The too-thin end (added as the symmetric complement to the long end) mirrors the
// over-breadth logic: a resource far SHORTER than a concept warrants (a ~1-min YouTube
// Short) can't deliver it, so it's demoted in ordering — never filtered — so a
// better-scoped alternative outranks it when one exists, and it still survives as the
// lone candidate when it doesn't. This is the candidate-ORDERING complement to the
// hard primary floor in build-track (TRACK_MIN_PRIMARY_DURATION_MIN): ordering reduces
// how often a thin clip reaches the composer as a top candidate; the build-track floor
// is the deterministic guarantee on the chosen primary.
export const MAP_DURATION_RANKING = {
  // Orientation/on-ramp: a beginner primer SHOULD be short, so no too-thin penalty
  // (shortTargetMin 0). Strict on the long end — full discount (0.25) by ~80 min.
  onRamp: { shortTargetMin: 0, shortFloor: 1, targetMin: 20, spanMin: 60, floor: 0.25 },
  // Every other concept: a sub-5-min resource is too thin to be a concept's teacher
  // (ramps from 0.5 at ~0 up to 1 by 5 min); a normal 30–60 min lesson is unpenalized;
  // a 3h chapter/course page reaches the 0.6 floor by ~180 min.
  default: { shortTargetMin: 5, shortFloor: 0.5, targetMin: 60, spanMin: 120, floor: 0.6 },
} as const;

// Container containment (track-budget-fill-plan Block 0): the hard ceiling past
// which a resource is whole-course/book-shaped, not an atomic lesson unit, and must
// never be ATTACHED to a concept. Two enforcement points share it:
//   - decompose(): an `atomic` outcome (classifier fast-path or a router's
//     keep-whole reroute) over the ceiling parks as `human_review` instead — the
//     2.5b invariant is "only atomic units are pickable", and a 30h course that
//     escaped decomposition (the MIT OCW course, the MML book) is not one.
//   - selectAttachable(): admission-time DROP of over-ceiling candidates from
//     fresh judge output — the backstop for rows already in the library. Unlike
//     the 2g-1 ordering penalty above, past the ceiling a hole (which thickening/
//     remediation can fill properly) beats a whole-course attachment that devours
//     an entire Track budget. Admission only: capCandidates (the persisted re-cap)
//     never re-litigates, so existing links can't be evicted by a re-cap.
// 300 = 5h: keeps legitimately-long atomic units (a 234m lecture video, a 282m
// chapter) while dropping the 365m+ whole-course rows the audit found.
export const MAX_ATTACHABLE_DURATION_MIN = 300;

// Track-build primary duration floor: a resource shorter than this (in minutes)
// cannot be a lesson's LEAD primary when a longer `teaches` candidate exists on the
// same concept — the thin one is demoted to an alternate and the better teacher
// promoted (build-track `enforcePrimaryDurationFloor`). Guards against the composer
// occasionally seating a too-thin clip (a ~1-min YouTube Short) as a concept's sole
// primary. Sub-minute durations floor to 1 at ingest (isoDurationToMinutes), so a
// Short reads as 1–2 min; 3 cleanly excludes those while sparing genuine short
// explainers. The swap only fires when a qualifying replacement exists, so it can
// never empty a lesson (the ≥1 guarantee holds — a thin-only concept keeps its clip).
// Authored on-ramps (generated origin) are exempt: they are intentionally the primary.
export const TRACK_MIN_PRIMARY_DURATION_MIN = 3;

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

// Budget-fill Block 2: how many concepts ONE thicken cycle may source for. The
// thickener is synchronous per-concept web sourcing inside the build (until the
// 2.5g async cutover), so an immersive-tier build flagging a dozen thin concepts
// would multiply build latency unboundedly. Targets are taken worst-first —
// teachability holes (underResourced) before budget-thin (thinForBudget), each
// list already in the composer's order — so the cap degrades gracefully to
// "fix the worst few, best-effort the rest".
export const TRACK_MAX_THICKEN_CONCEPTS = 6;

// Budget-fill Block 3: the healthy fill band for a budgeted Track — kept minutes
// over the requested budget. Outside it the build logs a loud warning (telemetry
// only; the build still succeeds — a must-have resource is never dropped and a
// thin library is a sourcing problem, not a build failure). 1.1 matches the
// allocator's DEFAULT_BUDGET_SLACK cap; 0.6 is the floor the audited scenarios
// now clear (calculus 93%, prob/stats 63% after Blocks 1–2).
export const TRACK_FILL_BAND = { min: 0.6, max: 1.1 } as const;

// Phase 2.5e-8 (block 2b): which composer backs a Track build.
//   'single' — the one-shot Output.object pass (composer.ts), today's default.
//   'agent'  — the tool-using loop (composer-agent.ts): reads the map/candidates and
//              assembles the track through incremental build tools, with the SAME
//              composition-core enforcement giving live feedback. Gated so we can A/B
//              on one Path and keep the deterministic single-pass as a fallback until
//              the agent proves out (cut over + delete 'single' after the 2d parity gate).
export const TRACK_COMPOSER_MODE: 'single' | 'agent' = 'single';

// Hard ceiling on model turns in the composer agent's loop. One step = one model turn
// (which may issue several tool calls). Bounds cost/latency on the per-request path; the
// model normally stops earlier by calling `finalize` once the track is complete. The
// agent tends to spend ~1 tool call per step, so a 14-concept map needs ~36 steps on the
// happy path — 60 gives real headroom (a 40 cap left search-heavy builds finalize-starved;
// generateFallbackFraming is the safety net for when the cap is still hit).
export const TRACK_COMPOSER_MAX_STEPS = 60;

// Phase 2.5g-3: the course worker's poll interval — how long it sleeps after
// draining the queue before checking again. Short enough that a freshly-enqueued
// request starts promptly, long enough not to hammer the DB while idle. 5s.
export const COURSE_WORKER_POLL_MS = 5_000;

// Phase 2.5g-3: a RemediationJob left `running` longer than this is treated as a
// dead worker's abandoned claim and reclaimed (→ `failed`, freeing the
// active-per-path unique index so the Path can be re-claimed). Generous: a
// remediation run is up to MAX_REMEDIATION_PASSES of per-concept web sourcing +
// re-judge, minutes of work. This is the "process died" threshold, not a per-pass
// timeout. 15 minutes — a "worker died" claim-recovery threshold like
// COURSE_REQUEST_STALE_MS, but independent of it (that one is 45m to clear the H4
// COURSE_JOB_DEADLINE_MS; this one only needs to outlast a remediation run).
export const REMEDIATION_JOB_STALE_MS = 15 * 60 * 1000;

// Phase 2.5g-2: ensurePathMap reclaim. A `building` Path with zero concepts is a
// claim that crashed before the lock-free populate phase (which runs ~30–60s after
// the claim tx commits, writing nothing to Path until it finishes). Only reclaim/
// rebuild such a Path once it's older than this, so a build that's legitimately
// still in flight is never stolen. A `failed` Path is reclaimed immediately (its
// builder is terminal), no age gate. 10 minutes — comfortably past a worst-case
// cold-topic spine build (author + review repairs + candidate attach).
export const PATH_BUILD_STALE_MS = 10 * 60 * 1000;

// H4 (audit 1.3): overall per-job deadline for one worker pipeline run. The
// single-concurrency loop AWAITS the pipeline, so one hung upstream call (LLM,
// fetch) would stall the ENTIRE queue — reclaimStale can requeue the row but
// can't unstick the loop. processCourseRequest races the pipeline against this:
// on expiry the request is failed with a diagnostic, the pipeline's AbortSignal
// fires (stages stop at their next checkpoint / AI call), and the loop moves
// on. 30 minutes: comfortably past a worst-case cold-topic build, where fresh
// Path creation (spine author + review + candidate attach) and course build
// (remediation web-sourcing + banks + compose) together can brush 20 minutes in
// practice — the earlier 20m budget was too tight for that path. Tighten once
// H3's buildUsage/duration data says what real builds cost. MUST stay SHORTER
// than COURSE_REQUEST_STALE_MS (below).
export const COURSE_JOB_DEADLINE_MS = 30 * 60 * 1000;

// Phase 2.5g-1: a CourseRequest left `running` longer than this is treated as a
// dead worker's abandoned claim and reclaimed (→ `queued`) by the g-3 worker on
// its next tick. Generous — a cold-topic run (spine author + review + remediation
// web-sourcing) legitimately takes minutes; this is the "the worker process died"
// threshold, not a per-stage timeout. 45 minutes — H4: kept well LONGER than
// COURSE_JOB_DEADLINE_MS (30m) with margin; if reclaim fired first, it would
// requeue a row whose live-but-slow pipeline is still running (duplicate build),
// and the two mechanisms would fight. Order is: deadline fails the job
// in-process; stale-reclaim only catches a worker that DIED holding a claim.
export const COURSE_REQUEST_STALE_MS = 45 * 60 * 1000;

// Phase 2.5e (track sections): a built Track with FEWER than this many lessons is
// not sectioned — it renders as a flat list. Chaptering a 2–3 lesson Track buys
// nothing (the headers would outnumber the content), so the post-build sectioner
// (section-track.ts) skips the LLM call entirely below this floor.
export const TRACK_MIN_LESSONS_FOR_SECTIONS = 4;

// Phase 2.5h (concept question bank): how many questions the bank author aims to
// write per concept in the one generation pass. Deliberately SMALL — a tight set
// the concept's resources can actually support beats a padded one full of
// questions the resources never cover (the whole reason generation is concept-
// framed + small). Lowered 8→5: at 8 the author over-reached into deep specifics a
// concept's resources don't establish; 5 keeps the set honestly within reach. Just
// above EXERCISE_SAMPLE_PER_LESSON (the build-time sampler draws that many), which
// is fine — a thin pool is the point; the operator deepens it via the discovery API.
export const CONCEPT_BANK_TARGET_QUESTIONS = 5;

// Phase 2.5h: how many concepts' banks to author concurrently in the per-Path
// fan-out (2.5h-3). Each concept is one independent Pro call, so we fan out — but
// bounded, like MAP_JUDGE_CONCURRENCY, so a wide map doesn't open dozens of Vertex
// calls at once.
export const CONCEPT_BANK_GEN_CONCURRENCY = 4;

// Phase 2.5h-4: how many exercises to snapshot per Lesson at Track build, sampled
// from the lesson's concept bank(s). The selection is stratified (≥1 per concept
// for a multi-concept lesson) then filled at random, frozen into Exercise rows. A
// lesson whose concepts have no bank yet simply gets none (non-fatal). Kept small —
// a few well-chosen checks per lesson, not a quiz; comfortably below
// CONCEPT_BANK_TARGET_QUESTIONS so there's a pool to sample from.
export const EXERCISE_SAMPLE_PER_LESSON = 4;

// Phase 2.75b: the program plan pass caps a goal's decomposition at this many
// single-topic Tracks. Bounds the child CourseRequest fan-out (worker cost) and
// keeps a Program legible — the decomposition prompt asks for ≤ this, and the pure
// budget allocator hard-slices to it by priority as a defensive backstop (echoing
// the DECOMPOSITION_MAX_AUTO_CHILDREN oversize gate on the per-topic side).
export const MAX_PROGRAM_TOPICS = 6;

// Phase 3c: how many Programs a (free) user may CREATE per calendar month (UTC).
// Creation is the metered action because it's where the LLM spend happens (plan
// pass + child Track builds); enrolling in an EXISTING Program is free and
// unlimited. Failed Programs don't count — a failed plan pass shouldn't burn
// quota. Read through programQuota (services/program-limits.ts) only, so the
// Stripe phase can swap that function's internals to a per-plan lookup without
// touching routes. Soft limit: two racing requests can each pass the pre-create
// check — acceptable (off-by-one on a free cap, not a security boundary).
export const FREE_PROGRAMS_PER_MONTH = 3;

// H1 (creation-route hardening, audit 1.1): the short-window burst cap on Program
// creation attempts per user. Unlike FREE_PROGRAMS_PER_MONTH this counts ALL
// statuses INCLUDING failed — a plan-empty/failed attempt doesn't burn monthly
// quota (by design) but DID burn the synchronous plan pass (an LLM call), so the
// burst cap is what stops a scripted loop of failing requests from hammering
// Vertex. Same soft-limit caveat as the quota: two racing requests can both pass.
export const PROGRAM_BURST_PER_HOUR = 3;
export const PROGRAM_BURST_WINDOW_MS = 60 * 60 * 1000;

// H1: duplicate-submit dedup window. A creation whose normalized payload hash
// (programInputHash) matches a non-failed Program the same user created within
// this window returns the EXISTING programId (202) instead of creating a sibling —
// a double-clicked submit or client retry is invisible to the user and burns
// nothing. Failed programs never dedup (an immediate retry after a failure is
// legitimate). Short on purpose: re-running the same goal LATER to get a fresh
// plan is a supported behavior, not a duplicate.
export const PROGRAM_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// Decomposer-agent plan (Block 2): hard ceiling on model turns in the decompose
// agent's tool loop (mirrors TRACK_COMPOSER_MAX_STEPS). One step = one model turn,
// which may issue several tool calls. The happy path is short — a get_path_map per
// existing topic + propose_course per topic + finalize, and the model batches
// calls — so ~MAX_PROGRAM_TOPICS×2 + slack. The finalize-miss fallback synthesizes
// title/description from the draft when the cap is hit.
export const DECOMPOSE_AGENT_MAX_STEPS = 16;

// Decomposer-agent plan: per-topic cap on frontier-concept requests
// (CourseRequest.frontierConcepts). Each request the worker executes is one
// addFrontierConcept call — potentially a web-sourcing ladder (30–60s, the
// app's expensive operation) — so this is a real budget lever, not hygiene.
// Enforced in the agent's propose_course tool (Block 2) AND defensively in the
// worker's execution loop (excess entries are logged + skipped, never fatal).
export const MAX_FRONTIER_PER_TOPIC = 2;

// Pre-Freeze Map Review (Block 1): the whole-map critic at the freeze boundary.
//
// MAP_HOLLOW_COVERAGE: a spine concept whose chosen `teaches` primary sits below
// this coverageScore is flagged `hollow` — a papered-over hole covered only by a
// weak resource. A `primaryRelaxed` concept is ALWAYS hollow (remediation already
// admitted it couldn't clear the floor). Start at 0.6 — just above the
// MAP_SPINE_MIN_PRIMARY_COVERAGE (0.5) readiness floor, so it catches the primaries
// that barely qualified (e.g. an aggregate-functions concept at exactly 0.6 is on
// the line). Deterministic, not an LLM call. Tune once observed on real Paths.
export const MAP_HOLLOW_COVERAGE = 0.6;
// MAP_DUP_CANDIDATE_SIMILARITY: the pure title/scope similarity (normalized-token
// Jaccard) at or above which two concepts are sent to the critic as a duplication
// CANDIDATE pair. Deliberately permissive (a low bar) — this only decides what the
// critic looks at; the LLM makes the precision call on whether it's a real
// duplicate. Too high and a genuine dup (sql-views vs database-views, sharing only
// the "view" stem) is never even considered.
export const MAP_DUP_CANDIDATE_SIMILARITY = 0.3;

// Phase 2.75b: the per-topic floor for the deterministic hours/week split — every
// surviving topic gets at least this many hours/week so no topic rounds to zero and
// silently vanishes from the plan. When Σ floors exceeds the program's
// totalHoursPerWeek, the allocator drops lowest-priority topics (nice_to_have before
// core) until the floors fit — which is what makes "re-run with a tighter budget
// visibly drops nice_to_have" a deterministic, auditable behavior.
export const PROGRAM_TOPIC_FLOOR_HOURS = 1;
