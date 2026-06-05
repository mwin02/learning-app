# Curriculum Agent Audit

A code review/audit of the curriculum agent workflow — the pipeline from input
(topic + background) to output (a generated path). Focus: security flaws, scaling
problems, efficiency/parallelism, behavior under concurrent load, and external API
rate limits (Vertex, YouTube Data API).

**Status:** complete. Sections reviewed: 1–9.

## Pipeline under review

`POST /api/generate-path` → `withAuth` → Zod validate → **topic gate** →
`createPath` → `generateCurriculum`:
1. **Retrieval** (tool-calling Flash agent; `ensureFloor` web-fallback, `searchResources`, `getResourceDetails`, `triggerWebFallback`)
2. **Select** (no-tools structured Flash call, by handle)
3. **Critic + revise** (rubric Flash call, bounded by `CRITIC_MAX_REVISIONS`)
4. **Persist** (`Path` + N `PathItem` in one transaction)

Web fallback = Gemini 2.5 **Pro** + Google Search grounding → validation
(liveness + rules-agent) → decompose (YouTube / doc-TOC) → canonicalize → upsert.

## External limits (confirmed)

- **Vertex Gemini 2.5** runs on [Dynamic Shared Quota](https://cloud.google.com/vertex-ai/generative-ai/docs/resources/dynamic-shared-quota): no fixed RPM, but bursty single-source spikes get deprioritized and can 429 under contention. Pro is the scarcer pool.
- **YouTube Data API v3**: [10,000 units/day](https://developers.google.com/youtube/v3/determine_quota_cost), project-wide, resets midnight PT. `playlistItems.list` and `videos.list` = 1 unit each.

## Severity legend

`HIGH` = address before real traffic · `MEDIUM` = address before scale · `LOW` =
opportunistic · `INFO` = note only.

---

## Section 1 — HTTP boundary & concurrency model

Every request runs the entire pipeline synchronously inside one Vercel serverless
invocation (`maxDuration = 60`). No queue, no background job, no streaming.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 1.1 | HIGH (security + cost) | `withAuth` is a `DEV_AUTH=1` placeholder with `userId: null`. The endpoint is effectively unauthenticated, unthrottled, and un-idempotent — anyone reaching the URL can trigger the most expensive operation in the app (Pro grounded search + validation fan-out + YouTube/embedding calls) without limit, draining Vertex spend, the YouTube 10k/day quota, and pushing all traffic into DSQ deprioritization (429s). | **Phase 3** — real auth + per-user rate limit + idempotency key (dedup on user + canonical topic + params). |
| 1.2 | MEDIUM (reliability + cost) | No `abortSignal` / time budget on any LLM or fetch call. Vercel's 60s kill leaves in-flight Vertex/YouTube/DB work running and billed; a single hung upstream call consumes the whole slot. | **Phase 3** (async) removes the HTTP guillotine; worker still needs explicit per-call timeouts + an overall job deadline. |
| 1.3 | MEDIUM (latency) | Cold-topic latency structurally exceeds 60s and fails ungracefully. The slowest path is the *first* request for a new topic — exactly the one a user waits on (`ensureFloor` runs full fallback before retrieval even starts). | **Phase 3** — async generation: route returns `202` + job id, user notified on completion. |
| 1.4 | LOW–MEDIUM (scale) | `PrismaPg` opens a node-postgres pool (default max 10) per warm instance; a cold-start burst multiplies pools against pgbouncer. Interactive transactions (esp. `decomposeExisting`, `timeout: 120_000`) pin a pooled backend connection for the transaction's life. Admin-only today. | Note; add `connection_limit` to the URL when real concurrency appears. Keep long transactions off hot paths. |
| 1.5 | INFO | Partial-work-on-failure is benign: fallback commits resources independently of path creation, so a timeout after fallback leaves new resources in the library (compounds) but errors the user. No corruption. | Accept. |

**Good:** clean 422-vs-500 split; `traceInResponse` gated independently of `DEV_AUTH`; `output: 'standalone'` + Node runtime; Zod caps every input field.

---

## Section 2 — Topic gate & registry

Three-tier gate: (1) curated slug → no LLM/DB; (2) `TopicAlias` cache hit → one
indexed lookup; (3) Flash classifier grounded on existing canonicals, persisted.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 2.1 | MEDIUM (scale + cost) | `listCanonicals()` loads *every* canonical ever minted and concatenates all into the tier-3 prompt. Grows unbounded across the broad niche → rising per-call tokens **and** degraded classification (more near-duplicate mints) exactly as the table grows. | **Phase 3.1** — nearby-candidate retrieval (embedding/prefix) instead of dump-all. |
| 2.2 | MEDIUM (folds into 1.1) | The gate is a cost + write-amplification vector: each distinct uncached phrasing = one Flash call + a `TopicAlias` write. Junk strings (`asdf1`, `asdf2`, …) each cost a call, and wrongly-accepted ones become permanent rows that pollute `listCanonicals` (feeding 2.1). | Neutralized by 1.1 (rate limit + auth). Noted. |
| 2.3 | MEDIUM (data quality) | First-writer-wins makes a bad canonicalization permanent with no correction path; two phrasings of one concept can mint distinct canonicals and fragment the library. No admin merge/relabel tool. | **Phase 3.1** — merge/relabel utility; seed curated `TOPIC_SLUGS` as self-aliases so the model maps onto them deterministically. |
| 2.4 | LOW | `normalizeTopic` only lowercases + collapses whitespace. Homoglyphs (`pythοn` w/ Greek omicron) bypass the cache → model call + distinct canonical. | **Phase 3.1** — add NFKC + zero-width stripping. |
| 2.5 | INFO (nit) | `TopicAlias.subject` is a free `String` cast `as TopicSubject`; a malformed write could store anything. | **Phase 3.1** — enum or check constraint. |
| 2.6 | INFO (→ Section 9) | Downstream stages key on `gate.canonical` (model-constrained), so `topic` is largely defanged as an injection vector — but `priorKnowledge` (500 chars) flows raw into retrieval + select prompts. | Carry to Section 9. Low (user attacks own generation). |

**Topic-partition follow-up** (its own design discussion — see ROADMAP ⭐ NEXT UP):
`resource.topic` is a single hard partition conflating *subject matter* with *the
discovery context that found the resource*; `searchResources` filters on exact
`topic =`. A generic JS tutorial discovered during a `javascript-react` request is
filed under `javascript-react` and invisible to a `javascript` path (real example:
`cmpyc0t4f0011bsm5rqszhb37`). Naive "filter on `conceptsTaught`" is insufficient
(per-topic concept vocab, fast-path dependence on the topic filter, no GIN index).
Direction TBD across four candidates (related-topic set / soft-topic-always-rank /
subject+specialization / fix-discovery+backfill).

**Good:** tiering makes curated topics free (no LLM/DB); first-writer-wins handles races; best-effort persist never fails a valid topic.

---

## Section 3 — Retrieval loop

Bounded tool-calling Flash agent. Opaque handles (`r1`, `r2`…) in place of cuids.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 3.1 | HIGH (latency) / → Section 5 | `ensureFloor` runs full web fallback synchronously + unconditionally before the loop, on a raw `count < 5` with **no concurrency guard** — two simultaneous first-requests for one cold topic both launch a full fallback (stampede). A cold topic can also pay the floor fallback *and* the model's 1 discretionary fallback = up to 2 full Pro loops per request. | Async (Phase 3) hides user pain; stampede + double-fallback are **Section 5** concerns. |
| 3.2 | MEDIUM (latency) | The system prompt asks for one `searchResources` per sub-skill, but whether those parallelize depends on the model emitting parallel tool calls vs. serializing across 6 steps. Each ranked search = embedding round-trip + pgvector query. No app-side batching/prefetch. | Measure via trace; consider a single multi-query search tool if serial. |
| 3.3 | LOW | `getResourceDetails` is a separate `findUnique` per call, no batching. Bounded by step count. | Note. |
| 3.4 | INFO (nit) | `session.all()` re-`view()`s every row, re-triggering idempotent `register()`. Correct, slightly wasteful. | Accept. |
| 3.5 | INFO | `runRetrieval` returns `notes`/`steps`/`fallbackCalls` but `generateCurriculum` only uses `candidates` + `resolve`. The model's gap notes are discarded rather than fed to select/critic. | Missed signal, not a bug. |

**Good:** opaque-handle design structurally prevents id fabrication/injection; idempotent registration; hard bounds on steps, fallbacks, and search limits.

---

## Section 4 — Search (`searchResources`)

Hybrid: structured filters → fast path (≤ `SEARCH_RANK_THRESHOLD`=30: return all
by trustScore, no embedding) or ranked path (> 30: pgvector cosine over filtered
set). hnsw index `Resource_embedding_idx` (cosine ops) exists.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 4.1 | LOW (efficiency) | Every search is two round-trips: `SELECT count(*)` then the fetch. Several searches per generation. | Could fetch `threshold+1` and branch, or fold into one query. Minor. |
| 4.2 | MEDIUM (scale) | hnsw applies the `WHERE` as a **post-filter** bounded by `hnsw.ef_search` (default 40). A selective filter (esp. difficulty within topic) can exhaust the index window before `LIMIT` filter-passing rows are found → fewer results / degraded recall. Natural partial mitigation: ranked path only runs when the topic slice is already > 30. | Tune `hnsw.ef_search` (or partial index) before any topic's library gets large. |
| 4.3 | LOW–MEDIUM (efficiency) | Every non-topic enum predicate is written `col::text = …` / `IN (…)`, defeating the enum-column indexes (`@@index([difficulty])` is effectively dead; only the `topic` leftmost-prefix does real index work). | Fix casts opportunistically; index for the real `topic + decompositionStatus + difficulty` predicate if it bottlenecks. |
| 4.4 | INFO (by design) | Behavioral cliff at the threshold: ≤30 → whole set by trustScore (`limit` ignored); 31 → embedding-ranked top-N. The candidate set's character flips at the boundary. | Explains any path-quality shift as a library crosses ~30. |
| 4.5 | LOW (consistency) | Ranked path filters `embedding IS NOT NULL`, so an un-embedded fresh resource is invisible there but visible on the fast path. Findability depends on the topic's set size. | Post-commit embedding usually closes this fast. Note. |

**Correction to earlier notes:** `topic` is **not** unindexed — `@@index([topic, status, tier])` covers `WHERE topic = X` via leftmost prefix.

**Good:** skip-embedding fast path is smart cost engineering; raw SQL is fully parameterized (no injection); the "ranked returned 0 of N" backfill warning is a useful operational tell.

---

## Section 5 — Web fallback

Gemini 2.5 **Pro** + Google Search grounding → validate (liveness + rules-agent) →
decompose → canonicalize → upsert. The app's most expensive operation. Triggered by
`ensureFloor` (deterministic, `count < FALLBACK_THRESHOLD`) and the model's
`triggerWebFallback` tool (budget 1/session).

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 5.1 | **HIGH** (cost) | **The fallback floor never fills, so fallback re-fires on every request for agent-grown topics.** `ensureFloor` counts `status='active' AND decompositionStatus='atomic'`; `upsertResource` inserts everything as `status='pending_review'`; **no promotion path exists** (nothing sets agent rows to `active`; the decomposition-review API only touches `decompositionStatus`). So for any topic without ≥5 *seeded* active atomic rows, `count` stays below threshold forever → a full Pro discovery loop fires every request. Search *does* see the new rows (`DEFAULT_STATUSES` includes `pending_review`), so the floor gate (`{active}`) and search eligibility (`{active, pending_review}`) diverge — defeating the "compound once, cheap thereafter" premise. Second cause: container finds upsert as unpickable (`human_review`/`pending`), which the `atomic` filter also excludes. `PENDING_REVIEW_GATE_PER_TOPIC` is defined but **wired nowhere** (dead config for an unimplemented gate). | **Phase 2.5 open items** — align the floor metric with search eligibility (count `pending_review` atomic toward the floor) **or** add the anticipated promotion path. Small, high-leverage; independent of the queue work. |
| 5.2 | **HIGH** (cost + waste) | **Cold-topic stampede: no lock/dedup across concurrent fallbacks.** Two simultaneous first-requests for the same cold topic each run a full Pro loop (up to 6 Pro calls), validate overlapping URLs, and both upsert. URL-unique prevents corruption but not doubled Pro/validation/decompose cost. Worst case = the realistic one (shared link → many users on one new topic at once); 5.1 makes every such request re-trigger too. | **Phase 3.1** — global web-fallback queue: worker pool (≤N at a time, Vertex-Pro/DSQ protection) + in-flight dedup + threshold re-check at dequeue. Deferred to 3.1 because Cloud Run (likely by then) makes a simple in-process worker-pool queue viable; an in-process queue doesn't span Vercel serverless instances. Vercel fallback if still there: Postgres advisory lock per topic + recheck (dedup + recheck, no global N-cap). |
| 5.3 | MEDIUM (cost) | A single cold request can run **two** full fallback loops: the deterministic floor (before retrieval) and the model's discretionary `triggerWebFallback` (during retrieval) are independent and unaware of each other → up to 2 × (3 Pro calls). | **Phase 3.1** — make the discretionary fallback aware the floor already ran this request. |
| 5.4 | MEDIUM (rate + latency) | Decompose fan-out is unbounded-parallel (`Promise.all` over up to 8 survivors, each potentially firing YouTube + doc fetch + concept-derivation LLM) while upsert+embed is fully **serial**. Aggressive in one phase (YouTube-quota/Vertex spike risk), conservative in the next (latency tail). | **Phase 3.1** — bound decompose concurrency (`p-limit`); parallelize post-commit embeds. |
| 5.5 | LOW (cost) | Repeated-empty discovery burns the full Pro budget: unparseable model output → `[]` → deny-list unchanged → loop re-runs identical discovery all 3 iterations for nothing. No early-abort on consecutive empties. | **Phase 3.1** — abort after N consecutive empty discoveries. |
| 5.6 | INFO (→ 1.1) | No per-day/per-topic $ budget; only iteration (3) and `targetCount` (8) per invocation. With 1.1 (unauthenticated) + 5.1 (re-fire), daily Pro spend is effectively unbounded. | Bounded by fixing 1.1 + 5.1. |

**Good:** growing deny-list prevents cross-iteration re-validation; oversample → validate → top-up absorbs rejections; decomposing before persist is the right placement; detailed per-iteration logging.

---

## Section 6 — Decomposition (YouTube + doc-TOC routers)

Deterministic `classify()` (URL/type only, no LLM) → YouTube playlist router (Data
API) / doc-TOC router (fetch + regex + LLM section-select) / atomic / unsupported.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 6.1 | MEDIUM (cost; compounds 5.1) | **Dedup is post-decompose.** Flow is discover → validate → decompose → upsert, and the existing-URL skip is in `upsertResource` (last step). Re-surfacing an already-stored playlist still runs liveness fetches + rules-agent Flash + full YouTube Data API decomposition + concept-derivation, then discards it at upsert. With 5.1 (re-fire every request), a popular cold topic re-pays YouTube quota + decompose cost every request. | **Phase 2.5 open items** — dedup URLs already in the library *before* validate/decompose, not just at upsert. Compounds the 5.1 fix. |
| 6.2 | MEDIUM (security; low practical exploitability) | **SSRF: no egress guard on any outbound fetch; redirects followed.** `decomposeDocToc` and the liveness validator fetch discovered URLs with no scheme allow-list / private-IP block, `redirect: 'follow'`. URLs come from grounded discovery (only attacker lever = canonicalized topic slug), so direct exploitation is hard — but a benign public URL that 302s to `169.254.169.254`/RFC1918 would be followed. | **Phase 3.1** — block non-http(s) + private/link-local ranges, re-check on each redirect hop, across liveness + doctoc + youtube oembed. |
| 6.3 | MEDIUM (reliability) | **Doc-TOC fetch has no timeout** (liveness has a 6s `AbortController`; doctoc has none). A hanging host stalls decomposition and, under the 5.4 fan-out, the whole fallback — with no request-scoped abort (1.2) to rescue it. | **Phase 3.1** — wrap in the same AbortController pattern. |
| 6.4 | MEDIUM (memory/DoS) | **Full response buffered before the size cap.** `(await res.text()).slice(0, 500k)` reads the entire body first; no `Content-Length` check, no streaming cap. A huge response is buffered in full → OOM risk, amplified by fan-out. | **Phase 3.1** — stream + abort past N bytes, or reject on Content-Length. |
| 6.5 | LOW | Regex HTML parsing (`extractCandidateLinks` etc.) is fragile (misses odd anchors, nested markup). The 500k cap bounds backtracking and the ⊆-URL guard defends correctness, so it's a recall/quality issue, not safety. | Note; acceptable for now. |
| 6.6 | LOW / INFO | Unrestricted YouTube key (by design — unstable egress IPs; API-restricted, server-side only). Quota-exceeded → `pending`, but `pending` rows don't count toward the floor (5.1) and there's no auto-retry scheduler (manual `scripts/retry-decomposition.ts`), so hitting 10k/day leaves topics full of unpickable containers. | Note; pairs with 5.1 + a retry scheduler. |
| 6.7 | LOW (data quality) | Missing-duration videos default to `durationMin: 1`, under-counting a path's true duration in the select-stage budget math. | Note. |

**6.2/6.3/6.4 share one surface** — do them as a single "outbound-fetch hardening" block (egress guard + timeout + size cap across all external fetches).

**Good:** oversize gate fires *before* per-child concept derivation (skips the expensive half for suspect containers); ⊆-URL guard makes URL hallucination structurally impossible in doc-TOC; same-origin link filtering; batched `videos.list`; private/deleted-video filtering; concept-derivation fan-out bounded by the oversize gate (≤2 batches auto).

---

## Section 7 — Upsert & embeddings

`upsertResource`: dedup-by-URL → `resolveSource` → atomic `$transaction`
(parent + children) → serial post-commit embeds. `decomposeExisting` /
`markAtomic` / `markUnsupported` for the curation paths.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 7.1 | MEDIUM (latency + cost) | **Post-commit embeds are one Vertex call + one UPDATE per row, fully serial.** A 50-child playlist = 50 sequential embedding round-trips. `embedMany` already batches natively (the backfill path uses 100/call) — the insert path just calls it one row at a time. | **Phase 2.5 open items** — collect `embedTasks`, `embedMany` once (chunks of 100), then UPDATE each. Also covers the "parallelize post-commit embeds" half of 5.4. |
| 7.2 | MEDIUM (scale) | **`resolveSource` loads the entire `Source` table and host-matches in JS, per upsert.** O(sources) full-table load + per-row URL parse on every insert; `Source` is agent-extensible so it grows. | **Phase 3.1** — cache source list (TTL) or add a normalized `host` column + indexed lookup. |
| 7.3 | LOW / INFO | No automatic embed backfill in the request path; a failed `safeEmbedResource` leaves the row unembedded until `scripts/embed-resources.ts` runs. With 4.5 (ranked search filters `embedding IS NOT NULL`), the row is unfindable on the ranked path until then. | Add a scheduled backfill/retry once on Cloud Run. |
| 7.4 | LOW (scale) | `embedMissing` SELECTs all stale rows unbounded (no `LIMIT`) before batching the embeds — whole table on a first backfill. Script, not hot path. | Keyset/LIMIT loop to bound memory. |
| 7.5 | LOW (handled) | URL-unique race: `findUnique`-then-`create` isn't atomic, but the constraint + `try/catch` make it safe (`'skipped'`). Cost: a parent-URL collision rolls back the whole container (children too), logged generically. Child clashes are handled gracefully per-child. | Accept; 5.2 shrinks the window. |
| 7.6 | LOW | `uniqueSlug`'s hash-suffixed branch isn't re-checked via `slugExists` — assumed unique. Two URLs with a hash collision *and* same title → duplicate suffixed slug → `create` throws → tx rollback. Astronomically rare but unguarded. | Re-check the suffixed slug, or accept. |
| 7.7 | MEDIUM (admin-only; ties 1.4) | `decomposeExisting` holds a 120s interactive transaction (~2 round-trips/child) pinning one pgbouncer backend connection. Curation/force-decompose only. | Keep off hot paths (already in 1.4). |

**Good:** atomic parent+children transaction; post-commit embed ordering; `safeEmbedResource` isolation (can't roll back an insert); `buildEmbeddingText` as single source of truth so backfill and insert-time embeddings can't diverge; `embeddedAt < updatedAt` staleness detection; conditional `updateMany` review-queue guards.

---

## Section 8 — Select + critic

Select: no-tools `Output.object` Flash call, picks/orders candidates by handle.
Critic: separate Flash call scoring against a 5-criterion rubric; revise loop up to
`CRITIC_MAX_REVISIONS` (2). Overall `pass` derived in code (AND of all criteria).

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 8.1 | MEDIUM (robustness) | **One stray/fabricated handle fails the whole request** (`CurriculumAgentError` → 422). Handle-indirection defense is right, but the response is maximal — one hallucinated handle among ten good items kills the path. At `temperature 0.4` this happens. | **Phase 3.1** — graceful-drop the unknown item (proceed if ≥1 valid remains); hard error only on zero valid. |
| 8.2 | MEDIUM–LOW (robustness) | **Duplicate/sparse `order` from the model → 500 at persist** (`@@unique([pathId, order])` violation). Schema allows any `order ≥ 1`; agent sorts but doesn't renumber. | **Phase 3.1** — renumber to dense `1..N` after sort. Removes the failure class. |
| 8.3 | MEDIUM (reliability + cost) | **`budgetFit` (pure arithmetic) is LLM-judged.** The prompt already hands the critic the computed `Path total` + `budget`; whether it passes is left to the model, which can wrongly pass an overrun / fail a fine total. | **Phase 3.1** — compute `budgetFit` in code; reserve the LLM for genuinely judgment-based criteria. |
| 8.4 | MEDIUM (quality + observability) | **A path that fails critique is persisted identically to a passing one** — no `passedCritique`/verdict flag on `Path`. Users can silently get a known-deficient path; no way to query how many shipped failing. | **Phase 3.1** — persist the final verdict / `passedCritique` + failed criteria on `Path`. Raw material for agent-quality metrics. |
| 8.5 | INFO (design) | Critic shares the selector's model (Flash) and rubric → independence is contextual, not capability; shared blind spots. | Stronger critic (different/larger model) or move mechanical criteria to code (8.3). |
| 8.6 | INFO (known) | Revision re-selects over the **same** candidate set, so "missing resource" feedback can't be addressed — may burn both revisions. | Already the roadmap "critic-triggered re-retrieval" open item. |
| 8.7 | LOW (taxonomy) | Select/critic mid-thought cap (`NoOutputGeneratedError`) throws non-`CurriculumAgentError` → 500/INTERNAL rather than 422/GENERATION_FAILED. | Map output failures to the semantic bucket. |

**Good:** code-derived `pass` (model can't claim a false overall pass); separate critic call (context independence); rubric mirrors the select contract; handle indirection carried into select (no cuid reaches the model); revision feeds back only failing criteria with concrete notes; bounded revisions with guaranteed best-effort return.

---

## Section 9 — Cross-cutting

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| 9.1 | **HIGH** (security; ties 1.1) | **`withAuth` and `withAdminAuth` gate on the same `DEV_AUTH=1` flag** — no user/admin boundary today. Setting the flag to enable generation simultaneously exposes the curation API including `force`-decompose (bypasses oversize gate, 100+ children, 120s tx), `markAtomic`/`markUnsupported`, and the human-review queue. | **Phase 3** (with 1.1) — real auth; `withAdminAuth` gets a *distinct* gate (role check), not the shared flag. |
| 9.2 | MEDIUM (cost + DoS) | **`GET /api/health?probe=ai` is unauthenticated and triggers a live Flash call per hit** (no auth wrapper); loopable → unbounded cost/DSQ. Also returns raw `err.message` to the client. | **Phase 3.1** — gate `probe=ai` behind admin/secret + rate-limit; keep plain liveness public. |
| 9.3 | MEDIUM–LOW (prompt injection) | **`priorKnowledge` (500 chars) flows raw into retrieval/select/critic prompts.** Blast radius bounded (handle indirection prevents id fabrication; never reaches discovery, so can't pollute the library) → realistic abuse is self-targeted + extra retrieval steps (cost). | **Phase 3.1** — delimit free text as untrusted data; instruct the model to treat as description, not instructions. |
| 9.4 | MEDIUM (operability) | **`console.log`-only; no structured logs, trace-id correlation, per-generation token/$ totals, or spike alerting.** Given the cost findings (1.1, 5.1, 5.2, 9.2), inability to see per-request/topic cost is itself a risk. Trace is per-request + ephemeral. | **Phase 3** — structured logs + persist per-job token cost on the async job record (pair with verdict, 8.4). |
| 9.5 | LOW / INFO | Default AI-SDK `maxRetries=2` everywhere: under a DSQ 429 each call becomes up to 3 attempts, tripling load during a throttle. No global concurrency limiter / circuit breaker. | Tune with the 5.2 worker-pool cap. |
| 9.6 | LOW | Secret hygiene is good (no SA-JSON/keys logged). Caveat: the YouTube key rides in the request URL (Data API requirement), so never log full request URLs (current code is clean — keep it). | Accept; guard future logging. |
| 9.7 | INFO (Phase 3) | State-changing POSTs have no CSRF protection — irrelevant now (env-flag/bearer), but matters once Phase 3 introduces Supabase cookie sessions. | Address in Phase 3 auth (or enforce non-cookie auth header). |

**Good:** genuine secret hygiene; generic errors on generate-path; Zod bounds every input (caps worst-case budget math); the `withAuth`/`withAdminAuth` *structure* is right (Phase-3-ready seam) — the only problem is the shared gate today.

---

## Priority summary

Top items by leverage, across all sections:

**Address with Phase 3 (auth/async work):**
- **1.1** — unauthenticated, unthrottled, un-idempotent generation endpoint (cost/DoS). The dominant risk.
- **9.1** — admin and user share one auth flag → no privilege boundary; curation/`force`-decompose exposed.
- **1.2 / 1.3** — synchronous 60s pipeline; cold-topic latency exceeds it → async job model.
- **9.4** — no per-request cost observability (build it into the async job record).

**Phase 2.5 (path-generation cost/efficiency — do early, independent of auth):**
- **5.1** — fallback floor never fills → full Pro discovery re-fires every request for grown topics. Highest cost-per-fix ratio in the audit.
- **6.1** — dedup before validate/decompose, not at upsert (compounds 5.1; re-burns YouTube quota).
- **7.1** — batch the per-row post-commit embeds (50 serial Vertex calls → 1).

**Phase 3.1 (launch readiness):**
- **5.2** — web-fallback stampede / global queue (simpler on Cloud Run).
- **6.2–6.4** — outbound-fetch hardening (SSRF egress guard + doc-TOC timeout + response size cap).
- **8.1 / 8.2** — graceful-drop unknown handles + renumber `order` (stop model slips from 422/500-ing the request).
- **8.3 / 8.4** — deterministic `budgetFit`; persist the critique verdict (quality measurement).
- **2.1 / 2.3** — bounded canonical retrieval; canonical correction/merge tool.
- **7.2 / 9.2 / 9.3** — `resolveSource` scan; health-probe auth; `priorKnowledge` delimiting.

**Own design discussion (ROADMAP ⭐ NEXT UP):**
- Topic-partition vs. semantic search (`searchResources` exact-`topic` rigidity).
