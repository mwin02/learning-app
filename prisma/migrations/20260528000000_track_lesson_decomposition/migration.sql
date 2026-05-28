-- CreateEnum
CREATE TYPE "DecompositionStatus" AS ENUM ('atomic', 'decomposed', 'pending', 'unsupported', 'human_review');

-- CreateEnum
CREATE TYPE "TrackStatus" AS ENUM ('pending', 'building', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "LessonResourceRole" AS ENUM ('primary', 'alternate');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('embed', 'newtab', 'native');

-- CreateEnum
CREATE TYPE "ExerciseKind" AS ENUM ('text', 'mcq');

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "decompositionStatus" "DecompositionStatus" NOT NULL DEFAULT 'atomic',
ADD COLUMN     "orderInParent" INTEGER,
ADD COLUMN     "parentResourceId" TEXT;

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "status" "TrackStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "orderInTrack" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "conceptsTaught" TEXT[],
    "estMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonResource" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "role" "LessonResourceRole" NOT NULL DEFAULT 'primary',
    "deliveryMode" "DeliveryMode" NOT NULL,
    "segmentRef" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exercise" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "kind" "ExerciseKind" NOT NULL,
    "origin" "Origin" NOT NULL DEFAULT 'agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exercise_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Track_pathId_key" ON "Track"("pathId");

-- CreateIndex
CREATE UNIQUE INDEX "Lesson_trackId_orderInTrack_key" ON "Lesson"("trackId", "orderInTrack");

-- CreateIndex
CREATE INDEX "LessonResource_lessonId_idx" ON "LessonResource"("lessonId");

-- CreateIndex
CREATE INDEX "LessonResource_resourceId_idx" ON "LessonResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "LessonResource_lessonId_resourceId_key" ON "LessonResource"("lessonId", "resourceId");

-- CreateIndex
CREATE INDEX "Exercise_lessonId_idx" ON "Exercise"("lessonId");

-- CreateIndex
CREATE INDEX "Resource_parentResourceId_idx" ON "Resource"("parentResourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_parentResourceId_orderInParent_key" ON "Resource"("parentResourceId", "orderInParent");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_parentResourceId_fkey" FOREIGN KEY ("parentResourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "Path"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonResource" ADD CONSTRAINT "LessonResource_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonResource" ADD CONSTRAINT "LessonResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
