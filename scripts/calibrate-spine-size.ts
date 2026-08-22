// Clause-1 calibration: what does the spine author return with NO count constraint?
// Everything else (model, temperature, schema, prompt) is identical to spine-author.ts;
// the ONLY variable is the removed 8–15 range. Read-only: no DB writes, no persistence.
import { Output, generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '../src/lib/ai/models';

const SpineSchema = z.object({
  concepts: z.array(z.object({ slug: z.string(), title: z.string().min(2), isOnRamp: z.boolean().default(false) })),
  edges: z.array(z.object({ fromSlug: z.string(), toSlug: z.string() })),
});

// spine-author.ts's SYSTEM_PROMPT with the count bullet's numeric range removed and
// nothing else altered.
const SYSTEM_PROMPT = `You are the spine author of a curriculum map-builder. Given a topic, you decompose it into the SPINE of its concept map: the required backbone of concepts a learner must master to be competent in the topic, plus the prerequisite relationships between them.

This is NOT a reading list and NOT a schedule. You are authoring a concept graph that every future learner's plan will traverse, so it must be correct and stable.

Concepts:
- Output as many concepts as the topic's required backbone genuinely needs — no more, no fewer. The spine is the REQUIRED backbone only — exclude optional enrichment, niche subtopics, and tooling. Those are added later as a separate "frontier".
- OPEN with a foundational onboarding concept at the root — an orientation on-ramp every later concept builds on, so an absolute beginner is never dropped cold into a hard idea. It covers what the subject is, the core mental model, and (as the subject warrants) how to set up / run / read it: for a programming topic, "Getting Started: what it is, environment setup, your first program"; for a math topic, the conceptual big picture, notation, and prerequisite review (NOT tooling). It is a real teachable concept (not a preface), has no prerequisites of its own, and is a prerequisite of the first substantive concept(s). Mark this one concept with \`isOnRamp: true\` and set \`isOnRamp: false\` on every other concept — exactly one on-ramp per spine. Skip it (no on-ramp at all) only when the topic genuinely has no meaningful on-ramp.
- Each concept is one coherent, teachable idea — coarse enough to map to real lessons, not a single fact and not a whole sub-field. Crucially, do NOT bundle several distinct ideas into one concept: a node like "Linear Independence, Basis, and Dimension" or "Symmetric Matrices and Singular Value Decomposition" is too coarse — no single resource teaches all of it, so it can't be covered. Split such bundles into one concept per idea (e.g. linear-independence → basis → dimension) with the right prerequisite edges between them. A title that lists multiple ideas (with "and"/commas) is a sign you should split. This applies EVEN to elementary, foundational basics that are often mentioned together: "Variables, Data Types, and Operators" must be separate concepts (e.g. variables-and-data-types → operators-and-expressions), not one node — a single intro resource rarely teaches all of them at depth. When in doubt, prefer the FINER split: one idea per concept. The single exception is the onboarding root above: it is deliberately one orientation concept even though it spans "what it is / mental model / setup", so do NOT split it — that grouping is by design and a single intro resource is expected to cover it.
- \`slug\`: stable, kebab-case, unique (e.g. "variables-and-types", "list-comprehensions"). The slug is an identity that later passes match against, so make it descriptive and canonical.
- \`title\`: a short human-readable name.

Prerequisite edges:
- Each edge \`{fromSlug, toSlug}\` means "learn \`from\` before \`to\`" — \`from\` is the prerequisite, \`to\` depends on it.
- The edges MUST form a Directed Acyclic Graph: no concept may be, directly or transitively, its own prerequisite. Order from foundational to advanced.
- Add an edge only for a genuine, direct prerequisite. Do not add an edge between two concepts that are merely related, and do not add transitive shortcuts (if A→B and B→C, you need not also state A→C).
- Every slug referenced in an edge must be one of the concepts you listed.`;

const POPULATIONS: Record<string, string[]> = {
  'has-a-path': ['calculus','data-structures-algorithms','javascript','javascript-react','linear-algebra','machine-learning','physics-mechanics','precalculus','python','python-data-ml','sql','statistics'],
  'broad-control': ['computer-science','mathematics','artificial-intelligence','physics','biology'],
  'narrow-control': ['reinforcement-learning','neural-networks','eigenvalues-and-eigenvectors','systems-of-linear-equations'],
};

async function authorOne(topic: string, subject: string): Promise<number | string> {
  const { model, temperature, maxOutputTokens } = getModel('mapSpineAuthor');
  try {
    const result = await generateText({
      model, temperature, maxOutputTokens,
      output: Output.object({ schema: SpineSchema }),
      system: SYSTEM_PROMPT,
      prompt: [`Topic: ${topic}`, `Subject domain: ${subject}`, '', 'Author the spine concept map for this topic: the backbone concepts and the directed prerequisite edges between them, as a DAG.'].join('\n'),
    });
    return result.experimental_output.concepts.length;
  } catch (err) {
    return `ERR ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`;
  }
}

const SUBJECT: Record<string, string> = {
  calculus:'math', 'linear-algebra':'math', precalculus:'math', statistics:'math', mathematics:'math',
  'eigenvalues-and-eigenvectors':'math', 'systems-of-linear-equations':'math',
  'physics-mechanics':'science', physics:'science', biology:'science',
};

async function main() {
  const runs = Number(process.env.RUNS ?? '1');
  const rows: { pop: string; topic: string; counts: (number | string)[] }[] = [];
  for (const [pop, topics] of Object.entries(POPULATIONS)) {
    for (const topic of topics) rows.push({ pop, topic, counts: [] });
  }
  for (let r = 0; r < runs; r++) {
    // Parallel in small batches: each call is a Pro round-trip.
    for (let i = 0; i < rows.length; i += 5) {
      const batch = rows.slice(i, i + 5);
      const got = await Promise.all(batch.map((b) => authorOne(b.topic, SUBJECT[b.topic] ?? 'cs')));
      batch.forEach((b, j) => b.counts.push(got[j]));
      console.error(`  …run ${r + 1}: ${batch.map((b, j) => `${b.topic}=${got[j]}`).join(' ')}`);
    }
  }
  console.log('\n=== unconstrained spine size (SPINE_MAX_CONCEPTS is currently 15)\n');
  let last = '';
  for (const row of rows) {
    if (row.pop !== last) { console.log(`-- ${row.pop}`); last = row.pop; }
    console.log(`   ${row.topic.padEnd(30)} ${row.counts.join(', ')}`);
  }
}
main();
