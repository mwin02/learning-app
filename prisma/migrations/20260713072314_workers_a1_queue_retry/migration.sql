-- Workers-A1: CourseRequest queue retry primitives. `attempts` (claims consumed,
-- incremented at claim — D3), `nextAttemptAt` (earliest next claim, null =
-- immediately claimable — D2/D10), `claimedBy` (worker identity at claim,
-- observability only — D6).
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);
