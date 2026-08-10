---
name: orchestrate-feature
description: Orchestrate block-by-block implementation of a planned feature. Takes a plan doc path; spawns a block-implementer subagent per block, then a block-verifier and block-reviewer, and pauses at the manual verification gate before committing. Use after a planning conversation has produced docs/plans/<feature>.md.
argument-hint: [plan-doc-path]
disable-model-invocation: true
---

# Orchestrate a planned feature

You are the orchestrator for one feature. The planning conversation already happened; its output is the plan doc passed as the argument. Your job is to drive each block to done, keep your own context lean, and enforce the gates below. You do the git work; subagents never touch git.

You direct three subagent types: `block-implementer` writes the code, `block-verifier` checks it behaves, `block-reviewer` reads it adversarially. The verifier and reviewer are strictly read-only — every fix, however small, routes back to the implementer. Do not verify, review, or fix code yourself; your context stays clean for coordination and judgment.

## Ground rules

- **The plan doc is the contract.** Read it fully first. If it's missing per-block briefs, block ordering, or branch structure, stop and ask the user before spawning anything. If a block brief has no **Acceptance criteria** section, draft criteria from the brief and get the user to confirm them *before* spawning the implementer — criteria written after the code exists get bent to fit it.
- **One block at a time, in plan order.** Blocks are ≤300 LOC by design; if a worker reports the block is ballooning past that, pause and surface it rather than letting it sprawl.
- **Decisions**: settle small ambiguities yourself in the spirit of the plan and log them in a "Decisions made" list you report at each gate. Escalate to the user anything design-level: schema changes not in the plan, new dependencies (JIT rule — a new library needs the user's OK), scope changes, or anything the plan explicitly defers.
- **Context discipline**: subagents report summaries, not diffs. Don't re-read changed files wholesale; the verifier and reviewer exist so raw test output, browser state, and diff reads never enter your context. Spot-check only what their reports flag.

## Per-block loop

1. **Branch.** Create the block's branch per the plan: off `main`, or off the previous block's branch when stacking. Do not use worktree isolation for stacked blocks — workers edit the main checkout.
2. **Spawn** a `block-implementer` subagent. The kickoff prompt must be self-contained: point it at the plan doc, name its block, list the files/areas it owns, restate any decisions made since planning, and tell it to read neighboring code (existing tests, sibling components) before writing.
3. **Spawn a `block-verifier`** (foreground — you need the verdict before continuing) when the implementer reports back. Its kickoff prompt must carry: the plan doc path and block number, the block's **Acceptance criteria** verbatim, the decisions made since planning, whether the block touches DB code (and whether the docker workers are stopped — ask the user, don't guess), how to reach authed routes in the dev app if the block needs it, and the block's base branch for the scope diff. Do not editorialize the criteria or hint at expected outcomes beyond them.
4. **Spawn a `block-reviewer` in `block` mode** in parallel with step 3 (background is fine). Give it the block brief, the base branch, and the decisions-made list plus the plan's deferrals — without those it will re-raise accepted trade-offs.
5. **Iterate through the implementer.** Send verifier failures and reviewer findings back to the same `block-implementer` via SendMessage — it retains full context. After fixes, SendMessage the same verifier to re-check (it holds the assertion list); respawn a fresh verifier instead if the rework was substantial. **Never fix code yourself, and never let the verifier or reviewer fix anything.** Cap this loop at two rounds; if still red, stop and present the open findings and assertion table to the user rather than grinding.
6. **Manual gate — always stop here.** When the verifier reports no failures and the reviewer reports no blocking findings, present to the user: what the block did, the decisions-made list, the assertion table (including anything `untested` and why), screenshot paths the verifier saved, review findings and how they were resolved, and a short manual verification plan. **Do not commit, push, or open a PR until the user explicitly confirms.** This gate applies even if everything passed.
7. **Ship.** After confirmation: commit (no `Co-Authored-By: Claude` trailer), push, open the PR against the correct base branch (no `Generated with Claude Code` trailer), then move to the next block.

## End of feature

When all blocks are shipped, spawn a `block-reviewer` in `stack` mode with the PR numbers in stack order. Present its findings to the user alongside the feature summary: PRs opened, decisions made, anything deferred. Cross-block findings are fixed as follow-up commits on the affected block's branch, through the same implement → verify loop, after user confirmation.

Merging the stack is a separate step — the user runs `/merge-stacked-prs` when ready, and `/code-review ultra` remains their final, user-triggered gate; do not attempt to launch it.

## Harvest and archive — after the stack is merged

The plan doc has one job left: give up whatever in it outlives the feature, then get out of the way. A shipped plan sitting in `docs/plans/` reads to the next agent exactly like a pending one.

1. **Harvest.** Go through the plan and move each durable fact to the tier that owns it — a hard invariant with blast radius to `AGENTS.md`, a file-type convention to `.claude/rules/`, an operational procedure to the matching runbook, a milestone to `docs/ROADMAP.md`. Everything else stays in the plan.
2. **Stamp the status header** with `shipped YYYY-MM-DD` and the PR numbers.
3. **`git mv docs/plans/<feature>.md docs/plans/archive/`**, and move its row from Active to Archive in `docs/plans/README.md`. Leave the prefix registry entry — the IDs are in shipped PR titles.
4. Propose all of it to the user as one commit; the verification gate applies here too.
