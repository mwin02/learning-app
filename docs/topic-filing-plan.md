# Topic Filing Plan — multi-topic membership, open-vocabulary filing

**Drafted 2026-07-25; revised 2026-07-25 after two consolidated design reviews** (guardrail
timing, container embedding, uncertainty carrier, collision guardrail, resequencing).
Fixes a structural defect in resource ingestion: a discovered
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
| Guardrail timing | The embedding is computed **pre-insert**, in `persistDiscovered`, so the guardrail runs at filing time. Its input (`title` + `summary` + `conceptsTaught`, [upsert-resource.ts:183–187](../src/lib/agents/decomposition/upsert-resource.ts)) is fully known before insert; without this, every fresh find hits the "no embedding yet" degradation row and the guardrail is dead code at its primary application point (embeds are post-commit, [:177–189](../src/lib/agents/decomposition/upsert-resource.ts)). The vector is passed into the transaction; the post-commit `safeEmbedResource` becomes a no-op for these rows. Changes `upsertResource`'s signature. |
| Containers | **Containers get embedded too** — one extra call each. The motivating case *is* a container, and containers currently never enter `embedTasks` ([upsert-resource.ts:144–152](../src/lib/agents/decomposition/upsert-resource.ts)), so the guardrail was structurally blind to the exact defect class this plan exists for — and children inherit the container's topic, multiplying one mistake by 45. Safe: retrieval already excludes non-atomic rows via the default `decompositionStatus = 'atomic'` predicate ([search-resources.ts:126](../src/lib/agents/tools/search-resources.ts)), not by embedding presence. The container's guardrail verdict governs what its children inherit. |
| Uncertainty | Park, never guess — carried on the **membership** (`ResourceTopic.contested`), **not** on `Resource.status`. Discovery rows are already born `pending_review` ([upsert-resource.ts:133](../src/lib/agents/decomposition/upsert-resource.ts), children `:162`) and `DEFAULT_STATUSES` includes `pending_review` ([search-resources.ts:87](../src/lib/agents/tools/search-resources.ts)), so a status flip adds no distinguishable signal and "parked" rows would stay retrievable anyway. Quality review and filing confidence are orthogonal axes. Contested **secondaries** are excluded from retrieval; a contested **primary** stays retrievable (never orphan a row). |
| New topics from discovery | Allowed, but only through the existing `runTopicGate` (tiers 1–2 short-circuit, tier 3 mints + persists the alias). A new topic with no Path is harmless — it waits in the library until a learner asks. |
| URL collisions | A URL discovered under a second topic adds a membership **only after clearing the same k-NN guardrail**. A collision is the *searched* topic asserting membership — the exact signal "The modelling error" rejects — so it gets no free pass. Collision rows: `relevance` = k-NN purity (never the schema default 1.0, which would outrank guarded classifier rows under any future `minRelevance`), `isPrimary = false` always, and they count against the membership cap. |
| `TOPIC_RELATIONS` | Survives, demoted to a **retrieval widening** hint — its original honest job. It is no longer a filing bound. |
| Request-side topics | `Path.topic` / `CourseRequest.topic` stay scalar. Nothing about request intake or the topic gate's request path changes. |
| Existing rows | Reclassified in bulk (T4), with disagreements routed to human review rather than auto-rewritten. |

## Sequencing

| # | Block | Kind | Depends on | Est. LOC |
| --- | --- | --- | --- | --- |
| T1 | `ResourceTopic` schema + backfill + retrieval seam | code + migration | — | ~250 |
| T1.5 | Twin merge + gate hardening (pulled forward from T4) | code + ops | T1 | ~80 |
| T2a | Pre-insert embedding plumbing + `TopicCentroid` | code + migration | T1 | ~150 |
| T2b | Open-vocabulary classifier + k-NN guardrail | code | T1.5, T2a | ~200 |
| T3 | Discovery-side topic minting + collision → membership | code | T2b | ~200 |
| T4 | Bulk reclassification, orphans, retrieval narrowing, recalibration | code + ops | T1–T3 | ~200 |

Blocks stack (branch per block, stacked PRs — merge bottom-up per the CLAUDE.md stacked-chain
procedure). T1 is independently valuable and independently shippable: it fixes retrieval
reachability even before filing gets smarter.

**Why T1.5 sits before T2b:** `listCanonicals()` — what T2b feeds the classifier — currently
contains both twin pairs (`data-structures-and-algorithms` / `data-structures-algorithms`,
`probability` / `probability-and-statistics`). Shipping the open-vocabulary classifier first
would spread memberships across both halves of each twin, and T3's minting could add more.
The twin merge and the snap-to-curated-slug gate guard are pure, cheap, and dependency-free —
there is no reason to let the classifier run against a dirty vocabulary. (Their specs remain
written in T4 §2–3 below; T1.5 executes them.)

**Why T2 split in two:** the original ~280 LOC estimate did not cover the pre-insert
embedding plumbing (an `upsertResource` signature change), the `TopicCentroid` migration,
the centroid refresh in `scripts/embed-resources.ts`, the k-NN query, and the calibration
re-wiring. T2a lands the plumbing and data; T2b lands the classifier + guardrail on top.

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
  // Exactly one true per resource; mirrored to Resource.topic. Enforced by the
  // setPrimaryTopic seam + backfill assertion + integration test — deliberately
  // NOT a partial unique index (see "The mirror write seam" below).
  isPrimary  Boolean           @default(false)
  // Filing uncertainty lives HERE, not on Resource.status — quality review and
  // filing confidence are orthogonal. Contested secondaries are excluded from
  // retrieval; a contested primary stays retrievable.
  contested  Boolean           @default(false)
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

### The mirror write seam

One transactional function — `setPrimaryTopic(resourceId, topic)` — is the **only** code
path that writes `isPrimary` or `Resource.topic`. It clears the old primary flag, sets the
new one, and updates the mirror in the same transaction. Everything else (backfill,
classifier, collisions, T4 reclassifier, review surface) calls it; nothing writes either
field directly, or the mirror rots.

**The "exactly one primary" invariant is enforced by assertion, not by index** — a
deliberate call, not an oversight. The DB-level option is a partial unique index
(`ON "ResourceTopic"("resourceId") WHERE "isPrimary"`), which Prisma can't model, making it
the **third** entry in AGENTS.md's never-drop table — a permanent tax on every future
migration. Unlike `RemediationJob_active_per_path` there is no concurrent-claim race to
backstop here: all primary changes flow through the one seam. So instead: assert the
invariant in the backfill check (below), in an integration test, and as a drift assertion
in the T1 differential harness. If a violation ever shows up in practice, escalate to the
partial index then — and update AGENTS.md's table in the same PR.

### Backfill

One row per existing `Resource`: `topic = Resource.topic`, `isPrimary = true`,
`origin = inherited`, `relevance = 1.0`. **Resolved** (was OPEN): an idempotent
`scripts/` **driver**, not in-migration. 1,926 rows is fine either way, but the free-beta
D2 Supabase cutover re-runs table lists, and a driver is re-runnable; a migration isn't.

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

| Call site | Entry point | Topic scoping today | Scoping after T4's backfill |
| --- | --- | --- | --- |
| Map candidate attachment | `attach-candidates.ts:263` → `searchResources` | `topics: relatedTopics(topic)` (`:169`) | **narrow to `[topic]`** |
| Web-fallback library rung | `web-fallback.ts:246` → `searchNearbyResources` | `topics: relatedTopics(topic)` (`:247`) | **keep `relatedTopics`** — `maxDistance` is the real gate here |
| Playground resource picker | `resource-search/route.ts:38` → `searchResources` | `topics: relatedTopics(topic)` (`:40`) | **narrow to `[topic]`** |
| Agent tool wrapper | `search-resources.ts:263` → `searchResources` | model-supplied `topic` | unchanged |

**Bleed is multiplicative until the narrowing lands.** `relatedTopics` widening layered on
top of multi-membership widens twice, and the stated control (`minRelevance`) defaults to
off. But narrowing **must wait for T4's backfill** — before cross-topic rows have their
memberships, dropping `relatedTopics` at the attach/picker sites would regress
reachability. So: T1 lands the plumbing with today's scoping unchanged; the narrowing is an
explicit T4 step (§4 below), flipped once memberships exist.

### 1. The predicate: `EXISTS`, not `JOIN`

Replace the scalar predicates in `buildConditions`:

```ts
// before
if (topics?.length) conds.push(Prisma.sql`topic IN (${Prisma.join(topics)})`);
else if (topic)     conds.push(Prisma.sql`topic = ${topic}`);

// after
const wanted = topics?.length ? topics : topic ? [topic] : [];
if (wanted.length > 0) {
  // Omit the relevance clause entirely when minRelevance is 0 (the default):
  // it keeps @@index([topic, resourceId]) sufficient (the clause isn't covered
  // by that index), and keeps the emitted SQL identical to the differential
  // baseline. Revisit the index shape ([topic, relevance, resourceId]) only
  // when a nonzero default actually lands (T4+).
  conds.push(Prisma.sql`EXISTS (
    SELECT 1 FROM "ResourceTopic" rt
    WHERE rt."resourceId" = "Resource".id
      AND rt.topic IN (${Prisma.join(wanted)})
      AND NOT (rt.contested AND NOT rt."isPrimary")
  )`);
}
```

(The `contested` clause implements the uncertainty decision: contested secondaries are
invisible to retrieval, a contested primary stays reachable.)

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
behaviour — more candidates is the point — but it shifts LLM/embedding cost.
**Resolved** (was OPEN): leave `SEARCH_RANK_THRESHOLD` as-is; re-tune only after T4's
backfill shows real membership fan-out.

`searchNearbyResources` ([:228](../src/lib/agents/tools/search-resources.ts)) reuses `buildConditions`
and keeps its hard `maxDistance` ceiling, so a weak membership still can't drag a far-off
row in on topic alone — the distance gate remains the real admission control there.

### 3. `minRelevance`: the new bleed control

Add `minRelevance?: number` to `SearchParams`, defaulting to 0.0 — i.e. off — until T4
produces a relevance distribution to calibrate against. Post-T2, `relevance` carries k-NN
purity, which is bounded 0–1 and comparable across topics — unlike the raw cosine, whose
narrow 0.72–0.79 band the calibration showed is unthresholdable.

**⚠️ `relevance` semantics are origin-dependent — `minRelevance` must be origin-aware.**
`inherited` rows carry 1.0 meaning "unknown", not "certain"; `classifier`/`collision` rows
carry measured k-NN purity. A flat nonzero `minRelevance` would let unverified inherited
labels sail through while gating verified classifier memberships — backwards. When
`minRelevance` goes nonzero (T4+), the predicate gates **only non-`inherited`/non-`review`
origins** (`AND (rt.origin IN ('inherited','review') OR rt.relevance >= ${minRelevance})`).
Note T4's reclassifier only re-scores the 1,152 skipped-classifier rows; the other ~774
inherited rows keep their placeholder 1.0 unless T4's stretch re-score (§1) reaches them.

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
pre-T2 — then delete the old branch. **Scope honestly stated:** pre-T2 the membership table
is exactly the mirror, so an identical id set validates the *SQL rewrite only* — it says
nothing about filing behaviour. Don't read a green differential as evidence about T2+.
The harness also asserts the mirror invariant (every `Resource.topic` matches its primary
membership) as the drift check for the write seam.

### Verification gate (T1)

- Unit: `buildConditions` emits the `EXISTS` form; a two-topic request produces no duplicate
  ids (regression test for the `JOIN` footgun).
- Integration (`tests/integration/`, `describeDb`, `__verify_rt__` prefix): a resource with
  two memberships is returned exactly once by each of the three `searchResources` paths, and
  by `searchNearbyResources`; a contested secondary membership does not match, a contested
  primary does; `setPrimaryTopic` leaves exactly one primary and a matching mirror.
- Differential: old vs new predicate over every existing topic → identical id sets.
- Manual: playground resource picker renders unchanged for a `javascript-react` topic.

---

## T2 — Open-vocabulary filing with an embedding guardrail

Ships as **two blocks** (see Sequencing): **T2a** = pre-insert embedding plumbing +
`TopicCentroid`; **T2b** = the classifier + guardrail below. T2b also depends on T1.5 so
the classifier never runs against the twin-polluted vocabulary.

### T2a — the guardrail's input must exist at filing time

The margin pre-filter and the k-NN purity check both read the resource's embedding, but
embeds run **post-commit** ([upsert-resource.ts:177–189](../src/lib/agents/decomposition/upsert-resource.ts))
— so without this block, every fresh find at discovery time (the guardrail's primary
application point) would hit the "no embedding" degradation row, and T2 would ship an open
vocabulary with no guardrail. The fix, per the locked decision above:

1. In `persistDiscovered`, compute the embedding from `title` + `summary` +
   `conceptsTaught` **before** calling `upsertResource` — the same input the post-commit
   embed uses ([:183–187](../src/lib/agents/decomposition/upsert-resource.ts)).
2. Run the guardrail on that vector, then pass it into `upsertResource` (signature change)
   so the row is written with its embedding and the post-commit `safeEmbedResource` is a
   no-op for it.
3. **Containers included** — add container parents to the embed set (amending the
   atomic-only gate at [:144–152](../src/lib/agents/decomposition/upsert-resource.ts) and its
   "wastes a call" comment: the embedding now buys filing evidence, not pickability).
   Retrieval stays container-free via `decompositionStatus`.

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
(4.3% of rows go to the k-NN check), **k = 10**, plurality with ties → membership
`contested = true` for review.

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
| Fewer than k embedded neighbours in the whole library | Accept the classifier's primary, membership `contested = true`. |
| Resource has no embedding yet | **Rare after T2a** (pre-insert embedding makes discovery rows arrive embedded) — reachable only via legacy paths like the seed backfill, or if the embed call itself fails. Defer the guardrail; file under the request topic with `contested = true` for T4's reclassifier to revisit. |
| Classifier errors / returns nothing | Fall back to the request topic, exactly as today ([classify-topic.ts:33–37](../src/lib/agents/tools/classify-topic.ts)). Never worse than current behaviour. |

**Resolved** (was OPEN): `MIN_CENTROID_MEMBERS = 20`. The data doesn't pin it down (every
sampled topic cleared 5), and the pre-filter only saves a k-NN query — being conservative
costs nothing but that query.

### Multi-membership at filing time

Every proposal clearing the guardrail becomes a `ResourceTopic` row (`origin: classifier`,
`relevance` = the k-NN purity fraction, which is bounded 0–1 and comparable across topics in
a way the raw cosine is not). The highest becomes `isPrimary` and is mirrored to
`Resource.topic` — via the `setPrimaryTopic` seam (T1), never directly. **Resolved** (was
OPEN): hard cap of **3** memberships per resource (primary + guarded secondaries), with
collision rows counting against it — the guard against a generic "intro to programming"
page joining every CS topic.

**Never auto-refile an existing row.** Per the motivating case above, a disagreement means
"the current label is contested", not "the alternative is right". Disagreements set
`contested = true` on the membership (not `Resource.status` — see the Uncertainty decision);
a human or T3's minting resolves them.

### As built — T2a + T2b (2026-07-26)

Seven deviations from the specs above. They are load-bearing for T3/T4; read them before
building either.

1. **The margin pre-filter was not implemented; k-NN runs unconditionally.** Skipping the
   k-NN query for margin-clearing rows would leave those memberships with no measured
   purity to put in `relevance`, and the query it saves is one indexed pgvector lookup on
   a batch of 3–10 rows. **`TopicCentroid` is therefore unconsumed until T4**, where
   skipping k-NN across 1,152 rows actually pays. It is built, refreshed by
   `scripts/embed-resources.ts`, and verified — just not read yet.
2. **New degradation row: `MIN_VOUCHABLE_POOL` (= k = 10).** Measured 2026-07-25: **10 of
   the 20 canonicals have no pool at all** (`precalculus`, `javascript`, `statistics`,
   `data-structures-algorithms`, …). k-NN can never vouch for a topic with fewer than k
   members, so as specced the guardrail would have rejected every correct proposal for
   half the vocabulary and the self-widening property would deadlock — an empty pool could
   never start filling. Such proposals are **accepted with `contested = true`** instead,
   the same treatment T3 gives a freshly minted topic.
3. **The request topic is a trailing secondary candidate**, held to the same purity bar.
   Otherwise the run that paid for the discovery could not retrieve it: open-vocabulary
   filing can land on a topic `relatedTopics` widening does not reach. Consistent with
   T3's collision rule — the searched topic may assert membership, it just gets no free
   pass.
4. **`MIN_SECONDARY_PURITY = 0.2` is uncalibrated.** The calibration measured top-1
   plurality agreement, not a secondary-label distribution. T4's recalibration settles it.
5. **Memberships are written at insert (T2b), including for children.** Not deferred to
   T3 as sequenced: post-T1 retrieval is `EXISTS` over `ResourceTopic`, so a filing
   verdict with no membership row is invisible — T2b would have had no observable effect.
   Written inside `upsertResource`'s transaction via `setPrimaryTopic(…, { tx })`.
   **T3's remaining scope is minting + collision handling only.**
6. **The classifier trusts the fallback topic even when it is outside the vocabulary** —
   it is the caller's own request topic, not a model invention, and a topic can
   legitimately be un-canonicalized. Without this, "none of these fit" is
   indistinguishable from the classifier failing.
7. **k-NN is snapshotted for the whole batch before the first insert.** Querying inside
   the upsert loop made filing order-dependent — each inserted row joins the library and
   becomes a neighbour for the rows after it, so a batch bootstrapped its own evidence
   (observed on a cold `rust` run: request-topic purity climbing 0.0 → 0.1 → 0.2 across
   three inserts of one batch).

**Live confirmation of the defect being fixed** (2026-07-26): three resources discovered
under `statistics` — no pool, **no `TOPIC_RELATIONS` edge**, so pre-T2b the classifier was
skipped and all three would have been stamped `statistics` forever — were classified into
`probability-and-statistics` and cleared the guardrail at purity **1.0** (all 10
neighbours agreed), landing as `classifier` memberships.

---

## T3 — Discovery may mint topics; collisions add memberships

1. **Minting.** When no existing canonical clears the threshold, hand the classifier's
   proposed label to `runTopicGate`. Tier 1 fast-accepts a curated slug, tier 2 reuses a
   known alias, tier 3 mints + persists (with T1.5's snap-to-curated-slug guard already in
   place, so a mint can't twin a code-owned slug). File under the result with the membership
   `contested = true` — a freshly minted topic has no pool, so the guardrail cannot vouch
   for it. The gate already coerces to a safe slug (`toCanonicalSlug`) and already grounds
   the model on the canonical list, so this reuses hardened code rather than adding a second
   minting path.
2. **Collisions — through the same guardrail, no free pass.** [upsert-resource.ts:76–93](../src/lib/agents/decomposition/upsert-resource.ts):
   on `existing.topic !== topic`, run the requested topic through the margin + k-NN
   guardrail against the existing row's embedding. Clearing it → add a `ResourceTopic` row:
   `origin: collision`, `relevance` = the measured k-NN purity (never the 1.0 default),
   `isPrimary = false`, counted against the cap of 3. Failing it → skip as today. Rationale:
   a collision is the *searched* topic asserting membership — exactly the signal "The
   modelling error" section rejects — so "two topics found the same page" is a hypothesis to
   test, not evidence to accept. Extend `UpsertOutcome` with a `membership_added` outcome so
   `persistDiscovered`'s counters (`skippedCount`, `reclassifiedCount`) report it honestly.
   Keep the existing log line — it becomes a useful signal rather than a dead end.
3. **Children.** Decomposition children still inherit the parent's primary topic
   ([:377](../src/lib/agents/decomposition/upsert-resource.ts), [:411](../src/lib/agents/decomposition/upsert-resource.ts)).
   Per-child classification is out of scope — a container's children are by construction the
   same subject as the container. What makes this safe post-revision: containers are now
   embedded and guardrail-checked (T2a), so the primary the children inherit has been
   evidence-tested at the granularity where the motivating defect actually occurred.

### As built — T3 (2026-07-26)

Scope was smaller than §1–3 above: **membership-at-insert had already shipped in T2b**
(As-built item 5), and children already inherit the parent's filing, so §3 was a no-op.
What remained was minting + collisions. Seven deviations:

1. **Minting was UNREACHABLE as specced, and T3 had to open the channel.** §1 says "hand
   the classifier's proposed label to the gate", but `classifyDiscoveryTopics` filters
   every proposal to `listCanonicals() ∪ requestTopic` — so no non-canonical label could
   ever reach `decideFiling`. The request-topic escape hatch doesn't rescue it either:
   `recordCanonicalization` writes a self-alias, so a gated request topic is already a
   canonical. `ClassificationSchema` therefore gained a per-result **`newTopic`** field,
   the one place the model may name a slug outside the vocabulary, with a prompt rule
   scoping it to "the subject is missing entirely, not merely a loose fit". Without it the
   motivating case stays unfixable — `algebra` is a label no code path could utter.
   ⚠️ This relaxes the classifier's "never invent a slug" rule; the compensating controls
   are the gate's domain rejection, `toCanonicalSlug`, T1.5's `snapToKnownSlug`, and the
   always-contested membership. There is no column marking a mint as discovery-born, so
   the audit trail is the `[topic-mint]` log line plus the contested flag.
2. **Evidence beats a mint.** The mint fires only when `decideFiling` returned `rejected`
   or `no-evidence` — an accepted proposal is evidence about a topic we already have, and
   minting over it would let an eager `newTopic` fragment a healthy shelf.
3. **A mint keeps the request topic as a secondary** when its measured purity clears
   `MIN_SECONDARY_PURITY` (`decideMintedFiling`, pure). A minted topic is not reachable
   through `relatedTopics` widening, so without this the run that paid for the discovery
   could not retrieve its own find — the same argument as T2b's As-built item 3.
4. **The collision candidate is the FILED topic, not the raw request topic.** `upsertResource`
   receives the post-guardrail verdict, which is what this discovery actually asserts;
   testing it against the existing row's embedding is strictly stronger than testing the
   searched topic, and the two coincide whenever filing degraded. A corollary worth
   knowing: a rediscovery the classifier files right back where the row already lives is
   correctly a plain skip, so **collisions are rarer than "two topics found the same page"**.
5. **`decideCollision` branches on `reason`, never on the returned topic.** It reuses
   `decideFiling` with a single proposal that is also its own fallback — so a REJECTED
   verdict still names that topic, and reading the topic alone would turn every rejection
   into an acceptance. `unvouchable-pool` is admitted `contested`, consistent with T2b;
   note that a contested secondary is invisible to retrieval under T1's predicate, so such
   a collision records the hypothesis for T4 without widening reachability today.
6. **A collision membership does not join `insertedIds`.** That list is the retrieval
   session's discovery allowlist and means "newly created pickable id"; the existing row
   may well be a parked container. So the rediscovering run makes the row reachable for
   FUTURE searches but does not attach it to the concept that triggered this one — rung 0
   is what covers that. `membershipAddedCount` is a summary-log counter; `PersistResult`'s
   shape is unchanged (it ripples into `WebFallbackResult`'s consumers).
7. **Everything gates on `filing` being supplied**, which is what marks an
   evidence-gathering caller. The seed/verify paths pass none and keep the pre-T3
   log-and-skip byte-for-byte.

**Live verification** (`scripts/verify-topic-filing-t3.ts`, 2026-07-26). Two findings worth
carrying into T4:

- **Rung 0 suppresses discovery for any well-covered concept.** `gradient descent` and
  `list comprehensions` both filled the target from the library, so those runs exercised
  nothing at all. Forcing the discovery ladder to run needs a concept with ZERO rows inside
  the rung-0 distance ceiling (`isotonic regression` under `machine-learning`).
- **A driver that cleans up by `insertedIds` LEAKS containers.** A parent that parks
  `human_review` is not pickable, so it never enters that list; the first run stranded
  scikit-learn's isotonic page in the library. Cleanup is a `createdAt` window instead,
  which is why the run needs the compose workers stopped.

The guardrail against the real corpus: a Khan *"Another least squares example"* filed under
`linear-algebra`, whose true 10-neighbourhood is **7 `probability-and-statistics` / 3
`linear-algebra`**, was admitted at relevance 0.7 — while `calculus` (pool 381, absent from
the neighbourhood) was declined. That is both directions of the collision rule on real
embeddings, and a preview of the ~11% disagreement T4's reclassifier will be draining.

---

## T4 — Bulk reclassification, orphans, retrieval narrowing, recalibration

1. **Reclassify the backlog.** A `scripts/reclassify-topics.ts` driver over rows filed while
   the classifier was skipped (1,152). Write memberships that clear the k-NN guardrail
   automatically; where the proposed primary **differs** from the current one, set
   `contested = true` on the membership and **leave `Resource.status` alone** — flipping
   ~130 `active` rows to `pending_review` (the original spec) would destroy the record that
   those rows already passed human *quality* review, and some are attached to live Paths.
   Filing doubt is the membership's business; the resource's quality status is not touched.
   Expect roughly 11% disagreement (the k-NN instrument's measured 88.7% agreement) —
   call it ~130 contested rows, though some of that 11% is the instrument being *right*
   about existing mis-filings. The `/review-pending-resources` skill is
   already the reviewer seam and already opens each page against a rubric — extend its
   queue to include contested memberships. Run in batches with a dry-run mode; this is an
   LLM + embedding cost, so it belongs in the ops budget alongside the warm campaign.
   **Stretch:** re-score the remaining ~774 `inherited` rows too, replacing their
   placeholder `relevance = 1.0` with measured purity — otherwise they keep a fake
   certainty forever and any nonzero `minRelevance` must stay origin-aware around them.
2. **Merge drifted canonicals** — *moved to T1.5; spec kept here.*
   `data-structures-and-algorithms` → `data-structures-algorithms`,
   `probability` → `probability-and-statistics`. Remap `TopicAlias.canonical`, rewrite
   memberships and mirrors (via `setPrimaryTopic`), then verify no `Path`/`CourseRequest`
   references the dead slug.
3. **Harden the gate against re-drift** — *moved to T1.5; spec kept here.* After
   `toCanonicalSlug`, snap a tier-3 mint onto a curated slug when it near-matches one
   (normalized comparison against `TOPIC_SLUGS`), so the gate can't mint a twin of a
   code-owned slug again. Unit-testable, pure.
4. **Adopt the orphans.** **Resolved** (was OPEN): **fold** `differentiation` (1 row, no
   embedded leaf — a mint accident) into `calculus`; **park** `differential-equations`
   (12 rows — a real, if thin, topic) with its memberships left intact, waiting for a
   learner request.
5. **Narrow retrieval widening** (see the call-site table in the T1 retrieval section).
   Once the backfill has written cross-topic memberships: attach-candidates and the
   playground picker drop `relatedTopics(topic)` for `[topic]`; the web-fallback library
   rung keeps `relatedTopics` (its `maxDistance` ceiling is the real gate). Doing this
   before the backfill would regress reachability, which is why it lives here and not T1.
6. **Re-run the calibration and re-tune.** This is a required closing step, not a nice-to-have.
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

### As built — T4a (2026-07-27)

T4 was split into sub-blocks in discussion: **T4a** = the reclassifier (§1), **T4b** =
quorum seed/mint, **T4c** = orphans (§4), **T4d** = retrieval narrowing (§5), **T4e** =
recalibration (§6). T4a shipped `src/lib/curation/reclassify.ts` (pure),
`applyReclassification` in `resource-topics.ts`, `centroidMargins` in `topic-centroids.ts`,
and `scripts/reclassify-topics.ts`. Applied to the dev DB 2026-07-27; the full decision
record is `docs/audits/reclassify-t4a.json` (git-ignored).

**Measured over all 1,152 rows** — dry-run and apply produced identical verdicts:

| verdict | rows | |
| --- | --- | --- |
| `agree` | 633 | 54.9% |
| `disagree` | 134 | 11.6% — matches the 88.7% k-NN agreement the calibration predicted |
| `unvouchable-pool` | 383 | 33.2% |
| `no-evidence` | 2 | 0.2% |

Seven deviations, all load-bearing for T4b–T4e:

1. **`unvouchable-pool` must NOT be read as T2b reads it.** At discovery time that verdict
   means "accept the proposal, contested" — how a new shelf starts filling. Reused
   verbatim here it contested the **current** primary when nothing had contradicted it,
   on 10–55% of rows per topic (measured before the fix). It would have buried the 134
   real disagreements under ~380 rows of "the classifier named an empty shelf". It is a
   VOCABULARY signal, not doubt about the row: the primary is left uncontested and the
   proposal is routed to T4b's seed channel via a new `unvouchable` field.
2. **The motivating case is fixed by SEEDING, not minting — the plan's §6 check was
   looking for the wrong thing.** All 49 Khan "Functions" leaves propose **`precalculus`**,
   unanimously, with `newTopic` null. `algebra` was never the answer: `precalculus` is a
   curated `TOPIC_SLUGS` entry with a Path and an **empty pool**, so k-NN could not vouch
   for it and pre-T2b the classifier was never asked. This also closes the open question
   in [resource.ts](../src/types/resource.ts): the `precalculus`→`calculus` edge was
   compensating for exactly this mis-filing.
3. **T4a writes ZERO uncontested secondaries** (58 written, all contested, all from the
   disagreement path). §5/T4d's stated precondition — "once the backfill has written
   cross-topic memberships" — is therefore satisfied by **T4b, not T4a**. An uncontested
   secondary needs the classifier to volunteer a second topic that independently holds
   ≥ `MIN_SECONDARY_PURITY`, and the prompt tells it to return one topic unless a resource
   squarely belongs on several shelves; that combination essentially never fires. This is
   also the calibration input §6 wanted: at 0.2 the measured yield is **nothing at all**.
   T4e's question is whether to lower the bar or loosen the classifier's one-topic rule.
4. **Re-scored primaries flip `inherited` → `classifier`.** The origin-aware `minRelevance`
   clause exempts `inherited` precisely because its 1.0 is a placeholder; leaving a
   MEASURED purity under that origin would park it in the one bucket the gate ignores.
   Post-run: 1,150 `classifier` primaries (avg relevance 0.82), 777 `inherited` remaining
   — that 777 is exactly the §1 stretch population.
5. **The pass never refiles, and that buys batch CONCURRENCY for free.** Decisions read the
   pool snapshot, the neighbours' `Resource.topic` labels, and the row's own memberships;
   since no batch can change any row's `Resource.topic`, no batch can move the evidence
   another batch reads. T2b had to purchase that property with a pre-insert snapshot.
   Serial: ~90 minutes. At 4 batches in flight: ~20. Verified post-apply: 0 rows refiled,
   0 mirror drift, all 134 contested primaries still retrievable.
6. **The margin pre-filter is a review-priority signal, NOT the cost gate the plan
   sketched.** Two measurements killed that role: every membership written needs a measured
   `relevance` and only k-NN produces one, so k-NN runs for every written row regardless;
   and at δ=0.05 **95.7% of rows clear the margin**, so gating the classifier call on it
   would skip classification for nearly the whole backlog. `TopicCentroid` is finally
   consumed (`centroidMargins`), just not as specced. δ as a cost gate is T4e's call.
7. **Small topics are systematically contested — an instrument artifact, not a finding.**
   All 12 `differential-equations` rows flag against `calculus`. The pool is exactly 10,
   vouchable by the letter of `MIN_VOUCHABLE_POOL`, but a thin topic embedded inside a
   large adjacent one cannot hold a plurality in any 10-neighbour window. This is
   independent support for §4's decision to **park** `differential-equations` rather than
   fold it, and a specific case for T4e: `MIN_VOUCHABLE_POOL = k` is exactly the boundary
   where this bites.

**T4b's quorum slate** (bar = 10, i.e. `MIN_VOUCHABLE_POOL` — below it k-NN could never
vouch for the topic, so a handful of rows would be stranded on a permanently distrusted
shelf):

| seed (canonical exists, shelf empty) | | mint (subject absent from the vocabulary) | |
| --- | --- | --- | --- |
| `statistics` | 254 | `cryptography` | 29 |
| `precalculus` | 49 | `convex-optimization` | 19 |
| `data-structures-algorithms` | 34 | `number-theory` | 14 |
| `multivariable-calculus` | 17 | *(below quorum: computational-complexity 6, computability-theory 5, optimization 4, …)* | |
| `systems-of-linear-equations` | 15 | | |
| `eigenvalues-and-eigenvectors` | 14 | | |

`statistics` at 254 is the headline: a curated slug with zero resources while
`probability-and-statistics` holds 456.

### As built — T4b (2026-07-27)

Shipped `src/lib/curation/quorum-refile.ts` (pure), `settleMembership` in
`resource-topics.ts`, and `scripts/refile-quorum-topics.ts`. Applied to the dev DB
2026-07-27; the move record is `docs/audits/refile-t4b.json` (git-ignored). **445 rows
refiled across 9 shelves, 0 drift skips, 0 invariant violations.** The whole slate cleared
quorum, so nothing above the bar was left behind.

Eight deviations, and the first two change what a future block should assume:

1. **T4b re-derives NOTHING — it reads the T4a record, which IS the snapshot.** The plan
   left open whether to re-run the classifier; every number this pass needs was already
   measured (`unvouchable`, `newTopic`, and `relevance` = purity against the current
   topic). Reading them means phase 1 touches no live neighbour labels and therefore
   cannot be perturbed by its own writes — which dissolves the order-dependence hazard
   that moving primaries would otherwise have created, without a snapshot mechanism.
   Cost: **3 LLM calls** (the gate, once per mint label) instead of 445 classifier rows.
   The compensating control is a per-row **live-drift guard** — skip when `Resource.topic`
   no longer matches the record — which also makes a re-run a reported no-op and a
   crashed run resumable with the same command.
2. **The vacated topic is retained as an UNCONTESTED SECONDARY, for free.**
   `setPrimaryTopic` clears `isPrimary` on the old membership but leaves the row, with the
   origin, measured relevance and uncontested flag T4a wrote — so `decideRefile` writes no
   secondary at all. This is load-bearing twice: `probability-and-statistics` dropped from
   445 primaries to 202 while its **retrievable pool stayed at 445**, so its live Path lost
   nothing to the `statistics` split; and uncontested secondaries went **0 → 441**, which
   is what finally satisfies T4d's precondition (As-built T4a item 3). The gap to 445 is
   exactly the 4 rows whose T4a verdict was `disagree` — their contested primary is
   correctly retained as a *contested* secondary, still doubted.
3. **Two phases, and the settle phase is the acceptance measurement, not cleanup.** Purity
   against an empty shelf is 0 by construction, so phase 1 can only write
   `relevance: 0.0, contested: true` — the one bucket an origin-aware `minRelevance` gates
   hardest. Phase 2 re-measures every moved row against the now-populated library and
   clears `contested` where the guardrail finally vouches. It runs strictly after all
   writes and touches only `relevance`/`contested`, so it cannot move the evidence it
   reads. **366 of 445 rows (82%) came back vouched** — the bootstrapping deadlock,
   measured rather than asserted.
4. **The "thin topics can't settle" prediction was WRONG, and the real variable is
   COHERENCE, not size.** Predicted from As-built T4a item 7 that the 14–19-row cohorts
   would stay contested; instead `systems-of-linear-equations` (15) settled **13/15** and
   `eigenvalues-and-eigenvectors` (14) **13/14**, while the larger
   `data-structures-algorithms` (34) managed **19/34** and `multivariable-calculus` (17)
   only **7/17**. A tight cohort holds its own neighbourhood at any size; a cohort that is
   really two subjects does not. Per-shelf settlement rates:

   | shelf | rows | vouched | mean relevance |
   | --- | --- | --- | --- |
   | `statistics` | 254 | 236 | 0.81 |
   | `precalculus` | 49 | 37 | 0.71 |
   | `data-structures-algorithms` | 34 | 19 | 0.51 |
   | `cryptography` | 29 | 19 | 0.59 |
   | `convex-optimization` | 19 | 17 | 0.68 |
   | `multivariable-calculus` | 17 | 7 | 0.40 |
   | `systems-of-linear-equations` | 15 | 13 | 0.72 |
   | `eigenvalues-and-eigenvectors` | 14 | 13 | 0.71 |
   | `number-theory` | 14 | 5 | 0.47 |

   **T4e input:** the three shelves under 0.60 mean relevance are where the calibration's
   "per-topic own-similarity drifting below the band" check should look first — and
   `multivariable-calculus` at 0.40 is the one to triage, not to re-tune around.
5. **The motivating case is FIXED.** All **49/49** Khan "Functions" leaves now carry
   `precalculus` as primary (relevance p50 0.8), with `discrete-mathematics` /
   `linear-algebra` retained uncontested behind them. `precalculus` went from **1 resource
   with a live Path** to 47 in the vouchable pool. Per As-built T4a item 2 this was always
   a seeding problem, not a minting one — `algebra` was never the answer.
6. **`QUORUM` is `MIN_VOUCHABLE_POOL`, exported from one module.** T4a's driver carried a
   local `QUORUM = 10`; it now imports the same constant, so T4e re-tuning `k` moves the
   bar in lockstep instead of leaving a stale literal behind. The bar is not tunable
   separately *by construction*: below it k-NN can never vouch for the shelf, which is the
   entire argument for the quorum.
7. **Seed beats mint when a row carries both signals.** Same principle as T3's "evidence
   beats a mint" — an existing canonical outranks inventing a new one — plus a counting
   reason: a row voting in two cohorts could push a mint label over the bar on strength it
   does not exclusively have. Fired on 2 rows (`calculus-of-variations`, which is below
   quorum anyway), so the rule is a guard against silent future drift, not a live effect.
8. **The mint channel routes through T3's `createTopicMinter`, and a dry run never calls
   it.** The gate persists a `TopicAlias`, so minting is a write; a dry run reports the raw
   label instead. All three labels passed the gate unchanged (`cryptography` → cs,
   `convex-optimization` → math, `number-theory` → math), so `snapToKnownSlug` had nothing
   to snap — the twin-guard was exercised but silent.

**What T4c/T4d/T4e inherit:** 441 uncontested secondaries (T4d's precondition is now
genuinely met), 209 contested primaries for the review queue (134 from T4a's disagreements
+ 79 unsettled refiles), and 3 new canonicals with no Path — harmless per the plan's
locked decision, waiting for a learner request.

---

## Rejected alternatives

| Option | Why not |
| --- | --- |
| Widen `TOPIC_RELATIONS` by hand | Restates the problem. Every new topic needs a code deploy, and agent-minted topics — the majority of the library by row count — can never get an edge at mint time. |
| Park-on-uncertainty only (the cheap fix) | Stops *new* mislabels but fixes neither the multi-topic reality nor the 1,152 existing rows, and grows a review backlog with no mechanism to drain it. Worth shipping only if T1–T4 are deferred. |
| Drop `topic`, retrieve purely semantically | Loses the hard subject boundary that keeps calculus material out of linear-algebra tracks, and makes the library unauditable — there'd be no answer to "what do we have on X". |
| Make `topic` editable via the PATCH whitelist | A manual patch over a systemic defect. Also insufficient on its own: the URL-collision skip still freezes the row, and one scalar still can't express dual membership. |

## Risks

- **Retrieval bleed.** More memberships = larger candidate sets — and *multiplicative*
  until T4 §5 narrows the `relatedTopics` widening at the attach/picker sites. Controls:
  the T4 narrowing, `minRelevance` (origin-aware), the contested-secondary exclusion, the
  per-resource membership cap of 3, and the unchanged `maxDistance` ceiling on the re-judge
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
