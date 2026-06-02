// Phase 2.5-AR: lightweight, structured agent trace for the playground.
//
// The curriculum pipeline (runRetrieval + generateCurriculum) already logs its
// stages and tool calls to stdout. A TraceEvent sink lets a caller ALSO collect
// those as structured events to surface in the UI — additive, opt-in via an
// `onTrace` callback threaded through the pipeline. When no callback is passed,
// nothing changes. Events are ephemeral (not persisted): the route returns the
// collected array in its response and the playground renders it once.

export type TraceEventKind = 'stage' | 'tool' | 'fallback' | 'info';

export type TraceEvent = {
  // ms epoch, stamped by the collector so callers don't have to.
  at: number;
  kind: TraceEventKind;
  // Short human-readable label, e.g. "retrieval started", "searchResources".
  label: string;
  // Optional structured payload (args, counts, usage). Kept JSON-serializable.
  detail?: Record<string, unknown>;
};

// Callers emit without the timestamp; the collector stamps it.
export type OnTrace = (event: Omit<TraceEvent, 'at'>) => void;

export function createTraceCollector(): { onTrace: OnTrace; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return {
    events,
    onTrace: (event) => {
      events.push({ ...event, at: Date.now() });
    },
  };
}
