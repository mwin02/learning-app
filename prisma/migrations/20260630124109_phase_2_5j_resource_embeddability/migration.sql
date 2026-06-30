-- NOTE: Prisma regenerates a `DROP INDEX "Resource_embedding_idx"` here every
-- migration because the hnsw vector index is hand-written SQL it can't model (see
-- AGENTS.md). Dropping it breaks pgvector semantic search — intentionally removed.

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "embedCheckedAt" TIMESTAMP(3),
ADD COLUMN     "embeddable" BOOLEAN;
