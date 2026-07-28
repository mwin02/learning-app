// Phase 2.5-AR (AR-1): Resource embeddings for semantic search.
//
// The `Resource.embedding` column is a pgvector type Prisma can't model, so
// all reads/writes go through raw SQL here. Embeddings are produced by the
// Vertex text-embedding model in the registry (text-embedding-005, 768 dims)
// over `title + summary + conceptsTaught`.
//
// Two entry points:
//   - `embedMissing()` — bulk backfill of null/stale rows. Used by the seed
//     and by scripts/embed-resources.ts.
//   - `safeEmbedResource()` — best-effort embed of one freshly-inserted row.
//     Used at web-fallback insert time; never throws, so an embedding failure
//     can't poison a discovery insert (the row is still useful, just unranked
//     until the next backfill catches it via `embeddedAt < updatedAt`).

import { embedMany } from 'ai';
import { prisma } from '@/lib/db';
import { getEmbeddingModel } from '@/lib/ai/models';
import type { PrismaClient } from '@prisma/client';

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Vertex text-embedding accepts large batches, but chunking bounds the blast
// radius of a single failing call and keeps memory predictable on backfill.
const BATCH = 100;

type EmbeddingFields = {
  title: string;
  summary: string;
  conceptsTaught: string[];
};

// Single source of truth for what gets embedded. Backfill and insert-time
// embedding MUST agree, or stale-detection and search would compare vectors
// built from different text.
export function buildEmbeddingText(r: EmbeddingFields): string {
  const concepts = r.conceptsTaught.length
    ? `\nConcepts: ${r.conceptsTaught.join(', ')}`
    : '';
  return `${r.title}\n${r.summary}${concepts}`;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const { model, dimensions } = getEmbeddingModel();
  const { embeddings } = await embedMany({ model, values: texts });
  for (const v of embeddings) {
    if (v.length !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: model returned ${v.length}, column expects ${dimensions}. ` +
          `Check the MODEL_EMBEDDING override matches the vector(${dimensions}) migration.`,
      );
    }
  }
  return embeddings;
}

// Embed a single search query into the same space as Resource embeddings, for
// the ranked path of `searchResources`. Thin wrapper over embedTexts so query
// and corpus go through identical model + dimension checks.
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

// pgvector accepts a text literal of the form `[0.1,0.2,...]` cast to ::vector.
//
// `client` lets a caller enlist this write in its own interactive transaction — T2a's
// pre-insert embedding writes the vector in the same transaction that creates the row
// (src/lib/agents/decomposition/upsert-resource.ts), so a discovery row is never briefly
// visible unembedded.
//
// ⚠️ `GREATEST("updatedAt", now())`, not bare `now()`: inside a transaction `now()` is
// TRANSACTION-START time, while Prisma stamps `updatedAt` client-side when the row is
// created — so a bare `now()` can land `embeddedAt < updatedAt` and make embedMissing()
// re-embed every freshly-inserted row on the next backfill.
export async function storeEmbedding(
  id: string,
  vec: number[],
  client: TxClient = prisma,
): Promise<void> {
  const literal = `[${vec.join(',')}]`;
  await client.$executeRaw`
    UPDATE "Resource"
    SET embedding = ${literal}::vector, "embeddedAt" = GREATEST("updatedAt", now())
    WHERE id = ${id}
  `;
}

type MissingRow = {
  id: string;
  title: string;
  summary: string;
  conceptsTaught: string[];
};

// Embeds every row that has never been embedded or whose content changed since
// its last embed (`embeddedAt < updatedAt`). Returns how many it embedded.
export async function embedMissing(): Promise<number> {
  const rows = await prisma.$queryRaw<MissingRow[]>`
    SELECT id, title, summary, "conceptsTaught"
    FROM "Resource"
    WHERE embedding IS NULL
       OR "embeddedAt" IS NULL
       OR "embeddedAt" < "updatedAt"
  `;
  if (rows.length === 0) return 0;

  let embedded = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vecs = await embedTexts(chunk.map(buildEmbeddingText));
    for (let j = 0; j < chunk.length; j++) {
      await storeEmbedding(chunk[j].id, vecs[j]);
    }
    embedded += chunk.length;
  }
  return embedded;
}

// Topic filing T2a: embed a whole discovery batch BEFORE any row is inserted, so the
// filing guardrail (T2b) has its input at filing time rather than post-commit. One
// embedMany call for the batch — cheaper than the N sequential post-commit calls it
// replaces, which also pays for the rows that turn out to be URL-dedup skips.
//
// Best-effort, like safeEmbedResource: a failure returns all-nulls and logs, so
// discovery degrades to "no embedding yet" (the guardrail defers, the post-commit
// embed still runs) instead of losing the finds.
export async function safeEmbedBatch(
  rows: EmbeddingFields[],
): Promise<(number[] | null)[]> {
  if (rows.length === 0) return [];
  try {
    return await embedTexts(rows.map(buildEmbeddingText));
  } catch (err) {
    console.log('[embeddings] pre-insert batch embed failed', {
      count: rows.length,
      error: (err as Error).message,
    });
    return rows.map(() => null);
  }
}

// Best-effort single-row embed for insert paths. Swallows + logs errors so the
// caller's insert is never rolled back by an embedding hiccup.
export async function safeEmbedResource(
  id: string,
  fields: EmbeddingFields,
): Promise<void> {
  try {
    const [vec] = await embedTexts([buildEmbeddingText(fields)]);
    await storeEmbedding(id, vec);
  } catch (err) {
    console.log('[embeddings] embed-on-insert failed', {
      id,
      error: (err as Error).message,
    });
  }
}
