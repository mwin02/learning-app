-- NOTE (AGENTS.md): Prisma generated `DROP INDEX "Resource_embedding_idx";` here and it
-- was DELETED before this migration was ever applied. That hnsw index over the
-- Unsupported("vector(768)") `embedding` column is invisible to Prisma, so every
-- `migrate dev` reads it as drift and tries to drop it. It backs pgvector semantic
-- search (searchResources' ranked path) — dropping it is always wrong.

-- CreateTable
CREATE TABLE "TopicCentroid" (
    "topic" TEXT NOT NULL,
    "centroid" vector(768) NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicCentroid_pkey" PRIMARY KEY ("topic")
);
