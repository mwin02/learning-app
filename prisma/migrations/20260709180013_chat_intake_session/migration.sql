-- Chat intake Block 1: IntakeSession — rate-limit anchor + server-authoritative
-- draft/turn state for the /programs/new chat. No message/transcript storage.
--
-- NOTE: `prisma migrate dev` wanted to prepend `DROP INDEX "Resource_embedding_idx"`
-- here. That hnsw index is defined in raw SQL in the AR-1 migration over the
-- `Unsupported("vector(768)")` column, which Prisma cannot model — so it reads
-- as drift on every diff. Dropping it is wrong (it's the semantic-search index).
-- The line is intentionally removed; see AGENTS.md on Unsupported columns.

-- CreateEnum
CREATE TYPE "IntakeSessionStatus" AS ENUM ('active', 'submitted', 'exhausted', 'abandoned');

-- CreateTable
CREATE TABLE "IntakeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "IntakeSessionStatus" NOT NULL DEFAULT 'active',
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeSession_userId_createdAt_idx" ON "IntakeSession"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
