-- NOTE: Prisma re-emits `DROP INDEX "Resource_embedding_idx";` here every migration
-- because the hnsw pgvector index lives in raw SQL it can't model (see AGENTS.md).
-- Dropping it would break semantic search (`searchResources`). Intentionally removed.

-- AlterTable
ALTER TABLE "LessonResource" ADD COLUMN     "orderInLesson" INTEGER NOT NULL DEFAULT 0;
