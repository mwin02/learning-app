-- NOTE: Prisma generated a `DROP INDEX "Resource_embedding_idx"` here (it reads
-- the raw-SQL hnsw index as drift because the schema can't model it). Removed by
-- hand per AGENTS.md — the index must stay; see 20260602145709_topic_alias_registry.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "buildUsage" JSONB;

-- AlterTable
ALTER TABLE "Program" ADD COLUMN     "planUsage" JSONB;
