-- CreateEnum
CREATE TYPE "DurationSource" AS ENUM ('api', 'extracted', 'estimated', 'unknown');

-- Prisma regenerated `DROP INDEX "Resource_embedding_idx"` here and it was deleted by
-- hand: that hnsw index is created in raw SQL (AR-1) over an Unsupported() column, so
-- Prisma reads it as drift every time. Dropping it would take out the pgvector
-- semantic-search index. See .claude/rules/prisma-migrations.md.

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "durationSource" "DurationSource" NOT NULL DEFAULT 'unknown',
ALTER COLUMN "durationMin" DROP NOT NULL;
