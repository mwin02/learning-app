-- Decomposer-agent Block 1: free-text frontier-concept requests on CourseRequest.
-- The worker executes each via addFrontierConcept once the Path is spine_ready,
-- before buildTrack; empty for every request until the decompose-agent populates it.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "frontierConcepts" TEXT[] DEFAULT ARRAY[]::TEXT[];
