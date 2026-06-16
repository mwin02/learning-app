-- NOTE: Prisma re-emits `DROP INDEX "Resource_embedding_idx"` here because the
-- hnsw pgvector index is created in raw SQL (AR-1) and can't be modeled, so it
-- always reads as drift. Dropping it would destroy the semantic-search index
-- `searchResources` depends on — removed per AGENTS.md. This migration only adds
-- the Section table + Lesson.sectionId.

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "sectionId" TEXT;

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "orderInTrack" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Section_trackId_idx" ON "Section"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "Section_trackId_orderInTrack_key" ON "Section"("trackId", "orderInTrack");

-- CreateIndex
CREATE INDEX "Lesson_sectionId_idx" ON "Lesson"("sectionId");

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
