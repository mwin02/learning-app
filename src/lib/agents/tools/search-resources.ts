// Phase 2.5-AR (AR-2): hybrid search over the Resource library.
//
// "Hybrid" = structured filters first (topic / difficulty / status /
// pickability), then semantic vector rank *within* that filtered set. Pure
// cosine over the whole table would surface wrong-difficulty items and
// non-pickable container rows, so the filter always gates the rank.
//
// Cost shape (SEARCH_RANK_THRESHOLD): when the filtered set is small enough to
// hand to the agent wholesale, we skip the query embedding entirely and return
// everything ordered by trustScore — today's load-all behavior. Only once a
// topic's pickable set grows past the threshold (which 2.5b's decomposition
// will cause) do we spend an embedding call to rank.
//
// This module is a pure primitive: it takes explicit filters and returns ranked
// rows. The gate/fallback orchestration (when to widen status, when to trigger
// web discovery) lives in the AR-3 retrieval loop, not here.

import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type {
  Difficulty,
  ResourceStatus,
  ResourceType,
  DecompositionStatus,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import { embedQuery } from '@/lib/ai/embeddings';
import { SEARCH_RANK_THRESHOLD, SEARCH_DEFAULT_LIMIT } from '@/lib/config';

export type SearchParams = {
  // Free-text intent to rank by. Optional: omitted (or on a small filtered
  // set) the result is ordered by trustScore instead of semantic distance.
  query?: string;
  topic?: string;
  // Explicit set of topics to filter on (e.g. a topic ∪ its related topics).
  // When provided it takes precedence over `topic`; relation expansion happens
  // in the caller — this primitive only filters on the list it's handed.
  topics?: string[];
  difficulty?: Difficulty;
  types?: ResourceType[];
  statuses?: ResourceStatus[];
  // Explicit decomposition-status filter (e.g. browsing containers in the
  // playground). When set it takes precedence over `pickableOnly`.
  decompositionStatuses?: DecompositionStatus[];
  // Restrict to resources the curriculum agent may actually pick. Pickable ==
  // decompositionStatus 'atomic' (decomposed containers are excluded; their
  // children are themselves 'atomic'). Ignored when `decompositionStatuses`
  // is provided.
  pickableOnly?: boolean;
  // Resource ids that bypass the `statuses` window (but no other filter). Used
  // by the retrieval session to admit resources it discovered this run even on
  // an above-gate topic whose window is active-only — a deliberate per-session
  // exception to the pending-review gate. Empty/omitted = no exception.
  includeIds?: string[];
  // Phase F6: drop `origin = generated` rows (the AI-authored on-ramp lessons).
  // Those enter a concept's candidate set ONLY via the injected map for their OWN
  // concept (attach-candidates); returning them from the ordinary search let one
  // on-ramp article become a candidate — and sometimes the primary — for unrelated
  // sibling concepts. Opt-in (default false) so only the map's attach path excludes
  // them; every other caller (playground, retrieval) is unchanged.
  excludeGenerated?: boolean;
  limit?: number;
};

export type SearchResult = {
  id: string;
  slug: string;
  topic: string;
  title: string;
  url: string;
  type: string;
  tier: string;
  difficulty: string;
  durationMin: number;
  summary: string;
  prerequisiteConcepts: string[];
  conceptsTaught: string[];
  requiresPurchase: boolean;
  trustScore: number;
  decompositionStatus: string;
  // Cosine distance to the query on the ranked path; null on the fast-path and
  // the large-set-no-query path (no embedding was computed).
  distance: number | null;
};

const DEFAULT_STATUSES: ResourceStatus[] = ['active', 'pending_review'];

// Enum columns are cast to text so $queryRaw yields plain strings matching the
// Prisma string-enum representation.
const COLS = Prisma.sql`
  id, slug, topic, title, url,
  type::text AS type, tier::text AS tier, difficulty::text AS difficulty,
  "durationMin", summary, "prerequisiteConcepts", "conceptsTaught",
  "requiresPurchase", "trustScore",
  "decompositionStatus"::text AS "decompositionStatus"
`;

export function buildConditions(params: SearchParams): Prisma.Sql[] {
  const {
    topic,
    topics,
    difficulty,
    types,
    decompositionStatuses,
    pickableOnly = true,
    statuses = DEFAULT_STATUSES,
    includeIds,
    excludeGenerated = false,
  } = params;
  const conds: Prisma.Sql[] = [];
  if (topics && topics.length > 0) {
    conds.push(Prisma.sql`topic IN (${Prisma.join(topics)})`);
  } else if (topic) {
    conds.push(Prisma.sql`topic = ${topic}`);
  }
  if (difficulty) conds.push(Prisma.sql`difficulty::text = ${difficulty}`);
  if (types && types.length > 0) {
    conds.push(Prisma.sql`type::text IN (${Prisma.join(types)})`);
  }
  // An explicit decomposition filter overrides the pickable shortcut so the
  // playground can surface containers / pending / unsupported rows.
  if (decompositionStatuses && decompositionStatuses.length > 0) {
    conds.push(Prisma.sql`"decompositionStatus"::text IN (${Prisma.join(decompositionStatuses)})`);
  } else if (pickableOnly) {
    conds.push(Prisma.sql`"decompositionStatus"::text = 'atomic'`);
  }
  if (statuses.length > 0) {
    // The allowlist relaxes ONLY the status window: an id in it survives even
    // when its status is outside `statuses`, but it still has to pass every
    // other predicate (topic, difficulty, pickability) in the AND above.
    if (includeIds && includeIds.length > 0) {
      conds.push(
        Prisma.sql`(status::text IN (${Prisma.join(statuses)}) OR id IN (${Prisma.join(includeIds)}))`,
      );
    } else {
      conds.push(Prisma.sql`status::text IN (${Prisma.join(statuses)})`);
    }
  }
  // F6: keep AI-generated on-ramp rows out of the ordinary candidate search.
  if (excludeGenerated) {
    conds.push(Prisma.sql`origin::text <> 'generated'`);
  }
  return conds;
}

function whereClause(conds: Prisma.Sql[]): Prisma.Sql {
  return conds.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`
    : Prisma.empty;
}

export async function searchResources(params: SearchParams): Promise<SearchResult[]> {
  const { query, limit = SEARCH_DEFAULT_LIMIT } = params;
  const conds = buildConditions(params);
  const where = whereClause(conds);

  const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "Resource" ${where}
  `;

  // Fast-path: small enough to return wholesale, no embedding spent.
  if (count <= SEARCH_RANK_THRESHOLD) {
    return prisma.$queryRaw<SearchResult[]>`
      SELECT ${COLS}, NULL::float8 AS distance
      FROM "Resource" ${where}
      ORDER BY "trustScore" DESC, id
    `;
  }

  // Large set, no query to rank by: deterministic top-N by trustScore.
  if (!query || query.trim().length === 0) {
    return prisma.$queryRaw<SearchResult[]>`
      SELECT ${COLS}, NULL::float8 AS distance
      FROM "Resource" ${where}
      ORDER BY "trustScore" DESC, id
      LIMIT ${limit}
    `;
  }

  // Ranked path: semantic nearest neighbors within the filtered set. Only rows
  // that actually have an embedding can be ranked; un-embedded rows (e.g. a
  // just-inserted fallback find awaiting backfill) are excluded here.
  const vec = await embedQuery(query);
  const literal = `[${vec.join(',')}]`;
  const rankedWhere = whereClause([...conds, Prisma.sql`embedding IS NOT NULL`]);
  const ranked = await prisma.$queryRaw<SearchResult[]>`
    SELECT ${COLS}, (embedding <=> ${literal}::vector)::float8 AS distance
    FROM "Resource" ${rankedWhere}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;

  // Unambiguous "embeddings not backfilled on this DB" signal: the filter
  // matched candidates but none could be ranked because every one is NULL. In
  // prod this is the tell that scripts/embed-resources.ts hasn't run since the
  // migration. Free to detect (we already have `count`); silent otherwise.
  if (ranked.length === 0 && count > 0) {
    console.warn(
      `[search-resources] ranked query returned 0 of ${count} candidates — ` +
        'embeddings appear unpopulated on this database. Run ' +
        'scripts/embed-resources.ts to backfill.',
    );
  }
  return ranked;
}

// Library re-judge Block 4 (rung 0): distance-gated candidate search. Unlike
// searchResources this ALWAYS ranks (no fast path — the caller needs real
// distances even on a small filtered set, where the fast path would return
// trust-ordered rows of arbitrary relevance) and applies a hard distance
// ceiling, so a far-off row can never enter the result on trust alone.
// Eligibility reuses buildConditions with the rung-0 defaults locked in the
// re-judge plan: statuses ['active','pending_review'], pickableOnly, plus
// excludeGenerated (on-ramp lessons enter only via their own concept's
// injected map). Un-embedded rows can't be ranked and are excluded.
export async function searchNearbyResources(args: {
  topics: string[];
  query: string;
  maxDistance: number;
  limit: number;
  // e.g. rows already attached to the demanding concept.
  excludeIds?: string[];
}): Promise<{ id: string; distance: number }[]> {
  const { topics, query, maxDistance, limit, excludeIds } = args;
  const vec = await embedQuery(query);
  const literal = `[${vec.join(',')}]`;
  const conds = buildConditions({ topics, excludeGenerated: true });
  conds.push(Prisma.sql`embedding IS NOT NULL`);
  conds.push(Prisma.sql`(embedding <=> ${literal}::vector) <= ${maxDistance}`);
  if (excludeIds && excludeIds.length > 0) {
    conds.push(Prisma.sql`id NOT IN (${Prisma.join(excludeIds)})`);
  }
  return prisma.$queryRaw<{ id: string; distance: number }[]>`
    SELECT id, (embedding <=> ${literal}::vector)::float8 AS distance
    FROM "Resource" ${whereClause(conds)}
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;
}

// AI SDK tool wrapper. Not yet wired into any agent — AR-3's retrieval loop
// consumes it (and adds the opaque-handle indirection over the real ids this
// returns). Pickability and the status window are fixed here; the model only
// chooses what to search for and how to scope it.
export const searchResourcesTool = tool({
  description:
    'Search the learning-resource library for pickable resources on a topic, ' +
    'ranked by semantic relevance to the query. Returns atomic (pickable) ' +
    'resources with their concepts, difficulty, duration, and trust score.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('What the resources should cover, e.g. "intro to derivatives and limits".'),
    topic: z.string().optional().describe('Restrict to this topic slug.'),
    difficulty: z
      .enum(['beginner', 'intermediate', 'advanced'])
      .optional()
      .describe('Restrict to this difficulty level.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 30).'),
  }),
  execute: async ({ query, topic, difficulty, limit }) =>
    searchResources({
      query,
      topic,
      difficulty: difficulty as Difficulty | undefined,
      limit,
      pickableOnly: true,
    }),
});
