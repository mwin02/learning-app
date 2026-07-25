// Free-beta C1: map-layer reset — wipe the MAP/TRACK/PROGRAM layer while
// PRESERVING the whole resource library. Existing Paths were authored under
// several different pipeline versions and are inconsistent, so the beta plan
// recreates them rather than patching them (docs/free-beta-plan.md): wipe the
// maps, keep the curated library, rebuild via scripts/warm-paths.ts.
//
//   npx tsx --env-file=.env.local scripts/reset-maps.ts          # dry run + snapshot
//   npx tsx --env-file=.env.local scripts/reset-maps.ts --yes    # actually truncate
//
// This is the narrow sibling of reset-content.ts, which also wipes `Resource` —
// too blunt here: the library is the expensive, curated, human-reviewed asset and
// the warm campaign is meant to rebuild maps ON TOP of it.
//
// WIPES (maps/tracks/programs): LessonResource, Exercise, Section, Lesson, Track,
//   ConceptResource, ConceptPrereq, Concept, RemediationJob, CourseRequest,
//   Progress, EnrolledProgram, ProgramPath, Program, Path. ConceptQuestion and
//   ResourceSourcedFor are Concept-anchored (FK → Concept, onDelete: Cascade), so
//   they die with the wipe without being listed; both are snapshotted anyway.
// KEEPS: Resource, Source, TopicAlias (the library + curated registries), User,
//   ResourceRating (accounts + the rating signal feeding trust).
//
// Safety argument for TRUNCATE … CASCADE: no KEPT table has an FK INTO the wiped
// set (Resource → Source/Resource, ResourceRating → User/Resource are the only
// FKs the kept tables have), so CASCADE can never reach a kept row. Verified
// against prisma/schema.prisma when this script was written — re-verify if a new
// FK is added from the library layer into a map table.
//
// Dev enrollments/progress ARE lost. Accepted pre-beta. A JSON snapshot lands in
// backups/ first (gitignored), so the wipe stays recoverable even though pg_dump
// isn't available in this environment.

import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/db';

// Order is cosmetic (TRUNCATE CASCADE resolves dependencies); listed leaf-ward.
const MAP_TABLES = [
  'LessonResource', 'Exercise', 'Section', 'Lesson', 'Track',
  'ConceptResource', 'ConceptPrereq', 'Concept',
  'RemediationJob', 'CourseRequest', 'Progress',
  'EnrolledProgram', 'ProgramPath', 'Program', 'Path',
] as const;

async function snapshot(): Promise<string> {
  // One findMany per wiped table, plus the two that only die by cascade.
  const data: Record<string, unknown[]> = {};
  data.Path = await prisma.path.findMany();
  data.Track = await prisma.track.findMany();
  data.Lesson = await prisma.lesson.findMany();
  data.Section = await prisma.section.findMany();
  data.LessonResource = await prisma.lessonResource.findMany();
  data.Exercise = await prisma.exercise.findMany();
  data.Concept = await prisma.concept.findMany();
  data.ConceptPrereq = await prisma.conceptPrereq.findMany();
  data.ConceptResource = await prisma.conceptResource.findMany();
  data.ConceptQuestion = await prisma.conceptQuestion.findMany();
  data.ResourceSourcedFor = await prisma.resourceSourcedFor.findMany();
  data.RemediationJob = await prisma.remediationJob.findMany();
  data.CourseRequest = await prisma.courseRequest.findMany();
  data.Progress = await prisma.progress.findMany();
  data.Program = await prisma.program.findMany();
  data.ProgramPath = await prisma.programPath.findMany();
  data.EnrolledProgram = await prisma.enrolledProgram.findMany();

  mkdirSync('backups', { recursive: true });
  const path = `backups/maps-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  // BigInt-safe stringify (ids are strings, but be defensive).
  writeFileSync(path, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  console.log('[reset-maps] snapshot written', { path });
  console.table(counts);
  return path;
}

async function keptCounts() {
  return {
    Resource: await prisma.resource.count(),
    Source: await prisma.source.count(),
    TopicAlias: await prisma.topicAlias.count(),
    User: await prisma.user.count(),
    ResourceRating: await prisma.resourceRating.count(),
  };
}

async function main() {
  const apply = process.argv.includes('--yes');
  console.log(`\n=== map-layer reset (${apply ? 'APPLY' : 'DRY RUN'}) ===\n`);

  await snapshot();
  console.log('\n[reset-maps] preserved tables (untouched):');
  console.table(await keptCounts());

  if (!apply) {
    console.log('\nDry run only. Re-run with --yes to TRUNCATE the map tables above.\n');
    return;
  }

  const list = MAP_TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE;`);
  console.log('\n[reset-maps] map tables truncated.');

  // Confirm the wipe — including that the cascade-only tables went with Concept.
  console.log('[reset-maps] post-wipe map counts:');
  console.table({
    Path: await prisma.path.count(),
    Concept: await prisma.concept.count(),
    Track: await prisma.track.count(),
    ConceptQuestion: await prisma.conceptQuestion.count(),
    ResourceSourcedFor: await prisma.resourceSourcedFor.count(),
  });
  // …and that the library survived it. These numbers must match the table above.
  console.log('[reset-maps] preserved after wipe:');
  console.table(await keptCounts());
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
