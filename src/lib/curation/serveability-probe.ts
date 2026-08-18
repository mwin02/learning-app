// Probe-level serveability — the part of `resource-standard.md` that is only decidable
// from the rendered page.
//
// Sibling of `serveability.ts`, which answers what a row's own stored fields can answer.
// This half implements clause 4 (standalone) and the rest of clause 5 (consumed, not
// performed) for pages whose recorded form says nothing wrong: the two rows that motivated
// this work are ordinary `/a/` URLs typed `article`, and no rule over `type` or `url` can
// see either.
//
// ⚠️ DELIBERATELY A SEPARATE FUNCTION, not an optional probe argument on
// `classifyServeability`, and it is not re-exported through it. A caller holding no probe
// must not be able to receive a weaker verdict and read it as the whole answer; a caller
// holding one runs both and takes either failure.
//
// ⚠️ THE STANDARD'S ERROR BUDGET IS ONE-SIDED, and it bites harder here than it does
// row-level: every input below is a measurement of a page rather than a statement about it,
// so every one of them has a legitimate population sitting near the threshold. So no rule
// here fires on a single weak signal — each is either PAIRED (two independent measurements
// that agree) or reads a value so extreme that it is not a measurement of a lesson at all.
// In particular the prose floor ALONE IS NOT A VERDICT: of 138 probed article rows, 50 sit
// under it, and six of those carry zero widgets and are real short lessons.
//
// Host note: the probe that produces this evidence is Khan-shaped (`.perseus-article` is
// its content selector), so in practice this classifier runs on Khan rows. Nothing below
// keys off the hostname — a host-agnostic probe would feed it unchanged.

import { MIN_CONTENT_WORDS } from './duration-estimate';
import type { KhanProbe } from './khan-probe-duration';
import { urlKind } from './serveability';

// `KhanProbe` declares only the fields `proposeKhanDuration` reads, and `title`/`mainWords`
// are emitted by the probe and present in every batch file but not yet declared there — S4
// adds them. Extending rather than restating keeps one description of the probe: when S4
// widens `KhanProbe`, this intersection collapses into it with no edit here and no chance
// of the two drifting apart. Both stay optional so a probe artifact that predates the field
// is readable; their absence only ever DISABLES a rule, never invents one.
export type ProbeEvidence = KhanProbe & {
  title?: string | null;
  mainWords?: number | null;
};

// What the classifier needs from the row itself. Deliberately not the whole row: `type` and
// `decompositionStatus` are the row-level classifier's inputs, and comparing stored fields
// against probe fields is clause 6, which is `metadata-integrity.ts`'s question.
export type ProbeServeabilityRow = {
  url: string;
  title?: string | null;
};

export type UnserveableProbeReason =
  | 'practice-page' // prose under the content floor wrapped around exercise widgets
  | 'editor-no-prose' // an in-browser code editor and no article to read
  | 'widget-shell' // an article body that is a caption on an embedded widget
  | 'chain-step'; // step n of a sequence — clause 4

export type NoEvidenceReason =
  | 'no-probe' // the row was never probed, or the probe failed
  | 'blocked' // a bot wall or an error page — we saw someone else's page, not this one
  | 'probe-voided'; // a probe exists, but of a page this row no longer points at

// Three outcomes, not two. A bot wall is not a quality failure and must never be counted as
// one, so "we have no evidence" is its own arm rather than a `serveable: true` that reads
// like a pass — and because `serveable` does not exist on that arm, a caller cannot reach
// it without narrowing on `evidence` first. The type checker holds the distinction that a
// nullable boolean would leave to a comment.
export type ProbeServeabilityOutcome =
  | { evidence: false; reason: NoEvidenceReason }
  | { evidence: true; serveable: true }
  | { evidence: true; serveable: false; clause: 4 | 5; reason: UnserveableProbeReason };

// A page body this many times the article it contains is not a short lesson: at this
// multiple the prose is under 2% of what the page renders, which is a caption on something
// else. Set well clear of the ordinary case rather than at the edge of it — `main` includes
// Khan's comment thread, so a real 1,356-word lesson under a 1,882-word discussion already
// reads ~2.4 here, and review-style articles with long threads reach the teens. Only a body
// that is essentially absent gets near this number.
const SHELL_MAIN_RATIO = 50;

// A title that LEADS with its ordinal is announcing its position in a sequence — clause 4's
// "step n of a chain". The leading anchor is the whole discriminator and is not decoration:
// dozens of legitimate Khan lessons carry a trailing part number (`Determining limits at
// infinity of quotients (Part 2)`, `RSA encryption: Step 3`) because one lesson was split
// for length, and those are lessons that teach in place. `Clue #4` and `Level 3: Challenge`
// name the step before they name anything else, because the step is what they are.
const CHAIN_STEP_TITLE = /^(?:clue|level|step|part|chapter)\b\s*[#:]?\s*\d+\b/i;

// A path segment that is a challenge CONTAINER — `…/cryptography/cryptochallenge/a/clue-2`.
// Only the container segments are read, never the slug: `…/v/primality-test-challenge` is a
// video lesson about a challenge, which is not the same thing as a page inside one.
const CHALLENGE_CONTAINER = /challenges?$/i;

// Everything from the content-kind segment onward is the leaf's own name; what precedes it
// is the shelf the leaf sits on. With no kind segment the last segment is the leaf.
function containerSegments(url: string): string[] {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Malformed and `generated://` URLs both reach the classifiers; neither may throw.
    return [];
  }
  const segments = path.split('/').filter(Boolean);
  const kindAt = segments.findIndex((s) => /^(a|v|e|pt|pi)$/.test(s));
  return kindAt >= 0 ? segments.slice(0, kindAt) : segments.slice(0, -1);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ⚠️ A PROBE IS KEYED BY resourceId, NOT BY URL, so it describes the page that row pointed at
// WHEN IT WAS PROBED — which is not necessarily the page it points at now. A stale probe
// allowed to answer a question about a row answers it about somebody else's page.
//
// The case that forced this, and it is not hypothetical: the S9 driver repoints a Khan `/pt/`
// row at its embedded video, so `row.url` becomes a youtube.com URL while the stored probe is
// still the Khan challenge page — `hasEditor: true`, `articleWords: null`. That fires
// `editor-no-prose`, and the sweep falls through to deprecating the ten attached SQL lessons
// S9 exists to save. The same defect, less loudly, on the 7 rows whose stored URL redirects
// across kinds: `classifyMetadataIntegrity` reports `url-redirects-across-kinds` on those,
// whose whole meaning is that the landed page is DIFFERENT CONTENT from this row — so it
// cannot simultaneously be the evidence that condemns it.
//
// So: kind or host disagreement voids the probe as evidence about this row.
// ⚠️ ONLY those two. Slug drift is normal and common on Khan and must still count —
// `metadata-integrity.ts` draws exactly this line ("the slug alone changing is normal and is
// deliberately not a finding; the kind changing is not"), and voiding on it would silently
// discard most of the page evidence the library has. An unparseable URL on either side voids
// too, because we cannot show the two agree, and the standard's one-sided error budget says
// an unproven signal does not get to exclude.
export function probeDescribes(rowUrl: string, probeUrl: string): boolean {
  const rowHost = hostOf(rowUrl);
  const probeHost = hostOf(probeUrl);
  if (rowHost === null || probeHost === null) return false;
  if (rowHost !== probeHost) return false;
  return urlKind(rowUrl) === urlKind(probeUrl);
}

function isChainStep(probe: ProbeEvidence, row: ProbeServeabilityRow): boolean {
  // Both titles and both URLs, because either copy is enough: the stored title is what a
  // learner is shown, the rendered one is what the page says it is, and a stored URL that
  // now redirects into a chain container points into the chain just the same. This is not
  // the stored-vs-probe COMPARISON of clause 6 — neither value is being checked against
  // the other, each is read for the same marker on its own.
  for (const title of [row.title, probe.title]) {
    if (title && CHAIN_STEP_TITLE.test(title.trim())) return true;
  }
  for (const url of [row.url, probe.url]) {
    if (containerSegments(url).some((s) => CHALLENGE_CONTAINER.test(s))) return true;
  }
  return false;
}

export function classifyServeabilityFromProbe(
  probe: ProbeEvidence | null,
  row: ProbeServeabilityRow,
): ProbeServeabilityOutcome {
  if (!probe) return { evidence: false, reason: 'no-probe' };
  if (probe.blocked) return { evidence: false, reason: 'blocked' };
  // Routed to the EXISTING no-evidence arm rather than given a fourth outcome: a probe that
  // does not describe this row is precisely an absence of evidence about it, which is what
  // that arm already means and already prevents from being read as a pass. Its own reason,
  // because a caller counting voided probes has to tell them from rows nobody ever probed.
  if (!probeDescribes(row.url, probe.url)) return { evidence: false, reason: 'probe-voided' };

  if (isChainStep(probe, row)) {
    return { evidence: true, serveable: false, clause: 4, reason: 'chain-step' };
  }

  const words = probe.articleWords;
  const widgets = probe.widgets ?? 0;
  const mainWords = probe.mainWords ?? null;
  // Over the floor is over the floor. `MIN_CONTENT_WORDS` is already the codebase's "we
  // have read chrome, not content" line in five estimators, and every rule below that reads
  // prose is gated on it — a page carrying real prose is a lesson whatever else it also
  // carries. This is why the 43 probed rows that clear the floor while wrapping ten or more
  // widgets stay in the library on purpose: `Calculating the mean` is 492 words around 31
  // widgets and is a real lesson, and a ratio tuned to catch the practice pages catches it
  // too. That alternative was measured and rejected; do not reintroduce it.
  const underFloorWords = words != null && words < MIN_CONTENT_WORDS ? words : null;

  // A body that is a shell around an embedded widget: `Unbiased estimate of population
  // variance` renders 1,126 words of page around an article reading four — `"Make a spinoff
  // here!"`. Paired, and both halves matter: the prose is under the floor AND the page
  // around it clears the floor on its own, so this fires on a page that is substantial
  // while containing nothing to read, never on a page that is simply short.
  if (
    underFloorWords != null &&
    mainWords != null &&
    mainWords >= MIN_CONTENT_WORDS &&
    mainWords >= SHELL_MAIN_RATIO * underFloorWords
  ) {
    return { evidence: true, serveable: false, clause: 5, reason: 'widget-shell' };
  }

  // An in-browser code editor with nothing to read: the page's substance is the program the
  // learner writes. Paired — the editor alone is not the verdict, because a real lesson may
  // embed one alongside its prose, and prose under the floor alone is not the verdict
  // either. `hasEditor` and `pageKind: 'challenge'` read the same selector in the probe, so
  // this is the same signal `pageKind` reports; `pageKind` itself is clause 6's input.
  if (probe.hasEditor && (words == null || underFloorWords != null)) {
    return { evidence: true, serveable: false, clause: 5, reason: 'editor-no-prose' };
  }

  // The practice page: too little prose to be the lesson, and exercise widgets sitting
  // where the lesson would be. `basic-normal-calculations` is 189 words around 6 problem
  // widgets, and its real cost is the problems — a cost that belongs to the learner and
  // that no word count can see. Strictly paired: six probed rows sit under the floor with
  // zero widgets and are real short lessons, so the floor alone admits.
  if (underFloorWords != null && widgets >= 1) {
    return { evidence: true, serveable: false, clause: 5, reason: 'practice-page' };
  }

  return { evidence: true, serveable: true };
}
