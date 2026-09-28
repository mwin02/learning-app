// Live driver for the Gemini 3 migration (G4 in gemini-3-migration.md). Exercises
// one agent of each call shape against the live models, then one full course build
// and one program plan through the seams the worker and the route use, and prints
// the usage each one recorded.
//
//   npx tsx --env-file=.env.local scripts/verify-gemini3.ts
//
// LOCAL DEV DB ONLY — refuses to start unless DATABASE_URL is a local host. Costs
// real Pro + Flash calls (~one course build plus a program plan). The rows it
// creates carry MARKER and are deleted in the finally block; library growth the
// real seams do on their own (thickener finds, concept banks, TopicAlias rows) is
// counted and reported, not deleted.
//
// The two tool loops do not return finishReason/steps, so this reads them off the
// log line each loop already emits — that line is the only place they surface.

import { randomUUID } from 'node:crypto';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { CourseRequestStatus, Difficulty } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getModel, type AgentName } from '@/lib/ai/models';
import { describeError } from '@/lib/ai/describe-error';
import { runWithTrace, traceUsageSnapshot, type UsageSnapshot } from '@/lib/log';
import { rulesAgentValidator } from '@/lib/agents/validation/validators/rules-agent';
import { discoverForConcept } from '@/lib/agents/tools/web-fallback';
import { composeTrackAgent } from '@/lib/agents/track/composer-agent';
import { loadComposerMap } from '@/lib/agents/track/build-track';
import { depthTier } from '@/lib/agents/track/allocate';
import { budgetMinutesFor } from '@/lib/agents/track/plan';
import { processCourseRequest } from '@/lib/services/course-worker';
import { enqueueProgram } from '@/lib/services/program';
import { resolveTarget } from './target-guard';

const MARKER = '__verify_gemini3__';
const TOPIC = 'calculus';
const GOAL = 'Refresh differentiation and integration before a first-year university exam.';
const PRIOR = 'Did high-school calculus two years ago; comfortable with algebra.';

// Captured loop/discovery log lines, keyed by the tag each module already prints.
const captured: Record<string, Record<string, unknown>[]> = {};
function capture(tag: string, fields: unknown) {
  if (typeof fields === 'object' && fields !== null) (captured[tag] ??= []).push({ ...fields });
}
for (const level of ['log', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const [first, second] = args;
    if (first === '[composer-agent]' || first === '[web-fallback] discovery call') capture(first, second);
    else if (typeof first === 'string' && first.startsWith('{"ts"')) {
      const line: unknown = JSON.parse(first);
      if (typeof line === 'object' && line !== null && 'event' in line && typeof line.event === 'string'
        && line.event.startsWith('decompose-agent.')) capture(line.event, line);
    }
    original(...args);
  };
}

type Probe = { agent: AgentName; ok: boolean; usage: unknown; [k: string]: unknown };
const results: Probe[] = [];
function report(p: Probe) {
  results.push(p);
  console.log(JSON.stringify({ g4: 'probe', ...p, modelId: getModel(p.agent).modelId }));
}

// Each probe runs in its own trace so the stage usage recordUsage accumulates is its own.
async function probe(agent: AgentName, stage: string | null, fn: () => Promise<Record<string, unknown> & { ok: boolean }>) {
  try {
    const { out, snap } = await runWithTrace(`g4-${agent}`, async () => ({ out: await fn(), snap: traceUsageSnapshot() }));
    report({ agent, usage: stage ? (snap?.stages[stage] ?? null) : null, ...out });
  } catch (err) {
    report({ agent, ok: false, usage: null, error: describeError(err) });
  }
}

function loopVerdict(line: Record<string, unknown> | undefined) {
  const steps = typeof line?.steps === 'number' ? line.steps : 0;
  const toolCalls = typeof line?.toolCalls === 'number' ? line.toolCalls : 0;
  const finishReason = line?.finishReason ?? null;
  return { ok: finishReason === 'stop' && steps >= 2 && toolCalls >= 1, finishReason, steps, toolCalls };
}

async function probes(pathId: string) {
  await probe('validityAgent', 'validate.rules-agent', async () => {
    const verdicts = await rulesAgentValidator.validate([
      { url: 'https://www.khanacademy.org/math/ap-calculus-ab/ab-differentiation-2-new/ab-3-1a/v/chain-rule-introduction', title: 'Chain rule introduction', summary: 'Video introducing the chain rule for composite functions with worked examples.', type: 'video' },
      { url: 'https://tutorial.math.lamar.edu/Classes/CalcI/ChainRule.aspx', title: "Paul's Online Notes: Chain Rule", summary: 'Lecture notes on the chain rule with worked examples and practice problems.', type: 'article' },
      { url: 'https://example-listicle.com/top-10-calculus-apps', title: 'Top 10 calculus apps you must download', summary: 'A listicle of calculus apps with affiliate links.', type: 'article' },
    ]);
    return { ok: verdicts.length === 3, verdicts: verdicts.map((v) => v.valid) };
  });

  await probe('curriculumFallback', 'web-fallback.discovery', async () => {
    const rows = await discoverForConcept(TOPIC, 'the chain rule', 4, []);
    const call = captured['[web-fallback] discovery call']?.at(-1);
    const attested = typeof call?.attested === 'number' ? call.attested : 0;
    // Rows can only carry attested URLs (the describe half joins by index); a
    // still-unresolved redirect host would mean attestation silently degraded.
    const redirects = rows.filter((r) => r.url.includes('vertexaisearch.cloud.google.com')).length;
    return { ok: attested >= 1 && rows.length >= 1 && redirects === 0, sourceCount: call?.sourceCount, attested, rows: rows.length, redirects, urls: rows.map((r) => r.url) };
  });

  await probe('onRampAuthor', null, async () => {
    // Direct call: generateOnRampResource records no usage and swallows failures,
    // so the registry config is exercised here with a same-shape prose request.
    const { model, temperature, maxOutputTokens, providerOptions } = getModel('onRampAuthor');
    const result = await generateText({
      model, temperature, maxOutputTokens, providerOptions,
      output: Output.object({ schema: z.object({ title: z.string().min(1), summary: z.string().min(1), content: z.string().min(1) }) }),
      system: 'You write the orientation on-ramp lesson that gets an absolute beginner started in a subject: the big picture, essential notation, and the first concrete steps. Roughly 500-900 words of clean markdown in `content`; the title is a separate field.',
      prompt: `Topic: ${TOPIC}\nOrientation concept: Getting started with calculus\n\nWrite the orientation on-ramp lesson for this topic.`,
    });
    return { ok: result.experimental_output.content.length > 500, finishReason: result.finishReason, usageDirect: result.usage, contentChars: result.experimental_output.content.length };
  });

  await probe('trackComposer', 'track.composer-agent', async () => {
    const { concepts, edges } = await loadComposerMap(pathId);
    const budgetMinutes = budgetMinutesFor(6, 5);
    const composition = await composeTrackAgent({
      topic: TOPIC, concepts, edges, goal: GOAL, priorKnowledge: PRIOR, targetMastery: Difficulty.intermediate,
      budgetMinutes, depthTier: depthTier(budgetMinutes, concepts.length),
    });
    return { ...loopVerdict(captured['[composer-agent]']?.at(-1)), lessons: composition.lessons.length };
  });
}

async function courseBuild(pathId: string) {
  const cr = await prisma.courseRequest.create({
    data: { topic: TOPIC, goal: GOAL, priorKnowledge: PRIOR, timeframeWeeks: 6, hoursPerWeek: 5, status: CourseRequestStatus.running, claimedBy: MARKER, attempts: 1, claimedAt: new Date() },
  });
  const outcome = await processCourseRequest(cr);
  const row = await prisma.courseRequest.findUniqueOrThrow({ where: { id: cr.id }, select: { status: true, error: true, buildUsage: true, track: { select: { status: true } } } });
  console.log(JSON.stringify({ g4: 'build', pathId, outcome, requestStatus: row.status, trackStatus: row.track?.status ?? null, error: row.error, buildUsage: row.buildUsage }));
}

async function programPlan() {
  const res = await runWithTrace(randomUUID(), () =>
    enqueueProgram({ goal: 'Get ready for a first-year machine learning course: I can code in Python but my math is rusty.', background: 'Comfortable in Python; last did math in high school.', totalHoursPerWeek: 8, totalWeeks: 10, inputHash: MARKER }),
  );
  const row = await prisma.program.findUniqueOrThrow({ where: { id: res.programId }, select: { status: true, planUsage: true } });
  console.log(JSON.stringify({ g4: 'plan', ...res, persistedStatus: row.status, planUsage: row.planUsage }));
  const failed = captured['decompose-agent.attempt-failed'] ?? [];
  // Prisma types the Json column as JsonValue; enqueueProgram writes it from traceUsageSnapshot().
  const stages = (row.planUsage as UsageSnapshot | null)?.stages;
  report({ agent: 'programDecomposer', ...loopVerdict(captured['decompose-agent.decomposed']?.at(-1)), usage: stages?.['plan.decompose-agent'] ?? null, attemptsFailed: failed.map((f) => f.error) });
}

async function cleanup(runStart: Date) {
  const crs = await prisma.courseRequest.findMany({ where: { claimedBy: MARKER }, select: { trackId: true } });
  const linked = crs.flatMap((c) => (c.trackId ? [c.trackId] : []));
  // A build that fails before linking still leaves its Track; match it by this run's inputs.
  const tracks = await prisma.track.deleteMany({ where: { OR: [{ id: { in: linked } }, { goal: GOAL, priorKnowledge: PRIOR, createdAt: { gte: runStart } }] } });
  const requests = await prisma.courseRequest.deleteMany({ where: { claimedBy: MARKER } });
  const programs = await prisma.program.deleteMany({ where: { inputHash: MARKER } });
  const left = {
    courseRequests: await prisma.courseRequest.count({ where: { claimedBy: MARKER } }),
    programs: await prisma.program.count({ where: { inputHash: MARKER } }),
    tracks: await prisma.track.count({ where: { goal: GOAL, priorKnowledge: PRIOR } }),
  };
  const libraryGrowth = await prisma.resource.count({ where: { createdAt: { gte: runStart } } });
  console.log(JSON.stringify({ g4: 'cleanup', deleted: { tracks: tracks.count, courseRequests: requests.count, programs: programs.count }, left, libraryGrowth }));
}

async function main() {
  const target = resolveTarget();
  console.log(JSON.stringify({ g4: 'target', label: target.label, isLocal: target.isLocal }));
  if (!target.isLocal) {
    console.error('refusing: this driver runs against the local dev DB only');
    process.exit(1);
  }
  const path = await prisma.path.findUniqueOrThrow({ where: { topic: TOPIC }, select: { id: true, status: true } });
  const runStart = new Date();
  try {
    await probes(path.id);
    await courseBuild(path.id);
    await programPlan();
  } finally {
    await cleanup(runStart);
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.agent);
  console.log(JSON.stringify({ g4: 'summary', probes: results.length, failed }));
}

main();
