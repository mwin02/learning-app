// Library-quality Q10 — the second matching pass for the Khan video rows the
// title key missed, and the rule that decides which of its answers may be written.
//
// The stored URL's last segment is Khan's own slug for the lesson, and Khan names
// the YouTube upload after the same lesson, so the slug keys the SAME cached index
// the title keys — no new fetch, no new quota, and nothing on `khanacademy.org` is
// contacted (Q6a: that host answers automated clients with a bot wall, `robots.txt`
// included).
//
// ⚠️ THE SLUG KEY MAY NOT WRITE UNATTENDED. Q6b measured it ~4% confidently wrong:
// of 233 rows where both keys resolved uniquely, 8 disagreed — `Introduction to
// matrices` resolves to a 711s video by one key and a 269s video by the other, and
// they are different videos. A key that wrong is a reviewer's proposal, not a
// measurement. So this module classifies rather than decides:
//
//   agreed  — the title key backs the slug key up on the same videoId. Safe to
//             write silently, because the disagreement mode cannot be present.
//   confirm — the slug key resolved alone. A proposal for a human, never a write.
//   unresolved — no unique slug match. Stays `unknown`, which is the honest answer
//             and, per B4, a success rather than a shortfall.
//
// Fuzzy and edit-distance matching are rejected outright by the plan: they widen
// exactly the confident-wrong band this classification exists to keep out.

import { lookupTitle, normaliseTitle, type KhanIndex, type KhanVideo } from './youtube-index';

export type SlugProposal =
  | { kind: 'agreed'; video: KhanVideo; slugKey: string }
  | { kind: 'confirm'; video: KhanVideo; slugKey: string }
  | { kind: 'unresolved'; reason: 'no-slug' | 'no-match' | 'ambiguous'; slugKey: string };

/**
 * The last path segment, run through the index's own normaliser.
 *
 * `…/v/introduction-to-matrices` → `introduction to matrices`, which is exactly
 * what `normaliseTitle` produces from the YouTube title `Introduction to matrices
 * | Matrices | Precalculus | Khan Academy`. One normaliser for both sides, so a
 * change to the folding rules can never desynchronise the two keys.
 *
 * A URL that does not parse yields no key rather than throwing: a malformed row is
 * one `unknown`, not a dead driver run.
 */
export function slugKey(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
  return normaliseTitle(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * `agreed` means the title key resolved uniquely to the SAME videoId. Nothing
 * weaker counts: a different video is Q6b's measured disagreement, and no match at
 * all leaves the slug standing alone. Both are `confirm`.
 *
 * Note what this makes agreement worth on THIS population, and it is worth stating
 * because it decided the block's shape. The index buckets by normalised title, so
 * a row whose title key already resolves is not a miss — the 254 rows this pass
 * runs on are precisely the ones whose title key found nothing. Agreement is
 * therefore unreachable here by construction, measured at 0 of 254 on the dev DB
 * 2026-08-12. The branch stays because the classification is what makes the
 * `confirm` path safe to define, not because it recovers rows.
 */
export function proposeBySlug(index: KhanIndex, row: { url: string; title: string }): SlugProposal {
  const key = slugKey(row.url);
  if (!key) return { kind: 'unresolved', reason: 'no-slug', slugKey: key };

  const bySlug = lookupTitle(index, key);
  if (!bySlug.ok) return { kind: 'unresolved', reason: bySlug.reason, slugKey: key };

  const byTitle = lookupTitle(index, row.title);
  const backed = byTitle.ok && byTitle.video.videoId === bySlug.video.videoId;
  return { kind: backed ? 'agreed' : 'confirm', video: bySlug.video, slugKey: key };
}
