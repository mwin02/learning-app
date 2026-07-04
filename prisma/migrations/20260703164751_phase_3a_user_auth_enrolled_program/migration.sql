/*
  Warnings:

  - You are about to drop the `EnrolledPath` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `email` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- DropForeignKey
ALTER TABLE "EnrolledPath" DROP CONSTRAINT "EnrolledPath_pathId_fkey";

-- DropForeignKey
ALTER TABLE "EnrolledPath" DROP CONSTRAINT "EnrolledPath_trackId_fkey";

-- DropForeignKey
ALTER TABLE "EnrolledPath" DROP CONSTRAINT "EnrolledPath_userId_fkey";

-- NOTE: Prisma generated a `DROP INDEX "Resource_embedding_idx"` here because the
-- hnsw index (created in raw SQL in the AR-1 migration — Prisma can't model indexes
-- on Unsupported vector columns) always reads as drift. Deleted by hand per
-- AGENTS.md: dropping it would kill pgvector semantic search (searchResources).

-- AlterTable
ALTER TABLE "Program" ADD COLUMN     "description" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "email" TEXT NOT NULL,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'user';

-- DropTable
DROP TABLE "EnrolledPath";

-- CreateTable
CREATE TABLE "EnrolledProgram" (
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrolledProgram_pkey" PRIMARY KEY ("userId","programId")
);

-- CreateIndex
CREATE INDEX "EnrolledProgram_programId_idx" ON "EnrolledProgram"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "EnrolledProgram" ADD CONSTRAINT "EnrolledProgram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrolledProgram" ADD CONSTRAINT "EnrolledProgram_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;
