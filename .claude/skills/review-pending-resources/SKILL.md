---
name: review-pending-resources
description: Browser-review resources in the pending_review approval queue against a content-quality rubric, then approve/reject them via the pending-resources API. Takes the number of queue roots to process; samples children for container resources. Returns a decision table.
argument-hint: [count]
disable-model-invocation: true
allowed-tools: Bash(scripts/operator-curl.sh *), Bash(node *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page
---

# Review the pending_review approval queue

Resources discovered by the web fallback land as `status='pending_review'` — usable in the run that found them, but hidden from future runs by the gate until approved. This skill works that queue **as a reviewer**: pull a batch, open each resource in a real browser, grade it against the rubric below (so we catch what discovery's URL-only validators can't — login walls, parked pages, metadata mismatches), then **execute** the decision via the pending-resources API. This is the human/POC stand-in for the autonomous review agent.

Number of queue **roots** to process this run: **$ARGUMENTS** (default 10 if empty). Note `limit` counts top-level roots, not flattened resources — one root may be a large container subtree.

## Preconditions (check first, stop if unmet)

- **The API target, confirmed and stated.** Every admin call goes through `scripts/operator-curl.sh <path> [curl args]`, which supplies the base URL and the admin credential from `.env.local`. It has **no localhost default** and refuses to run unconfigured. Probe: `scripts/operator-curl.sh "/api/playground/pending-resources?limit=1" -s -o /dev/null -w "%{http_code}"` → `200`. A `404` means the operator token is missing/wrong or its `User` row is not `role='admin'` — admin routes 404 rather than 401 by design; stop and see `operator-tooling.md`. If the base URL is a localhost one, the dev server has to be running.
- **Say which service you are approving into, in your first message.** The script prints `[operator-curl] GET <base><path>` to stderr on every call, with a `⚠ REMOTE` marker off localhost — read it off the probe. Remote means the production library and every approve/reject is real.
- **The `pending-review-db.cjs` helper is a separate target** — it talks to Postgres directly and follows `DATABASE_URL`, not `OPERATOR_BASE_URL`, so the two can disagree. It prints `[db] host:port/dbname` to stderr on every run; confirm it is the database behind the API base you probed (`…pooler.supabase.com:6543/postgres` is production, `localhost:55432/learning_app` is disposable). Pointed at the wrong one it returns **empty**, not an error — "nothing pending" is the symptom.
- A Chrome browser connected via the Claude-in-Chrome extension. `list_connected_browsers`; if empty, ask the user to connect it. `select_browser` the device, then `tabs_context_mcp` with `createIfEmpty: true` and use that one tab for everything.

## Rubric (grade each resource against the actual rendered page)

1. **Live & renders** — loads to real content, not a 404/410/parked/error page. (If `get_page_text` is empty, the page may be a JS-rendered SPA — confirm with `read_page` before calling it dead.)
2. **No access barrier** — main content readable/watchable without creating an account, logging in, or paying. Free-but-signup (e.g. email-gated videos) still fails this.
3. **Teaches directly** — the page itself teaches the topic; not a listicle, link aggregator, marketing/sales/signup landing page.
4. **Metadata accuracy — the default is to correct the record, not to reject the row.** Compare the page against the stored title / type / difficulty / summary / conceptsTaught. Clause 6 of `resource-standard.md` is *accurately described*, and a misdescribed resource is repaired by correcting its recorded form; exclusion is for a resource that fails a clause **even when described correctly**. So sort what you find into three cases:

   - **Correctable — this is the ordinary case.** A wrong title, a wrong difficulty, a summary describing something the page isn't, a stale type: PATCH the right values, *then* grade the row on what it actually is. The editable fields are `title`, `summary`, `difficulty`, `durationMin`, `requiresPurchase`, and `type` (with limits) — see *Metadata corrections* below. **Never reject a row for a defect you could have PATCHed.**
   - **Not correctable through this API** — two cases, and no editable field fixes either, so do not go looking for a call that does not exist. (a) **`conceptsTaught` is wrong**: it is not in the whitelist and no route this skill has can edit it. If the concepts are merely imprecise, flag it for a human and grade the rest of the row normally; if the row is misdescribed beyond use, **reject soft**, naming clause 6. (b) **The URL lands somewhere other than what the row claims**: `url` is the row's identity and is not editable — a different URL is a different resource, not an edit. **Scope match for `type='book'` rows:** confirm the URL lands on the stated chapter/section, not the entire work — a whole-work landing page (front matter, full table of contents) under a chapter-scoped title misrepresents its scope → **reject soft**, unchanged (or `action: "decompose"` when it is really an undecomposed container — see the decision mapping).
   - **Corrected, and it still fails something else.** Repair is not a rescue. Once the description is right, apply #1/#2/#3/#6/#7 to the *corrected* row: a row whose true form is an exercise is still **reject soft** under clause 5 after its type is fixed. Correcting metadata only guarantees that the clauses get applied to what the resource actually is.

   **The four integrity comparisons** (clause 6 of `resource-standard.md`) — with the page open you can make all four by eye, and they are the same four the ingestion classifier makes automatically:
   - stored `type` vs. what the **URL's own kind segment** says (Khan's `/v/` = video, `/e/` = exercise, `/a/` = article, and the like);
   - stored `type` vs. **what the page declares itself to be** — a video player, an article of prose, an exercise widget;
   - stored `url` vs. **where the browser actually landed** after redirects; a row whose URL now resolves somewhere else is misdescribed even when the destination is fine;
   - stored `title` vs. the **page's rendered title**. ⚠ This one is noisy and **never decides alone**: Khan appends its own chrome to every title, and legitimate re-titling happens. A mismatch is a reason to *look* — and, where the page confirms the stored title is simply wrong, a reason to *correct* it. It is never a rejection in itself.

   None of the four is a rejection on its own: the first two are a **`type` correction**, the fourth a **`title` correction** (PATCH, see *Metadata corrections* below, then grade the row for what it actually is), and the third is the not-correctable URL case above.
5. **Duration sanity** — while the page is open, estimate real consumption time: visible video length; article word count ÷ ~200 wpm; PDF page count × ~2 min/page. Stored `durationMin` for text resources is an unverified discovery-time LLM guess, and real gates trust it (the 300-min attach ceiling, duration ranking, the track time allocator). If the stored value is off by more than ~2× in either direction, **PATCH the correction first** (see the resources API below), *then* make the approve/reject decision. If the corrected value exceeds 300 min on an atomic row, do **not** approve — the PATCH response returns a `warning` signalling exactly this; reject (soft) if the content is weak, or send it to the decompose queue via `action: "decompose"` if it's good but container-sized. YouTube rows are exact (Data API) and never need this check.
6. **Standalone** (clause 4 of `resource-standard.md`) — a learner who opens this page with nothing else in front of them can follow it. It fails when the page only makes sense to someone who has already worked through a *specific* sibling: it is step *n* of a chain ("picking up where part 2 left off", "using the parser we built last time", a numbered walkthrough that carries state forward). The reason is structural, not editorial — nothing in the library records that one resource depends on another; ordering records position, not prerequisite, so a chained lesson gets placed where its antecedent will not be. Content quality is irrelevant here; a chained lesson can be excellent *in sequence* and still fail. Generic background ("assumes some algebra") is **not** this — every lesson has that. Look for a **named, specific** antecedent.
7. **Consumed, not performed** (clause 5) — its substance is content to read or watch, not work the learner does. Exercise sets, challenges, katas, a widget to operate: these fail, however well made and however well they fit the topic. The reason is that `durationMin` is a promise about time spent *receiving*; the cost of doing problems belongs to the learner and varies by an order of magnitude between two people on the same exercise. This is not a claim that practice doesn't matter — practice is authored against our own curriculum as questions attached to a concept, not sourced from the wild. **Interactive resources fail as a class, not case by case**: where a row is *classified* interactive, that classification is the answer — unless the page contradicts it, which is the precedence rule below and not an exception to this one.

### Decision mapping

- All pass → **approve** (atomic root) or **approve cascade** (container — promotes the whole subtree).
- Fails #1, broken/dead/removed → **reject hard**. `hard` is reserved for a dead link and nothing else.
- Fails #2/#3, page works but violates a quality rule → **reject soft**.
- Fails #4 → **PATCH the correction, then grade the corrected row.** A metadata mismatch is not by itself an approve/reject: clause 6 is repaired, not punished. It becomes **reject soft** only where no editable field can fix it — a wrong `conceptsTaught` that leaves the row misdescribed beyond use, or a `type='book'` row whose URL lands on the whole work rather than the stated chapter — and it becomes whatever the *corrected* row earns under #1/#2/#3/#5/#6/#7 otherwise.
- Fails #6 (standalone) or #7 (consumed, not performed) → **reject soft**. The page renders fine; it is the resource that does not belong. Name the clause it failed in `Reasoning` — "clause 4: step 3 of a numbered chain", "clause 5: an exercise set". A serveability failure is never `hard`.
- ⚠ **A clause-6 repair outranks a clause-5 exclusion — re-type first, then grade.** Worked example: a row stored as `type: 'interactive'` whose page serves a plain article. Clause 5 excludes interactive as a class, so the reflex is reject-soft — and that is wrong. The standard calls this a **misclassification**: correct the recorded form on the evidence of the content (PATCH `type` to `article`), then grade the article on its own merits like any other row. Reject only if the page really is the exercise or widget its type claims. The same order applies to every stored field the page contradicts: repair first, then judge the repaired row.
- **Doubt admits, it does not exclude** (the standard's error budget is one-sided). A page that merely *resembles* a chain or *resembles* practice, with no second signal, is not a failure — a weak signal never decides alone, and excluding a real lesson removes it from every learner's retrieval permanently and invisibly, while admitting a weak one stays visible to review and to the next audit. If you cannot corroborate the failure, approve it, or take the last bullet below and skip.
- Fails #5 with a corrected duration **over 300 min on an atomic row** → after PATCHing the correction, **reject soft** (weak content) or **send to decompose** (`action: "decompose"` — good content that's really a container: a course TOC, a whole book). Never approve. A correction that stays ≤300 doesn't change the decision — fix it and grade normally.
- **Misclassified atomic container** (an `atomic` row whose page is actually a course TOC / whole work, regardless of duration, **whose linked units do not already exist as rows**) → `action: "decompose"` — it re-routes to the decomposition queue (`decompositionStatus: pending`), drops out of this queue's actionable list, and (like reject) removes the row's concept-map candidate links with readiness recomputed — remediation refills any reopened spine hole. Atomic rows only; the API 409s on anything else.

  The existence clause is the whole distinction from **Exposed index pages** below, and it is not cosmetic — both rules describe "an atomic row whose page is a TOC", and they prescribe opposite actions. Ask *where the pages it links to are*: **nowhere in the library** → this rule, decompose creates them. **Already sitting beside it as sibling rows** in the same container → the other rule, decompose creates nothing and reject is the repair. A root-level row pulled straight from the queue is almost always the first; an `atomic` child inside a `decomposed` container is almost always the second.
- `blocked: true` in the queue (decompositionStatus `pending`/`human_review`) → **skip**, flag "resolve in Human review first" (the API 409s on these anyway).
- **Exposed index pages** (a `decomposed` container with one or more `atomic` children whose page is a chapter-index / intro / table-of-contents that links to *sibling* rows rather than teaching) → do **not** approve-cascade: it would publish those index pages as pickable duplicates of the very units they list (a pre-multi-layer decomposition artifact). Decide per child instead — see below. Partial counts: the container does **not** have to be uniformly flat, and usually isn't. A container with one properly nested `decomposed` chapter and two chapters flattened around it has exactly this defect in two places.

  **Rejecting the index rows is the repair — re-decomposition is not.** An exposed index page is an `atomic` row that fails **rubric #3** (a table of contents is a link aggregator, not teaching), so it takes the ordinary decision: **reject soft**, no cascade. That drops it from the pickable pool and removes its `ConceptResource` links, leaving its real sibling lessons approvable on their own. Then grade the remaining children normally and approve the ones that pass — the container ends up correct, just flatter than ideal.

  Two things **not** to do here, both of which look right and aren't:
  - **Not `action: "decompose"` on an index child.** Its links all point at rows that already exist, and `createChild` skips any child whose URL is already in the library — globally, by URL, without re-parenting (`src/lib/agents/decomposition/upsert-resource.ts`). So it would flip to `decomposed` and create **zero** children: an empty container, strictly worse than the index row you started with.
  - **Not "hand it to `/decompose` to rebuild the nesting".** Same reason: no API path re-parents existing rows, so re-decomposition cannot un-flatten anything. Re-parenting needs a direct DB write and is out of scope for this skill — flag it for a human if the nesting genuinely matters.

  **Requeue the root only for missing content, which is a separate defect.** If the landing page advertises chapters/units that have no row at all, `node --env-file=.env.local .claude/skills/decompose/scripts/decomp-db.cjs requeue <rootId>` moves the container back to `human_review` so `/decompose` can add them (new URLs are created normally; existing ones are skipped, so this is safe to run on a partially-built tree). Use the **production** `DATABASE_URL` override — the helper follows `DATABASE_URL`, not `OPERATOR_BASE_URL`. Requeuing sets `blocked: true`, so the root drops out of this queue until the decompose pass is done. Do this *after* rejecting the index rows, not instead of it.
- Genuinely unsure → **skip** and flag it; do not guess. We accept the residual risk and act on broken resources retroactively from user feedback.

### Approve a container root LAST, and only when its subtree is settled

This queue lists only top-level rows that are themselves `pending_review`
(`listPendingReview`: `where: { parentResourceId: null, status: 'pending_review' }`),
and it renders children **only beneath a listed root**. So approving a root does not
just decide that row — it takes its whole subtree off this surface.

- **Never approve a root without `cascade` while any descendant is still `pending_review`.**
  Those rows become unreachable here: the queue won't list the now-active root, so it
  won't render them either. This is the review-side twin of the seed-decomposition
  stranding that left 1,584 children unreviewable under active containers — see the
  `childStatus` note in `src/lib/agents/decomposition/upsert-resource.ts`. That bug was
  fixed at the creation side; this side is still reachable by hand.
- **Never approve a root you intend to requeue.** New children inherit the parent's
  status at creation (`childStatus: existing.status`), so re-decomposing under an
  `active` root yields `active` children that skip review entirely — and an active root
  would hide them from this queue regardless. Requeue first; approve after the decompose
  pass returns the row here.
- **Leaving a container root `pending_review` costs nothing.** `searchResources` filters
  to `decompositionStatus = 'atomic'` by default, so a `decomposed` container is never
  retrieved, never attaches, and is never pickable. The only effect is that it stays in
  the queue — which is where you want it while its subtree is unfinished.

Once the subtree is final and no further decomposition is planned, approve the root with
`cascade: true`: it touches only `pending_review` rows, so earlier rejects survive and it
doubles as the sweep for anything approved individually. An `atomic` root has no subtree —
approve it normally.

**A settled-looking root is not a bug.** A container whose children are all decided still
needs that one final root approval, and nothing prompts for it, so roots that are actually
done will sit in the queue looking undecided. Check the root's children before assuming a
listed root has work left in it.

## Steps

1. **Pull the batch.** `scripts/operator-curl.sh "/api/playground/pending-resources?limit=$ARGUMENTS" -s`. Each root carries `{ id, title, url, type, decompositionStatus, blocked, children:[…] }`.

2. **Grade each root** against the rubric by opening its page:
   - **Atomic root** (empty `children`) — open the `url`, grade, done.
   - **Container root** (non-empty `children`) — use **source-trust + sampling**, do **not** open every child:
     - Open the landing `url`; confirm it's a legitimate, free, no-login source and its structure matches the decomposition.
     - Sample a spread of real leaves: `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/pending-review-db.cjs sample <rootId> 3` returns up to 3 atomic leaf URLs from anywhere in the subtree (direct children from the API are often themselves containers; the real leaves are deeper). Open them, confirm live + on-topic + real teaching content.
     - **Check the decomposition shape, not just the content.** A correct multi-chapter container nests — each chapter is its own `decomposed` sub-container and only true lessons are `atomic` leaves. Smell test: any `atomic` child whose page opens to an outline / table-of-contents linking to *other rows in this same container* is an exposed index page. Check every `atomic` child that looks like a chapter head (titles like "Introduction", "Basic Concepts", "N. <Chapter Name>", or a URL like `Intro<Something>`), not just the sampled leaves — one nested `decomposed` sibling elsewhere in the tree does **not** clear the others. Handle per **Exposed index pages** in the decision mapping instead of approving as-is.
     - **Compare the child list against the landing page's own table of contents.** A container that advertises nine chapters and holds three is incomplete — a different defect from an exposed index, with a different fix (requeue), and the two travel together often enough to be worth one look.
     - Extrapolate trust to the rest of the subtree. (This can miss a single broken leaf — accepted tradeoff.)

3. **Execute the decision** via the API:
   ```sh
   B=/api/playground/pending-resources
   # approve a container subtree
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve","cascade":true}'
   # approve a single atomic resource
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"approve"}'
   # reject (severity soft = quality | hard = broken link); add "cascade":true for a whole subtree
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"reject","severity":"soft"}'
   # send a misclassified atomic row (really a container) to the decompose queue
   scripts/operator-curl.sh "$B" -s -XPOST -H 'content-type: application/json' -d '{"resourceId":"<id>","action":"decompose"}'
   ```
   Order matters within a container: **rejects first, then the approvals, then the root
   last** (see *Approve a container root LAST* above — approving the root early hides
   everything still undecided beneath it). Rejects and approvals compose safely in that
   order because approve only touches `pending_review` rows, so a cascade cannot undo a
   reject you already issued.

   Skip blocked/unsure rows — issue no POST. (Optionally `... pending-review-db.cjs state <id>` to confirm a decision landed.)

   **Metadata corrections** (rubric #4's type/title mismatches, rubric #5's durations, or any observed summary/difficulty error) go through the resources API *before* the approve/reject POST:
   ```sh
   # correct a bad duration guess (any of durationMin / title / summary / difficulty; whitelist-only)
   scripts/operator-curl.sh /api/playground/resources -s -XPATCH -H 'content-type: application/json' \
     -d '{"resourceId":"<id>","fields":{"durationMin":540}}'
   # correct a mis-recorded form (rubric #4, clause 6) — and clear a duration the old form owned
   scripts/operator-curl.sh /api/playground/resources -s -XPATCH -H 'content-type: application/json' \
     -d '{"resourceId":"<id>","fields":{"type":"article","durationMin":null}}'
   ```
   **`type` corrections, precisely:**
   - The only permitted targets are **`article` and `video`**. That is scope, not safety: those two are what clause 6 needs to repair a mislabelled single lesson. A container-shaped target (`course`, `book`, `docs`) is a shape decision — `action: "decompose"`'s business, not an edit's.
   - **Atomic rows only.** The API *refuses* a `type` edit on anything else and names the row's `decompositionStatus` in the refusal. This is the safety argument: an atomic row has never been examined for containment, so relabelling it contradicts nothing that has already been acted on, whereas a `decomposed` row's label has real children standing behind it.
   - `durationMin: null` is permitted and means **"nobody has measured this; re-measure me"** (it stamps `durationSource: 'unknown'`; a number you supply stamps `reviewer`). Use it in the same PATCH when the re-type orphans the stored number — a video recorded as a course carries a course-sized duration that describes nothing. Otherwise measure it per rubric #5.
   - ⚠ **Do not re-type a row you also mean to decompose.** A row typed `article`/`video` short-circuits a *later* `action: "decompose"`: that path's `classify()` routes a non-container type straight to atomic without ever fetching the page, so the decompose pass creates nothing and the row lands back as atomic. Order is the fix — send it to decompose **first**, re-type after, or don't re-type at all. `force` on the decomposition-review route is the usual bypass flag, but note it lifts only the oversize/budget gate and runs *after* `classify()`, so it does **not** rescue an already-re-typed row; the hand-supplied `decompose_manual` path is the only one that ignores classification entirely.

   The response echoes the updated row plus flags: `embeddingStale: true` means a title/summary edit will be re-embedded by the backfill (no action needed); a `warning` means the row now sits over the attachable ceiling — apply the decision-mapping rule above (never approve it).

## Parallelize where possible

- Browser actions share one tab, so they're inherently sequential — but batch all navigations + extractions for a container's samples into **one `browser_batch`** call (navigate→get_page_text→navigate→get_page_text…) instead of separate round-trips.
- The batch fetch and the `pending-review-db.cjs sample` lookups for independent roots have no ordering dependency — fire them together.
- Execute the POST decisions for independent roots together once grading is done.

## Report

Output **only** the final table — do not narrate your reasoning per resource as you go. One row per resource processed:

| Resource | Link | Type | Decision | Reasoning |
|---|---|---|---|---|

`Decision` is one of: Approve · Approve (cascade) · Reject (soft) · Reject (hard) · Skip · Requeue (incomplete). A container with exposed index pages is **not** one decision: report the rejected index rows and the approved lessons as their own rows. Keep `Reasoning` to one line grounded in the rubric. After the table, add a one-line tally (approved / rejected / skipped) and call out any borderline calls worth a human's second look.
