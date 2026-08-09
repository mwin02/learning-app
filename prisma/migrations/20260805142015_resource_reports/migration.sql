-- Reports R1: the ResourceReport defect channel (learner-reported dead links,
-- misfiling, wrong duration/difficulty …) alongside ResourceRating.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('dead_link', 'wrong_topic', 'wrong_lesson_fit', 'wrong_duration', 'wrong_difficulty', 'paywalled', 'low_quality', 'other');

-- CreateEnum
CREATE TYPE "ReportState" AS ENUM ('open', 'auto_resolved', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "ResourceReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "lessonId" TEXT,
    "category" "ReportCategory" NOT NULL,
    "note" TEXT,
    "state" "ReportState" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceReport_state_createdAt_idx" ON "ResourceReport"("state", "createdAt");

-- CreateIndex
CREATE INDEX "ResourceReport_resourceId_idx" ON "ResourceReport"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReport_userId_resourceId_category_key" ON "ResourceReport"("userId", "resourceId", "category");

-- AddForeignKey
ALTER TABLE "ResourceReport" ADD CONSTRAINT "ResourceReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReport" ADD CONSTRAINT "ResourceReport_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReport" ADD CONSTRAINT "ResourceReport_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
