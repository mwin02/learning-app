// Phase 2.5e (track sections): the post-build sectioner orchestrator. Given a built
// Track, it groups the Track's lessons into named chapters (Section rows) via one
// Flash judgment pass (sectioner.ts) re-validated deterministically
// (group-into-sections.ts), then persists the result.
//
// Runs AFTER buildTrack has frozen the Track, and is wired in best-effort: a
// sectioning failure never fails the build — the Track simply renders flat. It is
// also a standalone, idempotent entry point (delete + recreate this Track's
// Sections), so it can re-section an existing Track or backfill old ones without a
// rebuild.
//
// Two ways out without an LLM call:
//   - a Track below TRACK_MIN_LESSONS_FOR_SECTIONS lessons is left flat (chaptering
//     a 2–3 lesson Track buys nothing);
//   - if grouping collapses to a single chapter, we leave the Track flat rather than
//     persist one pointless full-width Section (the renderer would show a lone
//     header over everything).

import { prisma } from '@/lib/db';
import { TRACK_MIN_LESSONS_FOR_SECTIONS } from '@/lib/config';
import { sectionLessons } from '@/lib/agents/track/sectioner';
import { groupIntoSections } from '@/lib/agents/track/group-into-sections';
import type { OnTrace } from '@/lib/agents/agent-trace';

export type SectionTrackResult = {
  sectioned: boolean;
  // Why we didn't section (when sectioned=false): 'too_short' | 'single_chapter' |
  // 'no_lessons'. Undefined when sectioned=true.
  reason?: 'too_short' | 'single_chapter' | 'no_lessons';
  sectionCount: number;
  warnings: string[];
};

export async function sectionTrack(args: {
  trackId: string;
  onTrace?: OnTrace;
}): Promise<SectionTrackResult> {
  const { trackId, onTrace = () => {} } = args;

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      title: true,
      summary: true,
      intent: true,
      targetMastery: true,
      path: { select: { topic: true } },
      lessons: {
        orderBy: { orderInTrack: 'asc' },
        select: { id: true, orderInTrack: true, title: true, summary: true, conceptsTaught: true },
      },
    },
  });
  if (!track) throw new Error(`sectionTrack: no Track '${trackId}'.`);

  const lessons = track.lessons;
  const trackTitle = track.title ?? `Track for ${track.path.topic}`;

  if (lessons.length === 0) {
    return { sectioned: false, reason: 'no_lessons', sectionCount: 0, warnings: [] };
  }
  if (lessons.length < TRACK_MIN_LESSONS_FOR_SECTIONS) {
    onTrace({
      kind: 'stage',
      label: 'track sectioning skipped (too short)',
      detail: { trackId, lessons: lessons.length, floor: TRACK_MIN_LESSONS_FOR_SECTIONS },
    });
    await clearSections(trackId); // idempotent: a re-run that's now too short un-groups
    return { sectioned: false, reason: 'too_short', sectionCount: 0, warnings: [] };
  }

  const boundaries = await sectionLessons({
    trackTitle,
    trackSummary: track.summary,
    intent: track.intent,
    targetMastery: track.targetMastery,
    lessons: lessons.map((l) => ({
      orderInTrack: l.orderInTrack,
      title: l.title,
      summary: l.summary,
      conceptsTaught: l.conceptsTaught,
    })),
    onTrace,
  });

  const { sections, warnings } = groupIntoSections({
    lessonOrders: lessons.map((l) => l.orderInTrack),
    boundaries,
    fallbackTitle: trackTitle,
  });

  // A lone chapter over the whole Track isn't worth a header — leave it flat.
  if (sections.length < 2) {
    await clearSections(trackId);
    onTrace({ kind: 'stage', label: 'track sectioning produced a single chapter; left flat', detail: { trackId } });
    return { sectioned: false, reason: 'single_chapter', sectionCount: 0, warnings };
  }

  const lessonIdByOrder = new Map(lessons.map((l) => [l.orderInTrack, l.id]));

  // Idempotent rewrite: drop this Track's Sections (SetNull ungroups its lessons),
  // create the new ones, point each lesson at its Section. One transaction so a
  // half-applied re-section never ships.
  await prisma.$transaction(async (tx) => {
    await tx.section.deleteMany({ where: { trackId } });
    for (const s of sections) {
      const created = await tx.section.create({
        data: { trackId, orderInTrack: s.orderInTrack, title: s.title, intro: s.intro || null },
        select: { id: true },
      });
      const lessonIds = s.lessonOrders.map((o) => lessonIdByOrder.get(o)!).filter(Boolean);
      await tx.lesson.updateMany({
        where: { id: { in: lessonIds } },
        data: { sectionId: created.id },
      });
    }
  });

  onTrace({
    kind: 'stage',
    label: 'track sectioning done',
    detail: { trackId, sections: sections.length, warnings: warnings.length },
  });
  console.log('[track-section-track] sectioned', {
    trackId,
    lessons: lessons.length,
    sections: sections.length,
    warnings,
  });

  return { sectioned: true, sectionCount: sections.length, warnings };
}

// Clear a Track's Sections (FK SetNull ungroups the lessons). Used when a re-run
// decides the Track should be flat, so stale chapters never linger.
async function clearSections(trackId: string): Promise<void> {
  await prisma.section.deleteMany({ where: { trackId } });
}
