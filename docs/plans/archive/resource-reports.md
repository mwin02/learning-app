# Resource reports + track regeneration — plan

**Status:** shipped 2026-08-09 · **Blocks:** R1–R8 (PRs #310–#317), F1–F7 (#320–#326)
· **Block IDs:** `R`, `F` · **Started:** 2026-08-05

> The whole chain merged in one sitting, migrations applied, worker reset, and the feature was
> verified end-to-end against production the same day.
>
> **Parts 1 and 2 are the plan as written and are kept that way on purpose** — they record what
> was intended, which is what stops being recoverable once the code moves on. **Part 3 is what
> actually happened**: what the retroactive reviews found, what changed, what was deliberately
> left alone, and the two changes that went beyond what Parts 1–2 authorized. Where Parts 1–2
> and Part 3 disagree, **Part 3 is current.** Each block below carries a pointer to the fix
> that corrected it.

Two features, one loop: **reports** are how a defect gets found and fixed; **regeneration**
is how a learner collects the fix. They ship together because either alone is half a
product — reporting a broken resource that stays in your course is frustrating, and
regenerating a course whose defects were never fixed is a slot machine.

Companion to `library-quality.md` (which fixes the *pipeline* that produces bad
rows) and the free-beta A-series (votes → trustScore → eviction). This plan adds the
**learner-driven defect channel** and the **learner-driven repair action**.

---

## The diagnosis

### Votes cannot express a defect

The A-series vote (`ResourceRating` ±1 → `voteSignal` → `recomputeResourceTrust` →
`maybeEvictLowTrust`) is a *taste* signal, and its only outcome is a soft deprecation once
`TRUST_EVICT_MIN_VOTES` learners independently dislike a row. That is the right machine for
"this video is boring". It is the wrong machine for every defect we actually care about:

- A **dead link** needs `deprecationSeverity: 'hard'` — a fact, not a consensus. One
  learner is enough, and waiting for five is five learners hitting a 404.
- A **miscategorized** resource is a *filing* defect. Deprecating it is wrong; it is a fine
  resource in the wrong place. The fix is `ResourceTopic` / `ConceptResource`, not
  `Resource.status`.
- A **mistimed** resource (`durationMin` wrong) needs a field correction, which
  `update-resource.ts` already does. Deprecating a 3-hour course labeled 20 minutes throws
  away a good resource because a number is wrong.

Three defects, three different remediation axes, and today's only user-facing verb collapses
all of them into "downvote", whose only lever is deprecation. **`Resource.deprecationSeverity`
already documents the missing writer** — the schema comment says `hard` = "broken/dead link
(a future Track layer may need to patch or flag in-flight learners)", and nothing in the
codebase writes it from a user-facing path today.

### The dead-link case is where a human beats our validator

`src/lib/agents/validation/validators/liveness.ts` already splits its failures into
AUTHORITATIVE (explicit 404/410, malformed URL, YouTube oEmbed miss → reject) and HEURISTIC
(suspicious title, redirect to an error path, unreachable → quarantine). Its header records
the 2026-08-03 sweep and names the shape it **structurally cannot catch**:

> khanacademy.org answers 200 with a client-rendered shell that is byte-identical for a live
> and a removed page — same size, same title, differing only in the echoed canonical URL.
> Only a real browser render distinguishes them.

That is exactly the class a learner catches for free, because the learner *is* a real browser
render. A dead-link report is not a redundant re-run of the validator; it is the signal for
the class the validator was written to admit it misses. This is the single strongest argument
for the whole feature.

### Tracks are immutable, so "fix my course" can only mean "build a new one"

`pending-review.ts` is explicit: "Only the Path (the living concept map) is kept accurate;
built Tracks are immutable snapshots and are NOT touched (they may keep pointing at a
now-deprecated resource — broken Tracks are triaged manually)." That invariant is load-bearing
and this plan does not touch it. Regeneration builds a *new* Track and repoints the slot.

**The repoint already works.** `maybeAssembleProgram`
([src/lib/services/program.ts:192](../../../src/lib/services/program.ts)) sets
`ProgramPath.trackId` via `updateMany({ where: { programId, topic } })` once all sibling
`CourseRequest`s are terminal — unconditionally, *before* the guard that only finalizes
`Program.status` from a non-terminal state. So enqueuing a second `CourseRequest` with the
same `(programId, topic)`:

- builds through the unchanged per-topic worker path,
- repoints the program slot to the new Track on success,
- leaves a `ready` Program `ready` (the status guard no-ops),
- and on failure leaves the old `trackId` in place.

Regeneration needs a route, metering, preconditions, and UI. **It needs no new build
machinery.** That is what makes this feature cheap enough to ship alongside reports.

---

## Locked decisions

| Question | Decision |
| --- | --- |
| Auto-action scope | **Verified dead links only.** An authoritative `checkLiveness` failure auto-hard-deprecates. Heuristic/inconclusive verdicts and every other category go to the operator queue. |
| Reports → `trustScore` | **No.** A third evidence term next to `voteSignal`/`youtubeSignal` is uncalibratable at beta n, and deprecation/refile/field-fix are stronger outcomes than a score nudge. Reports are a defect channel; votes stay the scoring channel. |
| Report anchor | `resourceId` **plus optional `lessonId`** context. Category decides which axis triage acts on — a "doesn't belong here" report must not deprecate a good resource globally. |
| Regeneration scope | **One track within a program.** Not whole-program: N× the spend, and it discards progress on tracks that were fine. |
| Progress on regeneration | **Carried over by `conceptsTaught` overlap.** A pure function + unit test; the difference between regeneration being usable mid-course and being punitive. |
| Regeneration precondition | **Blocked when nothing changed**, unless the learner edits their inputs (goal / target mastery / timeframe / hours) — an input change always makes the rebuild meaningfully different. |
| Track immutability | Unchanged. Nothing in this plan mutates a built Track. |

---

# PART 1 — Reports

## R1. Schema + report intake (~180 LOC + migration)

> *Corrected by **F1** (Part 3): burst metering, the reopen that erased settled resolutions
> (`priorResolution`), and unvalidated `lessonId`.*

**Schema.** A `ResourceReport` model alongside `ResourceRating`:

```prisma
model ResourceReport {
  id         String         @id @default(cuid())
  userId     String
  user       User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  resourceId String
  resource   Resource       @relation(fields: [resourceId], references: [id], onDelete: Cascade)
  // Placement context: WHERE the learner hit this. Null for reports raised outside a
  // lesson. SetNull (not Cascade) — a regenerated Track's lessons disappear, and the
  // report about the resource must survive that.
  lessonId   String?
  lesson     Lesson?        @relation(fields: [lessonId], references: [id], onDelete: SetNull)
  category   ReportCategory
  note       String?        // learner free text, length-capped at the boundary
  state      ReportState    @default(open)
  // Set by R2's probe (the liveness verdict) or by the operator at resolve time.
  resolution String?
  resolvedAt DateTime?
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  @@unique([userId, resourceId, category])
  @@index([state, createdAt])
  @@index([resourceId])
}

enum ReportCategory {
  dead_link         // 404, removed video, host gone
  wrong_topic       // good resource, filed under the wrong subject
  wrong_lesson_fit  // good resource, wrong lesson — a placement defect, not a row defect
  wrong_duration    // durationMin materially wrong
  wrong_difficulty  // level mismatch
  paywalled         // requiresPurchase is wrong
  low_quality       // bad but not broken
  other             // free text only
}

enum ReportState {
  open
  auto_resolved  // R2's probe acted without a human
  resolved       // operator acted
  dismissed      // operator judged it not a defect
}
```

`@@unique([userId, resourceId, category])` means one report per user per resource per
category, re-submittable as an update (mirrors the rating unique). Distinct-reporter counts
per category then fall straight out of a `groupBy` for R4's triage ranking.

> ⚠️ **Migration**: per `AGENTS.md`, open the generated `migration.sql` before applying and
> delete any `DROP INDEX` for `Resource_embedding_idx` or `RemediationJob_active_per_path`.

**Route.** `POST /api/resources/[id]/report`, modeled on the rating route line for line:
`withAuth`, explicit 401 on a null `session.userId` (a report needs an owner), zod-parsed
body (`{ category, lessonId?, note? }`, note capped ~500 chars), burst cap **after**
validation and **before** the resource lookup, non-enumerable 404 on an unknown id, then
upsert on the composite unique.

**Metering.** `src/lib/services/report-limits.ts` — `reportBurst(userId)` mirroring
`ratingBurst` exactly (count rows in a rolling window). Knobs `REPORT_BURST_PER_HOUR` /
`REPORT_BURST_WINDOW_MS` in `config.ts`, set well below the rating cap: reports are a rare,
deliberate action, and a low cap is the abuse guard for a channel whose payload is free text.

**Verify**: unit tests for `reportBurst`; manual POST for each category, a re-report
(updates, not duplicates), an unauthenticated 401, an over-cap 429.

---

## R2. Dead-link auto-verification (~150 LOC)

> *Corrected by **F1** (Part 3): the `status !== 'active'` guard conflated three states, and a
> lost race left a contextless open report.*

**Where**: new `src/lib/curation/verify-dead-link.ts`, called from the R1 route when
`category === 'dead_link'`.

**What**: reuse `checkLiveness` from
[validators/liveness.ts](../../../src/lib/agents/validation/validators/liveness.ts) — it is already
the exact predicate, already timeout-bounded, already browser-UA'd, and already splits
authoritative from heuristic. Branch on its verdict:

| Verdict | Action |
| --- | --- |
| `alive: false`, `quarantine` falsy (**authoritative**: 404/410, malformed URL, oEmbed miss) | `applyPendingReview({ action: 'reject', severity: 'hard', cascade: false })` → report `auto_resolved`, resolution = the liveness reason |
| `alive: false`, `quarantine: true` (**heuristic**) | leave `open`, stamp the verdict into `resolution` so the operator sees what the probe thought |
| `alive: true` | leave `open` — this is the Khan soft-404 case the validator admits it can't see, and it is precisely where the human's report outranks the machine |

Guards, mirroring `evict-low-trust.ts`: probe only when the resource is still `active`
(idempotent — a second report on an already-deprecated row skips the network call entirely);
`origin = 'generated'` rows are never probed (no external URL to be dead); a raced concurrent
reject surfaces as `applyPendingReview`'s `raced` and is logged, not thrown.

`cascade: false` deliberately: a dead link on one child of a container says nothing about its
siblings.

**Severity matters here.** `hard` is what tells a future Track-patching layer that in-flight
learners are pointing at something genuinely broken, versus `soft`'s "quality downgrade,
future tracks only". This is the first user-facing writer of that distinction.

**Timing.** The probe is bounded at liveness's 6s and runs synchronously in the request. Two
alternatives were considered and rejected for v1: fire-and-forget (`void`-ing the promise is
unsound on Cloud Run with `min-instances=0` — the instance can be frozen after the response)
and a queue hop (a whole new job type for one HTTP call). The UI shows a pending state; a
report is a rare, deliberate action and a few seconds of "checking…" is honest feedback.

**Verify**: colocated unit test with an injected liveness checker covering all three verdict
branches plus the already-deprecated and `generated` skips. Manually: report a known-dead URL
(auto-deprecates), a known-live one (stays open), a Khan URL (stays open — the documented gap).

---

## R3. Report UI (~200 LOC)

> *Corrected by **F2** (Part 3): the category picker did not respond to most clicks — the whole
> learner-facing half of the feature was gated behind it.*

**Where**: `src/app/programs/_components/ReportDialog.tsx` (client) +
`submit-report.ts`, surfaced next to `RatingButtons` in
[NotebookResourcePane.tsx](../../../src/app/programs/_components/NotebookResourcePane.tsx) at its
five existing placements.

**What**: a small flag affordance opening a category picker (plain-language labels — "Link is
broken", "Wrong topic", "Doesn't fit this lesson", "Time estimate is way off", …) plus an
optional note. Submits with the ambient `lessonId` so placement-vs-resource defects are
distinguishable at triage.

Inherits `RatingButtons`' hard-won constraints: several placements sit inside an `<a>` or a
`<details>` summary, so **every** click must `preventDefault` + `stopPropagation` — a report
must never navigate the row or toggle the disclosure it lives in.

**Feedback**: unlike a vote, a report deserves an acknowledgement. For `dead_link`, R2's
synchronous verdict is available in the response — when it auto-deprecated, say so ("Confirmed
broken — removed from future courses"). Otherwise, "Thanks — we'll review this." No aggregate
report counts, same reasoning as the vote toggles (no herding, bad at beta n).

**Verify**: manual, each category, from each of the five pane placements, in light and dark;
confirm no navigation/disclosure side effects; confirm the dead-link path shows its verdict.

---

## R4. Operator triage queue (~280 LOC)

> *Corrected by **F3** (Part 3): three ways to record a fix that did not happen — duplicated edit
> bounds, unvalidated refile text, and lesson-blind sibling closure.*

**Where**: `src/lib/curation/report-triage.ts` + `GET/POST /api/playground/reports` +
`src/app/playground/reports/page.tsx`, patterned on the `pending-resources` pair so a curator
and an autonomous reviewer act through the same logic.

**Read side**: open reports grouped by resource, with distinct-reporter counts per category
(one `groupBy` over the composite unique) and the resource's current status, trust, primary
topic, and the lessons it was reported from. Ranked by distinct reporters then age. Row-capped
like the other playground pages (audit 7.2).

**Write side**: `resolveReport(reportId, action)`, where each action delegates to machinery
that already exists — this block adds no new remediation, only routing:

| Action | Delegates to |
| --- | --- |
| `deprecate_hard` / `deprecate_soft` | `applyPendingReview` (reject + severity) |
| `unlink` — drop this resource from the concept it was mis-attached to | targeted `ConceptResource` delete + `recomputeReadiness`, the `dropCandidateLinks` pattern |
| `refile` — wrong topic | `resource-topics.ts` / `reclassify.ts` |
| `edit` — duration / difficulty / title / summary | `update-resource.ts` (already whitelisted, already surfaces `embeddingStale`) |
| `dismiss` | state only |

Resolving one report on a resource offers to resolve the other open reports on the same
resource+category in the same action — five people reporting one dead link is one defect.

**Verify**: unit tests for the grouping/ranking pure parts; manually drive one report of each
category through its action and confirm the delegated effect (deprecation, unlink + readiness
regression, refile, field edit).

---

# PART 2 — Track regeneration

## R5. Regeneration service (~220 LOC + migration)

> *Corrected by **F4** (Part 3): a cleared override armed the button and was then discarded,
> spending a rebuild on byte-identical inputs.*

**Schema**: one nullable column.

```prisma
// On CourseRequest. Marks this request as a REBUILD of an existing Track rather than a
// first build. The assembler needs no change (it matches on programId + topic), but the
// worker's post-fulfill hook branches on this to carry progress over (R6), and it is the
// audit record of why a slot's Track changed. SetNull-free: it is an id, not an FK, for
// the same reason CourseRequest.trackId is nullable — the old Track may be cleaned up.
replacesTrackId String?
```

**Where**: `src/lib/services/regenerate-track.ts` + `POST /api/programs/[programId]/tracks/[trackId]/regenerate`.

**Preconditions**, in order, each a distinct refusal the UI can explain:

1. **Ownership** — the caller is enrolled in the program (`EnrolledProgram`), and the
   `ProgramPath` for `(programId, trackId)` exists.
2. **Single in-flight** — no `queued`/`running` `CourseRequest` for this `(programId, topic)`.
3. **Quota** — `FREE_TRACK_REBUILDS_PER_MONTH` per user, plus a dedupe window against
   double-submit. New `src/lib/services/rebuild-limits.ts`, shaped like `program-limits.ts`
   (a rebuild is a full track build with real LLM spend — this is the one that costs money).
4. **Staleness** — *unless* the learner edited their inputs, refuse when nothing has changed
   since the build: no resource in the Track's `LessonResource` set has `status != 'active'`
   or `updatedAt > track.createdAt`, and the Path's readiness/concept set is unchanged. A
   rebuild off an identical pool is a coin flip that costs a real build.

**Effect**: create a `CourseRequest` with the same `programId` + `topic`, `replacesTrackId`
set, and the Track's inputs (`priorKnowledge`, `goal`, `timeframeWeeks`, `hoursPerWeek`,
`targetMastery`) cloned from the old Track or overridden by the learner's edits. Return `202`
with the request id, matching `generate-program`'s fire-and-forget shape.

> **Open call for block start — the single-in-flight race.** Precondition 2 inside a
> `$transaction` leaves a small window where two concurrent submits both pass, costing one
> wasted build. The airtight alternative is a partial unique index
> (`... WHERE status IN ('queued','running') AND "replacesTrackId" IS NOT NULL`), which is
> robust but becomes a **third permanent entry** in AGENTS.md's hand-written-index table and
> a `DROP INDEX` to hand-delete on every future migration forever. Recommendation: take the
> transactional check — the client busy-guard and the dedupe window already cover the realistic
> double-click, and the failure mode is one wasted build, not corruption. Revisit if it bites.

**Verify**: unit tests for each precondition + the staleness predicate (pure, fixture Tracks);
an integration test enqueuing a rebuild and asserting the assembler repoints `ProgramPath` and
leaves a `ready` Program `ready`.

---

## R6. Progress carry-over (~140 LOC)

> *Corrected by **F5** (Part 3): the carry-over had no durable, idempotent, retryable record of
> having run — `carriedOverAt`, plus `Progress.carriedFromLessonId` beyond the plan.*

**Where**: `src/lib/progress-carryover.ts` (pure) + a call in the worker's post-fulfill hook,
branching on `replacesTrackId`.

**What**: `carryOverProgress(completedOldLessons, newLessons)` → the new lesson ids to mark
complete. A new lesson carries over when its `conceptsTaught` sufficiently overlap those of a
completed old lesson. Deliberately a heuristic, and deliberately generous: over-crediting
costs a learner a skipped review, under-crediting costs them re-doing work they finished, and
the second is the one that makes people abandon a course.

Runs inside the same post-fulfill step that the assembler's repoint fires from, so the new
Track is never visible with empty progress before the carry-over lands. Only for the user who
requested the rebuild (progress is per-user, and only their slot moved).

The old Track is **not deleted** — it is the evidence for why the rebuild happened, and
`ProgramPath.trackId`/`CourseRequest.trackId` are both `SetNull` precisely so orphaned Tracks
are safe.

**Verify**: colocated unit test over the overlap rule (exact match, partial overlap, split
lesson, merged lesson, no overlap); integration test asserting a rebuilt track's progress.

---

## R7. Regeneration UI (~240 LOC)

> *Corrected by **F4** (Part 3): the mastery control offered a choice the request could not carry,
> and `quotaLine` reported the remainder before the rebuild. **R8/F6** added the navigation half
> this block did not cover, and a confirmation step was added as a follow-up.*

**Where**: `NotebookCourseHome` (per-track entry point) + a `RegenerateDialog.tsx` client
component + `submit-regenerate.ts`, with the copy and derivations in `src/lib/rebuild-view.ts`.

Shipped with one addition the plan hadn't accounted for: **a `GET` on the regenerate route**
(`getRebuildStatus`, read-only — same slot lookup, same staleness read, plus quota and the
in-flight flag). The dialog has to state what changed and pre-fill the Track's inputs *before*
anything is spent, and a POST cannot be that probe — its only non-refusing outcome is a real
build. The read fires on dialog open, so the course home pays nothing for it.

**What**: a "Rebuild this course" action opening a dialog that:

- states plainly **what changed since the build** ("3 resources were removed as broken since
  this course was built") or, when nothing has, says so and offers input editing as the way
  forward — this is precondition 4 made legible rather than a bare error;
- exposes the original inputs (goal, target mastery, timeframe, hours), pre-filled and
  editable;
- says what happens to progress ("lessons covering material you've finished stay marked
  complete") and that this uses one of their monthly rebuilds;
- on submit, `202` → the existing in-flight/building affordances (`AutoRefresh`) carry it.

Each refusal from R5 gets its own message: already rebuilding, out of rebuilds this month,
nothing has changed yet.

**Also in R7: tighten R5's staleness proxies — SHIPPED in R7.** R5 shipped `assessStaleness` with two proxies
the plan hadn't pinned — Path readiness → `path.updatedAt > track.createdAt`, and concept set
→ concepts touched since the build. Measured against real dev data at the R5 gate, **three of
four live tracks read stale with zero broken resources**:

```
calculus (cmrdux…)      stale=true   deprecated=0  changed=7  pathChanged=true
prob-and-stats          stale=true   deprecated=0  changed=1  pathChanged=false
calculus (cms5x…)       stale=true   deprecated=0  changed=0  pathChanged=true
linear-algebra          stale=false  ← the only one that refuses
```

Both terms are far looser than the precondition's intent. `path.updatedAt` bumps on *any*
Path write — a status flip, a readiness recompute, a remediation pass — and
`resource.updatedAt` bumps on a re-embed or a `recomputeResourceTrust` triggered by someone
else's vote. So precondition 4, whose job is to stop "a rebuild off an identical pool [that]
is a coin flip that costs a real build", is close to a no-op in practice: the spend guard the
plan asked for isn't guarding.

R7 is the right place to fix it because R7 is where the counts become **visible copy** — a
dialog saying "3 resources were removed as broken" next to a `stale=true` derived from a
readiness flip is the bug made legible, and the threshold can be judged against real wording
instead of guessed at. Deliberately deferred from R5 rather than tuned blind.

**What shipped** (decided with the dialog in front of us — on the stale calculus track it
offered an *enabled* Rebuild button justified by nothing but "This subject has been worked on
since your course was built", with zero broken resources). The deciding rule: **a term that
cannot be phrased for a learner should not gate spend.**

```
stale = inputsEdited || deprecatedResources > 0 || conceptsCreatedSince > 0
```

- `pathChanged` and `changedResources` were **dropped from the disjunction** — both are row
  mtimes, bumped by writes (readiness recompute, remediation pass, re-embed, someone else's
  vote triggering `recomputeResourceTrust`) that say nothing about whether the course would
  come out different.
- Both are still **computed and reported**, not deleted: `changedResources` carries the
  dialog's "corrected since" line, and `pathChanged` remains a log/operator diagnostic. Its
  fallback line in `changeSummary` becomes *rare* rather than dead — it still renders on a
  track that is stale for another reason.
- The concept term moved from `updatedAt` to **`createdAt`** (`conceptsChangedSince` →
  `conceptsCreatedSince`, surfaced as `conceptsCreated`): a concept that did not exist at
  build time is something a re-compose must seat; a touched concept row is usually a status
  or embedding write.
- Pinned by unit test: a track whose Path row was merely touched, with no deprecated
  resources and no new concepts, is **not** stale.

**What remains** (its own block, not R7): distinguishing "the pool changed" from "the pool
changed in a way that would change the course" properly, by recording the Path's readiness /
concept-set fingerprint on the Track **at build time** so the question is answerable directly
instead of by proxy. That is a schema change (the Track records nothing of the kind today),
which is why it did not ride along here.

**Verify**: manual — the full loop end to end. Report a dead resource in a course → confirm
auto-deprecation → rebuild the track → confirm the new Track omits it, the slot repointed,
and progress carried over.

---

# PART 3 — Review fixes (F1–F7, R8)

R1–R7 were reviewed retroactively, per block and then as a stack. The reviews found enough to
warrant a second chain rather than a patch: F1 #320 → F2 #321 → F3 #322 → F4 #323 → F5 #324 →
R8/F6 #325 → F7 #326. Everything below is what those blocks changed.

| Fix | Corrects | In one line |
| --- | --- | --- |
| F1 | R1, R2 | Report lifecycle: who owns `state` and `resolution` |
| F2 | R3 | The category picker did not respond to most clicks |
| F3 | R4 | Three ways to record a fix that did not happen |
| F4 | R5, R7 | A cleared override armed the button and was discarded |
| F5 | R6 | Carry-over had no durable, retryable record of running |
| F6 | *(new — R8)* | Rebuild → learner navigation |
| F7 | — | Ops, runbook ordering, verify-script blast radius |

## Why the fixes stacked instead of amending

Fix blocks branched **on top of** `feat/resource-reports-r7-regen-ui` rather than being folded
back into the branches that carried the bugs. That kept PRs #310–#317 reviewable (threads stay
anchored to live lines), made every fix end-to-end verifiable with the whole feature underneath
it, and dissolved the migration-ordering problem — the fix migrations sort naturally after the
feature's.

The accepted cost: #310–#317 merged to `main` still carrying the bugs, and `cloudbuild.yaml`
deploys on every merge. That opened a window where production had the broken category picker (F2)
and the quota-burning rebuild (F4). Mitigation was to merge the whole chain in one sitting and do
the worker reset at the end. It held.

## What each block fixed

**F1 — report lifecycle.** The intake route and the auto-verification probe disagreed about who
owned `state` and `resolution`. Burst metering counted `updatedAt`, which other writers bump, so
learners were metered on rows they never wrote — switched to `createdAt`. Re-reporting erased the
operator's or the probe's record; a nullable **`priorResolution`** column now preserves one
generation of it. The `status !== 'active'` guard conflated `deprecated+soft`, `deprecated+hard`
and `pending_review` into one "settled defect" branch — now severity- and status-aware, so a
soft-deprecated dead resource escalates to `hard` instead of being silently closed. A lost
`applyPendingReview` race left a contextless open report; the row is re-read and falls through.
`lessonId` was accepted with no relation to the resource, letting a fabricated pairing point a
curator at an unrelated unlink — now checked against `LessonResource` and dropped when it fails.

**F2 — the category picker.** `onClick={stop}` on the dialog panel called `preventDefault()` as
well as `stopPropagation()`. A click on a category `<label>` bubbled to the panel, the event's
canceled flag was set, and the label's activation behaviour — the thing that forwards a click to
its radio — never ran. Only a direct hit on the ~13px radio dot worked. The panel is portaled to
`<body>`, well clear of the `<a>`/`<summary>` placements, so it needs no default suppression at
all: it now uses a bare `stopPropagation`, and `stop` is kept for the trigger button only, where
the navigation suppression is load-bearing. Also fixed: a late phase write could strand the dialog
on the acknowledgement screen after closing mid-send (guarded by a request generation), and the
note-cap copy now derives from `NOTE_MAX_CHARS` instead of hardcoding "500".

**F3 — operator triage.** The edit schema duplicated the canonical one with looser bounds
(`durationMin` capped at 100,000 here and 6,000 there, on the same write) — it now imports
`resourceUpdateSchema.shape.fields`. `refile` passed operator free text straight into an
exact-match column, manufacturing the twin-slug drift `merge-topic-twins.ts` exists to clean up —
it now canonicalizes and refuses slugs the registry does not know. `unlink` is lesson-scoped but
the queue was not, so one click closed reports about *other* lessons with a resolution describing
a fix that never touched them — sibling closure is now scoped to the same `lessonId`, and a report
whose `lessonId` went NULL no longer blocks its group. Added late (**F3e**): surface
`priorResolution` in triage, since F1 wrote the column and nothing read it.

**F4 — rebuild overrides.** `effectiveEdits` counted `null` as a real edit (clearing the goal),
but the insert cloned with `??`, which falls back to the Track's value for exactly `null`. Net
effect: clearing the goal returned 202, decremented the monthly quota, and enqueued a build with
byte-identical inputs — the precise spend the precondition exists to prevent, repeatable until
quota was exhausted. Fixed with an explicit `cloned()` helper (`override === undefined ? current :
override`). The mastery control's "No preference" option could not be carried by the wire format
at all, so it was dropped. `quotaLine` now states the remainder *after* the rebuild it describes.

**F5 — carry-over durability.** Four findings, one problem: the carry-over had no durable,
idempotent, retryable record of having run. `completedAt` was discarded, so a rebuild stamped
every carried lesson with today's date on top of the old Track's still-counted rows, permanently
duplicating weeks of activity onto one heatmap day. The inserts sat inside the repoint
transaction, so an insert failure rolled back the repoint. A planning failure was unrecoverable —
neither `maybeAssembleProgram` nor `sweepStuckPrograms` would retry an already-`ready` Program.
And the re-run guard could resurrect lessons the learner had deliberately un-completed. A
**`carriedOverAt`** marker on `CourseRequest` answers all four and makes the insert safely
retryable outside the transaction.

**F6 (block R8) — rebuild → learner navigation.** New work, not a fix: no block had been briefed
to deliver it. `AutoRefresh` mounted only while a program was `planning`/`building`, so on a
`ready` program the dialog's "your new course appears here when it is ready" was simply false —
the page never re-rendered. Worse, once the worker repointed the slot, the learner's own
`/programs/P/trackA` URL failed the membership check and returned `notFound()` — a 404 on the
course they were mid-way through, reachable by reload or back button. Both fixed; the old URL now
redirects to the new track.

**F7 — ops and hygiene.** No product code. Documented the merge → migrate → worker-reset ordering
and both failure modes in `worker-deploy.md` (every runtime effect that makes a rebuild
correct is worker-side and ships only with a manual reset, while the button ships automatically).
Put `npm run test:int` on the merge checklist, since F1's real regression guard is integration-only
by construction. Scoped two verify scripts' deletes to their own fixtures — both were wiping report
rows they did not own.

## Beyond what Parts 1–2 authorized

Two changes went past the plan. Both were deliberate:

- **`Progress.carriedFromLessonId`** (F5) — a second schema column. Dating carried rows correctly
  only *moved* the heatmap inflation onto the learner's real study days; identifying the covering
  lesson was the only way to exclude them. Deliberately **not** a real FK: `SetNull` on old-lesson
  cleanup would silently reclassify a carried row as a genuine completion.
- **A confirmation step on rebuild** (`RegenerateDialog.tsx`) — the primary button becomes its own
  confirm on first click. Armed **only when there is completed progress to lose**, and cleared by
  close, by re-open, and by any edit to the form. Added as a follow-up after Part 2 was written;
  it is why a rebuild with completed lessons takes two clicks and a fresh one does not.

## Settled escalations

Four questions the fixes chain left open, all settled 2026-08-06 and built as decided: add a
`priorResolution` column (not a string-prepend); drop the "No preference" mastery option (not
nullable end-to-end); authorize a `carriedOverAt`-style marker (not the weaker no-schema
derivation); and give F6 its own block (not folded into R7, not deferred past merge).

## Accepted, not fixed

**The `findUnique`/`upsert` race on operator resolution.** The route reads the existing report,
then upserts. An operator who resolves that report inside the gap has their resolution destroyed:
the upsert writes `resolution: null` over it while `priorResolution` carries the older value read
before it — so the one mechanism meant to make that loss impossible does not cover this window.

No fix fits the block. A `$transaction` around read+upsert does not close the window at
read-committed isolation. The one approach that genuinely closes it — a raw column-referencing
`UPDATE … SET "priorResolution" = COALESCE("resolution", "priorResolution") … RETURNING`, falling
back to `create` on zero rows — moves `planReopen`'s logic into SQL, destroying the unit
testability that is the reason `report-intake.ts` exists, and adds a P2002 retry path. The window
is narrow and the route already documents the upsert race. Revisit only if observed in practice.

## Downgraded — verified as not defects

- **"A re-reported dead link sits open until a human dismisses it."** The reviewer read R1 against
  `main`, where R2 did not exist. The route calls `verifyDeadLink` *after* the upsert and R2's
  `already_deprecated` branch re-closes the row. What survived is narrower and is fixed in F1.
- **"#312's lint gate has never run over these 5,900 lines."** True that it had not, but every one
  of the tip's errors was in a pre-#312 file the stack does not carry. Not latent debt in the
  feature.

## Production verification — 2026-08-09

Run against the deployed app on a real goal-driven program (4 courses), with app and worker on the
same commit and all four migrations applied. All five behavioural gates passed.

| Check | Evidence |
| --- | --- |
| Rebuilt course carries progress | Worker logged `carried: 5, completedBefore: 5`; course read 23% / 5-of-22; Resume skipped to lesson 6 |
| Slot does not repoint back | Rebuilt slot moved forward; the three sibling slots byte-identical |
| Cleared override is honoured | Reopening the dialog on the **new** track shows goal `""`, not the old text |
| Category picker responds | All 7 categories select on a label-text click; 5 placements, 2 inside `<a>`, none navigate |
| Triage records only real fixes | Out-of-bounds edits 400 while in-bounds controls 404; refile canonicalizes then refuses unknown slugs |

Two notes on method, because they are easy to get wrong:

- **A rebuild being accepted proves nothing about F4** — that happens under both the fixed and the
  broken code. The discriminating evidence is the *new* track's goal field being empty.
- **The 400s in F3 only mean something next to the in-bounds controls** that reach 404. Without
  them, a 400 could equally be the report id.

### Known gaps

- **A transient 0% window is real.** Immediately after the auto-refresh the rebuilt course reads
  0%; a reload shows the carried percentage. This is the designed cost of F5 moving the inserts
  *outside* the repoint transaction — between repoint and insert commit a learner can catch a 0%
  view of a course they were part-way through. Correct by construction, alarming to see.
- **F3's two-lesson case is not verifiable on one account.** It needs two `wrong_lesson_fit`
  reports on one resource from different lessons, but unique `(userId, resourceId, category)` makes
  a user's second report *upsert* the first. It structurally requires two users or seeded rows;
  unit tests cover it.
- **F5's timestamp-preservation criterion is not verifiable in a same-session test.** Completing
  and rebuilding within the hour puts the original and the insert time on the same heatmap day, so
  only a raw `Progress.completedAt` read distinguishes correct behaviour from the old bug.
- **Re-reporting the same `(resource, category)` has a 10-minute cooldown.** Budget for it when
  scripting any reopen or `priorResolution` check.

---

## Block order and gates

```
R1 → R2 → R3          reports: schema+API → auto-verify → learner UI  (verifiable loop)
       ↘ R4           operator triage (needs R1; independent of R3)
R5 → R6 → R7          regeneration: service+schema → carry-over → UI
       ↘ R8           rebuild → learner navigation  (added during review; see fixes doc)
```

R1–R3 ship a complete, demonstrable feature on their own. R4 can land in parallel with R5.
R7 is last and is where the two halves visibly become one loop.

**R8 was not in the original plan.** The stack review found that no block had been briefed to
deliver the navigation half of regeneration: on a `ready` program the course page never
re-rendered during a rebuild, and once the worker repointed the slot the learner's own track URL
404'd. It shipped as F6 in the fix chain.

Standard gates apply: **nothing is committed until the block is manually verified**, and
libraries are installed only when a block needs them (this plan needs none — every dependency
it touches is already in the tree).

## Merge checklist — executed 2026-08-09

This feature is the first where the learner-facing half deploys automatically and the half
that makes it correct does not, so the merge is ordered work rather than a series of
independent PRs. Run the chain bottom-up in **one sitting** (`/merge-stacked-prs`), then:

1. **Before the first merge, run the integration suite.** `npm test` is `--project unit`,
   and this feature's two load-bearing regression guards are integration-only by
   construction: `tests/integration/dead-link-escalation.test.ts` (a Prisma `not` filter
   that never matches a NULL column is invisible to a mocked test) and
   `tests/integration/track-carryover.test.ts`. Nothing in CI exercises them.

   ```bash
   docker compose --profile workers stop worker   # they poll the same DB and steal the tests' rows
   npm run test:int
   docker compose --profile workers up -d --build # without --build, compose reuses a stale image
   ```

   See `.claude/rules/testing.md` for why both halves of that stop/restart matter.

2. **Merge → migrations applied → worker reset, in that order.** `cloudbuild.yaml` applies
   migrations ahead of the app deploy on merge to `main`; the worker never auto-deploys.
   Wait for the deploy build to go green, then run `worker-deploy.md` §9. Deviating in
   either direction fails silently — the two failure modes are written out in that runbook's
   "Ordering when one change spans app, migrations and worker".

3. **The rebuild button is live and wrong for the interval between step 2's merge and its
   worker reset.** Keep it short; do not park the chain half-merged.

**How it actually went.** The ordering held and the window was closed the same day. Two things
worth carrying to the next chain of this shape:

- **Two merges close together produce two racing deploy builds.** #327 and #318 merged 13 seconds
  apart; their revisions landed 15 seconds apart and the *older* commit's revision won, leaving
  production on the earlier image with no error anywhere. After a burst of merges, check the
  serving revision's image tag against `main` rather than assuming the last merge deployed.
- **Promoting an already-built revision must not pin traffic.** `run services update-traffic
  --to-revisions` sets `latestRevision: false`, which silently disables auto-deploy on every
  later merge. Deploy the image tag again instead, which creates a new revision and leaves
  `latestRevision` true.

## Deliberately out of scope

- **Patching in-flight Tracks.** Track immutability stands. `hard` deprecation records the
  fact for a future Track-patching layer; this plan does not build that layer, it gives the
  learner regeneration as the escape hatch instead.
- **Whole-program regeneration.** Per-track first; revisit if beta feedback asks.
- **Reports as a `trustScore` term.** Locked no — see the decisions table.
- **Report-driven auto-refile / auto-unlink at quorum.** Every non-dead-link category stays
  human-triaged in v1; the quorum threshold is uncalibratable at beta n and the failure mode
  is auto-destroying a good resource.
