-- CreateEnum
CREATE TYPE "CourseRequestStatus" AS ENUM ('queued', 'running', 'fulfilled', 'failed');

-- NOTE: Prisma re-detected the hand-written pgvector hnsw index
-- `Resource_embedding_idx` as drift and tried to DROP it here. That index is the
-- semantic-search index `searchResources` depends on; it is intentionally invisible
-- to Prisma (Unsupported("vector(768)") column). The generated `DROP INDEX
-- "Resource_embedding_idx";` line was deleted by hand. See AGENTS.md.

-- CreateTable
CREATE TABLE "CourseRequest" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "userId" TEXT,
    "priorKnowledge" TEXT,
    "goal" TEXT,
    "timeframeWeeks" INTEGER,
    "hoursPerWeek" INTEGER,
    "targetMastery" "Difficulty",
    "status" "CourseRequestStatus" NOT NULL DEFAULT 'queued',
    "claimedAt" TIMESTAMP(3),
    "trackId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseRequest_status_createdAt_idx" ON "CourseRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "CourseRequest" ADD CONSTRAINT "CourseRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRequest" ADD CONSTRAINT "CourseRequest_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
