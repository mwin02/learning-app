// Row-level serveability — the part of `resource-standard.md` decidable from a row's own
// stored fields, with no page and no I/O.
//
// Two of the standard's six clauses are partly answerable before anything is fetched:
// clause 5 (consumed, not performed) for a resource whose recorded form already says its
// substance is work the learner does, and clause 3 (teaches in place) for a URL that names
// a container rather than a lesson. Everything else those clauses cover needs the rendered
// page and belongs to the probe-level classifier — deliberately a SEPARATE function rather
// than an optional probe argument here, so a caller holding no probe cannot silently
// receive a weaker verdict and read it as the whole answer.
//
// ⚠️ THE STANDARD'S ERROR BUDGET IS ONE-SIDED and every rule below is shaped by it:
// excluding a real lesson removes it from every learner's retrieval, permanently and
// invisibly. So each rule reads an ABSOLUTE signal — a recorded form, or a content-kind
// segment Khan itself writes into the URL — never a resemblance. A hostname alone decides
// nothing, a slug that merely reads like practice decides nothing, and anything ambiguous
// passes through as serveable by construction. That is the design, not a gap in it.
//
// Shaped like `classifyNonTeaching`: a discriminated union carrying the reason it failed,
// so a caller cannot read a boolean and lose the why — and, because the standard requires
// every exclusion to name the clause it failed, the clause travels with it. The two
// classifiers ask different questions and both run: furniture is not the same failure as
// an exercise.

import type { DecompositionStatus, ResourceType } from '@prisma/client';

export type UnserveableReason =
  | 'interactive-type' // the recorded form is interactive, excluded as a class
  | 'khan-exercise' // Khan `/e/` — an exercise set
  | 'khan-project-task' // Khan `/pt/` — talkthrough plus an in-browser challenge
  | 'khan-project-item' // Khan `/pi/` — a coding challenge
  | 'khan-container-url'; // a Khan URL naming a unit or landing page, filed as a leaf

export type ServeabilityVerdict =
  | { serveable: true }
  | { serveable: false; clause: 3 | 5; reason: UnserveableReason };

export type ServeabilityInput = {
  type: ResourceType;
  url: string;
  // Absent when the caller does not know it — ingestion classifies before the row exists.
  // Its absence only ever DISABLES the container rule below; it can never turn a serveable
  // row unserveable, so a caller without it gets a strictly weaker exclusion, never a
  // stricter one.
  decompositionStatus?: DecompositionStatus | null;
};

// Khan's content-type path segment: `/a/` article, `/v/` video, `/e/` exercise,
// `/pt/` project task, `/pi/` project item. A landing or unit page has none.
export function urlKind(url: string): string | null {
  return /\/(a|v|e|pt|pi)\/[^/?#]+/.exec(url)?.[1] ?? null;
}

// The kinds whose substance is work the learner performs. `/a/` and `/v/` are absent on
// purpose: they are the two kinds that carry content, and their absence from this table is
// what admits them.
const PERFORMED_KHAN_KINDS: Record<string, UnserveableReason> = {
  e: 'khan-exercise',
  pt: 'khan-project-task',
  pi: 'khan-project-item',
};

function isKhanUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'khanacademy.org' || hostname.endsWith('.khanacademy.org');
  } catch {
    // Non-URL `url` values exist (`generated://` rows parse, but a malformed one must not
    // throw out of a classifier the decomposition path calls per child).
    return false;
  }
}

export function classifyServeability(input: ServeabilityInput): ServeabilityVerdict {
  if (isKhanUrl(input.url)) {
    const kind = urlKind(input.url);
    if (kind === null) {
      // No content-kind segment means a unit or landing page — a page that points at
      // instruction instead of carrying it. Only a failure when the row is filed as a
      // pickable leaf: the same URL as a `decomposed` container is a container doing its
      // job, and nothing in the standard asks a container to teach.
      if (input.decompositionStatus === 'atomic') {
        return { serveable: false, clause: 3, reason: 'khan-container-url' };
      }
    } else {
      // Khan's own URL says what the page IS, so it outranks the stored type — which the
      // duration backfill found wrong on eight rows. Reading it before the type rule also
      // means a `/pt/` row is always reported as `/pt/` whatever it is typed, which is the
      // population repointed at its video rather than deprecated.
      const reason = PERFORMED_KHAN_KINDS[kind];
      if (reason) return { serveable: false, clause: 5, reason };
    }
  }

  // Excluded as a class, not judged case by case. A row that genuinely teaches in prose or
  // on video is a misclassification, and the repair is to correct its recorded form — a
  // clause-6 question, not a reason to weaken this rule.
  //
  // The one exemption is a row that is not being served at all: `interactive` is a
  // CONTAINER_TYPE (`router.ts`), so an interactive root is the type MOST likely to be a
  // legitimate decomposed container, and nothing in the standard asks a container to teach
  // — its children do. Deprecating one would also put it outside `listPendingReview`
  // (roots, `pending_review`), so it could never be approved and its children would never
  // surface under it: a working container destroyed on its type alone.
  //
  // ⚠️ The test is `!== 'decomposed'`, deliberately NOT the `=== 'atomic'` form the
  // container-URL rule above uses, and the asymmetry follows the strength of the signal.
  // A Khan URL with no kind segment is WEAK — it could be anything — so it needs `atomic`
  // to positively confirm before it fires. A stored `interactive` is STRONG and explicit,
  // so only an explicit `decomposed` excuses it: absent or unknown status still fails.
  if (input.type === 'interactive' && input.decompositionStatus !== 'decomposed') {
    return { serveable: false, clause: 5, reason: 'interactive-type' };
  }

  return { serveable: true };
}
