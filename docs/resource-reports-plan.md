# Resource reports + track regeneration — plan

Two features, one loop: **reports** are how a defect gets found and fixed; **regeneration**
is how a learner collects the fix. They ship together because either alone is half a
product — reporting a broken resource that stays in your course is frustrating, and
regenerating a course whose defects were never fixed is a slot machine.

Companion to `docs/library-quality-plan.md` (which fixes the *pipeline* that produces bad
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
([src/lib/services/program.ts:192](../src/lib/services/program.ts)) sets
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

**Where**: new `src/lib/curation/verify-dead-link.ts`, called from the R1 route when
`category === 'dead_link'`.

**What**: reuse `checkLiveness` from
[validators/liveness.ts](../src/lib/agents/validation/validators/liveness.ts) — it is already
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

**Where**: `src/app/programs/_components/ReportDialog.tsx` (client) +
`submit-report.ts`, surfaced next to `RatingButtons` in
[NotebookResourcePane.tsx](../src/app/programs/_components/NotebookResourcePane.tsx) at its
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

## Block order and gates

```
R1 → R2 → R3          reports: schema+API → auto-verify → learner UI  (verifiable loop)
       ↘ R4           operator triage (needs R1; independent of R3)
R5 → R6 → R7          regeneration: service+schema → carry-over → UI
```

R1–R3 ship a complete, demonstrable feature on their own. R4 can land in parallel with R5.
R7 is last and is where the two halves visibly become one loop.

Standard gates apply: **nothing is committed until the block is manually verified**, and
libraries are installed only when a block needs them (this plan needs none — every dependency
it touches is already in the tree).

## Deliberately out of scope

- **Patching in-flight Tracks.** Track immutability stands. `hard` deprecation records the
  fact for a future Track-patching layer; this plan does not build that layer, it gives the
  learner regeneration as the escape hatch instead.
- **Whole-program regeneration.** Per-track first; revisit if beta feedback asks.
- **Reports as a `trustScore` term.** Locked no — see the decisions table.
- **Report-driven auto-refile / auto-unlink at quorum.** Every non-dead-link category stays
  human-triaged in v1; the quorum threshold is uncalibratable at beta n and the failure mode
  is auto-destroying a good resource.
