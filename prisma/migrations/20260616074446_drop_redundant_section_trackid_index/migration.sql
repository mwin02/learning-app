-- NOTE: Prisma re-emitted `DROP INDEX "Resource_embedding_idx"` here as drift (the
-- hnsw pgvector index is raw SQL it can't model). Removed per AGENTS.md — dropping
-- it would destroy the semantic-search index `searchResources` depends on.
--
-- This migration drops the redundant `Section_trackId_idx`: the composite unique
-- `Section_trackId_orderInTrack_key` already provides a trackId left-prefix index,
-- so the standalone index only added write overhead. IF EXISTS so re-applying or
-- backfilling an environment that never had it is a no-op.

-- DropIndex
DROP INDEX IF EXISTS "Section_trackId_idx";
