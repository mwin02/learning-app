// DB helper for the split-path skill: retire one over-broad Path and build the narrower
// Paths that replace it, from an operator-authored proposal. Run from the repo root with
// the app's env so it reuses the SAME Prisma client and the SAME map-builder the worker
// runs (no reimplementation, so a split can't drift from a normal build):
//   npx tsx --env-file=.env.local .claude/skills/split-path/scripts/split-path.ts <cmd>
//
// Against PRODUCTION (the Paths worth splitting live on Supabase), override DATABASE_URL
// inline — shell env beats --env-file, so .env.local stays pointed at the local Docker
// Postgres the integration tests and compose workers depend on:
//   DATABASE_URL="$SUPABASE_POOLER_URL" npx tsx --env-file=.env.local <this> inspect machine-learning
// Use SUPABASE_POOLER_URL (:6543), NOT SUPABASE_DB_URL — the latter is the direct :5432
// endpoint, IPv6-only on current Supabase projects.
//
// Every run prints the database it connected to. A REMOTE `apply --apply` also requires
// `--target-host=<hostname>` (scripts/target-guard.ts).
//
//   inspect <topic>
//       What the parent Path is made of and what a split would cost: concepts, pool size,
//       unattached pool rows, and the assets a rebuild does NOT carry over. Read-only.
//   check <proposal.json>
//       Validate a proposal without touching anything: slug hygiene, the two clause checks
//       a script can make honestly, the TOPIC_RELATIONS edges the operator still owes, and
//       the parent's assets at risk. Read-only. Exits 1 if any error stands.
//   apply <proposal.json> [--apply] [--target-host=<h>] [--force]
//       Build each child Path (the real ensurePathMap), then dispose of the parent.
//       Dry run unless --apply. Re-runs `check` first and refuses while any error stands.
//
// ⚠️ WHY A REBUILD, NOT A CONCEPT MOVE. The parent's concepts were authored FOR THE PARENT
// TOPIC — that is the defect being repaired, so carrying them into a child preserves the
// thing we are trying to remove. Children are authored fresh for their own (narrower)
// topic and re-attached from the library, which is also how reset-maps.ts treats maps
// built under a superseded pipeline: recreate, don't patch. What that costs is real and
// `inspect` prints it: judged ConceptResource attachments are recomputed (LLM spend), and
// question banks / Tracks / Progress are DESTROYED. Hence the --force gate below.
//
// ⚠️ THE POOL IS NOT REFILED. Deleting a Path never touches Resource or ResourceTopic, so
// the parent's shelf survives intact. A child reaches it through TOPIC_RELATIONS, which is
// a CODE constant (src/types/resource.ts) this script cannot write — so `check` refuses
// until the edges a proposal declares are actually present in the loaded constant. That
// keeps the widening decision in git with its justification comment, where that file's own
// header demands it be.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { PathStatus } from '@prisma/client';
import { ensurePathMap } from '@/lib/agents/map/ensure-path-map';
import { relatedTopics, TOPIC_SLUGS } from '@/types/resource';
import { toCanonicalSlug, normalizeTopic, listCanonicals, snapToKnownSlug, recordCanonicalization } from '@/lib/agents/topic-registry';
import { requireTargetAck, resolveTarget } from '../../../../scripts/target-guard';

const ProposalSchema = z.object({
  parent: z.string().min(1),
  // `retire` deletes the parent Path (its shelf of Resources is untouched); `keep` leaves
  // it standing, for a split that only carves siblings off the side of a topic that is
  // itself still course-sized.
  parentDisposition: z.enum(['retire', 'keep']),
  children: z
    .array(
      z.object({
        topic: z.string().min(1),
        // Why this child is course-altitude in its own right. Not read by the script —
        // it is the record of the judgment for whoever reads the audit file later.
        rationale: z.string().min(1),
        subject: z.enum(['math', 'science', 'cs']).optional(),
        // Topics this child may widen INTO when attaching candidates. Must already be
        // declared in TOPIC_RELATIONS; `check` verifies and prints what is missing.
        relations: z.array(z.string()).default([]),
      }),
    )
    .min(2),
});
type Proposal = z.infer<typeof ProposalSchema>;

type Finding = { level: 'error' | 'warn'; message: string };

const hasFlag = (name: string) => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------- inspect

async function inspect(topic: string) {
  const path = await prisma.path.findUnique({
    where: { topic },
    include: {
      concepts: { orderBy: { title: 'asc' }, include: { _count: { select: { questions: true, resources: true } } } },
      _count: { select: { tracks: true, remediationJobs: true, pathReviews: true } },
    },
  });
  if (!path) {
    console.error(`✗ no Path for topic "${topic}"`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== ${path.topic}  [${path.status}]  created ${path.createdAt.toISOString().slice(0, 10)}\n`);
  for (const c of path.concepts) {
    const flags = [c.membership, c.isOnRamp ? 'on-ramp' : null, c.primaryRelaxed ? 'relaxed' : null].filter(Boolean).join(',');
    console.log(`  [${flags}] ${c.title}`.padEnd(74) + `${c._count.resources} attached  ${c._count.questions} questions`);
  }

  const pool = await prisma.resource.findMany({
    where: { status: 'active', decompositionStatus: 'atomic', topics: { some: { topic } } },
    select: { id: true, title: true, conceptResources: { select: { id: true } } },
  });
  const orphans = pool.filter((r) => r.conceptResources.length === 0);
  const questions = path.concepts.reduce((n, c) => n + c._count.questions, 0);
  const attachments = path.concepts.reduce((n, c) => n + c._count.resources, 0);

  console.log(`\n--- the shelf (untouched by a split; children reach it via TOPIC_RELATIONS)`);
  console.log(`  ${pool.length} active atomic resources, ${orphans.length} attached to nothing (${pool.length ? Math.round((100 * orphans.length) / pool.length) : 0}%)`);
  console.log(`  a high orphan share is the signature this standard exists to catch: material`);
  console.log(`  filed correctly that no concept in the map is able to hold.`);

  console.log(`\n--- what a split does NOT carry over`);
  console.log(`  ${attachments} judged attachments   — recomputed by attachCandidates (LLM spend)`);
  console.log(`  ${questions} question-bank items   — ${questions ? 'DESTROYED (--force required)' : 'none'}`);
  console.log(`  ${path._count.tracks} Tracks                 — ${path._count.tracks ? 'DESTROYED with their Lessons + Progress (--force required)' : 'none'}`);
  console.log(`  ${path._count.remediationJobs} remediation jobs, ${path._count.pathReviews} path reviews`);

  if (orphans.length) {
    console.log(`\n--- a sample of the unheld material (what the children are for)`);
    for (const r of orphans.slice(0, 25)) console.log(`    ${r.title.slice(0, 92)}`);
    if (orphans.length > 25) console.log(`    … and ${orphans.length - 25} more`);
  }
}

// ---------------------------------------------------------------- check

async function check(proposal: Proposal): Promise<{ findings: Finding[]; canonical: Map<string, string> }> {
  const findings: Finding[] = [];
  const canonical = new Map<string, string>();
  const known = await listCanonicals();

  const parent = await prisma.path.findUnique({
    where: { topic: proposal.parent },
    include: { concepts: { select: { title: true, slug: true, _count: { select: { questions: true } } } }, _count: { select: { tracks: true } } },
  });
  if (!parent) {
    findings.push({ level: 'error', message: `no Path for parent topic "${proposal.parent}"` });
    return { findings, canonical };
  }

  const questions = parent.concepts.reduce((n, c) => n + c._count.questions, 0);
  if (parent._count.tracks > 0 && !hasFlag('force')) {
    findings.push({ level: 'error', message: `parent has ${parent._count.tracks} Track(s); splitting deletes them and their Progress. Re-run with --force if that is really intended.` });
  }
  if (questions > 0 && !hasFlag('force')) {
    findings.push({ level: 'error', message: `parent has ${questions} question-bank item(s), which a rebuild destroys. Re-run with --force if that is really intended.` });
  }

  // Every concept title in every OTHER Path — the clause-2-downward corpus. A proposed
  // child that IS one of these is a concept that escaped its map, not a Path.
  const otherConcepts = await prisma.concept.findMany({
    where: { path: { topic: { not: proposal.parent } } },
    select: { slug: true, title: true, path: { select: { topic: true } } },
  });
  const existingPaths = new Set((await prisma.path.findMany({ select: { topic: true } })).map((p) => p.topic));

  for (const child of proposal.children) {
    const slug = toCanonicalSlug(normalizeTopic(child.topic));
    if (!slug) {
      findings.push({ level: 'error', message: `child "${child.topic}" has no usable slug` });
      continue;
    }
    const snapped = snapToKnownSlug(slug, known);
    if (snapped !== slug) {
      findings.push({ level: 'warn', message: `child "${slug}" snaps onto the existing canonical "${snapped}" — using that instead (T1.5 anti-drift)` });
    }
    canonical.set(child.topic, snapped);

    if (snapped === proposal.parent && proposal.parentDisposition === 'retire') {
      findings.push({ level: 'error', message: `child "${snapped}" is the parent topic, which this proposal retires` });
    }
    if (existingPaths.has(snapped) && snapped !== proposal.parent) {
      findings.push({ level: 'error', message: `a Path already exists for "${snapped}" — clause 3 (Distinct): narrow the child or extend that Path's frontier instead` });
    }

    // Clause 2, downward. A weak signal on its own (a legitimate course can share a name
    // with someone else's concept), so it is a warning that demands a human look, never
    // an automatic refusal.
    const asConcept = otherConcepts.filter(
      (c) => c.slug === snapped || toCanonicalSlug(c.title) === snapped,
    );
    if (asConcept.length) {
      const where = asConcept.map((c) => `${c.path.topic}/${c.title}`).join(', ');
      findings.push({ level: 'warn', message: `"${snapped}" is already a CONCEPT in: ${where} — clause 2 (Course-altitude), downward. Confirm it is course-sized before proceeding.` });
    }

    // TOPIC_RELATIONS is code; the script can only report what the loaded constant says.
    const reachable = relatedTopics(snapped);
    for (const want of child.relations) {
      if (!reachable.includes(want)) {
        findings.push({ level: 'error', message: `"${snapped}" cannot reach "${want}" — add it to TOPIC_RELATIONS in src/types/resource.ts (with the measured justification that file requires), then re-run` });
      }
    }
    if (child.relations.length === 0 && !TOPIC_SLUGS.includes(snapped as never)) {
      findings.push({ level: 'warn', message: `"${snapped}" declares no relations, so its map may only draw on its own shelf — check the pool size below is enough to cover a spine` });
    }
  }

  // What each child would actually see when attaching, given the relations that ARE live.
  console.log(`\n--- shelf reach per child (as TOPIC_RELATIONS stands right now)`);
  for (const child of proposal.children) {
    const slug = canonical.get(child.topic);
    if (!slug) continue;
    const topics = relatedTopics(slug);
    const n = await prisma.resource.count({
      where: { status: 'active', decompositionStatus: 'atomic', topics: { some: { topic: { in: topics } } } },
    });
    console.log(`  ${slug.padEnd(30)} ${String(n).padStart(4)} resources via [${topics.join(', ')}]`);
  }

  return { findings, canonical };
}

function report(findings: Finding[]): boolean {
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  console.log('');
  for (const w of warns) console.log(`  ⚠ ${w.message}`);
  for (const e of errors) console.log(`  ✗ ${e.message}`);
  if (!errors.length && !warns.length) console.log('  ✓ no findings');
  return errors.length === 0;
}

// ---------------------------------------------------------------- apply

async function apply(proposal: Proposal, live: boolean) {
  const { findings, canonical } = await check(proposal);
  const ok = report(findings);
  if (!ok) {
    console.error('\n✗ refusing to apply while an error stands.');
    process.exitCode = 1;
    return;
  }

  requireTargetAck('split-path', live, 'REBUILD PATHS in');
  if (!live) {
    console.log('\n[dry run] would, in order:');
    for (const c of proposal.children) console.log(`  build Path "${canonical.get(c.topic)}"  (author spine → attach candidates → readiness → frontier)`);
    console.log(`  ${proposal.parentDisposition === 'retire' ? `DELETE Path "${proposal.parent}" (its shelf of Resources survives)` : `leave Path "${proposal.parent}" standing`}`);
    console.log('\nRe-run with --apply to execute.');
    return;
  }

  const built: { topic: string; status: PathStatus; holes: string[] }[] = [];
  for (const child of proposal.children) {
    const topic = canonical.get(child.topic)!;
    // Register the slug so the registry (and every refile surface that checks it) knows
    // this canonical before anything files against it.
    await recordCanonicalization({ alias: topic, canonical: topic, subject: child.subject ?? 'cs' }).catch(() => {});
    console.log(`\n[split-path] building "${topic}" …`);
    const r = await ensurePathMap({ topic, subject: child.subject });
    console.log(`[split-path] "${topic}" → status=${r.status} created=${r.created} holes=${r.holes.length}`);
    built.push({ topic, status: r.status, holes: r.holes });
  }

  // Children first, parent last: a failure above leaves the parent map intact.
  let retired = false;
  if (proposal.parentDisposition === 'retire') {
    const del = await prisma.path.delete({ where: { topic: proposal.parent } }).catch((e: unknown) => {
      console.error(`[split-path] could not retire parent: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    retired = Boolean(del);
    if (retired) console.log(`\n[split-path] retired Path "${proposal.parent}" (its shelf of Resources is untouched)`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { at: new Date().toISOString(), target: resolveTarget().label, proposal, built, retired };
  mkdirSync('docs/audits', { recursive: true });
  const out = `docs/audits/split-path-${proposal.parent}-${stamp}.json`;
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`\n[split-path] wrote ${out}`);

  const holey = built.filter((b) => b.holes.length);
  if (holey.length) {
    console.log(`\n⚠ ${holey.length} child map(s) have spine holes — that is remediation's job, not a failed split:`);
    for (const b of holey) console.log(`    ${b.topic}: ${b.holes.join(', ')}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const [, , cmd, target] = process.argv;
  console.log(`[split-path] target: ${resolveTarget().label}`);

  if (cmd === 'inspect' && target) {
    await inspect(target);
  } else if ((cmd === 'check' || cmd === 'apply') && target) {
    const proposal = ProposalSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
    if (cmd === 'check') {
      const { findings } = await check(proposal);
      if (!report(findings)) process.exitCode = 1;
    } else {
      await apply(proposal, hasFlag('apply'));
    }
  } else {
    console.error('usage: split-path.ts inspect <topic> | check <proposal.json> | apply <proposal.json> [--apply]');
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main();
