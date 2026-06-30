-- CreateEnum
CREATE TYPE "BankStaleReason" AS ENUM ('primary_changed', 'resource_removed');

-- NOTE (AGENTS.md): Prisma regenerated `DROP INDEX "Resource_embedding_idx";` here
-- as phantom drift — it can't model the hnsw vector index, so it reads it as removable
-- every migration. Dropping it breaks `searchResources`. The DROP line is deleted on
-- purpose. (RemediationJob_active_per_path did not drift this run.)

-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "bankStaleReason" "BankStaleReason";
