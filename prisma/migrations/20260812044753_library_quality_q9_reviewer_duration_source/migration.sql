-- AlterEnum
-- Library-quality Q9: a reviewer's hand-measured duration, distinguishable from both
-- `unknown` and any scraper-derived value. Added at the end of the enum (no reordering)
-- so existing stored values keep their oids.
ALTER TYPE "DurationSource" ADD VALUE 'reviewer';

-- Prisma regenerated `DROP INDEX "Resource_embedding_idx"` here and it was deleted by
-- hand: that hnsw index is created in raw SQL (AR-1) over an Unsupported() column, so
-- Prisma reads it as drift every time. Dropping it would take out the pgvector
-- semantic-search index. See .claude/rules/prisma-migrations.md.
