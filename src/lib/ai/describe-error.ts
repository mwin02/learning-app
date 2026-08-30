// Failure-path diagnostics for AI calls.
//
// Every generateObject call site already logs `usage`/`finishReason` when it
// SUCCEEDS, and nothing at all when it doesn't — the catch blocks keep
// `err.message` and drop the rest. That message is the same 8 words every time
// ("No object generated: response did not match schema.") and cannot distinguish
// the two failures that need opposite fixes: a truncated response (raise
// maxOutputTokens) versus a well-formed response the schema rejected (fix the
// schema or the prompt). The 2026-08-30 multivariable-calculus build burned 14
// minutes on 23 of these and left no way to tell which it was.
//
// The fields that answer it are all on the error already:
//   - finishReason 'length'      → truncation
//   - a zod issue list on .cause → schema violation, naming the exact path
// AI SDK nests them as NoObjectGeneratedError → TypeValidationError → ZodError,
// so the cause chain is walked rather than destructured at a fixed depth: the
// nesting is an SDK implementation detail, and the same walk serves any wrapped
// error (TrackBuildError's `cause`, for instance).

// Log lines are one JSON object per line in Cloud Logging; a raw model response
// can be tens of KB. Everything here is bounded.
const MAX_TEXT = 600;
const MAX_ISSUES = 8;
const MAX_DEPTH = 5;
// SDK error messages inline their whole payload — TypeValidationError's message
// embeds both the raw value and a pretty-printed dump of every zod issue, which
// `schemaIssues` already carries in one line each. Cap what the chain contributes.
const MAX_CAUSE = 200;

export type DescribedError = {
  error: string;
  causes?: string[];
  finishReason?: string;
  outputTokens?: number;
  schemaIssues?: string[];
  responseText?: string;
  responseTextTruncated?: true;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// zod's ZodError carries `issues: [{ path, message }]`. Matched structurally so
// this works across zod versions and wherever in the chain the error sits.
function zodIssues(v: unknown): string[] | undefined {
  if (!isRecord(v) || !Array.isArray(v.issues)) return undefined;
  const out: string[] = [];
  for (const issue of v.issues.slice(0, MAX_ISSUES)) {
    if (!isRecord(issue)) continue;
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message : 'invalid';
    out.push(path ? `${path}: ${message}` : message);
  }
  return out.length > 0 ? out : undefined;
}

export function describeError(err: unknown): DescribedError {
  const out: DescribedError = { error: messageOf(err) };
  const causes: string[] = [];

  let node: unknown = err;
  for (let depth = 0; depth < MAX_DEPTH && isRecord(node); depth += 1) {
    // First writer wins: the outermost error carrying a field is the one whose
    // context the reader is holding.
    if (out.finishReason === undefined && typeof node.finishReason === 'string') {
      out.finishReason = node.finishReason;
    }
    if (out.outputTokens === undefined && isRecord(node.usage) && typeof node.usage.outputTokens === 'number') {
      out.outputTokens = node.usage.outputTokens;
    }
    if (out.responseText === undefined && typeof node.text === 'string' && node.text.length > 0) {
      out.responseText = node.text.slice(0, MAX_TEXT);
      if (node.text.length > MAX_TEXT) out.responseTextTruncated = true;
    }
    if (out.schemaIssues === undefined) {
      const issues = zodIssues(node);
      if (issues) out.schemaIssues = issues;
    }

    const cause: unknown = node.cause;
    if (cause === undefined || cause === null) break;
    // The top-level message is already in `error`; the chain is what it hides.
    // A node whose issues we extracted structurally contributes nothing here —
    // its message is the same content, unparsed.
    if (!zodIssues(cause)) {
      const message = messageOf(cause).slice(0, MAX_CAUSE);
      if (message && !causes.includes(message)) causes.push(message);
    }
    node = cause;
  }

  if (causes.length > 0) out.causes = causes;
  return out;
}
