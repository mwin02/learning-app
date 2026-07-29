---
name: orchestrate-feature
description: Orchestrate block-by-block implementation of a planned feature. Takes a plan doc path; spawns a block-implementer subagent per block, verifies each block, and pauses at the manual verification gate before committing. Use after a planning conversation has produced docs/<feature>-plan.md.
argument-hint: [plan-doc-path]
disable-model-invocation: true
---

# Orchestrate a planned feature

You are the orchestrator for one feature. The planning conversation already happened; its output is the plan doc passed as the argument. Your job is to drive each block to done, keep your own context lean, and enforce the gates below. You do the git work; workers never touch git.

## Ground rules

- **The plan doc is the contract.** Read it fully first. If it's missing per-block briefs, block ordering, or branch structure, stop and ask the user before spawning anything.
- **One block at a time, in plan order.** Blocks are ≤300 LOC by design; if a worker reports the block is ballooning past that, pause and surface it rather than letting it sprawl.
- **Decisions**: settle small ambiguities yourself in the spirit of the plan and log them in a "Decisions made" list you report at each gate. Escalate to the user anything design-level: schema changes not in the plan, new dependencies (JIT rule — a new library needs the user's OK), scope changes, or anything the plan explicitly defers.
- **Context discipline**: workers report summaries, not diffs. Don't re-read their changed files wholesale; spot-check what verification flags.

## Per-block loop

1. **Branch.** Create the block's branch per the plan: off `main`, or off the previous block's branch when stacking. Do not use worktree isolation for stacked blocks — workers edit the main checkout.
2. **Spawn** a `block-implementer` subagent. The kickoff prompt must be self-contained: point it at the plan doc, name its block, list the files/areas it owns, restate any decisions made since planning, and tell it to read neighboring code (existing tests, sibling components) before writing.
3. **Verify mechanically** when it reports back: run `npm test` (plus `npm run test:int` when the block touches DB code — remind the user the docker workers must be stopped first), `npx tsc --noEmit`, and `npm run lint`. For UI blocks, check the change in the browser preview. Review the diff (`git diff --stat` then targeted reads) against the block's scope.
4. **Iterate with the same worker.** Send failures and review findings back to the worker via SendMessage — it retains full context; do not respawn or fix things yourself unless the worker is stuck after two rounds.
5. **Manual gate — always stop here.** When green, present to the user: what the block did, the decisions-made list, test results, and a short manual verification plan. **Do not commit, push, or open a PR until the user explicitly confirms.** This gate applies even if everything passed.
6. **Ship.** After confirmation: commit (no `Co-Authored-By: Claude` trailer), push, open the PR against the correct base branch (no `Generated with Claude Code` trailer), then move to the next block.

When all blocks are shipped, summarize the feature: PRs opened, decisions made, anything deferred. Merging the stack is a separate step — the user runs `/merge-stacked-prs` when ready.
