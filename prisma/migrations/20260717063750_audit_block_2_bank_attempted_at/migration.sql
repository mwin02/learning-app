-- Audit 3.3 (action-plan Block 2): stamp for failed/empty concept-bank generation
-- attempts, so backfill stops re-paying a Pro call per course request for a
-- pathological concept. Nullable, no default — never-attempted concepts stay null.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "bankAttemptedAt" TIMESTAMP(3);
