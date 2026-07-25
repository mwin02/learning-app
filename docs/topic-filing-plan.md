# Topic Filing Plan — multi-topic membership, open-vocabulary filing

**Drafted 2026-07-25.** Fixes a structural defect in resource ingestion: a discovered
resource is permanently filed under the topic that was *searched*, not the topic it is
actually about, and the set of topics it may be filed under is a hand-maintained edge list
in code. This doc is the source of truth for the fix: every block below is meant to be
workable by a **fresh conversation** with no other context — it records the verified
codebase facts the design rests on, the decisions locked, and the ambiguities deliberately
left open (marked **OPEN** — settle them in the block's discussion phase, not
unilaterally).

Workflow per CLAUDE.md applies to every block: one feature per conversation, discussion
first, <300 LOC per block, one branch per block, verification gate before commit/PR.

## The defect

Found while reviewing the `pending_review` queue on 2026-07-25: a Khan Academy **Algebra 1
"Functions"** unit (45 leaves) sat in the library filed under `topic = 'discrete-mathematics'`,
because that was the topic being built when discovery found it. It is not reachable from
any other topic and never can be.

Six verified mechanics compound into that outcome:

1. **Topic is stamped once, at insert, and never revisited.** `persistDiscovered` picks
   `filedTopic` and passes it to `upsertResource(filedTopic, …)`
   ([web-fallback.ts:405–430](../src/lib/agents/tools/web-fallback.ts)), which writes it on create
   ([upsert-resource.ts:118](../src/lib/agents/decomposition/upsert-resource.ts),
   [:156](../src/lib/agents/decomposition/upsert-resource.ts)); decomposition children inherit the
   parent's ([:377](../src/lib/agents/decomposition/upsert-resource.ts),
   [:411](../src/lib/agents/decomposition/upsert-resource.ts)). **No code path anywhere updates
   `Resource.topic` after creation** — and the metadata-correction whitelist deliberately
   excludes it ([resource-update-schema.ts](../src/lib/api/resource-update-schema.ts)).
2. **The filing vocabulary is a closed, code-owned allowlist.** `classifyDiscoveryTopics`
   may only return a member of `relatedTopics(requestTopic)`; anything else is dropped and
   falls back to the request topic ([classify-topic.ts:33–37](../src/lib/agents/tools/classify-topic.ts)).
   `relatedTopics` = `{topic} ∪ TOPIC_RELATIONS` ([resource.ts:75–82](../src/types/resource.ts)),
   and `TOPIC_RELATIONS` has **five** keys total ([resource.ts:41–70](../src/types/resource.ts)).
3. **For most topics the classifier never runs at all.** It is skipped when
   `candidateTopics.length <= 1` ([web-fallback.ts:406](../src/lib/agents/tools/web-fallback.ts),
   [classify-topic.ts:38](../src/lib/agents/tools/classify-topic.ts)). `discrete-mathematics` has no
   edges, so every discovery under it is stamped with zero classification.
4. **New topics can only be born from a learner request.** The topic gate — the only thing
   that mints canonical slugs into `TopicAlias` — runs in the program plan pass
   ([topic-gate.ts:1–20](../src/lib/agents/topic-gate.ts)). Discovery has no minting path, and a
   freshly minted topic starts edgeless, so it cannot become a filing target without a code
   edit to `TOPIC_RELATIONS`.
5. **The mislabel is permanent even once the right topic exists.** `upsertResource` dedupes
   on canonical URL and, on a cross-topic collision, logs `skip cross-topic URL collision`
   and returns `skipped` — it does not refile
   ([upsert-resource.ts:76–93](../src/lib/agents/decomposition/upsert-resource.ts)).
6. **Retrieval hard-filters on topic**, so a mis-filed row is reachable only from the topic
   it was mis-filed under ([search-resources.ts:113](../src/lib/agents/tools/search-resources.ts),
   [attach-candidates.ts:169](../src/lib/agents/map/attach-candidates.ts)).

### Blast radius (measured 2026-07-25, dev DB)

| Topic | Resources | In `TOPIC_SLUGS`? | `TOPIC_RELATIONS` edges | Path? |
| --- | --- | --- | --- | --- |
| `probability-and-statistics` | 456 | no (agent-minted) | none | yes |
| `calculus` | 395 | yes | `precalculus` (symmetric) | yes |
| `discrete-mathematics` | 276 | no (agent-minted) | none | yes |
| `linear-algebra` | 219 | yes | none | yes |
| `calculus-for-machine-learning` | 188 | no (agent-minted) | none | yes |
| `sql` | 117 | yes | `python-data-ml` | yes |
| `javascript-react` | 97 | yes | `javascript` | yes |
| `python-data-ml` | 76 | yes | `python`, `machine-learning` | yes |
| `python` | 68 | yes | (symmetric) | yes |
| `machine-learning` | 21 | yes | (symmetric) | no |
| `differential-equations` | 12 | no (agent-minted) | none | no |
| `differentiation` | 1 | no (agent-minted) | none | no |

**1,152 of 1,926 rows** (60%) live under a topic with no relations — `probability-and-statistics`,
`discrete-mathematics`, `linear-algebra`, `calculus-for-machine-learning`,
`differential-equations`, `differentiation` — i.e. were filed with the classifier skipped
entirely. Two adjacent defects the same query surfaced:

- **Slug drift past a curated slug.** `TopicAlias` holds canonical
  `data-structures-and-algorithms` while `TOPIC_SLUGS` has `data-structures-algorithms` —
  the tier-3 mint produced a twin of a curated slug, which is exactly what AR-5 exists to
  prevent. Likewise `probability` and `probability-and-statistics` are two canonicals over
  one pool.
- **Orphan topics.** `differentiation` (1 row) and `differential-equations` (12) have no
  Path, so nothing can retrieve them.

## The modelling error

`topic` is currently a property of **the query that found the resource**, not of the
resource. Everything above follows from that. The fix is to correct the model, not to widen
the allowlist — and the correction has two halves:

- **Membership is many-to-many.** The Khan Functions unit genuinely *is* both Algebra 1
  material and a discrete-math prerequisite. A scalar column cannot say that, so every
  other fix is a workaround until membership is a relation.
- **The filing boundary must be evidence-based, not an allowlist.** The "subject ceiling"
  defended in the `classify-topic.ts` header (a calculus find must never silently become
  linear-algebra) is a sound goal implemented with the wrong instrument: a hand-written
  edge list also excludes *correct* topics that merely lack an edge, or don't exist yet.

## Locked decisions (this plan)

| Area | Decision |
| --- | --- |
| Membership model | New `ResourceTopic` join table. `Resource.topic` **stays** as a denormalized mirror of the primary membership — non-breaking rollout, and the `@@index([topic, status, tier])` keeps working. |
| Filing vocabulary | Full canonical vocabulary (`listCanonicals()` = `TOPIC_SLUGS ∪ TopicAlias.canonical`), **not** `relatedTopics(requestTopic)`. |
| Filing guardrail | **k-NN label purity** over the resource's embedding (k=10), with a centroid-margin pre-filter — replacing the allowlist ceiling. Calibrated 2026-07-25; the originally-proposed absolute cosine threshold was **measured and rejected** (see T2). Self-widening: a topic gets easier to file into as its pool grows, with no deploy. |
| Uncertainty | Park, never guess. Below threshold (or cold-start topic) → file under the request topic **and** set `status='pending_review'` so it lands in the existing review queue. |
| New topics from discovery | Allowed, but only through the existing `runTopicGate` (tiers 1–2 short-circuit, tier 3 mints + persists the alias). A new topic with no Path is harmless — it waits in the library until a learner asks. |
| URL collisions | A URL discovered under a second topic **adds a membership** instead of being skipped. Two topics finding the same page is evidence, not a conflict. |
| `TOPIC_RELATIONS` | Survives, demoted to a **retrieval widening** hint — its original honest job. It is no longer a filing bound. |
| Request-side topics | `Path.topic` / `CourseRequest.topic` stay scalar. Nothing about request intake or the topic gate's request path changes. |
| Existing rows | Reclassified in bulk (T4), with disagreements routed to human review rather than auto-rewritten. |

## Sequencing

| # | Block | Kind | Depends on | Est. LOC |
| --- | --- | --- | --- | --- |
| T1 | `ResourceTopic` schema + backfill + retrieval seam | code + migration | — | ~250 |
| T2 | Open-vocabulary classifier + centroid guardrail | code | T1 | ~280 |
| T3 | Discovery-side topic minting + collision → membership | code | T2 | ~200 |
| T4 | Bulk reclassification, drift merge, gate hardening | code + ops | T1–T3 | ~250 |

T1–T4 stack (branch per block, stacked PRs — merge bottom-up per the CLAUDE.md stacked-chain
procedure). T1 is independently valuable and independently shippable: it fixes retrieval
reachability even before filing gets smarter.

---

## T1 — `ResourceTopic`: membership becomes many-to-many

### Schema

```prisma
model ResourceTopic {
  id         String            @id @default(cuid())
  resourceId String
  resource   Resource          @relation(fields: [resourceId], references: [id], onDelete: Cascade)
  topic      String
  // Classifier confidence / centroid similarity at filing time. Retrieval may
  // gate on this; ranking may blend it. 1.0 for `inherited` backfill rows.
  relevance  Float             @default(1.0)
  origin     TopicFilingOrigin @default(classifier)
  // Exactly one true per resource; mirrored to Resource.topic.
  isPrimary  Boolean           @default(false)
  createdAt  DateTime          @default(now())

  @@unique([resourceId, topic])
  @@index([topic, resourceId])
}

enum TopicFilingOrigin {
  inherited   // T1 backfill from the legacy scalar
  discovery   // request topic, classifier skipped or unavailable
  classifier  // proposed by classify-topic and cleared the guardrail
  collision   // a second topic's discovery hit the same URL (T3)
  review      // a human set it via the review/curation surface
}
```

Precedent for the shape: `ResourceSourcedFor` is the same resource↔X join
([schema.prisma:665](../prisma/schema.prisma)).

### Backfill

One row per existing `Resource`: `topic = Resource.topic`, `isPrimary = true`,
`origin = inherited`, `relevance = 1.0`. Idempotent, run inside the migration or as a
`scripts/` driver — **OPEN**: which, given the ~1,926-row size (in-migration is simpler;
a driver is friendlier to the Supabase cutover in the free-beta D2 block).

Invariant to assert after backfill: `count(ResourceTopic where isPrimary) == count(Resource)`
and every `Resource.topic` has a matching primary membership.

### ⚠️ Migration hazard

Per AGENTS.md, this migration **must not** drop the two hand-written indexes Prisma can't
model (`Resource_embedding_idx`, `RemediationJob_active_per_path`). Check the generated
`migration.sql` for `DROP INDEX` lines before the first apply.

---

## Retrieval changes for multi-membership

This is the section to read before touching any query. **All topic-scoped retrieval funnels
through one function** — `buildConditions` in
[search-resources.ts:99–145](../src/lib/agents/tools/search-resources.ts) — which is what makes T1
tractable. Verified call sites:

| Call site | Entry point | Topic scoping today |
| --- | --- | --- |
| Map candidate attachment | `attach-candidates.ts:263` → `searchResources` | `topics: relatedTopics(topic)` (`:169`) |
| Web-fallback library rung | `web-fallback.ts:246` → `searchNearbyResources` | `topics: relatedTopics(topic)` (`:247`) |
| Playground resource picker | `resource-search/route.ts:38` → `searchResources` | `topics: relatedTopics(topic)` (`:40`) |
| Agent tool wrapper | `search-resources.ts:263` → `searchResources` | model-supplied `topic` |

### 1. The predicate: `EXISTS`, not `JOIN`

Replace the scalar predicates in `buildConditions`:

```ts
// before
if (topics?.length) conds.push(Prisma.sql`topic IN (${Prisma.join(topics)})`);
else if (topic)     conds.push(Prisma.sql`topic = ${topic}`);

// after
const wanted = topics?.length ? topics : topic ? [topic] : [];
if (wanted.length > 0) {
  conds.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "ResourceTopic" rt
    WHERE rt."resourceId" = "Resource".id
      AND rt.topic IN (${Prisma.join(wanted)})
      AND rt.relevance >= ${minRelevance}
  )`);
}
```

**`EXISTS` is load-bearing, not stylistic.** A plain `JOIN` against a multi-row membership
table multiplies result rows whenever a resource matches two of the requested topics — and
every query in this module selects `${COLS}` without a `DISTINCT`, so a
`javascript-react` search (which requests two topics) would silently return duplicate
candidates to the judge, double-counting them in ranking and in the fast path's wholesale
return. `EXISTS` is a semi-join: at most one row out, no `DISTINCT` needed, and it
short-circuits on first match.

The raw queries reference bare column names against `FROM "Resource"`, so the subquery must
qualify as `"Resource".id` to avoid ambiguity with `rt`.

### 2. All three query paths in `searchResources` inherit the fix for free

`searchResources` ([:153–205](../src/lib/agents/tools/search-resources.ts)) has three paths, all built
from the same `where`:

- **count + fast path** (`count <= SEARCH_RANK_THRESHOLD`) — returns wholesale, trust-ordered.
- **large set, no query** — top-N by `trustScore`.
- **ranked path** — pgvector `<=>` nearest neighbours within the filtered set.

None needs structural change. But note the **fast-path threshold now sees a larger candidate
pool**: multi-membership means more rows clear the filter, so some searches that used to take
the cheap unranked path will now rank (spending an embedding). That is the intended
behaviour — more candidates is the point — but it shifts LLM/embedding cost. **OPEN**:
whether `SEARCH_RANK_THRESHOLD` needs re-tuning once T4's backfill shows real membership
fan-out.

`searchNearbyResources` ([:228](../src/lib/agents/tools/search-resources.ts)) reuses `buildConditions`
and keeps its hard `maxDistance` ceiling, so a weak membership still can't drag a far-off
row in on topic alone — the distance gate remains the real admission control there.

### 3. `minRelevance`: the new bleed control

Add `minRelevance?: number` to `SearchParams`, defaulting to a constant (**OPEN**: start
at 0.0 — i.e. off — until T4 produces a relevance distribution to calibrate against;
`inherited` rows are all 1.0 so a nonzero default would be a no-op pre-T4 anyway). Post-T2,
`relevance` carries k-NN purity, which is bounded 0–1 and comparable across topics — unlike
the raw cosine, whose narrow 0.72–0.79 band the calibration showed is unthresholdable.

This is the knob that replaces `TOPIC_RELATIONS` as bleed control. Relatedness widening was
a proxy for "this resource might also be useful over here"; a real membership with a real
confidence says it directly, and better.

### 4. Ranking: expose `relevance`, don't blend it yet

Add `relevance: number` to `SearchResult` (selected from the matched membership via a
correlated scalar subquery, or `MAX(rt.relevance)` when several requested topics match).
Surface it to callers — the judge in `attach-candidates` and the re-judge rung are the
consumers that could use it — but **do not fold it into the ordering in T1**. The current
invariant is *coverage gates, trust only orders* (free-beta A3); adding a third term to
ranking is a separate decision with its own verification, not a side effect of a schema
change.

### 5. `Resource.topic` reads stay valid

`COLS` selects `topic` and the playground picker returns `r.topic` to the UI
([resource-search/route.ts:56](../src/app/api/playground/resource-search/route.ts)). Because the mirror
is maintained, every existing read keeps working unchanged and means "primary topic".

### 6. `includeIds` and the status window are unaffected

The allowlist escape hatch ([:132–139](../src/lib/agents/tools/search-resources.ts)) relaxes only the
status window and is `AND`-ed with everything else — including the new `EXISTS`. A resource
discovered this run still needs a membership to be retrievable, which T3 guarantees at
insert.

### 7. Indexing and rollout

`@@index([topic, resourceId])` covers the subquery (index-only scan for the `IN` + join
key). Keep `Resource.@@index([topic, status, tier])` — it still serves mirror reads.

Rollout is a straight cutover, not a dual-read: after the backfill, the membership table is
a **superset** of the scalar (every resource has its primary row), so the `EXISTS` predicate
returns a superset of today's results. Verify with a differential harness — run both
predicates over the same params on the dev DB and assert the result sets are identical
pre-T2 — then delete the old branch.

### Verification gate (T1)

- Unit: `buildConditions` emits the `EXISTS` form; a two-topic request produces no duplicate
  ids (regression test for the `JOIN` footgun).
- Integration (`tests/integration/`, `describeDb`, `__verify_rt__` prefix): a resource with
  two memberships is returned exactly once by each of the three `searchResources` paths, and
  by `searchNearbyResources`.
- Differential: old vs new predicate over every existing topic → identical id sets.
- Manual: playground resource picker renders unchanged for a `javascript-react` topic.

---

## T2 — Open-vocabulary filing with an embedding guardrail

### Candidate set

`classifyDiscoveryTopics` takes the full canonical vocabulary from `listCanonicals()`
([topic-registry.ts:62–70](../src/lib/agents/topic-registry.ts)) instead of `relatedTopics(topic)`, and
returns **ranked proposals with confidence** rather than one label. Delete the
`candidates.length <= 1` early return ([classify-topic.ts:38–40](../src/lib/agents/tools/classify-topic.ts))
and the caller-side skip ([web-fallback.ts:406](../src/lib/agents/tools/web-fallback.ts)) — those are
what make the classifier a no-op for 1,152 rows today.

### Calibration results (run 2026-07-25 — `scripts/calibrate-topic-threshold.ts`)

Run over 1,832 atomic, embedded, non-generated rows across 11 topics. Positives are
leave-one-out similarity to the row's own topic centroid; negatives are its similarity to
the best *other* centroid. **This run changed the design below — read it before implementing.**

| Instrument | Agreement with current labels | Verdict |
| --- | --- | --- |
| 1. Absolute centroid threshold *(originally specified)* | best Youden J **0.453** at t=0.725 | ❌ **rejected** |
| 2. Relative margin (own − bestOther) | 80.8% top-1 | ✅ viable as a **flagger** |
| 3. k-NN label purity (k=10) | **88.7%** plurality agreement | ✅ **strongest** |

**Instrument 1 fails.** The distributions overlap almost completely — own-topic p50 =
0.757, best-other p50 = 0.688, with p05–p95 spans of 0.663–0.825 and 0.586–0.779. At the
best operating point (t=0.725) it parks **28.3% of correctly-filed rows** while still
admitting 26.4% of wrong-topic claims. This confirms the prior warning already recorded in
[audit-topic-relations.ts](../scripts/audit-topic-relations.ts): a technical corpus clusters too
tightly for an absolute cosine to threshold on. Per-topic means sit in a narrow 0.724–0.786
band, so no per-topic threshold rescues it either.

**Instrument 2 works because it is scale-free.** An absolute cosine conflates "is this about
topic X" with "how tight is topic X's cluster"; the margin asks the discriminating question
directly. Margin p50 = +0.065, p05 = −0.045. Flag rates: δ=0 → 19.2% (352 rows), **δ=0.05 →
4.3% (78 rows)**, δ=0.1 → 0.9%.

**Instrument 3 is the best single signal** and is what the guardrail should actually use:
the plurality label of a row's 10 nearest neighbours matches its current topic 88.7% of the
time (median purity 1.0, p25 0.7). It handles multi-modal topics that a single mean vector
represents badly — which is most of them.

**Motivating case.** The 45 Khan "Functions" leaves score margin p50 = −0.033, and **38/45
are flagged at δ=0** — the margin instrument catches them, where the absolute threshold only
"caught" them by parking a quarter of the library. But their nearest other centroids are
`calculus-for-machine-learning` (19) and `calculus` (18): **detection works, correction does
not**, because the right answer (`algebra`) isn't in the vocabulary. This is the empirical
argument that T2 must *flag*, never auto-refile, and that T3's minting is the block that
actually fixes this class of defect.

**Side finding worth its own ticket.** The 15 lowest absolute scorers are dominated by
non-teaching boilerplate leaves — "About the course", "What Now?", "Feedback", "Course
Prerequisites", "Why These Prerequisites Matter". Low absolute similarity is a decent
**junk-leaf detector** even though it's a poor mis-filing detector. That's a quality/containment
signal for the review queue, not a filing signal. It also surfaced two genuine mis-filings
worth fixing by hand now: `sklearn.linear_model.LogisticRegression` filed under
`probability-and-statistics` (nearest `python-data-ml`, margin −0.163) and the Khan
average-rate-of-change rows.

### Revised guardrail: k-NN purity, with margin as the cheap pre-filter

Accept a proposed membership when the proposed topic is the **plurality label among the
resource's k=10 nearest neighbours** (k-NN, instrument 3). Use the margin (instrument 2) as
a cheap pre-filter: rows with margin ≥ δ are uncontested and skip the k-NN query entirely.
Drop `TOPIC_FILING_THRESHOLD` — there is no absolute cosine worth thresholding on.

Starting parameters from this run, to be re-verified after T4's backfill: **δ = 0.05**
(4.3% of rows go to the k-NN check), **k = 10**, plurality with ties → park for review.

`TopicCentroid` is still worth building: it powers the margin pre-filter cheaply, and the
absolute score feeds the junk-leaf signal above. Its role is narrowed, not eliminated.

### Centroid table (pre-filter input)

```prisma
model TopicCentroid {
  topic       String   @id
  centroid    Unsupported("vector(768)")
  memberCount Int
  computedAt  DateTime
}
```

Mean of the topic's `active` resource embeddings. Refreshed by the existing embed backfill
(`scripts/embed-resources.ts`) — the column is written and read only via raw SQL, exactly
like `Resource.embedding` (see the schema note at
[schema.prisma:66–75](../prisma/schema.prisma)).

**Cold start / degradation** — the design must not regress when evidence is missing:

| Condition | Behaviour |
| --- | --- |
| `memberCount < MIN_CENTROID_MEMBERS` | No trustworthy centroid → skip the margin pre-filter, go straight to k-NN. |
| Fewer than k embedded neighbours in the whole library | Accept the classifier's primary, file `pending_review`. |
| Resource has no embedding yet (post-commit backfill) | Defer the guardrail; file under the request topic, mark for T4's reclassifier to revisit. |
| Classifier errors / returns nothing | Fall back to the request topic, exactly as today ([classify-topic.ts:33–37](../src/lib/agents/tools/classify-topic.ts)). Never worse than current behaviour. |

**OPEN**: `MIN_CENTROID_MEMBERS`. Every topic in this run cleared 5 members except
`differentiation` (1 row, no embedded atomic leaf — it didn't even enter the sample), so the
data doesn't pin this down; pick it defensively.

### Multi-membership at filing time

Every proposal clearing the guardrail becomes a `ResourceTopic` row (`origin: classifier`,
`relevance` = the k-NN purity fraction, which is bounded 0–1 and comparable across topics in
a way the raw cosine is not). The highest becomes `isPrimary` and is mirrored to
`Resource.topic`. **OPEN**: cap memberships per resource (a hard cap of ~3 is the obvious
guard against a generic "intro to programming" page joining every CS topic).

**Never auto-refile an existing row.** Per the motivating case above, a disagreement means
"the current label is contested", not "the alternative is right". Disagreements go to
`pending_review`; a human or T3's minting resolves them.

---

## T3 — Discovery may mint topics; collisions add memberships

1. **Minting.** When no existing canonical clears the threshold, hand the classifier's
   proposed label to `runTopicGate`. Tier 1 fast-accepts a curated slug, tier 2 reuses a
   known alias, tier 3 mints + persists. File under the result with `status='pending_review'`.
   The gate already coerces to a safe slug (`toCanonicalSlug`) and already grounds the model
   on the canonical list, so this reuses hardened code rather than adding a second minting
   path.
2. **Collisions.** [upsert-resource.ts:76–93](../src/lib/agents/decomposition/upsert-resource.ts): on
   `existing.topic !== topic`, add a `ResourceTopic` row (`origin: collision`) instead of
   logging and returning `skipped`. Extend `UpsertOutcome` with a `membership_added` outcome
   so `persistDiscovered`'s counters (`skippedCount`, `reclassifiedCount`) report it honestly.
   Keep the existing log line — it becomes a useful signal rather than a dead end.
3. **Children.** Decomposition children still inherit the parent's primary topic
   ([:377](../src/lib/agents/decomposition/upsert-resource.ts), [:411](../src/lib/agents/decomposition/upsert-resource.ts)).
   Per-child classification is out of scope — a container's children are by construction the
   same subject as the container.

---

## T4 — Bulk reclassification, drift merge, gate hardening

1. **Reclassify the backlog.** A `scripts/reclassify-topics.ts` driver over rows filed while
   the classifier was skipped (1,152). Write memberships that clear the k-NN guardrail
   automatically; where the proposed primary **differs** from the current one, flip the row
   to `pending_review` rather than rewriting it. Expect roughly 11% disagreement (the k-NN
   instrument's measured 88.7% agreement) — call it ~130 rows for review, though some of
   that 11% is the instrument being *right* about existing mis-filings. The `/review-pending-resources` skill is
   already the reviewer seam and already opens each page against a rubric — no new tooling.
   Run in batches with a dry-run mode; this is an LLM + embedding cost, so it belongs in the
   ops budget alongside the warm campaign.
2. **Merge drifted canonicals.** `data-structures-and-algorithms` → `data-structures-algorithms`,
   `probability` → `probability-and-statistics`. Remap `TopicAlias.canonical`, rewrite
   memberships and mirrors, then verify no `Path`/`CourseRequest` references the dead slug.
3. **Harden the gate against re-drift.** After `toCanonicalSlug`, snap a tier-3 mint onto a
   curated slug when it near-matches one (normalized comparison against `TOPIC_SLUGS`), so
   the gate can't mint a twin of a code-owned slug again. Unit-testable, pure.
4. **Adopt the orphans.** `differentiation` (1 row) and `differential-equations` (12) have no
   Path — the reclassifier should either fold them into a real topic or leave them parked
   with a review flag. **OPEN**: fold vs. park.
5. **Re-run the calibration and re-tune.** This is a required closing step, not a nice-to-have.
   The 2026-07-25 run calibrated against labels we already know are partly wrong, so its
   88.7% is *agreement with the status quo*, not correctness — the noise floor is the very
   defect T4 removes. Once the backlog is reclassified and the review queue drained:

   ```bash
   npx tsx --env-file=.env.local scripts/calibrate-topic-threshold.ts
   ```

   The script is read-only and idempotent, so it is safe to run mid-drain for a progress
   read. Expect all three instruments to improve as label noise falls; k-NN agreement is the
   headline number to watch. Then revisit, in this order:

   - **k-NN agreement ≥ ~95%** → tighten `δ` below 0.05 (fewer rows need the expensive
     k-NN check) and consider raising the `minRelevance` retrieval default off 0.0.
   - **k-NN agreement still ~88% or worse** → the instrument, not the labels, is the limit.
     Escalate to a supervised classifier over the embeddings, or accept k-NN as a flagger
     only and lean harder on human review. Do **not** respond by loosening the guardrail.
   - **Any topic whose per-topic own-similarity mean drifts well below the 0.72–0.79 band**
     → that topic's pool has become incoherent (usually a container decomposed into
     off-topic leaves); triage it before it poisons its own centroid.
   - Re-check the motivating-case block: post-T3 the Khan leaves should have an `algebra`-ish
     topic available. If they still flag with no better home, minting isn't working.

   Record the new numbers in the T2 calibration table with their run date, replacing rather
   than appending — one current calibration, not a changelog.

---

## Rejected alternatives

| Option | Why not |
| --- | --- |
| Widen `TOPIC_RELATIONS` by hand | Restates the problem. Every new topic needs a code deploy, and agent-minted topics — the majority of the library by row count — can never get an edge at mint time. |
| Park-on-uncertainty only (the cheap fix) | Stops *new* mislabels but fixes neither the multi-topic reality nor the 1,152 existing rows, and grows a review backlog with no mechanism to drain it. Worth shipping only if T1–T4 are deferred. |
| Drop `topic`, retrieve purely semantically | Loses the hard subject boundary that keeps calculus material out of linear-algebra tracks, and makes the library unauditable — there'd be no answer to "what do we have on X". |
| Make `topic` editable via the PATCH whitelist | A manual patch over a systemic defect. Also insufficient on its own: the URL-collision skip still freezes the row, and one scalar still can't express dual membership. |

## Risks

- **Retrieval bleed.** More memberships = larger candidate sets. Controls: `minRelevance`,
  the per-resource membership cap, and the unchanged `maxDistance` ceiling on the re-judge
  rung. Watch candidate-set sizes in the map-attach trace after T2.
- ~~**Threshold miscalibration**~~ — **retired 2026-07-25.** Calibration ran
  (`scripts/calibrate-topic-threshold.ts`) and settled the instrument: absolute cosine
  rejected, k-NN purity adopted, δ=0.05 / k=10 as starting parameters. Residual risk is that
  the labels it calibrated against are themselves noisy, so re-run after T4's backfill
  cleans them. The script is idempotent and read-only.
- **Cost.** One classifier call per discovery batch (already batched) plus a cached centroid
  aggregate — small next to the discovery LLM spend. T4's one-off backfill is the real line
  item and should be budgeted with the warm campaign.
- **Cross-plan collision.** The free-beta D2 block migrates `Source` / `TopicAlias` /
  `Resource` to Supabase. `ResourceTopic` and `TopicCentroid` must be added to that migration
  script's table list, and centroids recomputed post-migration alongside the embed backfill.
