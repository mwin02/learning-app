// Read-only audit: scan ATTACHED resources (ConceptResource or LessonResource
// links > 0) for whole-work signals — rows that look like an entire book/course
// yet sit in a concept map or lesson as if they were one sitting of work.
//
// Signals:
//   title-signal  — title/summary matches /full book|complete course|textbook|full course/i
//   type-signal   — type in (book, course) with decompositionStatus 'atomic'
//     (a whole book/course that was never decomposed — the containment gap the
//     book-containment blocks close)
//
// Output: an operator report table (slug, title, url, durationMin, paths,
// tracks, signal). Mutations go through the admin APIs
// (PATCH /api/playground/resources, POST /api/playground/pending-resources) —
// this script never writes.
//
// Run: npx tsx --env-file=.env.local scripts/audit-attached-whole-works.ts

import { prisma } from '@/lib/db';

const TITLE_RE = /full book|complete course|textbook|full course/i;

async function main() {
  const rows = await prisma.resource.findMany({
    where: {
      status: 'active',
      OR: [{ conceptResources: { some: {} } }, { lessonResources: { some: {} } }],
    },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      url: true,
      type: true,
      durationMin: true,
      decompositionStatus: true,
      conceptResources: { select: { concept: { select: { pathId: true, path: { select: { topic: true } } } } } },
      lessonResources: { select: { lesson: { select: { trackId: true, track: { select: { title: true } } } } } },
    },
  });

  type Finding = {
    slug: string;
    title: string;
    url: string;
    durationMin: number;
    type: string;
    paths: string[];
    tracks: string[];
    signals: string[];
  };
  const findings: Finding[] = [];

  for (const r of rows) {
    const signals: string[] = [];
    if (TITLE_RE.test(r.title) || TITLE_RE.test(r.summary)) signals.push('title-signal');
    if ((r.type === 'book' || r.type === 'course') && r.decompositionStatus === 'atomic') {
      signals.push('type-signal');
    }
    if (signals.length === 0) continue;
    findings.push({
      slug: r.slug,
      title: r.title,
      url: r.url,
      durationMin: r.durationMin,
      type: r.type,
      paths: [...new Set(r.conceptResources.map((c) => `${c.concept.path.topic} (${c.concept.pathId})`))],
      tracks: [...new Set(r.lessonResources.map((l) => `${l.lesson.track.title ?? 'untitled'} (${l.lesson.trackId})`))],
      signals,
    });
  }

  console.log(`Scanned ${rows.length} attached active resources; ${findings.length} whole-work suspect(s).\n`);
  for (const f of findings.sort((a, b) => b.durationMin - a.durationMin)) {
    console.log(`- ${f.slug}`);
    console.log(`  title: ${f.title}`);
    console.log(`  url: ${f.url}`);
    console.log(`  type: ${f.type}  durationMin: ${f.durationMin}  signals: ${f.signals.join(', ')}`);
    console.log(`  paths: ${f.paths.length ? f.paths.join('; ') : '—'}`);
    console.log(`  tracks: ${f.tracks.length ? f.tracks.join('; ') : '—'}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
