---
name: review-topic-filing
description: Drain the contested-membership review queue - pull contested ResourceTopic rows grouped by container, judge each against a FILING rubric (is this row's topic right, and does it also belong elsewhere?), then execute confirm/refile/add verdicts via a verdict file. Writes memberships only, never Resource.status. Takes a count, topic, or container id. Returns a decision table.
argument-hint: [count | --topic <slug>]
disable-model-invocation: true
allowed-tools: Bash(npx tsx *), mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__select_browser, mcp__Claude_in_Chrome__tabs_context_mcp, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__browser_batch, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__read_page
---

# Drain the contested-membership review queue

A resource's topic membership is marked `contested` when the filing evidence disagreed with
its label — the T4a reclassifier's proposal differed from the current topic, or a k-NN
guardrail could not vouch for the shelf. Nothing in the pipeline resolves those: the
reclassifier **never refiles**, so a disagreement becomes a contested secondary, which
retrieval excludes by design. The queue only grows. This skill works it **as the operator**:
pull a batch grouped by container, judge each against the rubric below, and **execute** the
verdicts. It is the human/POC stand-in for the autonomous curation agent.

Batch to work this run: **$ARGUMENTS** (a group count, or `--topic <slug>`; default 5 groups).

> ⚠️ **This is the FILING axis, not the quality axis.** `/review-pending-resources` grades
> whether a page is good and writes `Resource.status`. This grades whether it is on the right
> shelf and writes `ResourceTopic`. **Never touch `Resource.status` here** — these rows
> already passed human quality review (113 of 131 are `active`) and some are attached to live
> Paths. The helper has no code path to it; keep it that way.

## Preconditions (check first, stop if unmet)

- `.env.local` DB env (the helper connects directly — no dev server, no `DEV_AUTH`).
- **Compose workers stopped** before any `--apply` run: `docker compose --profile workers stop worker`.
  They poll the same DB and can write memberships mid-pass. Restart after:
  `docker compose --profile workers up -d`.
- A connected Chrome is needed **only** for rows whose stored metadata is genuinely
  uninformative (see the rubric's escape hatch). Don't demand it up front; if a row needs it
  and no browser is connected, `skip` that row and flag it.

## The helper

`npx tsx --env-file=.env.local .claude/skills/review-topic-filing/scripts/topic-review.ts <cmd>`

- `queue [n] [--topic <slug>] [--kind primary|secondary|all]` — the queue, grouped by root
  container, ordered by review priority. `n` limits **groups**, not rows: a container is one
  decision. Read-only.
- `apply <verdicts.json> [--apply]` — dry run by default; `--apply` executes. It refuses
  outright while any error stands, and writes a `docs/audits/review-drain-*.json` record.

## Rubric — ONE question, asked of the evidence in this order

**"Is this row's contested topic right, and does it also belong elsewhere?"**

1. **Provenance first.** The container's title and topic, the `siblingFilings` histogram
   (how the container's *uncontested* children are filed), the source, and the row's own
   `conceptsTaught`. A Khan "Vectors and spaces" unit whose 27 uncontested siblings are all
   `linear-algebra` **is** linear algebra, whatever the embedding says.
2. **Then the embedding.** `neighbourhood` (the k=10 label histogram), `purityForHeldTopic`,
   `plurality`, and `margin` / `nearestRival`.
3. **`rivalMemberships`** — a topic the row already holds is a recorded hypothesis, usually
   T4a's proposal when it disagreed. It is the refile candidate. **59 of 131 contested
   primaries have none at all**, meaning the instrument doubted the row without naming an
   alternative — weak evidence for moving it, decent evidence for confirming it.

### ⚠️ When to distrust the neighbourhood

**k-NN is circular on exactly the cases that most need review.** A shelf that starts wrong
and grows big becomes its own neighbourhood and vouches for itself — measured on the retired
`calculus-for-machine-learning` shelf, whose rows named cfml as their own plurality purely
because they were each other's nearest neighbours.

Concretely, discount the neighbourhood when:

- **the container's own children dominate it** — the "evidence" is the siblings you are
  already looking at, restated;
- **the shelf is thin** (`margin: null` means it is under `MIN_CENTROID_MEMBERS`), so a
  correct row simply cannot hold a plurality against a big adjacent shelf;
- **plurality and provenance disagree and provenance is specific** — a named course unit
  beats a diffuse vector average.

Conversely, trust it when the neighbourhood is drawn from *outside* the container and agrees
with a rival membership: that is independent corroboration.

### Decision mapping

| Verdict | When | Effect |
|---|---|---|
| **confirm** | The held topic is right. The doubt was instrument noise — typically a thin shelf, or a container whose siblings corroborate. | Clears `contested`, keeps the measured relevance. Nothing moves. |
| **refile** | The row genuinely belongs on a different shelf, and provenance supports it (not just the neighbourhood). | `setPrimaryTopic(..., origin: 'review')` — the **only** sanctioned refiling path. The vacated topic is retained as an *uncontested secondary* by default; add `"dropVacated": true` only when that topic was never a real place for this row. |
| **add** | The held topic is right **and** the row squarely belongs on a second shelf too. | Writes an uncontested secondary (`origin: review`). This is the mechanism that makes cross-topic material retrievable — the gap the whole plan is missing. Capped at 3 memberships per resource. |
| **skip** | Genuinely unsure, or the metadata is too thin to judge and no browser is available. | No write. **Doubt is preserved** — the row stays queued. Do not guess. |

A **contested secondary** (`kind: "contested-secondary"`) is a different bug: it is invisible
to retrieval entirely, so it is a *reachability* problem rather than a labelling doubt.
`confirm` makes it retrievable; `refile` onto its own topic promotes it to primary.

## Steps

1. **Pull the batch.** `... topic-review.ts queue $ARGUMENTS`.

2. **Judge each group.** A group is a container plus its contested rows. Prefer a
   **container-level verdict** — one judgement settled 67 rows in the cfml triage, and a
   drain that only ever asks about single rows re-litigates structure a glance at the parent
   resolves. A container verdict **must** name `applyTo`, the held topic it acts on; it never
   covers a mixed subtree wholesale (`Khan Academy: Cryptography` holds contested
   `cryptography`, `data-structures-algorithms` *and* `discrete-mathematics` rows, and a
   blanket verdict would refile rows nobody looked at). Give a mixed container one verdict
   per held topic.

   A group whose `container.isContainer` is false is a loose top-level row — decide it
   row-by-row on `membershipId`.

3. **Write the verdict file** (`/tmp/verdicts.json`):
   ```json
   { "verdicts": [
     { "verdict": "confirm", "containerId": "<id>", "applyTo": "linear-algebra", "note": "Khan LA unit; 27 uncontested siblings agree" },
     { "verdict": "refile",  "containerId": "<id>", "applyTo": "precalculus", "topic": "linear-algebra", "note": "45/49 subtree already linear-algebra" },
     { "verdict": "add",     "membershipId": "<id>", "topic": "statistics" },
     { "verdict": "skip",    "membershipId": "<id>", "note": "title uninformative, no browser" }
   ] }
   ```

4. **Dry-run, read it, then apply.**
   ```sh
   H="npx tsx --env-file=.env.local .claude/skills/review-topic-filing/scripts/topic-review.ts"
   $H apply /tmp/verdicts.json            # dry run — prints every write + relevanceToWrite + vacated
   $H apply /tmp/verdicts.json --apply    # executes, asserts invariants, writes docs/audits/
   ```
   Check the dry run's `errors` is empty (it refuses to apply otherwise), that each
   `relevanceToWrite` is the measured purity you expect, and that every `vacated` line says
   what you intended. `unresolvedCount` is the rest of the queue — expected, not a failure.

## Report

Output **only** the final table — do not narrate per row as you go. One row per *decision*
(a container verdict is one row, not one per resource):

| Target | Rows | Held → Target | Verdict | Reasoning |
|---|---|---|---|---|

Keep `Reasoning` to one line, and **name the evidence that decided it** — provenance or
neighbourhood — since which one you trusted is the reviewable part. After the table: a
one-line tally (confirmed / refiled / added / skipped), the queue size before and after, and
any borderline calls worth a human's second look.
