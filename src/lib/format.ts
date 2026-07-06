// Small pure display helpers shared across server and client components. No
// prisma/DOM imports, so either side can pull them in (formatMinutes lives in
// program-view.ts, which is server-only — keep these free of that dependency).

// Turn a hyphenated topic slug into a Title Case label: "linear-algebra" →
// "Linear Algebra". The fallback label when a Track/Program has no generated
// title yet.
export function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Completion percentage, rounded, guarding the zero-total case (→ 0, not NaN).
// The single definition of "percent complete" across every progress readout.
export function pctComplete(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
