-- CreateEnum
CREATE TYPE "RemediationState" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'escalated');

-- NOTE: Prisma re-reads the raw-SQL hnsw index "Resource_embedding_idx" as drift
-- and prepended `DROP INDEX "Resource_embedding_idx";` here. Dropping it is wrong —
-- it's the pgvector semantic-search index searchResources depends on (see AGENTS.md).
-- Line deleted intentionally.

-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "primaryRelaxed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RemediationJob" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "state" "RemediationState" NOT NULL DEFAULT 'queued',
    "claimedAt" TIMESTAMP(3),
    "holeSlugs" TEXT[],
    "relaxedConceptSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escalatedConceptSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemediationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemediationJob_pathId_idx" ON "RemediationJob"("pathId");

-- CreateIndex (partial unique — single-flight: at most one active job per Path).
-- Prisma can't model a partial index, so it's hand-written here. A concurrent
-- claim of an already-active Path violates this and surfaces as P2002, which
-- claimRemediationJob maps to { busy }. Terminal-state rows don't block re-claim.
CREATE UNIQUE INDEX "RemediationJob_active_per_path" ON "RemediationJob"("pathId") WHERE "state" IN ('queued', 'running');

-- AddForeignKey
ALTER TABLE "RemediationJob" ADD CONSTRAINT "RemediationJob_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;
