---
name: merge-stacked-prs
description: Merge a stacked PR chain (each branch based on the previous) into main, bottom-up, one PR at a time. Use whenever merging any PR whose base branch is not main, or a chain of block PRs. The ordering prevents two permanent GitHub failure modes.
argument-hint: [PR numbers bottom-up, e.g. 259 260 261]
---

# Merge a stacked PR chain into `main`

When a chain of PRs is stacked (each branch off the previous), merge **bottom-up, one block at a time**, and only ever retarget the _immediate next_ PR — never the whole chain at once.

Before starting, confirm the chain order: `gh pr list --json number,headRefName,baseRefName` and walk the base→head links. The bottom PR is the one whose base is `main`.

For each PR, from the base of the stack upward:

1. Merge it into `main` (`gh pr merge <n> --merge`), but **do not pass `--delete-branch` yet**.
2. Retarget the immediate child (the PR based on this branch) to `main`: `gh pr edit <child> --base main`. Do this **while this branch still exists**.
3. Only now delete the just-merged branch: `git push origin --delete <branch>`.

Repeat until the top of the stack is merged. Then `git checkout main && git pull` and delete local branches.

## Why this exact ordering (both failure modes bit us on the 2.5f stack, #85–#94)

- **Never blanket-retarget the whole chain to `main` up front.** A PR retargeted _before its parent merges_ has its merge-base set to bare `main`, so its diff and commit list inflate to include every ancestor block's work. This is **permanent**: a merged PR's base branch is immutable, so the bloated "Files changed" / "Commits" record can't be fixed afterward. (`main`'s own history stays correct — only the PR record is wrong.)
- **Never `--delete-branch` a parent while a child PR still targets it.** Deleting a branch that is the base of an open PR _closes_ that PR instead of retargeting it, and a closed PR whose base branch is gone can't be reopened without recreating the branch. Retarget the child to `main` (step 2) before deleting (step 3).
