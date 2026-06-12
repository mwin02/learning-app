-- CreateEnum
CREATE TYPE "TrackIntent" AS ENUM ('learn', 'review', 'practice', 'master', 'exam_prep');

-- NOTE: Prisma re-emits `DROP INDEX "Resource_embedding_idx";` here every migration
-- because the hnsw pgvector index lives in raw SQL it can't model (see AGENTS.md).
-- Dropping it would break semantic search (`searchResources`). Intentionally removed.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "goal" TEXT,
ADD COLUMN     "intent" "TrackIntent";
