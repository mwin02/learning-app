-- Phase 2.5g-7: retire PathItem + the Path user-specific columns. Path is now an
-- input-agnostic concept map ({ topic, status } + relations); the per-learner
-- columns moved to Track at the cutover.

-- DropForeignKey
ALTER TABLE "Path" DROP CONSTRAINT "Path_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PathItem" DROP CONSTRAINT "PathItem_pathId_fkey";

-- DropForeignKey
ALTER TABLE "PathItem" DROP CONSTRAINT "PathItem_resourceId_fkey";

-- DropIndex
DROP INDEX "Path_createdById_idx";

-- NOTE: Prisma re-detected the hand-written pgvector hnsw index
-- `Resource_embedding_idx` as drift and tried to DROP it here. That index backs
-- searchResources' semantic search and is intentionally invisible to Prisma
-- (Unsupported("vector(768)") column). The generated `DROP INDEX
-- "Resource_embedding_idx";` line was deleted by hand. See AGENTS.md.

-- AlterTable
ALTER TABLE "Path" DROP COLUMN "createdById",
DROP COLUMN "difficulty",
DROP COLUMN "inputHoursPerWeek",
DROP COLUMN "inputPriorKnowledge",
DROP COLUMN "inputTimeframeWeeks",
DROP COLUMN "summary",
DROP COLUMN "title";

-- DropTable
DROP TABLE "PathItem";

-- DropEnum
DROP TYPE "PathItemStatus";
