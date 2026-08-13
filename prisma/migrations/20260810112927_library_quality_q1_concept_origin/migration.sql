-- CreateEnum
CREATE TYPE "ConceptOrigin" AS ENUM ('derived', 'inherited', 'fallback');

-- NOTE: the generated migration also contained `DROP INDEX "Resource_embedding_idx"`.
-- Deleted by hand: that hnsw index over the Unsupported("vector(768)") column exists
-- only in raw SQL (Prisma reads it as drift on every migrate dev) and searchResources
-- depends on it. See .claude/rules/prisma-migrations.md.

-- AlterTable
-- Default is 'inherited', not 'derived': pre-existing rows cannot be truthfully
-- stamped here, and 'inherited' is the value that asserts nothing. Q3 back-fills
-- the rows it repairs.
ALTER TABLE "Resource" ADD COLUMN     "conceptOrigin" "ConceptOrigin" NOT NULL DEFAULT 'inherited';
