---
name: split-path
description: Split one over-broad Path into several course-sized Paths from an operator's proposal - inspect what the parent holds and what it strands, draft child topics WITH the user, judge each against the five clauses of path-standard.md, then build the children and retire the parent. Rare, deliberate, and manual by design. Takes a topic slug.
argument-hint: <topic-slug>
disable-model-invocation: true
allowed-tools: Bash(npx tsx *), Read, Edit
---

# Split an over-broad Path

A Path whose topic is a whole field cannot teach what its name promises: the spine budget
does not widen for a wider topic, so the map covers a fraction of the subject and every
resource it cannot hold sits in the shelf attached to nothing. `path-standard.md` is the
standard this repairs against; **read it before judging anything here.**

This is deliberately **manual and rare**. Splitting is a library-shaping decision, made a
handful of times while the initial Paths settle, on evidence a human has looked at. An
earlier design gated it automatically on spine size; calibration killed that — unconstrained
spine size does not separate a field from a course (`precalculus` authors 32 concepts,
`computer-science` 24), so the count that would have driven it carries no signal. **The
judgment is yours. The script only checks what a script can honestly check.**

Topic to split this run: **$ARGUMENTS**

## Preconditions (check first, stop if unmet)

- `.env.local` DB env. The helper connects directly — no dev server, no admin API.
- **Point it at the database that holds the Path.** Production Paths live on Supabase;
  `.env.local` stays pointed at local Docker, so every command below goes through the
  `run-against-prod.ts` launcher.
- **Compose workers stopped** before any `--apply`: `docker compose --profile workers stop worker`.
  They poll the same DB and can claim a build mid-split. Restart after with
  `docker compose --profile workers up -d --build` (without `--build` compose reuses a stale image).
- A parent with **Tracks or question banks** needs `--force`, and you should stop and ask the
  user first: those are destroyed, and Tracks take learner `Progress` with them.

## The helper

```bash
npx tsx --env-file=.env.local scripts/run-against-prod.ts .claude/skills/split-path/scripts/split-path.ts inspect <topic>
```

Drop the `run-against-prod.ts` launcher to work against the local Docker DB instead. Use the
launcher rather than a `DATABASE_URL="$SUPABASE_POOLER_URL"` prefix: it reads the pooler URL
**inside** the process, so the secret never becomes a shell word (`AGENTS.md`, Secrets).

- `inspect <topic>` — the parent's concepts, its shelf, its orphan share, and everything a
  split does not carry over. Read-only. **Always start here.**
- `check <proposal.json>` — slug hygiene, the clause checks a script can make, the
  `TOPIC_RELATIONS` edges you still owe, and each child's shelf reach. Read-only, exits 1 on
  an error.
- `apply <proposal.json> [--apply] [--target-host=<h>]` — builds each child with the real
  `ensurePathMap`, then disposes of the parent. Dry run unless `--apply`; re-runs `check`
  first and refuses while an error stands. Writes a `docs/audits/split-path-*.json` record.

## The workflow

**1. Inspect, and read the orphans.** The unheld material *is* the evidence: a coherent run
of lectures nothing in the map can hold names the child Path that should exist. Report the
orphan share and the clusters you see to the user before proposing anything.

**2. Draft the children WITH the user.** Propose a partition and let them shape it. Do not
apply a split the user has not agreed to, and do not invent children the orphans do not
support — a child with no material behind it is a spine hole factory.

**3. Judge every proposed child against all five clauses.** Write the verdict out per child;
this is the part the script cannot do.

| Clause | How to judge a proposed child |
| --- | --- |
| **Coverable** | Name its backbone out loud. If you cannot finish the list, or every item is itself a subject, it is still a field — split further. |
| **Course-altitude** | *Upward*: no concept in its backbone should itself deserve a Path. *Downward*: it is not a single teachable idea. `check` warns when the slug is already a concept in another map — that is the signal, not the verdict. |
| **Distinct** | Read the spines of the neighbouring Paths (`inspect` them). If an existing Path already teaches most of this backbone, it is a frontier extension of that Path, not a new one. |
| **Floored** | State the entry level in the child's `rationale`. If you cannot say who it is for, the on-ramp has nothing to aim at. |
| **Terminal** | Finish the sentence "a learner who completes this can now ___". If nothing fits, the name overpromises. |

Then check the partition as a whole: **does every cluster of stranded material have a home?**
A split that leaves the same orphans stranded has moved the problem, not fixed it.

**4. Write the proposal.**

```json
{
  "parent": "machine-learning",
  "parentDisposition": "retire",
  "children": [
    { "topic": "neural-networks", "subject": "cs", "rationale": "…who it is for, and what they can do after", "relations": ["machine-learning"] }
  ]
}
```

`parentDisposition`: `retire` deletes the parent Path — **its shelf of Resources is
untouched** — or `keep` leaves it standing, for a split that only carves siblings off a topic
that is still course-sized itself.

**5. Declare the widening edges before applying.** `relations` are how a child reaches the
parent's shelf without refiling a single row, and `TOPIC_RELATIONS` is a **code constant**
(`src/types/resource.ts`) — the script cannot write it and `check` refuses until it is there.
Direction matters: `child: [parent]` lets the child draw on the parent, and says nothing
about the reverse.

- **Each child needs `child: [parent]`.** This is the load-bearing edge. Without it a child
  whose own shelf is empty sees *nothing* and every concept becomes a spine hole.
- **Do not add `parent: [child]`** when the parent is retired — there is no Path left to
  serve, and the edge only widens what other topics reach through it.
- **Sibling edges only where a real prerequisite exists**, each justified on its own.
- **Check who already points AT the parent** before retiring it — `grep` the constant for the
  parent slug. Retiring the *Path* does not break those edges, because they reference a
  **shelf** and the shelf survives deletion. But they become the reason step 8 cannot be
  skipped: once material moves to the children, an edge still aimed at the parent's shelf
  goes hollow. (`python-data-ml: ['python', 'machine-learning']` is a live example — 13 of
  its attachments come off the ML shelf today.)

**Measuring an edge runs backwards from what you would expect.** That file's header demands
measured justification, and the instrument is `verify-topic-narrowing.ts` — which diffs a
live per-concept re-search, so it can only measure a topic that **already has a Path**. A
child's edge therefore cannot be measured before the child is built. The workable order is:

```bash
npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/verify-topic-narrowing.ts --topic=<child> --drop=<parent>
```

declare the edge → build the child → probe **removing** it. A `LOST-ATTACHED` or `EMPTIED`
line is the proof the edge carries weight. For an edge on a Path that already exists (a
neighbour that should now reach a child), `--extra=<child>` asks the same question the other
way round without editing the constant first.

**6. Dry run, then apply.** `apply` without `--apply` prints the order of operations. A
remote apply also needs `--target-host=<hostname>`. Children are built before the parent is
retired, so a failure mid-way leaves the old map standing.

**7. Report what landed.** Each child's status and spine holes. **Holes are not a failed
split** — they are remediation's job, and a fresh narrow Path drawing on a shelf that was
filed for the parent will usually have some. Say so plainly rather than treating it as
breakage.

**8. Say out loud that the split is only half done.** The Paths are built; the *library* has
not moved. Every resource still carries its parent-topic filing, and the children reach it
only through the relations edge. That leaves each child at the bottom of the cold-start
ladder — see the trap below — so the follow-up is a **cohort refile** through
`/review-topic-filing`, which is the only pass that moves a primary. Hand the user that as
the next action; do not attempt it here.

## Traps

- **Children are authored fresh, not moved.** The parent's concepts were authored *for the
  parent topic* — carrying them over preserves the defect. What that costs is real and
  `inspect` prints it: judged attachments are recomputed at LLM cost, and question banks and
  Tracks are destroyed.
- **The shelf is never refiled by this skill.** Deleting a Path does not touch `Resource` or
  `ResourceTopic`. Resources keep their parent-topic filing and children reach them through
  the relations edge. Refiling is a separate, gradual job — `/review-topic-filing` owns it.
- **`check` warnings are prompts to look, not verdicts.** A legitimate course can share its
  name with someone else's concept. Corroborate before acting on one.
- **A minted topic is just a string, and a child starts at the bottom of a ladder.** Being in
  the registry buys nothing on its own: a shelf forms only when something files to the topic,
  a centroid needs ≥ `MIN_CENTROID_MEMBERS` (20) to be usable by the filing guardrail, and
  k-NN cannot vouch for a shelf below `MIN_VOUCHABLE_POOL`. That is a documented deadlock —
  a shelf that is never vouched for never fills — and its only exit is a cohort move big
  enough to clear the bar in one go, never a lower bar. A child Path can therefore build fine
  while its own shelf stays empty and new discovery keeps filing to the *parent*. Relations
  fix retrieval; only a refile fixes filing.
- **Do not promote a child into `TOPIC_SLUGS`.** That list has its own quorum guardrail;
  `reinforcement-learning` was deliberately left unpromoted at 3 rows for exactly this
  reason. The script registers the child in the alias registry, which is all a Path needs.
- **Deletion is the only retirement there is.** `PathStatus` has no `archived` state, so
  there is nowhere to retire a Path *to* without a migration — which is why the `--force`
  gate on Tracks and question banks matters. `retire-cfml-shelf.ts` hit this and left its
  Path standing rather than destroy 12 delivered Lessons.
