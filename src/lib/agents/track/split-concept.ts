// Phase 2.5f-4a: split a conflation concept into finer nodes.
//
// A conflation hole (classify-hole.ts) is an over-coarse spine concept: several
// sub-floor `teaches` each cover a different slice and none spans the whole
// concept, so no single resource can be its primary. The fix is structural, not
// sourcing — decompose the concept into one node per slice and re-attach, so each
// finer node's slice resource (which covered ~40% of the bundle) now covers ~100%
// of its own node and clears the floor.
//
// Flow: author finer nodes (LLM) → validate → attachCandidates for them (LLM,
// OUTSIDE the tx) → one tx: capture the coarse concept's neighbours, delete it,
// create the finer nodes, rewire edges (conservative inheritance), write the
// re-attached links, recompute readiness. The author may DECLINE (the concept is
// already atomic) → we mutate nothing and the caller (2.5f-4b) falls back to
// treating the hole as a gap.
//
// Conservative DAG inheritance (locked): every finer node inherits ALL of the
// coarse concept's prerequisites, and ALL of its dependents depend on EVERY finer
// node. Over-sequencing, never orphaning — and provably acyclic: the original
// P → C → D was acyclic, and P → Cx → D for new nodes Cx adds no back-edge.

import { Output, generateText } from 'ai';
import { z } from 'zod';
import { ConceptMembership, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getModel } from '@/lib/ai/models';
import { findCycle } from '@/lib/agents/map/cycle';
import { attachCandidates } from '@/lib/agents/map/attach-candidates';
import { recomputeReadiness } from '@/lib/agents/map/recompute-readiness';
import {
  REMEDIATION_SPLIT_MIN_NODES,
  REMEDIATION_SPLIT_MAX_NODES,
} from '@/lib/config';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The slice evidence handed to the author: the coarse concept's sub-floor
// `teaches` candidates, so it decomposes along the slices that actually exist.
export type SliceEvidence = { title: string; conceptsTaught: string[] };

export type CoarseConcept = { id: string; slug: string; title: string };

export type SplitResult =
  | { split: true; finerSlugs: string[]; status: string; holes: string[] }
  // Mutated nothing: either the author declined or the authored split failed
  // validation. The caller falls back to the gap path.
  | { split: false; reason: string };

const SplitSchema = z.object({
  canSplit: z.boolean(),
  reason: z.string(),
  concepts: z.array(z.object({ slug: z.string(), title: z.string().min(2) })).default([]),
  edges: z.array(z.object({ fromSlug: z.string(), toSlug: z.string() })).default([]),
});

export async function splitConcept(args: {
  pathId: string;
  topic: string;
  subject?: string;
  concept: CoarseConcept;
  evidence: SliceEvidence[];
}): Promise<SplitResult> {
  const { pathId, topic, subject, concept, evidence } = args;

  // This operation is DESTRUCTIVE — it DELETEs the coarse concept — but that is
  // safe even on a Path that already has live Tracks (the spine-hole regression
  // case, responsibility 3). A Track is an immutable SNAPSHOT: its Lessons reference
  // concepts only by denormalized `conceptsTaught` slug strings (no FK
  // Lesson→Concept), rendered as plain labels and never re-joined to live Concept
  // rows. Deleting/splitting the coarse Concept here only cascades Path-layer rows
  // (ConceptPrereq, ConceptResource); old Tracks keep their snapshot labels
  // (historically accurate for what they taught) and are otherwise untouched. The
  // Path is mutable and ever-growing, so it heals — future Tracks built off it are
  // sound — while past snapshots stay as they were. So: NO guard against existing
  // Tracks; that would forbid exactly the regression-remediation this exists for.
  const authored = await authorSplit({ concept, subject, evidence });
  if (!authored.canSplit) {
    console.log('[split] author declined', { pathId, concept: concept.slug, reason: authored.reason });
    return { split: false, reason: authored.reason };
  }

  // Validate against the existing path slugs (the finer nodes must be new — except
  // the coarse slug itself, which we delete and may reuse).
  const existingSlugs = new Set(
    (await prisma.concept.findMany({ where: { pathId }, select: { slug: true } })).map((c) => c.slug),
  );
  existingSlugs.delete(concept.slug);
  const invalid = validateSplit(authored.concepts, authored.edges, existingSlugs);
  if (invalid) {
    console.warn('[split] authored split invalid; falling back to gap', { pathId, concept: concept.slug, reason: invalid });
    return { split: false, reason: invalid };
  }

  const finerConcepts = authored.concepts.map((c) => ({ slug: c.slug, title: c.title }));
  // Re-attach OUTSIDE the tx — search + judge are LLM/network work that must not
  // hold a DB transaction open. The finer nodes need not exist yet; attachment
  // keys on slug, resolved to ids when we persist below.
  const attachments = await attachCandidates({ topic, concepts: finerConcepts });

  const result = await prisma.$transaction(async (tx) => {
    // Capture the coarse concept's neighbours BEFORE deleting it (cascade drops
    // its edges). prereqsIn: P → C (P is a prerequisite of C). prereqsOut: C → D
    // (D depends on C).
    const c = await tx.concept.findUniqueOrThrow({
      where: { id: concept.id },
      select: {
        prereqsIn: { select: { fromConceptId: true } },
        prereqsOut: { select: { toConceptId: true } },
      },
    });
    const prereqIds = c.prereqsIn.map((e) => e.fromConceptId);
    const dependentIds = c.prereqsOut.map((e) => e.toConceptId);

    await tx.concept.delete({ where: { id: concept.id } });

    await tx.concept.createMany({
      data: finerConcepts.map((fc) => ({ pathId, slug: fc.slug, title: fc.title, membership: ConceptMembership.spine })),
    });
    const rows = await tx.concept.findMany({
      where: { pathId, slug: { in: finerConcepts.map((fc) => fc.slug) } },
      select: { id: true, slug: true },
    });
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    const finerIds = rows.map((r) => r.id);

    const edgeData = computeSplitEdges({
      pathId,
      finerIds,
      prereqIds,
      dependentIds,
      internalEdges: authored.edges.map((e) => ({ fromId: idBySlug.get(e.fromSlug)!, toId: idBySlug.get(e.toSlug)! })),
    });
    if (edgeData.length > 0) await tx.conceptPrereq.createMany({ data: edgeData, skipDuplicates: true });

    const links = attachments.flatMap((a) =>
      a.candidates.map((cand) => ({
        conceptId: idBySlug.get(a.conceptSlug)!,
        resourceId: cand.resourceId,
        role: cand.role,
        coverageScore: cand.coverageScore,
      })),
    );
    if (links.length > 0) await tx.conceptResource.createMany({ data: links, skipDuplicates: true });

    return recomputeReadiness(pathId, tx);
  });

  console.log('[split] done', {
    pathId,
    coarse: concept.slug,
    finer: finerConcepts.map((c) => c.slug),
    status: result.status,
  });
  return { split: true, finerSlugs: finerConcepts.map((c) => c.slug), status: result.status, holes: result.holes };
}

// Pure: the full edge set for a split. Internal edges among finer nodes (authored
// ordering) + conservative inheritance (every prereq → every finer node; every
// finer node → every dependent). Provably acyclic given the original graph was.
export function computeSplitEdges(args: {
  pathId: string;
  finerIds: string[];
  prereqIds: string[];
  dependentIds: string[];
  internalEdges: { fromId: string; toId: string }[];
}): Prisma.ConceptPrereqCreateManyInput[] {
  const { pathId, finerIds, prereqIds, dependentIds, internalEdges } = args;
  const edges: Prisma.ConceptPrereqCreateManyInput[] = [];
  for (const e of internalEdges) edges.push({ pathId, fromConceptId: e.fromId, toConceptId: e.toId });
  for (const fid of finerIds) {
    for (const p of prereqIds) edges.push({ pathId, fromConceptId: p, toConceptId: fid });
    for (const d of dependentIds) edges.push({ pathId, fromConceptId: fid, toConceptId: d });
  }
  return edges;
}

// Returns an error string if the authored split is unusable, else null. Count in
// range, slugs well-formed/unique/new, edges reference local slugs, internal
// edges acyclic. (Inherited edges aren't checked — they're acyclic by construction.)
export function validateSplit(
  concepts: { slug: string; title: string }[],
  edges: { fromSlug: string; toSlug: string }[],
  existingSlugs: Set<string>,
): string | null {
  if (concepts.length < REMEDIATION_SPLIT_MIN_NODES) return `only ${concepts.length} finer node(s); not a split`;
  if (concepts.length > REMEDIATION_SPLIT_MAX_NODES) return `${concepts.length} finer nodes exceeds cap ${REMEDIATION_SPLIT_MAX_NODES}`;

  const slugs = new Set<string>();
  for (const c of concepts) {
    if (!SLUG_PATTERN.test(c.slug)) return `malformed slug "${c.slug}"`;
    if (slugs.has(c.slug)) return `duplicate slug "${c.slug}"`;
    if (existingSlugs.has(c.slug)) return `slug "${c.slug}" collides with an existing concept`;
    slugs.add(c.slug);
  }

  const adjacency = new Map<string, string[]>();
  for (const s of slugs) adjacency.set(s, []);
  for (const e of edges) {
    if (!slugs.has(e.fromSlug) || !slugs.has(e.toSlug)) return `edge "${e.fromSlug}" → "${e.toSlug}" references an unknown finer slug`;
    if (e.fromSlug === e.toSlug) return `self-loop on "${e.fromSlug}"`;
    adjacency.get(e.fromSlug)!.push(e.toSlug);
  }
  if (findCycle(adjacency)) return 'authored internal edges contain a cycle';
  return null;
}

// ── author ────────────────────────────────────────────────────────────────────

async function authorSplit(args: {
  concept: CoarseConcept;
  subject?: string;
  evidence: SliceEvidence[];
}): Promise<z.infer<typeof SplitSchema>> {
  const { concept, subject, evidence } = args;
  const { model, temperature, maxOutputTokens, modelId } = getModel('mapSpineAuthor');

  const result = await generateText({
    model,
    temperature,
    maxOutputTokens,
    output: Output.object({ schema: SplitSchema }),
    system: SPLIT_SYSTEM_PROMPT,
    prompt: buildSplitPrompt(concept, subject, evidence),
  });

  const out = result.experimental_output;
  console.log('[split-author]', {
    concept: concept.slug,
    modelId,
    canSplit: out.canSplit,
    finer: out.concepts.length,
    usage: result.usage,
    finishReason: result.finishReason,
  });
  return out;
}

const SPLIT_SYSTEM_PROMPT = `You refine a curriculum concept map. You are given ONE spine concept that appears too COARSE — several resources each teach a different slice of it and none teaches the whole thing, so it has no single qualifying primary resource. Your job is to split it into finer concepts, one coherent teachable idea each.

Rules:
- If the concept genuinely bundles several distinct ideas (its title lists ideas with "and"/commas, or the slice evidence shows resources covering different sub-topics), set canSplit=true and output the finer concepts.
- Output between ${REMEDIATION_SPLIT_MIN_NODES} and ${REMEDIATION_SPLIT_MAX_NODES} finer concepts, each ONE coherent idea a single resource could teach end-to-end. Prefer the finer split when in doubt.
- If the concept is already a single coherent idea that cannot be sensibly decomposed (the coarseness is not real), set canSplit=false and explain in reason — do NOT invent artificial sub-divisions.
- \`slug\`: stable, kebab-case, unique, descriptive (e.g. "linear-independence", "basis", "dimension"). Must be NEW slugs, not the coarse concept's slug.
- \`title\`: short human-readable name.
- \`edges\` {fromSlug, toSlug} mean "learn from before to" among the FINER nodes only — a Directed Acyclic Graph capturing genuine direct prerequisites between the slices (e.g. linear-independence → basis → dimension). Reference only the finer slugs you listed. Do not add edges to outside concepts; the map-builder reconnects the finer nodes to the rest of the graph.`;

function buildSplitPrompt(concept: CoarseConcept, subject: string | undefined, evidence: SliceEvidence[]): string {
  const lines = [
    `Coarse concept to split: "${concept.title}" (slug: ${concept.slug})`,
    `Subject domain: ${subject?.trim() ? subject : '(unspecified)'}`,
    '',
    'Slice evidence — resources that each partially teach the concept (title + what each teaches):',
    evidence.length > 0
      ? JSON.stringify(evidence.map((e) => ({ title: e.title, teaches: e.conceptsTaught })), null, 2)
      : '(no candidate evidence — decide from the title alone)',
  ];
  return lines.join('\n');
}
