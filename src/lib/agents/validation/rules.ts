// Content-quality rules a learning resource must satisfy before it lands in
// the library. Structured as data (not embedded in a prompt) so that:
//   - the rules-agent prompt enumerates them programmatically;
//   - a future human-review UI can present the same checklist;
//   - adding a rule is a one-line change here, not a prompt edit.

export type Rule = {
  id: string;
  // One-line description, written so it can be quoted directly into the LLM
  // prompt and shown to a human reviewer.
  description: string;
};

export const RESOURCE_RULES: readonly Rule[] = [
  {
    id: 'no-login-wall',
    description:
      'The resource must be readable / watchable without creating an account or logging in. Sites that require auth for the main content (e.g. most Coursera, DataCamp, LinkedIn Learning courses) fail this rule.',
  },
  {
    id: 'no-paywall-without-preview',
    description:
      'If the resource is behind a paywall, it must offer a substantial free preview that teaches the topic. Pure "buy to read" pages fail.',
  },
  {
    id: 'no-listicle-or-aggregator',
    description:
      'The resource itself must teach the topic. Listicles ("Top 10 Python tutorials"), link directories, and aggregator pages that only point to other resources fail.',
  },
  {
    id: 'no-marketing-page',
    description:
      'Product or course marketing pages, sales funnels, and signup landing pages with no actual teaching content fail.',
  },
  {
    id: 'teaches-topic-directly',
    description:
      'The resource must teach the requested topic, not merely mention it. A general SQL tutorial does not count as a "PostgreSQL window functions" resource.',
  },
] as const;
