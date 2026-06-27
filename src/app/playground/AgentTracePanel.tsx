// Phase 2.5-AR / 2.5e-8 (block 2d): shared renderer for an agent's structured trace
// (TraceEvent[]). Originally inline in the path-generation form; extracted so the
// build-track inspector can surface the composer agent's tool calls (search_candidates,
// add_lesson, exclude_concept, finalize) with the same look. Purely presentational.

import type { TraceEvent } from '@/lib/agents/agent-trace';

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

export function AgentTracePanel({ trace }: { trace: TraceEvent[] }) {
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
