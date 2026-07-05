// Unit tests for decomposeProgramAgent (decomposer-agent Block 2): a mocked
// LanguageModel drives the tool loop turn by turn — no LLM, no DB. Asserts the
// draft mechanics (propose/revise/cap), frontier hygiene (trim/dedup/cap), the
// get_path_map passthrough, prompt grounding, and the finalize-miss fallback chain
// (synthesized framing → deterministic topic-list framing → throw on no topics).
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { PathStatus, ConceptMembership } from '@prisma/client';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';

// The agent's import graph pulls in Vertex (via @/lib/ai/models) and Prisma (via
// topic-registry → @/lib/db), both of which throw at module-eval without env vars.
// Every seam is injected here, so stub the leaves (see CLAUDE.md testing notes).
vi.mock('@/lib/ai/models', () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { decomposeProgramAgent, type PathMapView } from '@/lib/agents/program/decompose-agent';
import { MAX_FRONTIER_PER_TOPIC, MAX_PROGRAM_TOPICS } from '@/lib/config';
import type { ProgramPlanInput } from '@/lib/agents/program/plan';
import type { ResolvedModel } from '@/lib/ai/models';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const response = { id: 'res-1', timestamp: new Date(0), modelId: 'mock' };

let callId = 0;
const toolTurn = (calls: Array<{ name: string; input: unknown }>): LanguageModelV3GenerateResult => ({
  content: calls.map((c) => ({
    type: 'tool-call' as const,
    toolCallId: `call-${++callId}`,
    toolName: c.name,
    input: JSON.stringify(c.input),
  })),
  finishReason: { unified: 'tool-calls', raw: undefined },
  usage,
  response,
  warnings: [],
});
const textTurn = (text = 'done'): LanguageModelV3GenerateResult => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage,
  response,
  warnings: [],
});

// Wrap a scripted turn sequence as the ResolvedModel the agent takes via opts.
// Sequenced via our own counter, NOT the mock's array form: MockLanguageModelV3
// indexes an array with doGenerateCalls.length AFTER pushing the current call
// (ai 6.0.191), so the array form skips its first element.
const scripted = (turns: LanguageModelV3GenerateResult[]): ResolvedModel => {
  let i = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        const turn = turns[i++];
        if (!turn) throw new Error(`mock model ran out of scripted turns (asked for turn ${i})`);
        return turn;
      },
    }),
    modelId: 'mock',
    temperature: 0,
    maxOutputTokens: 4096,
  };
};

const input: ProgramPlanInput = {
  goal: 'be ready for a machine-learning research internship',
  background: 'CS sophomore',
  totalHoursPerWeek: 8,
  totalWeeks: 12,
};

const proposal = (over: Record<string, unknown>) => ({
  topic: 'calculus',
  weight: 1,
  priorityTier: 'core',
  phaseLabel: 'Month 1',
  orderHint: 1,
  rationale: 'r',
  ...over,
});

describe('decomposeProgramAgent', () => {
  it('builds the decomposition through the tool loop: map lookup, proposals, finalize', async () => {
    const mapCalls: string[] = [];
    const getPathMap = async (topic: string): Promise<PathMapView> => {
      mapCalls.push(topic);
      return {
        exists: true,
        status: PathStatus.spine_ready,
        concepts: [{ slug: 'limits', title: 'Limits', membership: ConceptMembership.spine }],
      };
    };
    const turns = [
      toolTurn([{ name: 'get_path_map', input: { topic: 'calculus' } }]),
      toolTurn([
        {
          name: 'propose_course',
          input: proposal({
            // trims, dedups, then caps at MAX_FRONTIER_PER_TOPIC (order-preserving)
            frontierConcepts: [' matrix calculus ', 'matrix calculus', 'optimization theory', 'measure theory'],
          }),
        },
        { name: 'propose_course', input: proposal({ topic: 'python', orderHint: 2, weight: 2 }) },
      ]),
      toolTurn([{ name: 'finalize', input: { title: 'ML foundations', description: 'Math and Python for ML.' } }]),
      textTurn(),
    ];
    const model = scripted(turns);

    const result = await decomposeProgramAgent(input, {
      model,
      getPathMap,
      listTopics: async () => ['calculus', 'linear-algebra', 'python'],
    });

    expect(result.title).toBe('ML foundations');
    expect(result.description).toBe('Math and Python for ML.');
    expect(result.topics.map((t) => t.topic)).toEqual(['calculus', 'python']);
    expect(result.topics[0].frontierConcepts).toEqual(['matrix calculus', 'optimization theory']);
    expect(result.topics[0].frontierConcepts.length).toBe(MAX_FRONTIER_PER_TOPIC);
    expect(result.topics[1].frontierConcepts).toEqual([]); // omitted → schema default
    expect(mapCalls).toEqual(['calculus']);

    // The prompt seeds the library list inline (ambiguity-#2 default: no list tool).
    const mock = model.model as MockLanguageModelV3;
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain('linear-algebra');
  });

  it('rejects proposals past MAX_PROGRAM_TOPICS and revises on re-propose', async () => {
    const over = Array.from({ length: MAX_PROGRAM_TOPICS + 1 }, (_, i) =>
      ({ name: 'propose_course', input: proposal({ topic: `topic-${i}`, orderHint: i }) }),
    );
    const turns = [
      toolTurn(over),
      // Re-propose an accepted topic (case-insensitive key): revises, not duplicates.
      toolTurn([{ name: 'propose_course', input: proposal({ topic: 'Topic-0', weight: 9 }) }]),
      toolTurn([{ name: 'finalize', input: { title: 'T', description: 'D' } }]),
      textTurn(),
    ];

    const result = await decomposeProgramAgent(input, {
      model: scripted(turns),
      getPathMap: async () => ({ exists: false }),
      listTopics: async () => [],
    });

    expect(result.topics.length).toBe(MAX_PROGRAM_TOPICS); // the +1th was rejected
    expect(result.topics.map((t) => t.topic)).not.toContain(`topic-${MAX_PROGRAM_TOPICS}`);
    const revised = result.topics[0];
    expect(revised.topic).toBe('Topic-0'); // latest label wins
    expect(revised.weight).toBe(9);
  });

  it('finalize-miss synthesizes framing from the draft via the fallback model', async () => {
    const turns = [
      // finalize before any proposal is rejected by the tool (framing stays unset)...
      toolTurn([{ name: 'finalize', input: { title: 'too early', description: 'x' } }]),
      toolTurn([{ name: 'propose_course', input: proposal({}) }]),
      // ...and the loop then ends without a successful finalize.
      textTurn(),
    ];
    const fallbackModel = scripted([
      {
        content: [{ type: 'text', text: JSON.stringify({ title: 'Calculus program', description: 'Covers calculus.' }) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        response,
        warnings: [],
      },
    ]);

    const result = await decomposeProgramAgent(input, {
      model: scripted(turns),
      fallbackModel,
      getPathMap: async () => ({ exists: false }),
      listTopics: async () => [],
    });

    expect(result.title).toBe('Calculus program');
    expect(result.topics.map((t) => t.topic)).toEqual(['calculus']);
  });

  it('degrades to a neutral topic-list framing when the fallback call also fails', async () => {
    const turns = [toolTurn([{ name: 'propose_course', input: proposal({}) }]), textTurn()];
    const fallbackModel: ResolvedModel = {
      model: new MockLanguageModelV3({
        doGenerate: () => {
          throw new Error('fallback boom');
        },
      }),
      modelId: 'mock',
      temperature: 0,
      maxOutputTokens: 4096,
    };

    const result = await decomposeProgramAgent(input, {
      model: scripted(turns),
      fallbackModel,
      getPathMap: async () => ({ exists: false }),
      listTopics: async () => [],
    });

    expect(result.title).toBe('Learning program: calculus');
    expect(result.description).toBe('A learning program covering calculus.');
  });

  it('throws when the loop ends with no proposals (caller records Program.failed)', async () => {
    await expect(
      decomposeProgramAgent(input, {
        model: scripted([textTurn('I cannot help with that.')]),
        getPathMap: async () => ({ exists: false }),
        listTopics: async () => [],
      }),
    ).rejects.toThrow(/proposed no topics/);
  });
});
