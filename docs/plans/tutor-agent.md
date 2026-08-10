# Tutor Agent Plan — resource ingestion, tutor chat, learner notes

**Status:** active — not started · **Blocks:** T1–T4; no PRs yet · **Block IDs:** `T`
(collides with the archived topic-filing plan — see the prefix registry in
[README.md](README.md)) · **Started:** 2026-07-20 · **Briefs retrofitted:** 2026-08-10

**Decided 2026-07-20.** The tutor agent (ROADMAP Phase 4) lets a learner ask general
questions about their topic and specific questions about the resource in front of them,
streamed into a panel on the lesson view. This doc is the source of truth for the work:
every block below is meant to be workable by a **fresh conversation** with no other
context — it records the design decisions already locked, the codebase facts the
decisions rest on, and the ambiguities deliberately left open (marked **OPEN** — settle
them in the block's discussion phase, not unilaterally).

Workflow per CLAUDE.md applies to every block: one feature per conversation, discussion
first, <300 LOC per block, one branch per block, verification gate before commit/PR.

## Core design insight

Resource-specific Q&A decomposes into two halves with opposite cost profiles:

1. **Getting the resource's content into text** — expensive and flaky (fetch, extract,
   video ingestion), but a property of the resource, not the conversation.
2. **Answering questions over that text** — cheap (Flash input ≈ $0.30/M tokens) and
   per-question.

So we pay #1 **once per resource, globally**, persist the result, and never fetch or
transcribe per conversation — the same library-compounding philosophy as
`curriculumFallback` (see its comment in `src/lib/ai/models.ts`: spend tokens once, save
them on every future request). The tutor turn itself is stateless and cheap.

## Sequencing

| # | Block | Kind | Depends on |
| --- | --- | --- | --- |
| T1 | Ingestion: `ResourceDigest` schema + article/YouTube extraction + digest author | code | — |
| T2 | Tutor core: context assembly + system prompt + streamed route + quota + guardrails | code | T1 |
| T3 | Lesson-view tutor panel (learn UI) | code | T2 |
| T4 | Learner notes: schema + tutor write-tool + context injection | code | T2 (T3 for manual verify) |

T-blocks stack off each other (branch per block, stacked PRs — merge bottom-up per the
CLAUDE.md stacked-chain procedure). If T1 threatens the 300-LOC budget, split it at the
natural seam: T1a = schema + article extraction + digest author; T1b = YouTube-via-Gemini
extraction prong.

## Locked decisions (this plan)

| Area | Decision |
| --- | --- |
| Scope | **Tutor mode only.** The ROADMAP's `quizzer` / `path_adjuster` modes are deferred: quizzer duplicates `ConceptQuestion` banks + Exercises; path_adjuster needs Phase 5 checkpoint machinery and a separate safety discussion. |
| Ingestion timing | **Lazy** — first tutor question about a resource triggers ingestion. No eager pass at Track build (would burn tokens on resources nobody asks about). Future option (not now): eagerly digest `role=primary` resources. |
| Retrieval strategy | **Digest-first, no chunk RAG.** A one-time LLM pass produces a compact (~1–2k token) structured digest that is always fully in context for resource-scoped questions. Escalation is a `readFullResource` tool that pulls the cached `extractedText` into context when the digest lacks detail. Chunk-level pgvector RAG is explicitly deferred (see "Why no chunk RAG" below) but the door stays open: `extractedText` is persisted at ingestion, so chunking later is a backfill over cached text, never a re-ingestion. |
| Raw text cache | `extractedText` is stored even though the digest is the default context payload — the fetch/extract step is the expensive, flaky part; caching it makes every future use (escalation tool, future chunking, digest regeneration) free. |
| YouTube extraction | **Vertex Gemini native video ingestion** — pass the YouTube URL as media input to a one-time "produce a digest" call (low-res media mode). No transcript scraping (brittle, ToS-gray). Cost is pennies per video, amortized across all learners forever. |
| Article extraction | Plain fetch + text extraction, reusing the doc-TOC fetcher's approach (`src/lib/agents/decomposition/doctoc.ts`: plain fetch, real UA, no parser dependency). Must apply the outbound-fetch hardening rules already flagged in the ROADMAP audit backlog (scheme/private-IP blocking, timeout, size cap) — the tutor fetch is a new SSRF-shaped call site. |
| Extraction failure | Recorded on the digest row (status + reason) so it doesn't retry per question. The tutor still answers, grounded in DB metadata (resource summary, `conceptsTaught`, concept map, lesson context), and says it's speaking from topic knowledge rather than the specific material. Resource-specific Q&A degrades gracefully; it never gates the feature. |
| Conversation state | **Stateless server.** The client holds the message history for the session; no conversation persistence (explicitly not needed). The route is `streamText`-streamed per the ROADMAP sketch. |
| Gating | **Quota-gated free access for beta users** (free beta displaced the paid gate — see free-beta.md). Deterministic server-side daily message budget per user, modeled on `src/lib/services/intake-limits.ts` (env-overridable dials, DB-counted, soft-limit race acceptable). A wall-clock "5-hour session" cap was considered and rejected — hard to define server-side; a message/token budget bounds the same spend. |
| Guardrails | Four layers, all cheap: (1) scope guard in the system prompt — answers about *this program's topic and materials* only; refuses off-topic homework-mill / general-assistant use and prompt-extraction attempts; (2) the deterministic quota; (3) modest `maxOutputTokens` so a jailbroken turn is cost-bounded; (4) untrusted-data fencing for BOTH user text and extracted resource content (a web page or transcript can carry prompt injection and it goes into the model's context). **No per-message LLM topic classifier** — doubles per-turn cost to defend against abuse the quota already bounds; revisit only if beta logs show real misuse. |
| Learner notes | **In scope** (block T4). Compact per-(user, path, concept) observations written by the tutor itself during conversation, injected into future context assembly. This is the app's ONLY struggle signal until Phase 5 (Progress is bare lesson completion; exercise attempts aren't persisted), and it seeds the Phase 5 adaptive branch — checkpoints can write to the same table later. |
| Models | New `tutor` entry in the `models.ts` registry — Flash for chat turns. Digest authoring gets its own registry entry (`resourceDigest`) so the model is swappable independently. |

### Why no chunk RAG (recorded so it isn't relitigated)

Chunk RAG solves "the source is too big to put in context affordably". Decomposition
already bounds pickable resources to atomic, lesson-sized leaves (~3–15k tokens of
extracted text), where (a) stuffing even the full text into a Flash call costs fractions
of a cent, and (b) retrieval answers *worse* than full context — wording-mismatch misses,
worked examples fragmented across chunks. Chunk RAG at these sizes costs a block of
engineering (chunker, embedder, top-k tuning, invalidation) and buys nothing. The
escalation ladder is: digest in context → `readFullResource` tool → *(only if a real
case demands it)* chunk retrieval for genuinely huge resources.

## Codebase facts the plan rests on (verified 2026-07-20)

Fresh conversations: trust these, but re-verify before editing.

1. **Resources are overwhelmingly link-out.** `Resource.content` is null except for
   `origin=generated` on-ramp lessons — the material lives at `url`. This is why
   ingestion is the crux of resource-specific Q&A.
2. **Decomposition bounds resource size.** Containers are decomposed into atomic leaves;
   only atomic rows are pickable. Digests are per-atomic-resource and lesson-sized.
3. **Rich tutor context already exists in the DB, free.** Lesson (title, summary,
   `conceptsTaught`, `estMinutes`), Section intro, Track (`goal`, `intent`,
   `targetMastery`, `priorKnowledge`, title/summary), Progress (done lessons → position
   in track), and the Path's Concept DAG (`Concept` + `ConceptPrereq`) for the current
   concept's prerequisite neighborhood.
4. **No struggle signals exist anywhere.** `Progress` is `(userId, lessonId, completedAt)`
   only; exercise attempts are not persisted; the Phase 5 check route doesn't exist.
5. **Quota pattern to copy:** `src/lib/services/intake-limits.ts` — env-overridable
   positive-int dials (`parsePositiveIntEnv`), DB-counting, documented soft-limit race.
6. **Streaming:** the intake route (`src/app/api/intake/route.ts`) is non-streaming JSON;
   the tutor route will be the first `streamText` surface. The ROADMAP Phase 4 sketch
   already specifies `streamText`.
7. **Untrusted-input fencing pattern:** free text (`priorKnowledge`, `goal`) is fenced as
   untrusted data at every surviving call site (track composers, program decomposer) —
   see ROADMAP audit item 9.3, including the known residual that `<<< >>>` fences don't
   sanitize a literal `>>>`.
8. **Model registry:** `src/lib/ai/models.ts` — per-agent `modelId` env-overridable via
   `MODEL_<AGENT>`. Add `tutor` + `resourceDigest` names here.
   **Corrected 2026-08-10:** the original fact said temperature and `maxOutputTokens` are
   call-site decisions. They are not — each registry entry carries `modelId`, `temperature`
   and `maxOutputTokens` together (`src/lib/ai/models.ts:37-39`, and every entry from
   `curriculum` at :43 onward). This matters for T2: the "modest `maxOutputTokens` as a cost
   guardrail" decision is a registry value, not something the route sets.
9. **Fetcher precedent:** `decomposeDocToc` (`src/lib/agents/decomposition/doctoc.ts`)
   does plain `fetch` with a real UA and maps fetch/parse errors to a retryable status.
   The ROADMAP audit backlog ("Outbound-fetch hardening 6.2–6.4") already plans a shared
   guard — the T1 fetcher should either use it if it lands first or follow its rules.
10. **Learn UI:** the lesson view is `src/app/learn/[trackId]/[lessonId]/`; shared learn
    components in `src/app/learn/_components/`. Learn UI styling follows the
    centralized token system in `src/app/globals.css` (CLAUDE.md styling rules apply).
11. **Auth on APIs:** intake route returns 401 via the shared error-envelope helper for
    signed-out users — same shape for the tutor route.

## T1 — ingestion + digest layer (~280 LOC)

**Base branch:** `main`
**Files owned:**
- `prisma/schema.prisma` (+ migration)
- `src/lib/agents/tutor/digest.ts` (new — `ensureResourceDigest`, type routing)
- `src/lib/agents/tutor/extract.ts` (new — hardened fetch + text extraction)
- `src/lib/agents/tutor/digest-prompt.ts` (new)
- `src/lib/ai/models.ts` (modify — add `resourceDigest`)
- `src/lib/agents/tutor/digest.test.ts`, `extract.test.ts` (new)

**What it does.** Adds the `ResourceDigest` table and the one-time-per-resource ingestion
that fills it. `ensureResourceDigest(resourceId)` is idempotent: it returns an existing
`ready` or `failed` row untouched, and otherwise routes by resource type — a YouTube URL
goes to a Gemini media-input digest call, a fetchable page to hardened fetch → text
extraction → digest call, anything else to `failed` with a reason. Nothing in this block is
wired to a request path; T2 is the first caller.

**Out of scope.** The tutor route, context assembly, prompts for answering, quota, and all
UI. Deciding *when* ingestion runs is T2's problem — T1 exposes a function, not a trigger.
Backfill or eager digesting of existing resources.

**Migration:** yes — new `ResourceDigest` table, 1:1 with `Resource`, `onDelete: Cascade`.
Before `prisma migrate dev`, read `.claude/rules/prisma-migrations.md` — the generated
`migration.sql` will propose dropping two hand-written indexes. Dropping either is always
wrong.

**New deps:** none expected. If text extraction turns out to want a parser library, that
needs the user's OK before install (JIT rule) — `doctoc.ts` sets the no-parser precedent, so
prefer following it.

**Tests.** `src/lib/agents/tutor/digest.test.ts` (unit, pure — type routing, status
transitions, idempotency on each status), `extract.test.ts` (unit, pure — SSRF guard
rejects private IPs and non-http schemes, size cap, timeout mapping). Live digest generation
is a `scripts/verify-tutor-digest.ts` driver, not a test — it costs LLM calls.

**Acceptance criteria.**
- [ ] `ensureResourceDigest` called twice for the same `ready` resource issues exactly one
      LLM call; the second returns the persisted row.
- [ ] A resource whose fetch returns 403 ends `status: 'failed'` with `failureReason`
      populated, and a subsequent call does **not** retry the fetch.
- [ ] An article-type resource that succeeds has both `extractedText` and `digest`
      non-null, and `model` recording which model authored the digest.
- [ ] A YouTube-type resource that succeeds has `digest` non-null and `extractedText` null
      — the plan's locked decision, not an oversight.
- [ ] Extraction refuses a URL resolving to a private IP, and one with a `file://` or
      `data:` scheme, without issuing a network call.
- [ ] Extraction enforces a byte cap and a timeout; exceeding either yields `failed`, never
      a truncated digest silently marked `ready`.
- [ ] `ResourceDigest` rows are deleted when their `Resource` is deleted.

---

New Prisma model (separate table, 1:1 with Resource — keeps the wide text columns off
the hot `Resource` row):

```
ResourceDigest
├─ resourceId      (unique FK → Resource, Cascade)
├─ status          enum: pending | ready | failed
├─ failureReason   String?   (e.g. "fetch 403", "unsupported type")
├─ extractedText   String?   (raw article text; null for the YouTube prong — the
│                             digest call ingests the video directly and there is
│                             no cheap raw-text artifact to cache)
├─ digest          String?   (~1–2k tokens structured markdown: outline w/ section
│                             headings or timestamps, key definitions, worked
│                             examples, notation, common pitfalls)
├─ model           String?   (which model authored the digest — provenance)
└─ createdAt / updatedAt
```

Service: `ensureResourceDigest(resourceId)` — idempotent; returns the existing row
unless `pending`/absent; routes by resource type: YouTube URL → Gemini media-input
digest call; fetchable page → hardened fetch + text extraction → digest call; otherwise
(PDF-behind-paywall, courseware requiring login, etc.) → `failed` with reason. A `failed`
row is terminal for the request path (no per-question retries); a manual/backfill retry
path can clear it later.

- **OPEN:** where the lazy ingestion runs. In-request (the first asker waits ~5–20s with
  a "reading the material…" streamed state) vs. enqueued to the existing worker
  infrastructure (first asker gets the metadata-grounded fallback answer, digest is
  ready for the next question). Decide against request-timeout limits of the current
  hosting (Vercel now, Cloud Run mid-migration — see free-beta plan D-blocks status).
- **OPEN:** digest author model — Pro (mirrors `curriculumFallback`'s
  spend-once-compounds-forever reasoning) vs. Flash (digesting is summarization, not
  discovery). Registry entry makes this swappable either way.
- **OPEN:** whether a `ready` digest ever goes stale. Resources are mostly immutable
  URLs; propose ignoring staleness in v1.
- Unit tests: type-routing + status transitions (pure); extraction prompt assembly.
  Live digest generation stays a `scripts/verify-*.ts` driver (costs LLM calls).

## T2 — tutor core (~290 LOC)

**Base branch:** `T1`'s branch (stacked)
**Files owned:**
- `src/lib/agents/tutor/context.ts` (new — context assembly)
- `src/lib/agents/tutor/prompt.ts` (new — system prompt, untrusted-data fencing)
- `src/lib/agents/tutor/tools.ts` (new — `readFullResource`)
- `src/app/api/tutor/route.ts` (new)
- `src/lib/api/tutor-schema.ts` (new — zod body schema)
- `src/lib/services/tutor-limits.ts` (new)
- `src/lib/ai/models.ts` (modify — add `tutor`)
- `prisma/schema.prisma` (+ migration, if the quota counter needs a table — see OPEN)
- colocated `.test.ts` for context, prompt, and limits

**What it does.** The first streaming surface in the app. `POST /api/tutor` authenticates,
zod-validates `{ trackId, lessonId, resourceId?, messages }`, checks the daily message
budget, assembles server-side context, and returns a `streamText` response. Context assembly
pulls lesson/section/track fields, outline position from `Progress`, the current lesson's
concepts and their prereq neighbourhood, and — when the question is resource-scoped — that
resource's digest, calling `ensureResourceDigest` if absent. The learner-notes slot exists
and assembles empty; T4 fills it.

**Out of scope.** All UI (T3). Writing learner notes (T4). Conversation persistence — the
client holds history and the server stores nothing about the conversation, per locked
decisions.

**Migration:** only if the quota counter lands as a `TutorUsage` day-bucket table rather
than a count over an existing events table. Settle that inside the block, smallest option
wins. If yes, the `DROP INDEX` rule above applies.

**New deps:** none — `streamText` comes from the `ai` package already in use.

**Tests.** `context.test.ts` (unit, pure — assembly shape with and without `resourceId`,
with and without a `ready` digest, empty-notes slot present), `prompt.test.ts` (unit — both
user text and digest/extracted content land inside untrusted-data fences),
`tutor-limits.test.ts` (unit — dial parsing, boundary at the limit). Live behaviour goes to
`scripts/verify-tutor.ts`, which asks a general question, a resource-scoped question before
and after ingestion, an off-topic question, and exhausts the quota.

**Acceptance criteria.**
- [ ] `POST /api/tutor` without a session cookie returns 401 in the shared error-envelope
      shape used by `src/app/api/intake/route.ts`.
- [ ] A body missing `trackId` or `messages`, or carrying an unknown field, is rejected by
      the zod schema before any model call.
- [ ] A valid request returns a streamed response, not a buffered JSON body.
- [ ] A resource-scoped question against a resource with no digest triggers exactly one
      `ensureResourceDigest` call and still returns an answer.
- [ ] With a `failed` digest, the answer is still produced and states it is speaking from
      topic knowledge rather than the material — the graceful-degradation rule.
- [ ] Both learner message text and digest/extracted content appear inside untrusted-data
      fences in the assembled prompt; neither is interpolated bare.
- [ ] An off-topic request ("write my cover letter") is refused by the scope guard.
- [ ] Exhausting the daily budget returns 429 with the reset time, and the request does not
      reach the model.
- [ ] The quota counter is durable — it survives a process restart within the same day.
- [ ] `models.ts` gains a `tutor` entry carrying `modelId`, `temperature` and a modest
      `maxOutputTokens` (per the corrected fact 8; the cap is a registry value).

---

- `src/lib/agents/tutor/` — context assembly + prompt + turn logic:
  - **Context assembly (server-side, per call):** lesson + section + track fields,
    done/next outline position from Progress, the current lesson's concepts and their
    prereq neighborhood from the map, learner notes (T4; assembled as empty until then),
    and — when the client scopes the question to a resource — that resource's digest
    (triggering `ensureResourceDigest` if absent).
  - **System prompt:** tutoring persona; scope guard (this topic/these materials only;
    refuse general-assistant use and prompt extraction); honesty rule for the
    fallback case ("answering from topic knowledge, not the material itself"); all
    user text and all extracted/digest content fenced as untrusted data.
  - **Tools:** `readFullResource` (loads `extractedText` for the scoped resource when
    the digest lacks detail; unavailable for YouTube-prong resources — the digest is
    all there is). T4 adds the note-writing tool.
- `src/app/api/tutor/route.ts` — auth (401 envelope), zod-validated body
  `{ trackId, lessonId, resourceId?, messages }`, quota check, `streamText` response.
  Client-held history; server persists nothing about the conversation.
- `src/lib/services/tutor-limits.ts` — daily message budget per user, modeled on
  intake-limits. **OPEN:** the numbers (proposal: 50 messages/day, env-overridable
  `TUTOR_MESSAGES_PER_DAY`). Counting requires a cheap durable counter —
  **OPEN:** a `TutorUsage` day-bucket row vs. counting an events table; pick the
  smallest thing in-block.
- `models.ts`: add `tutor` (Flash, modest `maxOutputTokens` — the cost guardrail) and
  `resourceDigest` entries.
- Verification: `scripts/verify-tutor.ts` live driver (seeded track; asks a general
  question, a resource-scoped question pre/post digest, an off-topic question →
  refusal, and exhausts the quota → 429).

## T3 — lesson-view tutor panel (~260 LOC)

**Base branch:** `T2`'s branch (stacked)
**Files owned:**
- `src/app/learn/_components/TutorPanel.tsx` (new — client component, the only `"use client"` leaf)
- `src/app/learn/_components/TutorMessage.tsx` (new)
- `src/app/learn/_components/LessonView.tsx` (modify — mount the panel)
- `src/app/learn/_components/ResourcePane.tsx` (modify — the "ask about this resource" affordance)
- `src/lib/learn/tutor-panel-view-model.ts` (new — state derivation, kept out of the component per CLAUDE.md layering)
- `src/lib/learn/tutor-panel-view-model.test.ts` (new)

**What it does.** Puts the tutor on the lesson view: a chat thread with streamed rendering,
an input box, and a scoping affordance that attaches `resourceId` when the learner asks
about a specific resource rather than the topic generally. Renders the four states the route
can produce — ingesting, digest-failed, quota-exhausted, signed-out.

**Out of scope.** Any change to the route or to context assembly. If the panel wants a field
the route does not return, that is a finding to report, not a T2 edit made from here.

**Migration:** none
**New deps:** none — streamed rendering uses the `ai` package's existing client helpers.

**Tests.** `tutor-panel-view-model.test.ts` (unit, pure — state selection from
`{ status, quota, digestState }`). The panel itself is verified in the browser by
`block-verifier`; do not add a component-render test harness for this block alone.

**Acceptance criteria.**
- [ ] "I don't get this" typed into the panel returns an answer that names the current
      lesson or resource — the ROADMAP's stated exit criterion for Phase 4.
- [ ] Tokens render progressively as they stream; the panel does not wait for the full
      response before showing anything.
- [ ] The "ask about this resource" affordance sends `resourceId`; a question typed without
      it does not.
- [ ] While a digest is being produced, the panel shows the reading-the-material state and
      the input stays usable.
- [ ] A 429 renders the friendly limit message with a reset time, not a generic error.
- [ ] Signed-out users see no panel (or a sign-in prompt) — never a panel that 401s on use.
- [ ] The panel is dark-mode-clean and uses only the token utilities in
      `src/app/globals.css`; no hardcoded colours (`.claude/rules/styling.md`).
- [ ] No browser console errors during a full ask-and-stream cycle.

---

- Panel in `src/app/learn/[trackId]/[lessonId]/` (learn UI — token utilities only, dark-
  mode-clean per CLAUDE.md styling rules): chat thread, streamed rendering, input box.
- Scoping affordance: "ask about this resource" from a lesson's resource (passes
  `resourceId`) vs. general topic questions (no `resourceId`). **OPEN:** exact
  placement/interaction (per-resource button vs. a scope selector on the panel) — a
  design call for the block's discussion phase.
- States: ingestion-in-progress ("reading the material…"), digest-failed (tutor answers
  anyway — no special UI beyond the tutor's own disclosure), quota-exhausted (friendly
  limit message with reset time), signed-out (panel hidden or sign-in prompt).
- Exit criterion from the ROADMAP applies here: "I don't get this" returns an answer
  that references the current item by name.

## T4 — learner notes (~200 LOC)

**Base branch:** `T3`'s branch (stacked — T4 depends on T2 for code, on T3 for manual verification)
**Files owned:**
- `prisma/schema.prisma` (+ migration)
- `src/lib/agents/tutor/notes.ts` (new — upsert, cap/eviction)
- `src/lib/agents/tutor/tools.ts` (modify — add `recordLearnerNote`)
- `src/lib/agents/tutor/context.ts` (modify — fill the notes slot T2 left empty)
- `src/lib/agents/tutor/notes.test.ts` (new)

**What it does.** Adds `LearnerConceptNote` and lets the tutor write to it mid-conversation
via a `recordLearnerNote` tool call, upserting on `(userId, pathId, conceptSlug)` so each
concept holds one living observation. T2's empty context slot starts returning these notes.
This is the app's only struggle signal before Phase 5, and the table is deliberately shaped
so Phase 5 checkpoints can become a second `source`.

**Out of scope.** Any UI for viewing or editing notes. Phase 5 checkpoint writes — the
`source` enum makes room for them and stops there. Using notes for anything beyond context
injection (no adaptive branching here).

**Migration:** yes — `LearnerConceptNote` with `@@unique([userId, pathId, conceptSlug])`.
`conceptSlug` is deliberately **not** an FK, matching the snapshot-by-slug philosophy so a
concept merge or split cannot delete a learner's notes. The `DROP INDEX` rule above applies.

**New deps:** none

**Tests.** `notes.test.ts` (unit, pure — cap enforcement, oldest-updated eviction, injection
formatting stays within its token budget, upsert replaces rather than appends). The
tool-call write-through is verified by the T2 live driver.

**Acceptance criteria.**
- [ ] Two `recordLearnerNote` calls for the same `(user, path, conceptSlug)` leave exactly
      one row, holding the later text.
- [ ] At the cap, writing one more note evicts the oldest-updated note and leaves the count
      at the cap.
- [ ] Notes are keyed on `pathId`: a learner in a two-path Program sees only the notes for
      the path they are currently in.
- [ ] Deleting a `Concept` does not delete notes referencing its slug.
- [ ] Assembled context including the maximum number of notes stays within a few hundred
      tokens.
- [ ] With no notes, context assembly produces the same output it did in T2 — filling the
      slot must not change the empty case.

---

New Prisma model:

```
LearnerConceptNote
├─ userId + pathId + conceptSlug   (@@unique — one living note per concept per user;
│                                   conceptSlug not FK, matching the snapshot-by-slug
│                                   philosophy — merges/splits must not eat notes)
├─ note        String   (short observation: "struggled with chain-rule notation",
│                        "confident on limits, tested out")
├─ source      enum: tutor  (Phase 5 adds: checkpoint)
└─ createdAt / updatedAt
```

- Written by the tutor via a `recordLearnerNote` tool call (upsert on the unique key —
  updates replace, so notes stay current and bounded). Cap notes per (user, path)
  (**OPEN:** proposal 30; oldest-updated evicted) so context injection stays a few
  hundred tokens.
- Injected into T2's context assembly (the assembly slot ships empty in T2; T4 fills it).
- Keyed on `pathId` (not programId): notes are about concepts, concepts are Path-scoped,
  and multi-path Programs get the right notes per path free. **OPEN:** confirm in-block
  that the lesson→concept→path join at assembly time is as direct as expected.
- Unit tests: cap/eviction logic, injection formatting (pure). Tool-call write-through
  verified via the T2 live driver.

## Rejected alternatives

Recorded so they are not relitigated in a block conversation. Each was considered and turned
down for a stated reason, not overlooked.

| Rejected | Instead | Why |
| --- | --- | --- |
| Chunk-level pgvector RAG | digest in context, `readFullResource` to escalate | see "Why no chunk RAG" above — at lesson-sized resources it costs a block of engineering and answers *worse* |
| YouTube transcript scraping | Gemini native video ingestion | brittle and ToS-gray; the media call is pennies and amortizes forever |
| Wall-clock "5-hour session" cap | daily message budget | a session is hard to define server-side; a message budget bounds the same spend deterministically |
| Per-message LLM misuse classifier | scope guard in the prompt + the quota | doubles per-turn cost to defend against abuse the quota already bounds |
| Eager digesting at Track build | lazy, on first question | burns tokens on resources nobody asks about |
| Conversation persistence | client-held history | explicitly not needed; keeps the route stateless |

## Open questions for you

Consolidated from the `OPEN` markers inline above — each is marked where it bites, and each
must be settled in that block's discussion phase rather than unilaterally.

1. **T1 — where lazy ingestion runs.** In-request (first asker waits ~5–20s behind a
   "reading the material…" state) vs. enqueued to the existing worker infrastructure (first
   asker gets the metadata-grounded fallback; the digest is ready for the next question).
   Decide against Cloud Run's request timeout. **Note the plan text still says "Vercel now,
   Cloud Run mid-migration" — that is stale as of 2026-07-31; Vercel is gone and Cloud Run
   is the only target.**
2. **T1 — digest author model.** Pro (mirrors `curriculumFallback`'s spend-once reasoning)
   vs. Flash (digesting is summarization, not discovery). The registry entry makes it
   swappable either way.
3. **T1 — digest staleness.** Proposal: ignore it in v1; resources are mostly immutable URLs.
4. **T2 — the quota numbers.** Proposal: 50 messages/day, env-overridable
   `TUTOR_MESSAGES_PER_DAY`.
5. **T2 — how the counter is stored.** A `TutorUsage` day-bucket row vs. counting an events
   table. Smallest durable thing wins; this decides whether T2 carries a migration.
6. **T3 — the scoping affordance.** Per-resource button vs. a scope selector on the panel.
7. **T4 — the notes cap.** Proposal: 30 per (user, path), oldest-updated evicted.
8. **T4 — the join.** Confirm in-block that lesson → concept → path at assembly time is as
   direct as assumed.

## Explicitly deferred (post-v1)

- **Quizzer / path_adjuster modes** — see Locked decisions.
- **Chunk-level RAG** (`ResourceChunk` + pgvector) — only if a real case shows digests +
  full-text escalation insufficient; backfills from cached `extractedText`.
- **Eager digest of `role=primary` resources at Track build** — optimization, not v1.
- **Per-message LLM misuse classifier** — only if beta logs show abuse the quota
  doesn't bound.
- **Conversation persistence / cross-session chat history** — explicitly not needed.
- **Digest staleness/regeneration** — pending the T1 OPEN decision landing at "ignore".
- **Paid gate flip** — the tutor becomes a paid feature when Stripe returns post-beta
  (ROADMAP free→paid gate line); the quota service is the seam where that flips.
