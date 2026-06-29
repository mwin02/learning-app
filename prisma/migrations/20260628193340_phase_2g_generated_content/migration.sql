-- Phase 2g: schema for AI-generated content (the on-ramp orientation lesson).
--   - Origin += 'generated'      — distinguishes our authored content from sourced.
--   - SourceKind += 'generated'  — the synthetic source for generated:// rows (kept
--     out of the sourcing allowlist on purpose; see loadAllowlistDomains).
--   - Resource.content           — inline markdown body, null for link-out resources.
--
-- NOTE (AGENTS.md): `prisma migrate diff` prepended a `DROP INDEX
-- "Resource_embedding_idx"` because that hnsw pgvector index is created in raw SQL
-- (the AR-1 migration) and Prisma can't model the Unsupported("vector(768)") column,
-- so it reads the index as drift every time. Dropping it would break searchResources.
-- That line is intentionally OMITTED here. Do not re-add it.

-- AlterEnum
ALTER TYPE "Origin" ADD VALUE 'generated';

-- AlterEnum
ALTER TYPE "SourceKind" ADD VALUE 'generated';

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "content" TEXT;
