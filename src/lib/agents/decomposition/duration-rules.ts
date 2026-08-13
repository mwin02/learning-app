// Library-quality Q2 — the write-path rules for `durationMin` / `durationSource`.
//
// Pure, so the accept/reject table is unit-testable without a database. Two rules:
//
//   checkDuration      — plausibility gate at upsert. A number that contradicts the
//                        shape of the thing it describes is not a measurement, it is
//                        a placeholder that survived. The audit found a book at
//                        exactly 6000 (the schema max — a clamp artifact) and 33 of
//                        50 books at 20 minutes.
//   containerDuration  — a decomposed container's duration is its children's, not an
//                        independent guess about an index page. 22 containers claimed
//                        less than half their children's sum (`2-first-order-de-s`:
//                        5m parent, 555m of children).
//
// Rejecting here means "discard the number", never "discard the resource": the
// caller writes null + `unknown` and logs it. Dropping a real resource over an
// implausible minute count would trade one silent inaccuracy for a worse one.

import type { DurationSource } from '@prisma/client';
import { MAX_ATTACHABLE_DURATION_MIN } from '@/lib/config';

// Below this, a whole book or a multi-lesson course is claiming to be a single
// sitting — which no such artifact is. Deliberately far under any real value so it
// only ever catches placeholders, not a short-but-genuine work.
export const MIN_MULTI_UNIT_DURATION_MIN = 30;

export type DurationClaim = {
  type: string;
  durationMin: number | null;
  // 'decomposed' + a child count is what makes a `course` multi-unit. An atomic
  // course is a single sitting of course material and is judged as a leaf.
  decompositionStatus?: string;
  childCount?: number;
};

export type DurationVerdict = { ok: true } | { ok: false; reason: string };

// A "multi-unit" work: something that is by construction longer than one sitting —
// any book, or a course that was actually exploded into units.
function isMultiUnit(claim: DurationClaim): boolean {
  if (claim.type === 'book') return true;
  return claim.type === 'course' && (claim.childCount ?? 0) > 1;
}

export function checkDuration(claim: DurationClaim): DurationVerdict {
  const { durationMin } = claim;
  if (durationMin == null) return { ok: true }; // unknown is an honest answer

  if (isMultiUnit(claim) && durationMin < MIN_MULTI_UNIT_DURATION_MIN) {
    return {
      ok: false,
      reason: `${claim.type} claims ${durationMin}min, under the ${MIN_MULTI_UNIT_DURATION_MIN}min floor for a multi-unit work — that is a placeholder, not a measurement`,
    };
  }

  // A leaf over the attachable ceiling is whole-course/book content wearing a leaf's
  // clothes. decompose() already parks such a row for review; the number itself is
  // still not trustworthy, so it does not get persisted as if it were. A multi-unit
  // work is exempt: 400 minutes is what a book HONESTLY is, and decompose() parks
  // every book on type alone — reading its real length as an over-ceiling leaf would
  // throw away the one duration we most want kept.
  const isLeaf = !isMultiUnit(claim) && (claim.decompositionStatus ?? 'atomic') === 'atomic';
  if (isLeaf && durationMin > MAX_ATTACHABLE_DURATION_MIN) {
    return {
      ok: false,
      reason: `atomic ${claim.type} claims ${durationMin}min, over the ${MAX_ATTACHABLE_DURATION_MIN}min attachable ceiling — an unverified guess about whole-course content`,
    };
  }

  return { ok: true };
}

// Sum of the children whose durations are known. `null` when none are: a container
// over a subtree of unknowns is itself unknown. The result is `estimated`, not
// `extracted`, even when every child was API-measured — the sum leaves out whatever
// the unknown children cost, so it is a floor, not a measurement.
export function containerDuration(
  children: { durationMin: number | null }[],
): { durationMin: number | null; durationSource: DurationSource } {
  const known = children.filter((c) => c.durationMin != null).map((c) => c.durationMin ?? 0);
  if (known.length === 0) return { durationMin: null, durationSource: 'unknown' };
  return { durationMin: known.reduce((s, d) => s + d, 0), durationSource: 'estimated' };
}
