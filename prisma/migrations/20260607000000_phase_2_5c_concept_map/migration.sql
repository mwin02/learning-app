-- Phase 2.5c — Topic Concept Map + Track Traversal: additive schema + inert re-keys.
--
-- New tables: Concept / ConceptPrereq / ConceptResource (the Path-scoped concept
-- DAG that replaces PathItem as the curriculum record at the 2.5f cutover).
-- Re-keys on the INERT delivery tables (Track / Progress / EnrolledPath — zero
-- runtime consumers today, all empty), so the destructive ops below are free.
-- Path/PathItem and path-service stay live and untouched aside from the additive
-- Path.status + @@unique([topic]).
--
-- NOTE: the `lessonId NOT NULL` (Progress) and `trackId NOT NULL` PK (EnrolledPath)
-- carry no DEFAULT and no backfill — safe ONLY because both tables are empty. Do
-- not copy this pattern onto a populated table.

-- CreateEnum
CREATE TYPE "PathStatus" AS ENUM ('draft', 'building', 'spine_ready', 'failed');

-- CreateEnum
CREATE TYPE "ConceptMembership" AS ENUM ('spine', 'frontier');

-- CreateEnum
CREATE TYPE "ConceptResourceRole" AS ENUM ('teaches', 'uses', 'assesses');

-- DropForeignKey
ALTER TABLE "Progress" DROP CONSTRAINT "Progress_pathItemId_fkey";

-- DropIndex
DROP INDEX "Path_topic_idx";

-- DropIndex
DROP INDEX "Progress_pathItemId_idx";

-- DropIndex
DROP INDEX "Track_pathId_key";

-- AlterTable
ALTER TABLE "EnrolledPath" DROP CONSTRAINT "EnrolledPath_pkey",
ADD COLUMN     "trackId" TEXT NOT NULL,
ADD CONSTRAINT "EnrolledPath_pkey" PRIMARY KEY ("userId", "trackId");

-- AlterTable
ALTER TABLE "Path" ADD COLUMN     "status" "PathStatus" NOT NULL DEFAULT 'draft';

-- AlterTable
ALTER TABLE "Progress" DROP CONSTRAINT "Progress_pkey",
DROP COLUMN "pathItemId",
ADD COLUMN     "lessonId" TEXT NOT NULL,
ADD CONSTRAINT "Progress_pkey" PRIMARY KEY ("userId", "lessonId");

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "hoursPerWeek" INTEGER,
ADD COLUMN     "priorKnowledge" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "timeframeWeeks" INTEGER,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "membership" "ConceptMembership" NOT NULL DEFAULT 'spine',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptPrereq" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "fromConceptId" TEXT NOT NULL,
    "toConceptId" TEXT NOT NULL,

    CONSTRAINT "ConceptPrereq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptResource" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "role" "ConceptResourceRole" NOT NULL DEFAULT 'teaches',
    "coverageScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Concept_pathId_membership_idx" ON "Concept"("pathId", "membership");

-- CreateIndex
CREATE UNIQUE INDEX "Concept_pathId_slug_key" ON "Concept"("pathId", "slug");

-- CreateIndex
CREATE INDEX "ConceptPrereq_toConceptId_idx" ON "ConceptPrereq"("toConceptId");

-- CreateIndex
CREATE INDEX "ConceptPrereq_pathId_idx" ON "ConceptPrereq"("pathId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptPrereq_fromConceptId_toConceptId_key" ON "ConceptPrereq"("fromConceptId", "toConceptId");

-- Self-loop guard: a concept can never be its own prerequisite. Cycle-freeness
-- beyond self-loops is a DAG invariant the map-builder validates at write time
-- (Postgres can't express a transitive-closure constraint); this CHECK catches
-- the degenerate one-node cycle cheaply at the DB.
ALTER TABLE "ConceptPrereq" ADD CONSTRAINT "ConceptPrereq_no_self_loop" CHECK ("fromConceptId" <> "toConceptId");

-- CreateIndex
CREATE INDEX "ConceptResource_conceptId_idx" ON "ConceptResource"("conceptId");

-- CreateIndex
CREATE INDEX "ConceptResource_resourceId_idx" ON "ConceptResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptResource_conceptId_resourceId_key" ON "ConceptResource"("conceptId", "resourceId");

-- CreateIndex
CREATE INDEX "EnrolledPath_trackId_idx" ON "EnrolledPath"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "Path_topic_key" ON "Path"("topic");

-- CreateIndex
CREATE INDEX "Progress_lessonId_idx" ON "Progress"("lessonId");

-- CreateIndex
CREATE INDEX "Track_pathId_idx" ON "Track"("pathId");

-- AddForeignKey
ALTER TABLE "EnrolledPath" ADD CONSTRAINT "EnrolledPath_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Progress" ADD CONSTRAINT "Progress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Concept" ADD CONSTRAINT "Concept_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptPrereq" ADD CONSTRAINT "ConceptPrereq_fromConceptId_fkey" FOREIGN KEY ("fromConceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptPrereq" ADD CONSTRAINT "ConceptPrereq_toConceptId_fkey" FOREIGN KEY ("toConceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptResource" ADD CONSTRAINT "ConceptResource_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptResource" ADD CONSTRAINT "ConceptResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
