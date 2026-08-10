---
name: plan-feature
description: Run a planning conversation for one feature and write docs/plans/<feature>.md — diagnosis, locked decisions, verified codebase facts, and block briefs with acceptance criteria in the exact shape /orchestrate-feature consumes. Use at the start of a feature, before any code is written.
argument-hint: [feature-slug or a sentence describing the feature]
disable-model-invocation: true
---

# Plan one feature

You are running the planning conversation for one feature. Its only output is a written
plan doc at `docs/plans/<slug>.md`. **You write no feature code in this conversation** —
not a scaffold, not a stub, not "just the schema". Implementation is `/orchestrate-feature`'s
job, in a different conversation, from the doc you produce.

The doc has two halves, and they are for different readers:

- **Prose sections** — for the user now and for whoever asks "why is it like this" in six
  months. Argue. This is where the real thinking goes.
- **Block briefs** — a machine contract consumed by `block-implementer` and
  `block-verifier`. Rigid, uniform, every field present.

Between them is a hard gate: **you may not write a single block brief until the codebase
facts section is filled from files you actually read.**

## Phase 1 — the prose

Work through these with the user. Ask; don't assume. Write them into the doc in this
order.

**Status header** — directly under the H1, exactly this shape:

```
**Status:** active · **Blocks:** <ids>; no PRs yet · **Block IDs:** `X` · **Started:** YYYY-MM-DD
```

**Diagnosis** — what is wrong or missing, in the present tense, with evidence. Not "we
should add X" but "X does not exist, and here is what breaks because of it". Measured
numbers beat adjectives: row counts, failure rates, the actual query plan. If the feature
is additive rather than a fix, this section is the design insight instead — the one
non-obvious thing the whole feature turns on.

**Locked decisions (this plan)** — a table of choices settled here, so implementers do not
relitigate them. Each row: the decision, and one clause of why. Include the ones you
*rejected*, in a **Rejected alternatives** section, with the reason — this is the section
that saves the most time later, and only one existing plan has it.

**Codebase facts (verified `<today's date>`)** — the gate. See below.

**Sequencing** — block order, what stacks on what, where the dependencies are.

**Explicitly deferred** — what a reasonable reader will expect to be in here and is not.

**Open questions for you** — anything you could not settle. Mark each one `OPEN` inline
where it bites, so an implementer hitting it knows to stop rather than choose.

### The codebase-facts gate

Every claim a block brief rests on must appear here as a **verified** fact, with the file
path and line number you read it at, or the query you ran and the number it returned.

```
- `searchResources` filters on `Resource.topic` scalar, not `ResourceTopic`
  (`src/lib/curation/search.ts:88`).
- 1,926 rows have `filedBy: 'inherited'` (dev DB, counted 2026-08-10).
```

Anything you believe but did not check gets written as `NEEDS VERIFICATION: <claim>` and
is raised to the user before the doc is finished. **Do not write a confident sentence in
place of a check.** A block brief built on an imagined function signature costs an
implementer a full round trip and usually produces code that compiles against nothing.

Read `AGENTS.md`, `CLAUDE.md`, and the `.claude/rules/` files that match the paths this
feature touches, before writing this section — several facts you need are already recorded
there (the migration index hazard, the `.env` read ban, the `describeDb` split).

**Stop here and confirm with the user before continuing to phase 2.** The prose is the
part they can correct cheaply; block briefs written on a wrong premise are not.

## Phase 2 — the block briefs

Read [references/block-brief.md](references/block-brief.md) and follow it exactly. Every
block gets all nine fields, in that order, no exceptions and no extras.

Rules that decide whether a block is a block at all:

- **A block with no acceptance criteria is not a block.** Do not emit it. Criteria written
  now drive `block-verifier` honestly; criteria written after the code exists get bent to
  fit it. If you cannot state what would be observably true when the block is done, the
  block is not scoped yet — split it or ask.
- **A block that cannot list the files it owns is not scoped yet.** Same remedy.
- **≤300 LOC, with a stated `~N LOC` budget.** A block you estimate above that gets split
  before it is written down, not during implementation.
- **One migration per block, at most.** Migrations are the least reversible thing in the
  repo.
- **No code snippets, no per-block commit messages, no mandated test-first ordering.**
  Specify boundaries and assertions; the implementer reads neighboring code for idiom. A
  snippet written at planning time is stale by the block that follows it, and an
  implementer copying a stale snippet is worse than one reading the real file.

### Block IDs

Read the prefix registry in `docs/plans/README.md` and pick a letter nobody has claimed.
Three collisions already exist and are frozen; do not add a fourth. Add your prefix to
that table in the same change that creates the plan doc.

### Conventions check

Before you finish, re-read `AGENTS.md`, `CLAUDE.md`, and the matching `.claude/rules/`
files against your own block briefs, and confirm none of them quietly authorizes a
violation. A plan that says "add a `process.env.FOO` read in the service" will get built
that way and will survive review because the plan said so. Specifically confirm:

- zod at every route input and every LLM structured output; types from `z.infer<>`
- `process.env` only in leaf config modules
- Prisma via the `@/lib/db` singleton; raw SQL only where Prisma cannot express it
- no `any`, no `as`, no `!` to silence the checker
- new pure logic has a colocated unit test; DB tests use `describeDb`
- any migration block carries the `prisma-migrations.md` `DROP INDEX` warning
- new dependencies are named as needing the user's OK (JIT rule)
- docs are referenced by filename, not by path (CLAUDE.md § coding conventions) — this
  applies to the plan doc you are writing as much as to the code it describes

Record any deliberate deviation as a row in **Locked decisions** with its justification.
An unjustified deviation is a bug in the plan.

## Finishing

1. Write `docs/plans/<slug>.md`.
2. Add the plan to the **Active** table and your prefix to the registry in
   `docs/plans/README.md`.
3. Report to the user: block list with LOC budgets, open questions, new dependencies
   needing approval, and anything marked `NEEDS VERIFICATION` that is still unresolved.
4. **Do not commit.** The verification gate applies here too — the user reads the plan
   first. When they confirm, commit the doc and the README edit together.

Implementation starts separately: `/orchestrate-feature docs/plans/<slug>.md`.
