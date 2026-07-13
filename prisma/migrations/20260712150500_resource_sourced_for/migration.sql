-- Library re-judge Block 1: ResourceSourcedFor — sourcing provenance join table
-- (which Concept's demand caused a parked/non-atomic resource to be sourced).
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- CreateTable
CREATE TABLE "ResourceSourcedFor" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceSourcedFor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceSourcedFor_conceptId_idx" ON "ResourceSourcedFor"("conceptId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceSourcedFor_resourceId_conceptId_key" ON "ResourceSourcedFor"("resourceId", "conceptId");

-- AddForeignKey
ALTER TABLE "ResourceSourcedFor" ADD CONSTRAINT "ResourceSourcedFor_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSourcedFor" ADD CONSTRAINT "ResourceSourcedFor_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;
