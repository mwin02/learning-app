-- Reports R5: CourseRequest.replacesTrackId — marks a request as a REBUILD of an
-- existing Track (regenerate-track.ts). Nullable, no FK: the old Track may be
-- cleaned up and the audit record must survive that.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "replacesTrackId" TEXT;
