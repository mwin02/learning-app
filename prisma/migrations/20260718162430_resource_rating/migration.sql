-- Free-beta A1: ResourceRating — resource-global ±1 learner votes (one per user
-- per resource), the raw evidence behind the vote EvidenceSignal that
-- recomputeResourceTrust blends into Resource.trustScore.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- CreateTable
CREATE TABLE "ResourceRating" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceRating_resourceId_idx" ON "ResourceRating"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceRating_userId_resourceId_key" ON "ResourceRating"("userId", "resourceId");

-- AddForeignKey
ALTER TABLE "ResourceRating" ADD CONSTRAINT "ResourceRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceRating" ADD CONSTRAINT "ResourceRating_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
