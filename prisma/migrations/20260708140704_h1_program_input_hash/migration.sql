-- H1 (creation-route hardening, audit 1.1): Program.inputHash — the idempotency
-- fingerprint of the normalized creation payload (programInputHash), matched by
-- findRecentDuplicate to make a duplicate submit return the existing Program —
-- plus the [userId, createdAt] index serving the per-user metering scans
-- (programQuota, programBurst, findRecentDuplicate).
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- AlterTable
ALTER TABLE "Program" ADD COLUMN     "inputHash" TEXT;

-- CreateIndex
CREATE INDEX "Program_userId_createdAt_idx" ON "Program"("userId", "createdAt");
