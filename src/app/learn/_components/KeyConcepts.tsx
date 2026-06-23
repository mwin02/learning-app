// Phase 2.6 (learn UI): the "Key concepts" card. The source design had a
// "What you'll learn" outcomes grid, but we have no outcomes field — so this
// surfaces the track's distinct conceptsTaught as chips instead (real data).

export function KeyConcepts({ concepts }: { concepts: string[] }) {
  if (concepts.length === 0) return null;
  return (
    <div className="card mb-[var(--space-section)] px-[22px] py-5">
      <div className="eyebrow mb-[14px]">KEY CONCEPTS</div>
      <div className="flex flex-wrap gap-2">
        {concepts.map((concept) => (
          <span
            key={concept}
            className="rounded-full border border-line bg-fill-soft px-3 py-1 text-sm text-ink-soft"
          >
            {concept}
          </span>
        ))}
      </div>
    </div>
  );
}
