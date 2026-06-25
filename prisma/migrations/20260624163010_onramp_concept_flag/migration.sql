-- NOTE: Prisma re-emits `DROP INDEX "Resource_embedding_idx";` here on every
-- migration because the pgvector hnsw index is created in raw SQL (Prisma can't
-- model the Unsupported("vector(768)") column), so it reads the index as drift.
-- Dropping it would break searchResources' semantic search. The DROP has been
-- removed deliberately — see AGENTS.md "Migrations: never drop the hand-written
-- indexes Prisma can't model".

-- AlterTable
ALTER TABLE "Concept" ADD COLUMN     "isOnRamp" BOOLEAN NOT NULL DEFAULT false;
