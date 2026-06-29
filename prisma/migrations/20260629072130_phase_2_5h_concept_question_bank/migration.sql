-- NOTE: Prisma regenerates a `DROP INDEX "Resource_embedding_idx"` here on every
-- migrate because that hnsw index lives in raw SQL (AR-1) it can't model, so it
-- reads it as drift. Dropping it breaks pgvector semantic search — removed per
-- AGENTS.md. Same pattern as 20260602145709_topic_alias_registry.

-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "bankReviewed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ConceptQuestion" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "rubric" TEXT NOT NULL,
    "kind" "ExerciseKind" NOT NULL,
    "origin" "Origin" NOT NULL DEFAULT 'agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConceptQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConceptQuestion_conceptId_idx" ON "ConceptQuestion"("conceptId");

-- AddForeignKey
ALTER TABLE "ConceptQuestion" ADD CONSTRAINT "ConceptQuestion_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
