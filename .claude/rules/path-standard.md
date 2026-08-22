---
paths:
  - "src/lib/agents/map/**"
  - "src/lib/agents/topic-gate.ts"
  - "src/lib/agents/topic-registry.ts"
  - "src/lib/agents/program/**"
  - "scripts/seed-spine-maps.ts"
---

# What deserves a Path

A locked design decision, and the sibling of `resource-standard.md`. That one says what a
library resource **is**; this one says what a **topic** is — the unit a Path is built for,
named after, and judged against. It is the standard every path-creation decision is measured
against, by the code that admits a topic, by the map-builder, and by anyone auditing the
Paths that already exist. It says nothing about how any of that is enforced.

One question decides it:

> **Can a learner who completes this path's spine honestly claim competence in the thing the
> path is named after?**

Everything below is that question made checkable.

## The five clauses

A topic deserves a Path only if all five hold.

| # | Clause | It fails when |
| --- | --- | --- |
| 1 | **Coverable** | its required backbone does not fit the spine budget — a competent syllabus needs more concepts than a map may hold, so the map must omit things the name promises |
| 2 | **Course-altitude** | it is larger or smaller than one course: one of its own spine concepts would itself deserve a Path, or it is already a concept inside an existing Path |
| 3 | **Distinct** | a Path that already exists teaches most of this topic's backbone |
| 4 | **Floored** | the beginner it assumes is unstated, so no on-ramp can be authored at a known level |
| 5 | **Terminal** | a learner who finishes every concept still cannot do the thing the name promises |

## Why "coverable" is the load-bearing clause

*Too broad* is the instinct behind this standard, and on its own it is not checkable. Every
topic is broad relative to something, and a judge asked "is this too general?" answers
differently every time it is asked.

The spine budget makes it checkable. A spine holds a bounded number of concepts, and **that
bound does not widen for a wider topic** — so the same budget that comfortably covers a
course covers a field only by leaving most of it out. The budget is this standard's teeth,
and clause 1 is the mechanical form of the question: *estimate the backbone a competent
syllabus for this topic needs; if that estimate does not fit the budget, the topic is not a
Path.*

**A topic that fails clause 1 is split, not rejected.** It is not shrunk to fit and it is
not turned away: it becomes several course-altitude Paths, each standing on its own and each
answering the governing question for its own name. The oversized name survives as a way of
talking about the region those Paths cover — never as one Path wearing the name of a field.

## Altitude is a property of the topic, not of its phrasing

Admitting a topic asks two questions that are already familiar — is this a real learning
topic, and is it one we already have under another name? Neither is altitude. A topic can be
perfectly legitimate, perfectly unique, and still be the wrong **size**, and nothing about
its wording reveals which.

So clause 2 is checked in both directions:

- **Upward**: a topic whose own backbone concepts are each big enough to deserve a Path is a
  field, and belongs to clause 1.
- **Downward**: a topic that names a single teachable idea is not a small Path. It is a
  concept that escaped a map and took a pool of resources with it — and the repair is to
  file it back under the Path whose spine already contains it.

The downward direction is the easier one to miss, because a narrow topic looks like exactly
the caution this standard is asking for.

## Why distinctness is its own clause

A Path is a **singleton for its topic**, and it claims that topic's pool of resources —
retrieval reaches the library by exact topic. Two Paths whose spines overlap therefore split
one shelf between two maps, and each resource lands on whichever side its filing happened to
fall. Neither map is wrong on its face; both are quietly starved, and the split is invisible
from inside either one.

An overlapping proposal is not a new Path. It is a frontier extension of the Path that
already covers it, or — when it is genuinely course-sized and merely adjacent — a Path whose
scope must be narrowed until the overlap is gone.

## Resolving an ambiguous case

**The error budget inverts here, and the inversion is deliberate.**

`resource-standard.md` resolves doubt toward **inclusion**: excluding a real lesson removes
it from every learner's retrieval permanently and invisibly, while admitting a weak one
costs one candidate among thousands and stays visible to review.

A topic is not one candidate among thousands. A Path is a singleton, it is the artifact every
learner on that topic traverses, and its scope decides what an entire pool of resources gets
used for. An over-broad Path strands the material it cannot hold: resources filed correctly,
attached to nothing, because no node in the map was ever big enough — or small enough — to
take them. That loss is as invisible as the resource standard's, and it is not one row.

Therefore:

- **An ambiguous topic resolves toward the finer split.** Two narrow Paths cost one extra map
  to author. One over-broad Path costs every learner on it, and buries the resources that
  would have made the narrow Paths good.
- **A verdict against a topic is never a discard.** A topic that fails a clause is
  re-expressed — split, narrowed, or absorbed as frontier — never dropped. Its resources are
  usually already in the library, waiting for a map that can hold them.
- **Refusal names a clause.** Every one. "This feels too broad" is not a finding under this
  standard — either the topic fails one of the five, or it deserves a Path.

The one thing this asymmetry does **not** license is splitting a coherent course into pieces
because finer felt safer. A Path below course altitude fails clause 2 exactly as hard as a
field fails clause 1, and the clauses are the standard in both directions.

## What this standard does not decide

- **How any of it is checked**, by whom, or at which point in a topic's life.
- **What happens to a Path that already violates it.** A verdict is not a migration.
- **Whether the library can actually teach this topic.** Sourceability is deliberately not a
  clause. It is decided per concept, after a map exists, by the readiness gate — which knows
  exactly which concepts lack a qualifying primary, where an admission-time judgment could
  only guess at the topic as a whole. A gap it finds is repaired by remediation (source,
  relax, or escalate), never by re-judging the topic: a thin pool is a reason to source, and
  never a reason to widen a topic until it looks full.
