-- CreateEnum
CREATE TYPE "ProgramStatus" AS ENUM ('planning', 'building', 'ready', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "PriorityTier" AS ENUM ('core', 'nice_to_have');

-- NOTE (per AGENTS.md): Prisma re-emits `DROP INDEX "Resource_embedding_idx";`
-- as drift on every migration because it can't model the hnsw index over the
-- Unsupported("vector(768)") embedding column (the pgvector index searchResources
-- depends on). That DROP has been intentionally deleted here — do NOT restore it.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "programId" TEXT;

-- CreateTable
CREATE TABLE "Program" (
    "id" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "background" TEXT,
    "totalHoursPerWeek" INTEGER NOT NULL,
    "totalWeeks" INTEGER NOT NULL,
    "antiList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProgramStatus" NOT NULL DEFAULT 'planning',
    "error" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramPath" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "trackId" TEXT,
    "phaseLabel" TEXT NOT NULL,
    "orderInProgram" INTEGER NOT NULL,
    "priorityTier" "PriorityTier" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramPath_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProgramPath_trackId_idx" ON "ProgramPath"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramPath_programId_topic_key" ON "ProgramPath"("programId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramPath_programId_orderInProgram_key" ON "ProgramPath"("programId", "orderInProgram");

-- CreateIndex
CREATE INDEX "CourseRequest_programId_idx" ON "CourseRequest"("programId");

-- AddForeignKey
ALTER TABLE "CourseRequest" ADD CONSTRAINT "CourseRequest_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Program" ADD CONSTRAINT "Program_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramPath" ADD CONSTRAINT "ProgramPath_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramPath" ADD CONSTRAINT "ProgramPath_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
