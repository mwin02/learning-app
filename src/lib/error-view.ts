// Derivation for the 500 page's "incident slip" — the handful of facts a learner
// can hand us when they write in. Pure, so the copy-to-clipboard text, the
// support mail body and the rendered rows are all one source.
//
// The design mocked a fourth field, `Type` ("Lesson content failed to load"),
// which we cannot honestly fill: in production Next replaces a Server Component's
// error message with a generic string plus `digest` before it reaches the
// boundary, so any Type we printed would be either blank or a guess. Dropped
// rather than faked — the digest is what actually pairs the slip to the
// `server.unhandled` line instrumentation.ts wrote.

export type IncidentFacts = {
  /** Next's error digest. Absent for genuine client-side crashes. */
  reference?: string | null;
  /** When the boundary rendered. Absent until the client has mounted. */
  when?: Date | null;
  where: string;
};

export type IncidentRow = { k: string; v: string };

/** "Aug 26, 2026 · 14:08". Locale/zone are injectable so tests are deterministic. */
export function formatIncidentWhen(
  when: Date,
  { locale = 'en-US', timeZone }: { locale?: string; timeZone?: string } = {}
): string {
  const date = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(when);
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(when);
  return `${date} · ${time}`;
}

/** Only the facts we actually have — a missing one is omitted, never rendered blank. */
export function incidentRows(
  facts: IncidentFacts,
  formatOpts?: { locale?: string; timeZone?: string }
): IncidentRow[] {
  const rows: IncidentRow[] = [];
  if (facts.reference) rows.push({ k: 'Reference', v: facts.reference });
  if (facts.when) rows.push({ k: 'When', v: formatIncidentWhen(facts.when, formatOpts) });
  rows.push({ k: 'Where', v: facts.where });
  return rows;
}

/** The slip as plain text, for the clipboard and for the support mail body. */
export function incidentText(rows: IncidentRow[]): string {
  return rows.map(({ k, v }) => `${k}: ${v}`).join('\n');
}
