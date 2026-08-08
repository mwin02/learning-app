-- Reports F5: make the rebuild progress carry-over durable, and stop it inflating the
-- learner's activity record.
--
-- CourseRequest.carriedOverAt — the record of having SETTLED the carry-over. It used to
-- be inferred from the presence of Progress rows on the new Track, so a learner who
-- un-completed every carried lesson had them re-inserted by the next assembler pass. It
-- also ran inside the slot-repoint transaction, so an insert failure rolled the repoint
-- back and nothing retried it.
--
-- Progress.carriedFromLessonId — names the completed old lesson a carried row was copied
-- from. The old Track's Progress rows are deliberately kept, so a carried row is a second
-- record of one study session; anything counting completion EVENTS (the home heatmap)
-- filters these out. Not an FK: the old Lesson can be cleaned up, and a SetNull would
-- silently reclassify a carried row as genuine.
--
-- Hand-authored rather than generated: `prisma migrate dev` reads the raw-SQL hnsw
-- index `Resource_embedding_idx` (AR-1) as drift and would prepend a DROP INDEX for
-- it. See AGENTS.md.

-- AlterTable
ALTER TABLE "CourseRequest" ADD COLUMN     "carriedOverAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Progress" ADD COLUMN     "carriedFromLessonId" TEXT;

-- Backfill: a rebuild that was genuinely ASSEMBLED before this column existed already had
-- its carry-over applied, so stamping it keeps the new sweep from re-running one against
-- progress the learner has since edited. "Assembled" is the slot pointing at this build's
-- Track — a row that is merely `fulfilled` may be one the worker never got to (crash
-- between finishCourseRequest and the assembler hook, or a sibling still running), which
-- is exactly the row the sweep exists to heal and must not be retired here.
--
-- Carried Progress rows written before this migration are not identifiable and stay
-- unmarked; they keep double-counting on the heatmap until their window rolls past.
UPDATE "CourseRequest" cr
SET "carriedOverAt" = cr."updatedAt"
WHERE cr."replacesTrackId" IS NOT NULL
  AND cr."status" = 'fulfilled'
  AND cr."trackId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "ProgramPath" pp
    WHERE pp."programId" = cr."programId"
      AND pp."topic" = cr."topic"
      AND pp."trackId" = cr."trackId"
  );
