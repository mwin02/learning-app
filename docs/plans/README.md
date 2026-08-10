# Feature plans

One doc per feature, written before implementation by `/plan-feature`, consumed
block-by-block by `/orchestrate-feature`. `archive/` holds plans whose blocks have all
shipped — they explain code that exists, so they are kept, but nothing in `archive/` is a
to-do list.

**A plan doc is not a spec you maintain.** It records what was decided and why, at the
moment it was decided. Once a block ships, the code is authoritative; the plan stays as
the record of intent. Correcting an archived plan to match code that drifted is wasted
work — write a new plan instead.

## Active

| Plan | Status | Open blocks |
| --- | --- | --- |
| [free-beta.md](free-beta.md) | active | C2 — the warm-path campaign (ops, no code) |
| [library-quality.md](library-quality.md) | active, not started | P1–P7, B1–B6 |
| [tutor-agent.md](tutor-agent.md) | active, not started | T1–T4 |

## Archive

| Plan | Shipped | Blocks |
| --- | --- | --- |
| [archive/resource-reports.md](archive/resource-reports.md) | 2026-08-09 | R1–R8 (#310–#317), F1–F7 (#320–#326) |
| [archive/rung0-starvation.md](archive/rung0-starvation.md) | 2026-08-01 | R0–R3 (#295–#300) |
| [archive/topic-filing.md](archive/topic-filing.md) | 2026-07-29 | T1–T4e (#259–#281) |

## Block ID prefix registry

Block IDs are scoped to their plan, not globally unique — the table below is what
`/plan-feature` reads to avoid minting a prefix that already means something else. Three
collisions predate the registry and are left alone rather than renumbered, because the IDs
are in shipped PR titles and in source comments:

| Prefix | Claimed by | Note |
| --- | --- | --- |
| `A` `C` `D` `E` | free-beta | |
| `B` | free-beta (error reporting), library-quality (backfill) | collision, pre-registry |
| `F` | resource-reports (review-fix chain) | |
| `P` | library-quality (pipeline) | |
| `R` | resource-reports, rung0-starvation | collision, pre-registry |
| `T` | topic-filing, tutor-agent | collision, pre-registry |

New plans pick an unclaimed letter. `G`–`O`, `Q`, `S`, `U`–`Z` are free.

## Status header

Every plan carries one, directly under the H1, in this form:

```
**Status:** active | shipped YYYY-MM-DD | abandoned YYYY-MM-DD · **Blocks:** <ids and PRs>
· **Block IDs:** `X` · **Started:** YYYY-MM-DD
```

## Lifecycle

1. **Plan** — `/plan-feature` writes `docs/plans/<feature>.md`. Status `active`.
2. **Implement** — `/orchestrate-feature docs/plans/<feature>.md`.
3. **Merge** — `/merge-stacked-prs`.
4. **Harvest, then archive.** Before moving the doc, decide what outlives it and put each
   thing where it belongs. This is the step that keeps the plan library from becoming the
   place facts hide:
   - a hard invariant with blast radius → `AGENTS.md`
   - a convention that applies to a file type → `.claude/rules/`
   - an operational procedure → a runbook (`docs/app-deploy.md`, `docs/worker-deploy.md`,
     `docs/operator-tooling.md`)
   - a milestone → `docs/ROADMAP.md`
   - everything else stays in the plan and goes to `archive/` with `git mv`

**Abandoned plans that never produced code get deleted, not archived** — there is no code
for them to explain. `docs/track-budget-fill-plan.md` was deleted this way in `5e96658`.
