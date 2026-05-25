/*
  Warnings:

  - You are about to drop the column `source` on the `Resource` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "Origin" AS ENUM ('seed', 'agent', 'user');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('official_docs', 'educator', 'course_platform', 'textbook', 'community');

-- AlterTable
ALTER TABLE "Resource" DROP COLUMN "source",
ADD COLUMN     "attribution" TEXT,
ADD COLUMN     "origin" "Origin" NOT NULL DEFAULT 'seed',
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5;

-- DropEnum
DROP TYPE "ResourceSource";

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_slug_key" ON "Source"("slug");

-- CreateIndex
CREATE INDEX "Source_kind_idx" ON "Source"("kind");

-- CreateIndex
CREATE INDEX "Resource_sourceId_idx" ON "Resource"("sourceId");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
