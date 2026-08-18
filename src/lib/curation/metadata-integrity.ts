// Metadata integrity — clause 6 of `resource-standard.md`, the only clause with no
// implementing rule anywhere in the codebase until now.
//
// Every other clause asks whether a page belongs in the library at all. This one asks a
// different question with an opposite remedy: is what we RECORDED about the row still true
// of what the URL serves? A row that fails it is usually a good lesson wearing a stale
// label, and the repair is to correct the label — never to remove the row. That is why this
// is a separate module from `serveability.ts` / `serveability-probe.ts` rather than another
// reason in their unions: a caller that could not tell the two apart would deprecate on a
// finding whose whole point is that the content is fine.
//
// ⚠️ A CLAUSE-6 REPAIR OUTRANKS A CLAUSE-5 EXCLUSION. A row typed `interactive` that the
// page serves as an article is re-typed and kept, never deprecated on the stale type it is
// being corrected out of. The precedence is enforced by the sweep, and what makes it
// expressible is that a `retype` here names its target in the type system rather than in a
// string a caller has to parse.
//
// ⚠️ REPORTS ONLY, and deliberately NOT wired into any create path. At ingestion `type`
// comes from the LLM extraction, so a mismatch there means "the extraction is wrong" and the
// answer is to fix the field, not to run a repair loop inside a `Resource` create. Detection
// belongs where a human or a driver can see the page and act on it.
//
// Four comparisons. The first needs nothing but the row and is therefore the one that can
// run over the whole library; the other three need a probe. Each carries the repair it
// implies, and only two repairs exist:
//
//   `retype` — the evidence names a form the row should have had. Restricted to `article`
//              and `video`, which is SCOPE rather than safety: those are the only targets
//              clause 6 needs, and a flip into a container type is the `action: 'decompose'`
//              decision, not this one.
//   `review` — a human looks. Used where the finding is real but does not by itself say what
//              the row should become.
//
// A list rather than a verdict, because a row can lie about two things at once and the two
// lies have different repairs. Nothing here collapses or ranks them; two `retype` findings
// that name DIFFERENT targets are both reported, and a caller that means to act on one must
// treat the disagreement as an escalation rather than picking a winner.

import type { ResourceType } from '@prisma/client';
import type { KhanProbe } from './khan-probe-duration';
import { isKhanUrl, urlKind } from './serveability';
import { probeDescribes } from './serveability-probe';

export type RetypeTarget = 'article' | 'video';

export type MetadataDiscrepancyKind =
  | 'type-contradicts-url' // comparison 1 — stored `type` vs the stored URL's own kind
  | 'type-contradicts-page' // comparison 2 — stored `type` vs the page's declared kind
  | 'url-redirects-across-kinds' // comparison 3 — the stored URL now serves something else
  | 'title-contradicts-page'; // comparison 4 — stored title vs the rendered one

type Finding = {
  kind: MetadataDiscrepancyKind;
  clause: 6;
  // Human-readable evidence, for a report line and for a reviewer. Never parsed.
  detail: string;
};

// `to` exists ONLY on the retype arm, so a caller cannot read a target off a finding that
// does not name one, and cannot forget to handle the arm that names none. This is the shape
// the sweep reads to decide repair-versus-removal, so its unambiguity is load-bearing.
export type MetadataDiscrepancy =
  | (Finding & { repair: 'retype'; to: RetypeTarget })
  | (Finding & { repair: 'review' });

export type UncheckedReason =
  | 'no-probe' // the row was never probed, or the probe failed
  | 'blocked'; // a bot wall or an error page — we saw someone else's page, not this one

// Two arms with DIFFERENT list property names, on purpose. Comparison 1 runs whatever the
// caller holds, so an empty list is always a truthful statement about the checks that ran —
// and a badly different statement in each case. `[]` under `pageChecked: true` means the row
// is clean on all four comparisons; `[]` under `pageChecked: false` means only the free rule
// found nothing and three comparisons were never made. Naming them apart means a caller has
// to narrow before it can read either, so it cannot count an unprobed row as a pass. The
// type checker holds the distinction a single nullable field would leave to a comment.
export type MetadataIntegrityOutcome =
  | { pageChecked: true; discrepancies: MetadataDiscrepancy[] }
  | { pageChecked: false; reason: UncheckedReason; rowDiscrepancies: MetadataDiscrepancy[] };

export type MetadataIntegrityRow = {
  type: ResourceType;
  url: string;
  title?: string | null;
};

// The two Khan URL kinds that name a form a row could correctly carry. `/e/`, `/pt/` and
// `/pi/` are absent because no permitted retype target describes them — a row on one of
// those is a serveability question (clause 5), and answering it here with a `retype` would
// re-label an exercise as an article and keep it.
const URL_KIND_TYPE: Record<string, RetypeTarget> = { a: 'article', v: 'video' };

// The page's own claim about what it is. `article` and `video` are the only two the probe
// reads off Khan's `(article)` / `(video)` title marker — the page stating its form. Its
// other values (`article-like`, `challenge`, `other`) are the probe INFERRING from what it
// found in the DOM, which is a weaker signal than the stored type it would be overturning.
const PAGE_KIND_TYPE: Record<string, RetypeTarget> = { article: 'article', video: 'video' };

// ⚠️ THE HOST GATE IS NOT DECORATION. `urlKind` is a bare path regex, so on a non-Khan URL
// a `/a/` or `/v/` segment means nothing — `docs.python.org/3/v/…` is not a video. The two
// comparisons that read it carry DESTRUCTIVE repairs, and the standard's one-sided error
// budget says such a repair must never fire on a resemblance. Comparisons 2 and 4 need no
// gate: they read the probe, which is Khan-shaped by construction.
function khanUrlKind(url: string): string | null {
  return isKhanUrl(url) ? urlKind(url) : null;
}

// Khan writes `<page title> (article) | <breadcrumbs…> | Khan Academy` into `document.title`,
// so a raw comparison against the stored title reports a mismatch on every single row. Only
// the leading segment is the title; the rest is chrome this strips before comparing.
const KHAN_TITLE_TAIL = /^khan academy$/i;
const PAGE_KIND_MARKER = /\s*\((?:article|video|practice|challenge|quiz|unit test)\)\s*$/i;

function normalizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw.trim();
  const segments = title.split('|').map((s) => s.trim());
  if (segments.length > 1 && KHAN_TITLE_TAIL.test(segments[segments.length - 1])) {
    title = segments[0];
  }
  const folded = title
    .replace(PAGE_KIND_MARKER, '')
    .toLowerCase()
    .normalize('NFKC')
    // Typography only. Khan renders curly quotes and en/em dashes where our stored copy has
    // the ASCII the extraction wrote, and a punctuation difference is not a re-titling.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.:;,]+$/, '')
    .trim();
  return folded.length > 0 ? folded : null;
}

export function classifyMetadataIntegrity(
  row: MetadataIntegrityRow,
  probe?: KhanProbe | null,
): MetadataIntegrityOutcome {
  const storedKind = khanUrlKind(row.url);

  // Comparison 1 — the free rule, and the only one that needs no I/O. Khan's own URL says
  // what the page is, so a row typed anything else has a stale label: measured at 8 rows in
  // production, 3 of them pickable and 1 attached to a live concept.
  const rowDiscrepancies: MetadataDiscrepancy[] = [];
  const urlSaysType = storedKind === null ? undefined : URL_KIND_TYPE[storedKind];
  if (urlSaysType && row.type !== urlSaysType) {
    rowDiscrepancies.push({
      kind: 'type-contradicts-url',
      clause: 6,
      repair: 'retype',
      to: urlSaysType,
      detail: `stored type '${row.type}' on a /${storedKind}/ URL`,
    });
  }

  if (!probe) return { pageChecked: false, reason: 'no-probe', rowDiscrepancies };
  // A bot wall is not evidence about this row. Reporting the three page comparisons against
  // someone else's error page would manufacture findings on rows nobody has seen.
  if (probe.blocked) return { pageChecked: false, reason: 'blocked', rowDiscrepancies };

  const discrepancies = [...rowDiscrepancies];

  // Comparison 2 — the page's declared kind against the stored type. This is the rule that
  // catches the row typed `interactive` that Khan serves as an article, which no rule over
  // `type` or `url` can see.
  const pageSaysType = PAGE_KIND_TYPE[probe.pageKind];
  if (pageSaysType && row.type !== pageSaysType) {
    discrepancies.push({
      kind: 'type-contradicts-page',
      clause: 6,
      repair: 'retype',
      to: pageSaysType,
      detail: `stored type '${row.type}' but the page declares itself a ${pageSaysType}`,
    });
  }

  // Comparison 3 — the redirect. `proposeKhanDuration` already refuses to measure this case
  // and that is where it ends: the row keeps its wrong type and nothing records why. Here it
  // becomes a finding.
  //
  // `review`, never a `retype`, and the asymmetry with comparison 2 is the point: a
  // redirect across kinds means the URL points at DIFFERENT CONTENT, so the title, the
  // summary and the concepts taught are all suspect too — correcting `type` alone would
  // leave a row that is still wrong and now looks repaired. The slug alone changing is
  // normal and common on Khan and is deliberately not a finding; the kind changing is not.
  const landedKind = khanUrlKind(probe.url);
  if (isKhanUrl(row.url) && isKhanUrl(probe.url) && storedKind !== landedKind) {
    discrepancies.push({
      kind: 'url-redirects-across-kinds',
      clause: 6,
      repair: 'review',
      detail: `stored /${storedKind ?? '—'}/ URL now serves /${landedKind ?? '—'}/`,
    });
  }

  // Comparison 4 — the stored title against the rendered one. ⚠️ ALWAYS `review`, never a
  // `retype` and never a verdict on its own. Legitimate re-titling exists, Khan's own
  // rendering differs from what we stored for reasons that are not defects, and this signal
  // found its one real row only because an agent noticed it by eye. Same two-signal caution
  // as `non-teaching.ts`'s `junk-leaf`: a weak signal is grounds for a closer look, never
  // for acting alone. A missing title on either side disables the rule rather than
  // reporting an empty string as a mismatch.
  //
  // ⚠️ AND THE ONE COMPARISON HERE THAT A VOIDED PROBE DISABLES. It is the only one that
  // reads the landed page as a description OF THIS ROW; comparisons 1–3 read it as the page
  // the URL actually reaches, which is what clause 6 asks. So a row repointed at different
  // content since it was probed would otherwise pick up a title mismatch against the old
  // page's title — a finding about two pages that were never meant to have the same name.
  const storedTitle = normalizeTitle(row.title);
  const renderedTitle = normalizeTitle(probe.title);
  if (probeDescribes(row.url, probe.url) && storedTitle && renderedTitle && storedTitle !== renderedTitle) {
    discrepancies.push({
      kind: 'title-contradicts-page',
      clause: 6,
      repair: 'review',
      detail: `stored title '${row.title}' but the page renders '${probe.title}'`,
    });
  }

  return { pageChecked: true, discrepancies };
}
