// Rules-agent validator. Single LLM call (Flash) over the full batch, judging
// each resource against the data-driven rule list in `../rules.ts`. Operates
// on URL + title + summary + type only — no page fetching. The model is
// expected to know enough about common domains (coursera.org, medium.com
// listicles, etc.) to flag rule violations without seeing the page itself.

import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/lib/ai/models';
import { recordUsage } from '@/lib/log';
import { RESOURCE_RULES } from '../rules';
import type { Validator, ValidatorVerdict, ValidatableResource } from '../types';

const RULE_IDS = RESOURCE_RULES.map((r) => r.id) as [string, ...string[]];

const VerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        url: z.string().url(),
        valid: z.boolean(),
        // When valid=false, which rule was violated and why.
        violatedRule: z.enum(RULE_IDS).nullable(),
        reason: z.string().nullable(),
      }),
    )
    .min(0),
});

export const rulesAgentValidator: Validator = {
  id: 'rules-agent',
  cost: 'expensive',
  async validate(rows: ValidatableResource[]): Promise<ValidatorVerdict[]> {
    if (rows.length === 0) return [];
    const { model, temperature, maxOutputTokens } = getModel('validityAgent');

    const input = rows.map((r) => ({ url: r.url, title: r.title, summary: r.summary, type: r.type }));

    const result = await generateObject({
      model,
      temperature,
      maxOutputTokens,
      schema: VerdictSchema,
      system: buildSystemPrompt(),
      prompt: [
        'Resources to validate. Return one verdict per resource, keyed by url.',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    });

    recordUsage('validate.rules-agent', result.usage);

    console.log('[rules-agent] call', {
      rowCount: rows.length,
      usage: result.usage,
      finishReason: result.finishReason,
    });

    const out: ValidatorVerdict[] = [];
    for (const v of result.object.verdicts) {
      if (v.valid) {
        out.push({ url: v.url, valid: true });
      } else {
        const ruleLabel = v.violatedRule ?? 'unspecified';
        const why = v.reason?.trim() || 'no reason given';
        out.push({ url: v.url, valid: false, reason: `${ruleLabel}: ${why}` });
      }
    }
    return out;
  },
};

function buildSystemPrompt(): string {
  const rulesText = RESOURCE_RULES.map((r, i) => `${i + 1}. [${r.id}] ${r.description}`).join('\n');
  return `You are a content-quality validator for a learning-resource library. Judge each candidate against the rules below.

Rules:
${rulesText}

For each candidate:
- If it satisfies all rules, set valid=true, violatedRule=null, reason=null.
- If it violates any rule, set valid=false, set violatedRule to the id of the first violated rule, and write a short reason quoting what's wrong.
- Be strict about login walls: if the domain is known to require auth for its main content (Coursera, DataCamp, Udemy paid courses, LinkedIn Learning, edX verified-track), reject regardless of how the title is phrased.
- Free official documentation, free educator content (YouTube, blog posts), free university courseware (MIT OCW, Stanford CS), and free textbook sites are typically fine.
- When in doubt about a specific URL, lean reject — the cost of a bad library entry is higher than the cost of a missed good one.`;
}
