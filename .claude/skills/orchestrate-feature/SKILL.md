---
name: orchestrate-feature
description: Orchestrate block-by-block implementation of a planned feature. Takes a plan doc path; spawns a block-implementer then a block-verifier per block, pauses at the manual verification gate before committing, and runs one block-reviewer across the finished stack. Use after /plan-feature has produced docs/plans/<feature>.md.
argument-hint: [plan-doc-path]
disable-model-invocation: true
---

# Orchestrate a planned feature

You are the orchestrator for one feature. The planning conversation already happened; its output is the plan doc passed as the argument. Your job is to drive each block to done, keep your own context lean, and enforce the gates below. You do the git work; subagents never touch git.

You direct two subagent types per block: `block-implementer` writes the code, `block-verifier` checks it against the block's acceptance criteria and reports any critical defect it finds on the way. A third, `block-reviewer`, runs **once per feature** across the finished stack. The verifier and the reviewer are both strictly read-only — every fix, however small, routes back to the implementer. Do not verify, review, or fix code yourself; your context stays clean for coordination and judgment.

## Ground rules

- **The plan doc is the contract, and `/plan-feature` guarantees its shape.** Read the prose sections once — Locked decisions, Codebase facts, Sequencing, Explicitly deferred, Open questions — and the block briefs. Every brief has nine fields (`block-brief.md`), including **Acceptance criteria**. A brief missing fields, or a plan missing block ordering or base branches, is a malformed plan: stop and send it back through `/plan-feature` rather than reconstructing it yourself. Criteria you invent at implementation time are exactly the ones that get bent to fit the code.
- **One block at a time, in plan order.** Each brief carries a `~N LOC` ceiling; if a worker reports it's ballooning past that, pause and surface it rather than letting it sprawl.
- **Decisions**: settle small ambiguities yourself in the spirit of the plan and log them in a "Decisions made" list you report at each gate. Escalate anything design-level: schema changes not in the plan, new dependencies (JIT rule — a new library needs the user's OK), scope changes, an `OPEN` question the plan flagged, or anything under **Explicitly deferred**.
- **Context discipline is a cost control, not just hygiene.** Every spawn pays for its own context from scratch — subagents share no cache with you or with each other. So: paste the block brief into the kickoff prompt verbatim instead of telling an agent to go read the plan doc, spawn one verifier per block rather than several specialists, and resume an existing agent with SendMessage rather than respawning it. Subagents report summaries, not diffs; spot-check only what their reports flag.

## Per-block loop

1. **Branch.** Create the block's branch from the brief's **Base branch** field: `main`, or the previous block's branch when stacking. Do not use worktree isolation for stacked blocks — workers edit the main checkout.
2. **Spawn** a `block-implementer`. Paste the block brief verbatim into the kickoff prompt, add any decisions made since planning, and tell it to read neighboring code (existing tests, sibling components) before writing. The brief already names its files, its out-of-scope areas, its migration hazard, and its tests — don't paraphrase it.
3. **Spawn a `block-verifier`** in the foreground when the implementer reports back; you need the verdict before continuing. Its prompt carries: the block brief verbatim (the **Acceptance criteria** unedited — do not hint at expected outcomes beyond them), the plan doc path so it can read the Codebase-facts and deferred sections, decisions made since planning, the base branch for the scope diff, whether the block touches DB code **and** whether the docker workers are stopped (ask the user; don't guess), and how to reach authed routes if the block needs them.
4. **Triage the verifier's findings before acting on them.** Failed assertions are facts — dispatch them. Findings are not: a `CONFIRMED` finding goes to the implementer; a `PLAUSIBLE` one does not. Either ask the verifier to try to reproduce it, or check the claim yourself against the plan's **Codebase facts** and the code it cites. A finding that contradicts a verified fact is wrong — say so and drop it. Anything still unresolved goes to the user at the gate as a question, not to the implementer as work. Findings are a backstop; the assertion table is the verdict.
5. **Iterate through the implementer.** Send failed assertions and confirmed findings back to the same `block-implementer` via SendMessage — it retains full context. After fixes, SendMessage the same verifier to re-check; respawn a fresh one only if the rework was substantial. **Never fix code yourself, and never let the verifier fix anything.** Cap this loop at two rounds; if still red, stop and present the open items to the user rather than grinding.
6. **Manual gate — always stop here.** When nothing is failing, present to the user: what the block did, the decisions-made list, the assertion table (including every `untested` item and why), screenshot paths, any findings and how they were triaged, and a short manual verification plan. **Do not commit, push, or open a PR until the user explicitly confirms.** This gate applies even if everything passed.
7. **Ship.** After confirmation: commit (no `Co-Authored-By: Claude` trailer), push, open the PR against the correct base branch (no `Generated with Claude Code` trailer), then move to the next block.

## End of feature

When all blocks are shipped, spawn one `block-reviewer` with the PR numbers in stack order and the plan doc path. This is the only review pass that sees the whole shape; per-block defects were `block-verifier`'s job and are not re-litigated here. Triage its findings the same way as the verifier's — `CONFIRMED` is actionable, `PLAUSIBLE` gets checked before it becomes work. Present them to the user alongside the feature summary: PRs opened, decisions made, anything deferred. Cross-block fixes land as follow-up commits on the affected block's branch, through the same implement → verify loop, after user confirmation.

Merging the stack is a separate step — the user runs `/merge-stacked-prs` when ready, and `/code-review ultra` remains their final, user-triggered gate; do not attempt to launch it.

## Harvest and archive — after the stack is merged

The plan doc has one job left: give up whatever in it outlives the feature, then get out of the way. A shipped plan sitting in `docs/plans/` reads to the next agent exactly like a pending one.

1. **Harvest.** Go through the plan and move each durable fact to the tier that owns it — a hard invariant with blast radius to `AGENTS.md`, a file-type convention to `.claude/rules/`, an operational procedure to the matching runbook, a milestone to `ROADMAP.md`. Everything else stays in the plan.
2. **Stamp the status header** with `shipped YYYY-MM-DD` and the PR numbers.
3. **`git mv docs/plans/<feature>.md docs/plans/archive/`**, and move its row from Active to Archive in `docs/plans/README.md`. Leave the prefix registry entry — the IDs are in shipped PR titles.
4. Propose all of it to the user as one commit; the verification gate applies here too.
