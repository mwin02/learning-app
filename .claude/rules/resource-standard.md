---
paths:
  - "src/lib/curation/**"
  - "src/lib/agents/decomposition/**"
  - "src/lib/agents/tools/**"
  - "src/app/api/playground/pending-resources/**"
---

# What belongs in the resource library

A locked design decision. This is the standard every admission decision is measured
against — by the ingestion pipeline, by review, and by anyone auditing what is already
filed. It says what a library resource **is**, and nothing about how any of that is
enforced.

One question decides it:

> **Can a learner open this resource, alone, with nothing else in front of them, and come
> away having learned the thing we claim it teaches?**

Everything below is that question made checkable.

## The six clauses

A resource belongs in the library only if all six hold.

| # | Clause | It fails when |
| --- | --- | --- |
| 1 | **Live** | the content is gone, removed, or replaced by an error or parking page |
| 2 | **Free** | a login, a signup, or a payment stands between the learner and the content |
| 3 | **Teaches in place** | it points at instruction instead of carrying it — navigation, front matter, an index, a link list, marketing |
| 4 | **Standalone** | it only makes sense to someone who has already worked through a specific sibling; it is step *n* of a chain |
| 5 | **Consumed, not performed** | its substance is work the learner does — exercises, challenges, a widget to operate — rather than content to read or watch |
| 6 | **Accurately described** | what we have recorded about it (title, form, level, concepts taught, duration) does not match what it actually is |

## Why "consumed, not performed" excludes practice

We build plans against a time budget, and a resource's duration is a promise about how long
the learner spends *receiving* content. A resource whose cost is doing problems has no such
number — that cost belongs to the learner, not to the resource, and it varies by an order of
magnitude between two learners working the same exercise.

This is not a claim that practice is unimportant. Practice is how anyone actually learns,
which is exactly why it is **authored against the curriculum we built**, as questions
attached to a concept, and not sourced as a resource. An exercise found in the wild is
practice we did not write, aimed at a syllabus we did not design, priced with a number we
cannot measure. Serving it as a lesson misrepresents all three.

Two consequences are locked:

- **Interactive resources are excluded as a class.** Not judged case by case. Where a
  resource is classified as interactive, that classification is the answer.
- **An exercise or challenge is never a resource**, however well made, however well it fits
  the topic, and whether or not it stands alone.

A resource that has been *classified* as interactive but that genuinely teaches in prose or
on video is not an exception to this — it is a misclassification, and the repair is to
correct its recorded form on the evidence of the content itself. Clause 6 already covers
that. Nothing here is a reason to keep an interactive resource as interactive.

## Why "standalone" is its own clause

A resource is placed into one position in one learner's plan. Nothing in the library records
that one resource depends on having completed another: ordering records position, not
dependency, and a learner arriving at a lesson has not read its neighbours.

So a resource that is a step in a sequence is excluded even when it teaches well *in
sequence*. It is not a defect in the content. It is a resource whose prerequisite we cannot
express, placed by a system that will not know to satisfy it.

## Resolving an ambiguous case

**The error budget is one-sided, and it does not point where instinct suggests.**

Excluding a real lesson removes it from every learner's retrieval, permanently and
invisibly. Admitting one bad resource costs one weak candidate among thousands, and it
remains visible to review, to reports, and to the next audit.

Therefore:

- **An ambiguous resource is admitted.** Doubt resolves toward inclusion. This is the
  design, not a gap in it.
- **A weak signal never decides alone.** Something that merely *resembles* a violation is
  grounds for a closer look, never for exclusion by itself; it must be corroborated by a
  second, independent signal before it counts as a failure.
- **Exclusion needs a clause.** Every removal names the clause it failed. "This feels like
  a poor resource" is not a finding under this standard — either it fails one of the six, or
  it belongs in the library.

The one thing this asymmetry does **not** license is keeping a resource that plainly fails a
clause because it looks useful. The clauses are the standard; usefulness is not a seventh.

## What this standard does not decide

- **How any of it is checked**, by whom, or at which point in a resource's life.
- **What happens to a resource that fails.** Exclusion is a verdict, not a procedure.
- **Whether the library has enough resources.** Coverage is a separate question and never a
  reason to relax a clause — a gap left by this standard is filled by finding a resource
  that meets it, or by authoring one.
