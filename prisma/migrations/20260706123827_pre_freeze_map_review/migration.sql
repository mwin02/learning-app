-- CreateEnum
CREATE TYPE "MapReviewKind" AS ENUM ('duplication', 'hollow', 'granularity');

-- CreateEnum
CREATE TYPE "PathReviewResolution" AS ENUM ('merged', 'dismissed', 'kept');

-- NOTE (AGENTS.md): the regenerated `DROP INDEX "Resource_embedding_idx";` that
-- Prisma prepends here has been DELETED. That hnsw index is hand-written in raw SQL
-- (Prisma can't model the Unsupported("vector(768)") column), so every migrate dev
-- reads it as drift and tries to drop it. Dropping it breaks searchResources'
-- pgvector semantic search. This migration only adds the PathReview table + enums.

-- CreateTable
CREATE TABLE "PathReview" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "kind" "MapReviewKind" NOT NULL,
    "conceptSlugs" TEXT[],
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution" "PathReviewResolution",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PathReview_pathId_resolved_idx" ON "PathReview"("pathId", "resolved");

-- AddForeignKey
ALTER TABLE "PathReview" ADD CONSTRAINT "PathReview_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;
