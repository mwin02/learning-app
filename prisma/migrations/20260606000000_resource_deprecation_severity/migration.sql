-- Pending-review reject severity. Records WHY a resource was deprecated so a
-- future Track layer can branch policy: `soft` (quality downgrade, future tracks
-- only) vs `hard` (broken/dead link, may need to patch in-flight learners).

-- CreateEnum
CREATE TYPE "DeprecationSeverity" AS ENUM ('soft', 'hard');

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "deprecationSeverity" "DeprecationSeverity";
