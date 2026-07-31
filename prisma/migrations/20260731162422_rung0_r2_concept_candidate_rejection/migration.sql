-- rung0-starvation R2: per-concept rejection memory. One row per library candidate
-- the judge scored and selectAttachable dropped for a concept, so a later sourcing
-- run excludes it from rung 0 instead of re-paying a judge call on it forever.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.
-- (The other hand-written index, the partial unique `RemediationJob_active_per_path`,
-- was NOT flagged by this diff — but the same rule applies if it ever is.)

-- CreateTable
CREATE TABLE "ConceptCandidateRejection" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "coverageScore" DOUBLE PRECISION NOT NULL,
    "judgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptCandidateRejection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConceptCandidateRejection_resourceId_idx" ON "ConceptCandidateRejection"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptCandidateRejection_conceptId_resourceId_key" ON "ConceptCandidateRejection"("conceptId", "resourceId");

-- AddForeignKey
ALTER TABLE "ConceptCandidateRejection" ADD CONSTRAINT "ConceptCandidateRejection_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptCandidateRejection" ADD CONSTRAINT "ConceptCandidateRejection_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
