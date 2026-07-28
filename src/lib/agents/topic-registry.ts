// Phase 2.5-AR (AR-5): persisted topic canonicalization registry.
//
// Backs the topic gate's LLM tier so it stops re-minting near-duplicate slugs
// for the same concept ("go" one run, "golang" the next) — a drift that
// fragments the Resource library, which keys on an exact `topic` match.
//
// A row maps one normalized input phrasing (`alias`) to the canonical slug it
// resolved to. The gate consults this before calling the model (a repeat
// phrasing short-circuits for free) and, on a fresh mint, records the mapping.
// The set of canonical slugs the gate grounds the model on is the distinct
// `canonical` values here UNION the curated TOPIC_SLUGS — curated topics stay
// code-owned (src/types/resource.ts) and are never written here.

import { prisma } from '@/lib/db';
import { TOPIC_SLUGS } from '@/types/resource';

export type TopicSubject = 'math' | 'science' | 'cs';

// The alias key. Lowercasing + whitespace-collapsing maximizes cache hits so
// "Go", " go " and "go" all resolve to one row.
export function normalizeTopic(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Longer emissions are truncated (not rejected) — a verbose but valid topic
// shouldn't be turned away. 64 chars is ample for a real topic slug.
const MAX_CANONICAL_SLUG_LEN = 64;

// Safety net over the LLM-minted canonical slug (AR-5 tier 3): the model is asked
// for kebab-case but that's prompt-only, and whatever it returns is frozen forever
// as Path.topic / CourseRequest.topic / a first-writer-wins TopicAlias. Coerce it to
// a safe slug — ASCII-fold accents, lowercase, collapse every run of non-alphanumerics
// to a single hyphen, strip leading/trailing hyphens, cap the length. Returns '' when
// nothing usable survives (empty or all-punctuation), which the gate treats as an
// invalid verdict. Pure; unit-tested.
export function toCanonicalSlug(input: string): string {
  const slug = input
    .normalize('NFKD') // decompose accents: "ö" → "o" + combining diaeresis
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks so accents fold: "schrodinger", not "schro-dinger"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → one hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  if (slug.length <= MAX_CANONICAL_SLUG_LEN) return slug;
  return slug.slice(0, MAX_CANONICAL_SLUG_LEN).replace(/-+$/g, ''); // re-trim after the cut
}

// Topic filing T1.5 — the anti-drift guard on a tier-3 mint.
//
// AR-5 exists to stop the gate minting near-duplicate slugs for one concept, but it
// leaked twice: `TopicAlias` held `data-structures-and-algorithms` alongside the curated
// `data-structures-algorithms`, and `probability` alongside `probability-and-statistics`
// — two canonicals over one pool each. `relatedTopics` keys off the exact slug and the
// Resource library keys off an exact `topic` match, so a twin silently splits a shelf.
// scripts/merge-topic-twins.ts cleans those two up; this stops the next one.
//
// The rule: a mint snaps onto a known slug when their NON-STOPWORD TOKEN SETS are equal.
// That catches the filler-word twin (the motivating case differs only by "and", which a
// plain de-hyphenated comparison misses: "datastructuresandalgorithms" ≠
// "datastructuresalgorithms") and reordering ("algorithms-and-data-structures").
//
// The safety property that makes this conservative enough to run unattended: any extra
// CONTENT token blocks the snap. So deliberately-scoped mints survive — the F7
// reconciler's `calculus-for-machine-learning` is {calculus,machine,learning}, not
// {machine,learning}, and `probability-and-statistics` is not `statistics`. Edit
// distance was rejected for the opposite reason: on slugs this short it merges genuinely
// distinct topics (`python`/`pytorch` is distance 3, `calculus`/`calculus-2` is 2).
const SLUG_STOPWORDS = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'to', 'a', 'an', 'with']);

function tokenKey(slug: string): string {
  const tokens = slug.split('-').filter((t) => t.length > 0 && !SLUG_STOPWORDS.has(t));
  // Set, not sequence: order-insensitive, and a repeated token doesn't change identity.
  return [...new Set(tokens)].sort().join(' ');
}

// `known` is the vocabulary to snap onto — pass listCanonicals() (curated ∪ learned), as
// the gate does. Curated TOPIC_SLUGS win ties: a code-owned slug is the canonical form by
// definition, which is the direction the twin merge also resolves.
export function snapToKnownSlug(slug: string, known: readonly string[]): string {
  if (!slug) return slug;
  // An exact hit is already canonical; nothing to snap.
  if (known.includes(slug)) return slug;
  const key = tokenKey(slug);
  // All-stopword input has no content to match on — never snap it onto another
  // all-stopword slug.
  if (!key) return slug;

  const matches = known.filter((k) => k !== slug && tokenKey(k) === key).sort();
  if (matches.length === 0) return slug;
  const curated = matches.find((m) => (TOPIC_SLUGS as readonly string[]).includes(m));
  return curated ?? matches[0];
}

// Cached canonicalization for a previously-seen phrasing, or null on a miss.
export async function lookupAlias(
  normalized: string,
): Promise<{ canonical: string; subject: string } | null> {
  const row = await prisma.topicAlias.findUnique({
    where: { alias: normalized },
    select: { canonical: true, subject: true },
  });
  return row;
}

// The vocabulary the gate grounds the model on: curated slugs plus every
// canonical learned so far, de-duplicated and sorted for a stable prompt.
export async function listCanonicals(): Promise<string[]> {
  const rows = await prisma.topicAlias.findMany({
    distinct: ['canonical'],
    select: { canonical: true },
  });
  const learned = rows.map((r) => r.canonical);
  return [...new Set<string>([...TOPIC_SLUGS, ...learned])].sort();
}

// Persist a fresh canonicalization. Records both the input phrasing AND the
// canonical's own self-alias, so the next time either form arrives it
// short-circuits the model. Idempotent (upsert on the unique `alias`), so
// concurrent cold runs of the same topic race harmlessly.
export async function recordCanonicalization(args: {
  alias: string;
  canonical: string;
  subject: TopicSubject;
}): Promise<void> {
  const { alias, canonical, subject } = args;
  const rows = [{ alias, canonical, subject }];
  if (alias !== canonical) rows.push({ alias: canonical, canonical, subject });

  await prisma.$transaction(
    rows.map((r) =>
      prisma.topicAlias.upsert({
        where: { alias: r.alias },
        create: r,
        update: {}, // first writer wins; an existing mapping is never overwritten
      }),
    ),
  );
}

// Phase F7: repoint every alias that resolves to `from` so it resolves to `to`. Used
// by the plan-pass scoped-topic reconciler to CORRECT a mint: when the gate minted a
// scoped canonical (e.g. `calculus-for-machine-learning`) that reconciliation folds
// into an existing library topic (`calculus`), this repoints both the gate's
// phrasing→scoped row and its self-alias to the existing topic — so the same scoped
// phrasing short-circuits at tier 2 next time. A deliberate override of
// recordCanonicalization's first-writer-wins (a correction, not a race). Returns the
// number of alias rows repointed. No-op when `from === to`.
export async function repointCanonical(from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const { count } = await prisma.topicAlias.updateMany({
    where: { canonical: from },
    data: { canonical: to },
  });
  return count;
}
