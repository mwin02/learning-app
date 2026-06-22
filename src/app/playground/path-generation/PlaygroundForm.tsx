'use client';

import { useState, type FormEvent } from 'react';
import type { TraceEvent } from '@/lib/agents/agent-trace';

type ErrorBody = {
  error: string;
  code: string;
  details?: unknown;
};

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; requestId: string; topic: string; trace: TraceEvent[] }
  | { kind: 'error'; body: ErrorBody | { error: string; code: 'NETWORK' } };

export function PlaygroundForm() {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);

    const rawTimeframe = String(data.get('timeframeWeeks') ?? '');
    const rawHours = String(data.get('hoursPerWeek') ?? '');
    const priorKnowledge = String(data.get('priorKnowledge') ?? '').trim();
    const goal = String(data.get('goal') ?? '').trim();
    const targetMastery = String(data.get('targetMastery') ?? '').trim();

    // Submit raw strings as-is for text fields so the server validates
    // exactly what the user typed. Number fields go through Number() so
    // the JSON shape matches the Zod schema; non-numeric input becomes NaN
    // and trips INVALID_INPUT on the server — which is what we want to see.
    const payload: Record<string, unknown> = {
      topic: String(data.get('topic') ?? ''),
      timeframeWeeks: rawTimeframe === '' ? '' : Number(rawTimeframe),
      hoursPerWeek: rawHours === '' ? '' : Number(rawHours),
    };
    if (priorKnowledge.length > 0) payload.priorKnowledge = priorKnowledge;
    if (goal.length > 0) payload.goal = goal;
    if (targetMastery.length > 0) payload.targetMastery = targetMastery;

    setState({ kind: 'loading' });

    let res: Response;
    try {
      res = await fetch('/api/generate-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      setState({
        kind: 'error',
        body: { error: err instanceof Error ? err.message : 'Network error.', code: 'NETWORK' },
      });
      return;
    }

    if (res.status === 404) {
      setState({
        kind: 'error',
        body: {
          error: 'POST /api/generate-path returned 404 — is DEV_AUTH=1 set on the dev server?',
          code: 'NETWORK',
        },
      });
      return;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      setState({
        kind: 'error',
        body: { error: `Non-JSON response (HTTP ${res.status}).`, code: 'NETWORK' },
      });
      return;
    }

    if (!res.ok) {
      setState({ kind: 'error', body: json as ErrorBody });
      return;
    }

    const { requestId, topic, trace } = json as {
      requestId: string;
      topic: string;
      trace?: TraceEvent[];
    };
    setState({ kind: 'done', requestId, topic, trace: trace ?? [] });
  }

  const disabled = state.kind === 'loading';

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 max-w-2xl">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">topic</span>
        <input
          name="topic"
          type="text"
          defaultValue="python-data-ml"
          className="border px-2 py-1 rounded"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">targetMastery (optional — beginner | intermediate | advanced)</span>
        <input
          name="targetMastery"
          type="text"
          defaultValue="beginner"
          className="border px-2 py-1 rounded"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">goal (optional, ≤2000 chars — the composer infers intent from this)</span>
        <textarea
          name="goal"
          rows={2}
          placeholder="e.g. refresh calculus before a stats course"
          className="border px-2 py-1 rounded"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">priorKnowledge (optional, ≤500 chars)</span>
        <textarea
          name="priorKnowledge"
          rows={3}
          className="border px-2 py-1 rounded"
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-sm font-medium">timeframeWeeks (1–52)</span>
          <input
            name="timeframeWeeks"
            type="number"
            defaultValue={4}
            className="border px-2 py-1 rounded"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-sm font-medium">hoursPerWeek (1–40)</span>
          <input
            name="hoursPerWeek"
            type="number"
            defaultValue={5}
            className="border px-2 py-1 rounded"
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="border px-4 py-2 rounded bg-black text-white disabled:opacity-50 self-start"
      >
        {disabled ? 'Queueing…' : 'Request course'}
      </button>

      {state.kind === 'loading' && (
        <p className="text-sm text-gray-600">
          Validating the topic and queueing the request…
        </p>
      )}

      {state.kind === 'error' && (
        <div className="border border-red-400 bg-red-50 text-red-900 p-3 rounded text-sm">
          <div className="font-semibold">{state.body.code}</div>
          <div>{state.body.error}</div>
          {'details' in state.body && state.body.details !== undefined && (
            <pre className="mt-2 whitespace-pre-wrap text-xs">
              {JSON.stringify(state.body.details, null, 2)}
            </pre>
          )}
        </div>
      )}

      </form>

      {state.kind === 'done' && (
        <div className="flex flex-col gap-3 max-w-5xl">
          <div className="border border-green-500 bg-green-50 text-green-900 p-3 rounded text-sm">
            <div className="font-semibold">Request queued ✓</div>
            <div>
              requestId <code className="font-mono">{state.requestId}</code> · topic{' '}
              <code className="font-mono">{state.topic}</code>
            </div>
            <div className="mt-1 text-green-800">
              Fire-and-forget: the out-of-band worker builds the Track. Run{' '}
              <code className="font-mono">tsx --env-file=.env.local scripts/course-worker.ts --once</code>{' '}
              to process it; the built Track is logged to the worker console (the
              &ldquo;course ready&rdquo; notification is Phase 3).
            </div>
          </div>
          <AgentTracePanel trace={state.trace} />
        </div>
      )}
    </div>
  );
}

const KIND_STYLES: Record<TraceEvent['kind'], string> = {
  stage: 'bg-blue-100 text-blue-800',
  tool: 'bg-gray-200 text-gray-800',
  fallback: 'bg-amber-100 text-amber-900',
  info: 'bg-gray-100 text-gray-700',
};

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  return Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
}

function AgentTracePanel({ trace }: { trace: TraceEvent[] }) {
  if (trace.length === 0) {
    return <p className="text-sm text-gray-600">No trace events were recorded.</p>;
  }
  const t0 = trace[0].at;
  return (
    <div className="border rounded">
      <div className="px-3 py-2 border-b bg-gray-50 text-sm font-semibold">
        Agent trace ({trace.length} events)
      </div>
      <ol className="max-h-80 overflow-auto p-2 text-xs font-mono flex flex-col gap-1">
        {trace.map((e, i) => {
          const dt = ((e.at - t0) / 1000).toFixed(2);
          const detail = formatDetail(e.detail);
          return (
            <li key={i} className="flex gap-2 items-baseline">
              <span className="text-gray-400 w-12 shrink-0 text-right">+{dt}s</span>
              <span className={`px-1.5 rounded shrink-0 ${KIND_STYLES[e.kind]}`}>{e.kind}</span>
              <span className="shrink-0 font-semibold">{e.label}</span>
              {detail && <span className="text-gray-600 break-all">{detail}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
