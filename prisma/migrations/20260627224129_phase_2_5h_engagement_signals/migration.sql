-- Phase 2.5h: persist raw YouTube engagement signals + channel-level source
-- resolution, so trustScore is recomputable and youtube.com URLs stop colliding
-- onto one seeded channel row.
--
-- NOTE: `prisma migrate diff` prepended `DROP INDEX "Resource_embedding_idx";`
-- here. That is the hnsw pgvector index over Resource.embedding, created in raw
-- SQL (AR-1 migration) because Prisma can't model an Unsupported("vector(768)")
-- index — so every diff reads it as drift and tries to drop it. Dropping it
-- breaks searchResources' semantic search. The DROP line is intentionally OMITTED
-- (see AGENTS.md "Migrations: never drop the hand-written indexes Prisma can't
-- model"). The index is left untouched.

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "likeCount" INTEGER,
ADD COLUMN     "viewCount" INTEGER,
ADD COLUMN     "youtubeChannelId" TEXT;

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "youtubeChannelId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Source_youtubeChannelId_key" ON "Source"("youtubeChannelId");
