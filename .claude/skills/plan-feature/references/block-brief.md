# Block brief — the exact shape

Every block in every plan doc uses this template. Nine fields, this order, all present.
`none` is a valid value; omitting a field is not. The uniformity is the point: this is what
`block-implementer` is pointed at and what `block-verifier` builds its assertion list from,
and both do worse when they have to guess which sections a given plan happens to use.

```markdown
## X1 — <imperative one-line title> (~<N> LOC)

**Base branch:** `main`
**Files owned:**
- `src/lib/foo/bar.ts` (new)
- `src/app/api/foo/route.ts` (modify)
- `prisma/schema.prisma` (+ migration)

**What it does.** Two to five sentences, behavioral. What is true after this block that
was not true before. Name the seam it plugs into, not the code it writes.

**Out of scope.** What a reasonable implementer might pull in and must not. Point at the
block that does own it: "the UI for this lands in X3, not here."

**Migration:** none | <what it changes, and the hazard>
**New deps:** none | `<lib>` — needs the user's OK before install (JIT rule)

**Tests.** Which files, and which kind. `src/lib/foo/bar.test.ts` (unit, pure) /
`src/lib/foo/bar.int.test.ts` (`describeDb`).

**Acceptance criteria.**
- [ ] <observable assertion>
- [ ] <observable assertion>
```

## Field notes

**`## X1 — title (~N LOC)`** — `X` is the plan's registered prefix (`docs/plans/README.md`).
The LOC budget is required and is a ceiling, not an estimate to be exceeded quietly: a
block heading past it is a signal for the implementer to stop and report.

**Base branch** — `main` for the first block, the previous block's branch when stacking.
The orchestrator creates branches from this field; getting it wrong produces a PR chain
that `/merge-stacked-prs` cannot order.

**Files owned** — the scope check runs against this list. `git diff --stat` showing a file
that is not here is a finding, so a deliberately-touched shared file must be listed even if
the change is one line.

**Migration** — if non-`none`, copy the warning verbatim:

> Before `prisma migrate dev`, read `.claude/rules/prisma-migrations.md` — the generated
> `migration.sql` will propose dropping two hand-written indexes. Dropping either is always
> wrong.

## Acceptance criteria — the part that is usually done badly

A criterion is a statement someone else can check without reading the diff, and that can
come out false.

| Not a criterion | Criterion |
| --- | --- |
| "The schema is correct" | "`ResourceTopic` has a unique index on `(resourceId, topicId)`; inserting a duplicate pair raises `P2002`" |
| "Reports work end to end" | "POST `/api/resources/:id/report` without a session cookie returns 401; with one, returns 201 and a row appears in `ResourceReport`" |
| "Tests pass" | *(delete — `npm run verify` is run on every block regardless; it is not a criterion)* |
| "The dialog looks right" | "Clicking a category chip marks it selected and enables Submit; Submit is disabled with none selected" |
| "Handles errors gracefully" | "A 500 from the upstream fetch leaves the report `pending` and emits one `logError` line; no partial row is written" |

Rules of thumb:

- **Name the observable**: an HTTP status, a DB row, rendered text, a log line, a returned
  value. Not an internal design property.
- **Write the negative case.** Most criteria that pass trivially are missing the "and
  without X it does not" half.
- **Include the ones you expect to be `untested`.** A criterion needing production data or
  a live third party is still worth writing — the verifier marks it `untested` and says
  why, which is honest. Silence about it is not.
- **Three to eight per block.** Fewer means the block is under-specified; more usually
  means it should be two blocks.
