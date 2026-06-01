-- Phase 2.5-AR (AR-1): pgvector semantic search over Resources.
-- Portable SQL (no Prisma postgresqlExtensions preview feature) so the same
-- migration runs on Supabase now and on Cloud Run Postgres later.
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable: 768-dim embedding (text-embedding-005) + staleness timestamp.
ALTER TABLE "Resource" ADD COLUMN     "embedding" vector(768),
ADD COLUMN     "embeddedAt" TIMESTAMP(3);

-- Semantic search index. hnsw needs no training step (unlike ivfflat, which
-- requires a populated table) and is queried via the cosine distance operator
-- (<=>). Near-cosmetic until AR-2's searchResources runs against it, but ships
-- with the column so the index exists before the library grows.
CREATE INDEX "Resource_embedding_idx" ON "Resource" USING hnsw ("embedding" vector_cosine_ops);
