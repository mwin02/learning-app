-- Reports F1b: keep the settled record when a learner re-reports.
--
-- Reopening resets state/resolution/resolvedAt so a stale verdict can't sit next to
-- a live complaint; without this column the operator's fix note, the dismissal
-- reason, or the probe's liveness verdict is destroyed on every re-report — which is
-- exactly the context triage needs to see that a fix didn't take.
--
-- Hand-authored rather than generated: `prisma migrate dev` reads the raw-SQL hnsw
-- index `Resource_embedding_idx` (AR-1) as drift and would prepend a DROP INDEX for
-- it. See AGENTS.md.

-- AlterTable
ALTER TABLE "ResourceReport" ADD COLUMN     "priorResolution" TEXT;
