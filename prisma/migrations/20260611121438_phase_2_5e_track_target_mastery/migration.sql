-- Phase 2.5e: the learner's target mastery for a Track (beginner/intermediate/
-- advanced). Reuses the Difficulty enum; drives composer depth + difficulty-match.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "targetMastery" "Difficulty";
