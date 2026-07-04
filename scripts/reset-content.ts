// Phase 2.5h block 2f: content-graph reset — wipe the agent/seed CONTENT so the
// new sourcing pipeline can be observed building a library from empty, while
// PRESERVING the curated registries and user accounts.
//
//   npx tsx --env-file=.env.local scripts/reset-content.ts            # dry run + snapshot
//   npx tsx --env-file=.env.local scripts/reset-content.ts --yes      # actually truncate
//
// WIPES (content): Resource, Path, Track, Lesson, Section, LessonResource,
//   Exercise, Concept, ConceptPrereq, ConceptResource, RemediationJob,
//   CourseRequest, Progress, Program, ProgramPath, EnrolledProgram. (Programs
//   are generated content — and ProgramPath would be cascade-truncated via
//   Track anyway, leaving husk Programs if they were kept.)
// KEEPS: Source (allowlist/trust registry), TopicAlias (learned vocab), User,
//   Subscription (accounts/billing).
//
// Always writes a JSON snapshot of the content tables to backups/ first (gitignored),
// so a wipe is recoverable even though pg_dump isn't available in this environment.
// TRUNCATE … CASCADE handles FK ordering; CASCADE only ever reaches content/join
// tables (no kept table has a FK INTO the wiped set), so accounts are never touched.

import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';

// Order is cosmetic (TRUNCATE CASCADE resolves dependencies); listed leaf-ward.
const CONTENT_TABLES = [
  'LessonResource', 'Exercise', 'Section', 'Lesson', 'Track',
  'ConceptResource', 'ConceptPrereq', 'Concept',
  'RemediationJob', 'CourseRequest', 'Progress',
  'EnrolledProgram', 'ProgramPath', 'Program', 'Path', 'Resource',
] as const;

async function snapshot(): Promise<string> {
  // One findMany per content table (scalars only; the Unsupported `embedding`
  // vector is omitted by Prisma and is regenerable via embedMissing).
  const data: Record<string, unknown[]> = {};
  data.Resource = await prisma.resource.findMany();
  data.Path = await prisma.path.findMany();
  data.Track = await prisma.track.findMany();
  data.Lesson = await prisma.lesson.findMany();
  data.Section = await prisma.section.findMany();
  data.LessonResource = await prisma.lessonResource.findMany();
  data.Exercise = await prisma.exercise.findMany();
  data.Concept = await prisma.concept.findMany();
  data.ConceptPrereq = await prisma.conceptPrereq.findMany();
  data.ConceptResource = await prisma.conceptResource.findMany();
  data.RemediationJob = await prisma.remediationJob.findMany();
  data.CourseRequest = await prisma.courseRequest.findMany();
  data.Progress = await prisma.progress.findMany();
  data.Program = await prisma.program.findMany();
  data.ProgramPath = await prisma.programPath.findMany();
  data.EnrolledProgram = await prisma.enrolledProgram.findMany();

  mkdirSync('backups', { recursive: true });
  const path = `backups/content-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  // BigInt-safe stringify (counts/ids are strings, but be defensive).
  writeFileSync(path, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  console.log('[reset] snapshot written', { path });
  console.table(counts);
  return path;
}

async function keptCounts() {
  return {
    Source: await prisma.source.count(),
    TopicAlias: await prisma.topicAlias.count(),
    User: await prisma.user.count(),
    Subscription: await prisma.subscription.count(),
  };
}

async function main() {
  const apply = process.argv.includes('--yes');
  console.log(`\n=== content reset (${apply ? 'APPLY' : 'DRY RUN'}) ===\n`);

  await snapshot();
  console.log('\n[reset] preserved tables (untouched):');
  console.table(await keptCounts());

  if (!apply) {
    console.log('\nDry run only. Re-run with --yes to TRUNCATE the content tables above.\n');
    return;
  }

  const list = CONTENT_TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE;`);
  console.log('\n[reset] content tables truncated.');

  // Confirm the wipe + that the registries survived.
  console.log('[reset] post-wipe content counts:');
  console.table({ Resource: await prisma.resource.count(), Path: await prisma.path.count(), Concept: await prisma.concept.count() });
  console.log('[reset] preserved after wipe:');
  console.table(await keptCounts());
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
