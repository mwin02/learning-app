---
name: author-concept-bank
description: Upgrade a concept's question bank by reading its actual resources (YouTube transcripts, articles, generated lessons) and authoring resource-grounded questions, then marking the bank reviewed via the concept-banks API. Takes either a conceptId (one bank) or a number N (process the N oldest weak banks from the discovery worklist). Replaces shallow title-only agent questions with grounded user questions. Returns a decision table.
argument-hint: [conceptId | count] [pathId?]
disable-model-invocation: true
allowed-tools: Bash(curl *), Bash(python3 *), WebFetch, Read
---

# Author resource-grounded concept-bank questions

Most concepts ship with auto-generated questions (`origin=agent`) written from resource **titles** only — serviceable but shallow, and they often drift out of scope (e.g. a "Systems of Linear Equations" bank testing row-echelon-form, which belongs to the downstream "Gaussian Elimination" concept). This skill upgrades a bank **as an author**: open the concept's real resources, read what they actually teach, author better questions scoped strictly inside the concept, then **execute** the edits via the concept-banks API and mark the bank reviewed. This is the human/POC stand-in for the autonomous curriculum agent.

**Argument (`$ARGUMENTS`):** first token is the target.
- **A conceptId** (starts with `cm…`) → process that single concept's bank.
- **A number `N`** → pull the `N` oldest weak banks from the discovery worklist and process them in order.
- Optional second token: a **`pathId`** to scope the worklist / lookups to one path.
- Empty → default to `N=1`.

## Preconditions (check first, stop if unmet)

- Dev server on `http://localhost:3000` with its env (incl. `DEV_AUTH=1`). Probe: `curl -s -o /dev/null -w "%{http_code}" "localhost:3000/api/playground/concept-banks?limit=1"` → `200`. A `404` means `DEV_AUTH` is off (the route 404s when unauthed); ask the user to start it with `DEV_AUTH=1`. Confirm the port the dev server actually printed — it falls back to `3001` if `3000` is taken.
- Transcript tooling: `python3 -c "import youtube_transcript_api"`. If it errors, `python3 -m pip install youtube-transcript-api` (the `fetch-transcript.py` helper prints this hint and exits 2 when the dep is missing). Captions are fetched from the `timedtext` endpoint the web player uses — the YouTube **Data API cannot** download third-party captions (owner-only, 403), so do not reach for it. Fetches can still fail on a residential vs. cloud IP, rate-limiting, or caption-less videos — fall back to title + domain knowledge for just those resources.

## Resolve targets

- **conceptId given:** fetch it with `includeReviewed=1` so it returns even if already reviewed:
  `curl -s "localhost:3000/api/playground/concept-banks?includeReviewed=1[&pathId=…]"` then select the matching `conceptId`.
- **number `N` given:** `curl -s "localhost:3000/api/playground/concept-banks[?pathId=…][&limit=…]"` — this is the weak-bank worklist (`bankReviewed=false`, oldest `Concept.createdAt` first), each concept carrying its `questions[]` and `resources[]`. Take the first `N` **after skipping on-ramp concepts** (next rule).
- **Skip on-ramp concepts** (`isOnRamp: true`, broad orientation concepts like "Getting Started with …"): they deliberately carry **no** question bank. Never author or mark one — leave it empty and unreviewed. If a conceptId argument resolves to an on-ramp concept, say so and stop without changes.

## Per-concept workflow

1. **Read the resources.** From the concept's `resources[]` (`title`, `url`, `type`, `role`):
   - **YouTube** (`youtube.com` / `youtu.be`) → `python3 ${CLAUDE_SKILL_DIR}/scripts/fetch-transcript.py <url-or-id> [<url-or-id> …]` (batch all of a concept's videos in one call; dedupe IDs that repeat across concepts). Read the `OK` transcripts; for any `FAIL` block, fall back to the title + your own knowledge of that well-known video.
   - **Articles / docs** (Khan Academy, MIT OCW, blog posts) → `WebFetch` the `url`.
   - **`generated://…`** (internal authored lesson) → read at `http://localhost:3000/playground/resource/<resourceId>` (the `resources[].id`).
   - Weight `role: "teaches"` resources over `role: "uses"`; prioritize whichever resource is most squarely on the concept (often the one whose title matches the concept name).

2. **Author 5–10 questions** grounded in what those resources actually teach — a rough mix of `text` (short-answer) and `mcq`. Reveal-only: no auto-grading, so write for a learner who attempts then reveals.
   - **Stay inside the concept.** Do not test prerequisite or later concepts, and do not reach for deep specifics the resources don't establish. Re-scoping is the main value here — the existing agent questions frequently bleed into adjacent concepts.
   - **MCQ:** embed options inside `prompt` as lines `A) …`, `B) …`, `C) …`, `D) …` (the POST endpoint **rejects** an MCQ whose prompt lacks ≥2 lettered options). `answer` = correct option (letter + text). `rubric` = why it's right + a brief note on the tempting distractors.
   - **text:** `answer` = a complete model answer; `rubric` = what a correct answer must contain.

3. **Edit the bank.** There is **no update endpoint** — to change a question, delete it and post a new one.
   - **POST** new questions (persisted as `origin=user`). Post the batch as a JSON file to avoid shell-escaping (`-d @file.json`):
     ```sh
     curl -s -XPOST "localhost:3000/api/playground/concept-banks/questions" \
       -H 'content-type: application/json' -d @questions.json
     # body: {"conceptId":"…","questions":[{"kind":"text"|"mcq","prompt":"…","answer":"…","rubric":"…"}]}
     ```
   - **DELETE** the weak `origin=agent` questions: `curl -s -XDELETE "localhost:3000/api/playground/concept-banks/questions?id=<questionId>"`. Keep any agent question that is genuinely good and in-scope — your call.
   - Post-then-delete is safest: confirm the new batch validated (`{"added":N}`) before removing the old ones.

4. **Mark reviewed:** `curl -s -XPATCH "localhost:3000/api/playground/concept-banks" -H 'content-type: application/json' -d '{"conceptId":"…","bankReviewed":true}'`.

5. **Verify.** Re-GET with `includeReviewed=1`: confirm the concept now shows your `origin=user` questions and `bankReviewed: true`. Then GET the worklist **without** `includeReviewed` and confirm the concept has dropped off it.

## Parallelize where possible

- Batch all of a concept's video IDs into a **single** `fetch-transcript.py` call rather than one per video.
- The transcript fetch and the `WebFetch`/generated-lesson reads for one concept have no ordering dependency — fire them together.
- The DELETE calls for a concept's old questions are independent — issue them together. ⚠️ The shell here is **zsh**, which does **not** word-split unquoted variables: `for id in $IDS; do curl …; done` runs **once** with every ID mashed into one bad URL (it silently deletes nothing). Iterate over an explicit list (`for id in cmA cmB cmC; do …`), or force splitting with `${=IDS}`. Always re-GET and confirm the agent questions are actually gone before marking reviewed.

## Report

Output **only** the final table — do not narrate per-resource reasoning as you go. One row per concept processed:

| Concept | Resources read | Added | Removed | Reviewed |
|---|---|---|---|---|

`Resources read` = count of resources actually read (note any transcript `FAIL` fallbacks). `Added` / `Removed` = question counts. `Reviewed` = ✓ / skipped (on-ramp) / blocked (precondition). After the table, add a one-line tally and flag any concept where resources were too thin to ground a full bank.
