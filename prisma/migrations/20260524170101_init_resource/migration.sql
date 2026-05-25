-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('article', 'video', 'course', 'interactive', 'docs', 'book');

-- CreateEnum
CREATE TYPE "ResourceTier" AS ENUM ('core', 'optional');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "ResourceSource" AS ENUM ('seed', 'agent', 'user');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('active', 'deprecated', 'pending_review');

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "tier" "ResourceTier" NOT NULL DEFAULT 'core',
    "durationMin" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "prerequisiteConcepts" TEXT[],
    "conceptsTaught" TEXT[],
    "requiresPurchase" BOOLEAN NOT NULL DEFAULT false,
    "source" "ResourceSource" NOT NULL DEFAULT 'seed',
    "status" "ResourceStatus" NOT NULL DEFAULT 'active',
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Resource_slug_key" ON "Resource"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_url_key" ON "Resource"("url");

-- CreateIndex
CREATE INDEX "Resource_topic_status_tier_idx" ON "Resource"("topic", "status", "tier");

-- CreateIndex
CREATE INDEX "Resource_difficulty_idx" ON "Resource"("difficulty");
