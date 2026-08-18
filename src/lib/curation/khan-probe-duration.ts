// Khan browser backfill — the measurement→minutes mapping, kept pure.
//
// The 526 Khan rows stamped `unknown` are measured by sub-agents driving a real browser,
// which report raw measurements only: a YouTube id, or a word count of the article body.
// This module turns one such measurement into a duration, and it is the ONLY place that
// decision is made — 15 agents each rounding their own way is exactly how the library
// filled up with confident unmeasured numbers in the first place.
//
// Lives here rather than in the driver so the accept/reject table is unit-testable
// without a database or a browser. `scripts/apply-khan-durations.ts` is the only caller.

import { MIN_CONTENT_WORDS, readingMinutes, secondsToMinutes } from './duration-estimate';
import { urlKind } from './serveability';

// What the in-page probe reports. Only the fields the mapping READS are declared;
// the driver's zod schema is the boundary that validates them.
export type KhanProbe = {
  // Where the browser actually ended up. Khan redirects freely, and a stored `/a/` URL
  // that now lands on `/v/` means the row points at different content — see urlKind.
  url: string;
  pageKind: string;
  videoIds: string[];
  articleWords: number | null;
  articleWordsBeforeExpand: number | null;
  collapsedExpanded: number;
  workedExamples: number | null;
  // Diagnostic only — never an input to a number. See the under-floor branch below.
  widgets?: number;
  hasEditor: boolean;
  blocked: boolean;
};

export type KhanMeasured = { durationMin: number; durationSource: 'api' | 'extracted'; evidence: string };
export type KhanUnmeasured = { durationMin: null; durationSource: 'unknown'; evidence: string };
export type KhanProposal = KhanMeasured | KhanUnmeasured;

// A union rather than a nullable number, so a caller cannot compile a write path that
// persists an unmeasured row. "Never write a null over an existing number" is then held
// by the type checker instead of by a runtime guard someone can forget.
const unreadable = (evidence: string): KhanUnmeasured => ({
  durationMin: null,
  durationSource: 'unknown',
  evidence,
});

export function proposeKhanDuration(
  storedType: 'video' | 'article' | 'interactive',
  storedUrl: string,
  probe: KhanProbe | null,
  videoSeconds: Map<string, number>,
): KhanProposal {
  if (!probe) return unreadable('agent reported failure');
  if (probe.blocked) return unreadable('page reported blocked/not-found');

  // A stored URL that redirects across content kinds is pointing somewhere else now, and
  // the row's own type and title no longer describe what is served. Measured on batch 02:
  // 5 of 25 stored `/a/` URLs landed on a video, a coding challenge, or a bare unit page.
  // Without this guard three of them would have taken the video branch below and written
  // some other lesson's runtime onto an article row — a wrong number that would look
  // perfectly well-attributed. The slug alone changing is fine and common; the KIND
  // changing is the part that means "different content".
  const from = urlKind(storedUrl);
  const to = urlKind(probe.url);
  if (from !== to) {
    return unreadable(`stored /${from ?? '—'}/ URL now serves /${to ?? '—'}/ — row points at different content, needs review`);
  }

  // A video is measured by its embedded id, never by its prose. Exactly one id: a page
  // carrying several is ambiguous about which one it IS, and taking the first would be a
  // guess wearing an `api` stamp. Measured 2026-08-16, a Khan `/v/` page embeds one.
  if (storedType === 'video' || probe.pageKind === 'video') {
    if (probe.videoIds.length !== 1) {
      return unreadable(`${probe.videoIds.length} youtube ids in page, need exactly 1`);
    }
    const [videoId] = probe.videoIds;
    const seconds = videoSeconds.get(videoId);
    if (seconds == null) return unreadable(`videoId ${videoId} unresolved by the index and the Data API`);
    return { durationMin: secondsToMinutes(seconds), durationSource: 'api', evidence: `videoId ${videoId} → ${seconds}s` };
  }

  // Everything else is measured as prose from `.perseus-article` alone. The probe also
  // reports `mainWords`/`bodyWords`, and they are diagnostics that must never be used as
  // a content measurement: `<main>` contains `#questions-panel`, the user comment thread,
  // which on `limits-intro` was 1,882 words against 1,356 of real article — reading it
  // would have written 28 minutes where the answer is 12.
  if (probe.articleWords == null) {
    return unreadable(probe.hasEditor ? 'coding challenge, no readable prose' : 'no .perseus-article on page');
  }
  // Under the floor we have read page chrome, not content. An honest unknown beats a
  // confident 2-minute lesson.
  //
  // An exercise-heavy article lands here legitimately: `basic-normal-calculations` is 189
  // words of prose wrapped around 6 problem widgets, and its real cost is the problems,
  // which no word count can see. The widget count rides along in the evidence so this
  // population can be counted and priced later — inventing a per-widget constant now
  // would be exactly the unmeasured confidence this backfill exists to remove.
  if (probe.articleWords < MIN_CONTENT_WORDS) {
    const widgets = probe.widgets ?? 0;
    return unreadable(
      `${probe.articleWords} words, under the ${MIN_CONTENT_WORDS}-word content floor` +
        (widgets > 0 ? ` (${widgets} exercise widget(s) — cost is problems, not prose)` : ''),
    );
  }
  // Khan articles embed videos, and reading time alone badly misreads those. Both ends of
  // the range are real: `matrices-as-transformations` embeds 11 clips that are 4–25 SECOND
  // animations and add ~2 minutes to a 12-minute read, while `ap-calc-prerequisites` is
  // 663 words wrapped around one 14-MINUTE lecture — 6 minutes of reading standing in for
  // 20. Summing the measured parts handles both without a threshold to tune.
  //
  // Every embedded id must resolve. A partial sum is a confidently LOW number, which is
  // the same defect as the placeholder this backfill removes, so an unresolved clip makes
  // the whole row unknown rather than an under-count wearing a measurement's stamp.
  const embedded = probe.videoIds.map((id) => ({ id, seconds: videoSeconds.get(id) }));
  const unresolved = embedded.filter((v) => v.seconds == null);
  if (unresolved.length > 0) {
    return unreadable(
      `${probe.articleWords} words but ${unresolved.length} of ${embedded.length} embedded video(s) unresolved — a partial sum would under-count`,
    );
  }
  const videoSecondsTotal = embedded.reduce((s, v) => s + (v.seconds ?? 0), 0);

  const examples = probe.workedExamples ?? 0;
  const revealed = probe.articleWords - (probe.articleWordsBeforeExpand ?? probe.articleWords);
  const reading = readingMinutes(probe.articleWords, examples);
  const watching = videoSecondsTotal > 0 ? secondsToMinutes(videoSecondsTotal) : 0;
  return {
    // `extracted`, not `api`, even though the video half came from the Data API: the two
    // halves carry different provenance and the column holds one, so it takes the weaker
    // of them rather than borrowing the stronger one's authority.
    durationMin: reading + watching,
    durationSource: 'extracted',
    evidence:
      `${probe.articleWords} words (+${revealed} from ${probe.collapsedExpanded} reveal(s)), ` +
      `${examples} worked example(s) → ${reading}min read` +
      (embedded.length > 0 ? ` + ${embedded.length} embedded video(s) ${videoSecondsTotal}s → ${watching}min` : ''),
  };
}
