-- NOTE (AGENTS.md): Prisma generated `DROP INDEX "Resource_embedding_idx";` here and it
-- was DELETED before this migration was ever applied. That hnsw index over the
-- Unsupported("vector(768)") `embedding` column is invisible to Prisma, so every
-- `migrate dev` reads it as drift and tries to drop it. It backs pgvector semantic
-- search (searchResources' ranked path) — dropping it is always wrong.

-- CreateEnum
CREATE TYPE "TopicFilingOrigin" AS ENUM ('inherited', 'discovery', 'classifier', 'collision', 'review');

-- CreateTable
CREATE TABLE "ResourceTopic" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "relevance" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "origin" "TopicFilingOrigin" NOT NULL DEFAULT 'classifier',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "contested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceTopic_topic_resourceId_idx" ON "ResourceTopic"("topic", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceTopic_resourceId_topic_key" ON "ResourceTopic"("resourceId", "topic");

-- AddForeignKey
ALTER TABLE "ResourceTopic" ADD CONSTRAINT "ResourceTopic_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
