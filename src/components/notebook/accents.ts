// Notebook UI (Block B): the course accent cycle. Dashboard chapters, bookmark
// tabs, and section badges color-code by position using these five pairs — a
// fill (`bg`, white text on top) and a darker matching ink (`ink`, for text and
// progress fills on paper). CSS var references so dark mode resolves for free.

export type Accent = { bg: string; ink: string };

const NAMES = ['coral', 'gold', 'violet', 'green', 'pink'] as const;

export const NB_ACCENTS: Accent[] = NAMES.map((n) => ({
  bg: `var(--color-nb-${n})`,
  ink: `var(--color-nb-${n}-ink)`,
}));

export function accentFor(index: number): Accent {
  return NB_ACCENTS[index % NB_ACCENTS.length];
}
