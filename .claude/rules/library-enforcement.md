---
paths:
  - "src/lib/curation/**"
  - "src/lib/agents/decomposition/**"
  - "src/lib/agents/tools/**"
  - "scripts/*serveability*"
  - "scripts/repoint-khan-pt.ts"
  - "scripts/resolve-type-url-conflicts.ts"
  - "scripts/repair-stale-titles.ts"
---

# Enforcing the resource standard

`resource-standard.md` says what a library resource **is** and deliberately carries no
mechanics. This file is the mechanics: which code answers which clause, which seam may
write, and the traps that have already cost a re-verification pass.

## Three classifiers, three different questions

| Module | Answers | Needs |
| --- | --- | --- |
| `serveability.ts` | clauses 3 and 5, from the row's own fields | nothing — pure, no I/O |
| `serveability-probe.ts` | clauses 4 and 5, from the rendered page | a probe |
| `metadata-integrity.ts` | clause 6 — is the row still described accurately | a row, optionally a probe |

**They are separate functions on purpose.** Serveability is split row-level / probe-level so
a caller holding no probe cannot silently receive a weaker verdict, and clause 6 is separate
from 3/4/5 because they have **opposite remedies** — exclusion vs. correction. A single
function returning both would let a caller act on the wrong one.

**Clause 6 outranks a clause-5 exclusion.** A row whose page contradicts its stored type is
re-typed and kept, never deprecated on the stale type. This is the standard's own
instruction — an interactive-classified page that teaches in prose is a *misclassification*,
and the repair is to correct the record. Any driver acting on both must encode this.

## A probe is bound to a row by id, and rows move

Probe artifacts are keyed by `resourceId`. Nothing about that key says the page still *is*
the row's page — and the repoint driver rewrites `url`, so it genuinely goes stale.

`classifyServeabilityFromProbe` therefore voids a probe whose landed **host** or **`urlKind`**
disagrees with the row's current URL, returning `{ evidence: false, reason: 'probe-voided' }`.
**Do not bypass this and do not re-implement it in a caller** — it lived in one driver first,
and the other driver silently disagreed with it about how many rows fail clause 5.

- **Slug drift still counts.** A stored `/a/` URL landing on a different `/a/` slug is normal;
  a kind change is not. Clause 6 draws the same line.
- **Clause 6's comparisons 1–3 still run against a voided probe**, deliberately. Comparing a
  stored field against the page the URL actually lands on *is* clause 6 —
  `url-redirects-across-kinds` exists to report the very disagreement that voided the probe.
  Only the noisy title comparison is suppressed.

## Four drivers, and they partition the library rather than overlapping

Every one takes its population from a classifier — never an id list — so the four sets are
disjoint by construction and a row is somebody's or nobody's, never two drivers'.

| Driver | Population | Repair | Writes |
| --- | --- | --- | --- |
| `sweep-serveability.ts` | any clause 3/4/5 failure, or a clause-6 `retype` | decompose / re-type / deprecate | `applyPendingReview`, `updateResource` |
| `repoint-khan-pt.ts` | `urlKind === 'pt'` | point the row at its embedded video | `url` **direct**, or `applyPendingReview` |
| `resolve-type-url-conflicts.ts` | `type-url-page-conflict` | move `url` to the landed one, or deprecate the duplicate | `url` **direct**, or `applyPendingReview` |
| `repair-stale-titles.ts` | `title-contradicts-page` | adopt the page's own title | `updateResource` |

All four default to a dry run, take `requireTargetAck` for `--apply`, and are idempotent —
re-run the dry run after any apply and expect zero. That check is not ceremony: it is how the
clause-6 oscillation was caught, and it passed every unit and integration gate first.

## Writing

- **Every removal goes through `applyPendingReview({ action: 'reject', severity: 'soft' })`.**
  It is the only seam that also drops `ConceptResource` links and recomputes Path readiness.
  Writing `status` directly leaves rows deprecated, invisible to retrieval, and **still placed
  in live concept maps**.
- **`severity: 'soft'`, never `hard`.** `hard` means broken; a serveability failure is a
  working page we choose not to serve.
- **Never delete a `Resource`.** It is referenced by `ResourceRating`, `ResourceReport`,
  `Lesson` snapshots and `ConceptCandidateRejection`, and a delete frees the URL for immediate
  re-ingestion.
- **`action: 'decompose'` needs only `decompositionStatus === 'atomic'`** — not
  `pending_review`. It is how a container misfiled as a leaf gets repaired, and it works on an
  `active` row.
- **`type` is editable only on an `atomic` row, only to `article | video`.** The atomic-only
  constraint is the safety argument; the two targets are scope. A repair into a container type
  is `action: 'decompose'`'s job.
- **`url` is not in any edit whitelist, and two drivers write it directly anyway.** It is the
  row's IDENTITY — the unique column every dedup path collapses onto — so a repair that moves
  it is a `prisma.resource.update`, justified in the driver's header, never a reason to widen
  `ResourceUpdateFields`. The property that makes it the right seam: **a field update does not
  touch `ConceptResource`**, which is the exact opposite of `applyPendingReview`. A repointed
  row is still the same lesson, so it must keep its links.
- **A repair that moves `url` must check the collision by READING the table, before writing.**
  `Resource.url` is `@unique`. A caught 23505 tells you a row exists but not which one, and a
  failed write mid-loop leaves the operator guessing which half of the run applied. And the
  incumbent's status decides the outcome: an *actionable* incumbent means this row is a
  duplicate (deprecate it), a *deprecated* one means neither write is available (escalate) —
  deprecating against a copy nobody can be served retires the last servable copy.
- **A `title` repair bumps `updatedAt`, which leaves the row's embedding stale.** The vector
  covers title + summary + conceptsTaught, so retrieval keeps matching on the old name until
  `scripts/embed-resources.ts` runs. `updateResource` reports it as `embeddingStale`; a driver
  that retitles in bulk must say so and the operator must run the backfill.
- **Clearing `durationMin` stamps `durationSource: 'unknown'`, never `'reviewer'`.** `reviewer`
  is the tier no automated pass may overwrite, so stamping it on a *retraction* freezes the row
  at "a human measured it as nothing".

## Five facts that read the opposite of how they behave

- **`force` does NOT bypass the re-decompose short-circuit.** A row retyped to `article` or
  `video` routes straight to atomic on a later `decompose()`, because `classify()` runs first
  and the `atomic` branch returns before `force` is read. `force` lifts
  `DECOMPOSITION_MAX_AUTO_CHILDREN`, a different gate reached only once a router is already
  running. The path that ignores classification is **`action: 'decompose_manual'`**, whose
  child list is supplied rather than derived. For anyone holding both intentions the rule is
  ordering: **decompose first, re-type after.**
- **`pending_review` is selectable.** `search-resources.ts`'s `DEFAULT_STATUSES` is
  `['active', 'pending_review']`, so "not deprecated" does not mean "not served". A row left
  `pending_review` reaches learners until someone reviews it.
- **`type` does not gate selection.** Pickability is derived as `status='active' AND
  decompositionStatus='atomic'`; the type filter in `search-resources.ts` is an optional
  caller-supplied allowlist that nothing passes by default. Filing a row under a
  "non-servable" type does **not** remove it from retrieval.
- **`cleanPageTitle` produces a title that does not satisfy the title comparison.** The two
  modules fold differently and both are right for their own job: `page-title.ts` keeps up to
  two segments (`Name | Section`) because on the sourcing path the section is real context and
  the title feeds an embedding, while `metadata-integrity.ts`'s comparison 4 folds a Khan
  title to its FIRST segment. So a candidate can be a genuine improvement and still leave the
  finding firing — 19 production rows — which means a driver writes and re-embeds them on
  every pass, forever. **Verify a clause-6 repair by re-running the classifier over the row as
  it WOULD be stored, not against your own idea of equality.** Then idempotence is structural.
- **`type` is a candidate signal for containment, not the verdict.** `CONTAINER_TYPES` only
  decides whether the doc-TOC router *examines* the page; it then decides by fetching. So
  retyping *to* `article` is the direction that skips examination.

## Enforce at the seam that can see the page

Ingestion knows the row's stored form and its URL, so it enforces **clause 5** on creation.
It does **not** enforce clause 3: that rule fires on `decompositionStatus === 'atomic'`, and at
creation `atomic` is a *default* — `classify()` returns it for any non-container type without
fetching. Clause 3 is about what a page does, and nothing at ingestion has looked at the page.

Clause 6 is likewise **detection only** at ingestion: there `type` comes from the LLM
extraction, so a mismatch means the extraction is wrong, and a create path is the wrong place
to run a field-repair loop.

A row failing at ingestion is still **created**, then soft-deprecated. Skipping the insert
loses the URL, and the next decomposition re-admits it with nothing for the canonical-URL
dedup to collapse onto.

## The error budget is one-sided, and composition can break it

Excluding a real lesson removes it from every learner's retrieval, permanently and invisibly;
admitting a weak one leaves it visible to review and the next audit. So doubt admits, and a
weak signal never decides alone — every rule here is paired or absolute.

That property is **per-rule and does not compose for free**. Three individually-cautious rules
can exclude a row none of them would have excluded alone. When adding a rule, check what it
does *in combination*, not only in isolation.
