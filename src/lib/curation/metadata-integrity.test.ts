import { describe, it, expect } from 'vitest';
import type { KhanProbe } from './khan-probe-duration';
import {
  classifyMetadataIntegrity,
  type MetadataIntegrityRow,
  type MetadataDiscrepancy,
} from './metadata-integrity';

const ARTICLE_URL =
  'https://www.khanacademy.org/math/statistics-probability/sampling-distributions/a/introduction-to-residuals';
const VIDEO_URL =
  'https://www.khanacademy.org/math/statistics-probability/sampling-distributions/v/central-limit-theorem';

// A row and a probe that agree about everything, so each test below changes one thing.
const row = (over: Partial<MetadataIntegrityRow> = {}): MetadataIntegrityRow => ({
  type: 'article',
  url: ARTICLE_URL,
  title: 'Introduction to residuals',
  ...over,
});

const probe = (over: Partial<KhanProbe> = {}): KhanProbe => ({
  url: ARTICLE_URL,
  title: 'Introduction to residuals (article) | Khan Academy',
  pageKind: 'article',
  videoIds: [],
  articleWords: 900,
  articleWordsBeforeExpand: 900,
  collapsedExpanded: 0,
  workedExamples: 0,
  widgets: 0,
  mainWords: 2100,
  hasEditor: false,
  blocked: false,
  ...over,
});

// The page-checked list is unreachable without narrowing, by design. This asserts the
// narrowing once rather than at every call site.
const checked = (r: MetadataIntegrityRow, p?: KhanProbe | null): MetadataDiscrepancy[] => {
  const out = classifyMetadataIntegrity(r, p);
  if (!out.pageChecked) throw new Error(`expected a page-checked outcome, got: ${out.reason}`);
  return out.discrepancies;
};

const kinds = (d: MetadataDiscrepancy[]) => d.map((x) => x.kind);

describe('comparison 1 — stored type against the stored URL, the free rule', () => {
  // The measured population: 8 rows, 3 pickable, 1 attached. It needs no probe, which is
  // what lets it run over the whole library.
  it('reports a retype with no probe supplied at all', () => {
    const out = classifyMetadataIntegrity(row({ type: 'interactive' }));
    expect(out.pageChecked).toBe(false);
    if (out.pageChecked) throw new Error('unreachable');
    expect(out.reason).toBe('no-probe');
    expect(out.rowDiscrepancies).toEqual([
      {
        kind: 'type-contradicts-url',
        clause: 6,
        repair: 'retype',
        to: 'article',
        detail: "stored type 'interactive' on a /a/ URL",
      },
    ]);
  });

  it('reports a /v/ URL that is not typed video', () => {
    const out = classifyMetadataIntegrity(row({ type: 'article', url: VIDEO_URL }));
    expect(out.pageChecked ? out.discrepancies : out.rowDiscrepancies).toMatchObject([
      { kind: 'type-contradicts-url', repair: 'retype', to: 'video' },
    ]);
  });

  it('says nothing when the URL kind and the stored type agree', () => {
    expect(classifyMetadataIntegrity(row())).toMatchObject({ rowDiscrepancies: [] });
    expect(
      classifyMetadataIntegrity(row({ type: 'video', url: VIDEO_URL })),
    ).toMatchObject({ rowDiscrepancies: [] });
  });

  // `/e/`, `/pt/` and `/pi/` name no permitted retype target. A retype there would re-label
  // an exercise as an article and keep it, which is clause 5's exclusion inverted.
  it.each(['e', 'pt', 'pi'])('never proposes a retype for a /%s/ URL', (kind) => {
    const url = `https://www.khanacademy.org/computing/computer-programming/x/${kind}/build-a-house`;
    for (const type of ['article', 'video', 'interactive'] as const) {
      expect(classifyMetadataIntegrity(row({ type, url }))).toMatchObject({ rowDiscrepancies: [] });
    }
  });

  it('says nothing about a Khan URL with no content-kind segment', () => {
    const url = 'https://www.khanacademy.org/math/statistics-probability/sampling-distributions';
    expect(classifyMetadataIntegrity(row({ type: 'interactive', url }))).toMatchObject({
      rowDiscrepancies: [],
    });
  });

  // ⚠️ `urlKind` is a bare path regex, so off Khan a `/a/` or `/v/` segment means nothing
  // and this rule's repair is destructive. The host gate is what keeps it off a resemblance.
  it('does not fire on a non-Khan URL carrying a /v/ segment', () => {
    expect(
      classifyMetadataIntegrity({
        type: 'docs',
        url: 'https://docs.python.org/3/v/library-intro',
        title: 'Library intro',
      }),
    ).toMatchObject({ rowDiscrepancies: [] });
  });

  it('does not throw on a value that is not a URL', () => {
    expect(
      classifyMetadataIntegrity({ type: 'article', url: 'generated://onramp/x', title: 'On-ramp' }),
    ).toMatchObject({ rowDiscrepancies: [] });
  });
});

describe('comparison 2 — the page declares a kind the stored type contradicts', () => {
  // The row that motivated the rule: typed `interactive`, served by Khan as an article, and
  // invisible to every rule over `type` or `url` because its URL carries no /a/ segment.
  it('reports a retype to article for an interactive row the page calls an article', () => {
    const url = 'https://www.khanacademy.org/computing/computer-science/cryptography/comp-number-theory';
    const found = checked(row({ type: 'interactive', url, title: 'Modular arithmetic' }), probe({ url, title: 'Modular arithmetic (article) | Khan Academy' }));
    expect(found).toEqual([
      {
        kind: 'type-contradicts-page',
        clause: 6,
        repair: 'retype',
        to: 'article',
        detail: "stored type 'interactive' but the page declares itself a article",
      },
    ]);
  });

  it('reports a retype to video when the page declares itself a video', () => {
    expect(
      checked(row({ type: 'video', url: VIDEO_URL, title: 'Central limit theorem' }), probe({ url: VIDEO_URL, title: 'Central limit theorem (video) | Khan Academy', pageKind: 'video' })),
    ).toEqual([]);
    expect(
      kinds(checked(row({ type: 'interactive', url: VIDEO_URL, title: 'Central limit theorem' }), probe({ url: VIDEO_URL, title: 'Central limit theorem (video) | Khan Academy', pageKind: 'video' }))),
    ).toContain('type-contradicts-page');
  });

  // `article-like`, `challenge` and `other` are the probe INFERRING from the DOM rather than
  // the page stating its form, and a weaker signal must not overturn the stored type.
  it.each(['article-like', 'challenge', 'other'])(
    'does not retype on the inferred pageKind %s',
    (pageKind) => {
      const url = 'https://www.khanacademy.org/computing/computer-programming/programming/intro';
      expect(
        checked(row({ type: 'interactive', url, title: 'Intro' }), probe({ url, pageKind, title: 'Intro | Khan Academy' })),
      ).toEqual([]);
    },
  );
});

describe('comparison 3 — the stored URL now serves a different kind', () => {
  const landed = 'https://www.khanacademy.org/math/statistics-probability/sampling-distributions/v/introduction-to-residuals';

  it('reports the redirect as a review, never a retype', () => {
    const found = checked(row(), probe({ url: landed, pageKind: 'video', title: 'Introduction to residuals (video) | Khan Academy' }));
    const redirect = found.find((d) => d.kind === 'url-redirects-across-kinds');
    expect(redirect).toEqual({
      kind: 'url-redirects-across-kinds',
      clause: 6,
      repair: 'review',
      detail: 'stored /a/ URL now serves /v/',
    });
  });

  // ⚠️ THE LOAD-BEARING NEGATIVE. Khan re-slugs constantly and a moved slug is not a defect;
  // the KIND changing is what means "this row points at different content".
  it('says nothing when only the slug moved', () => {
    const reslugged =
      'https://www.khanacademy.org/math/statistics-probability/x2dd7feea:regression/a/introduction-to-residuals';
    expect(checked(row(), probe({ url: reslugged }))).toEqual([]);
  });

  it('reports a stored leaf that now lands on a bare unit page', () => {
    const unit = 'https://www.khanacademy.org/math/statistics-probability/sampling-distributions';
    expect(
      checked(row(), probe({ url: unit, pageKind: 'other', title: 'Sampling distributions | Khan Academy' })).map((d) => d.detail),
    ).toContain('stored /a/ URL now serves /—/');
  });
});

describe('comparison 4 — the stored title against the rendered one', () => {
  // Khan appends `(article) | Khan Academy` to every title, so a raw comparison would report
  // a mismatch on all 526 probed rows.
  it('sees through the Khan page-kind suffix and breadcrumbs', () => {
    for (const title of [
      'Central limit theorem (video) | Khan Academy',
      'Central limit theorem (article) | Statistics | Khan Academy',
      'Central limit theorem',
    ]) {
      expect(
        checked(row({ type: 'video', url: VIDEO_URL, title: 'Central limit theorem' }), probe({ url: VIDEO_URL, pageKind: 'video', title })),
      ).toEqual([]);
    }
  });

  it('reports a genuine mismatch as a review', () => {
    const found = checked(
      row({ type: 'video', url: VIDEO_URL, title: 'Central limit theorem' }),
      probe({ url: VIDEO_URL, pageKind: 'video', title: 'Introduction to residuals (article) | Khan Academy' }),
    );
    expect(found).toContainEqual({
      kind: 'title-contradicts-page',
      clause: 6,
      repair: 'review',
      detail:
        "stored title 'Central limit theorem' but the page renders 'Introduction to residuals (article) | Khan Academy'",
    });
  });

  // ⚠️ It is a flag, never a verdict. Nothing this comparison produces may name a target.
  it('never proposes a retype', () => {
    const found = checked(
      row({ title: 'Something else entirely' }),
      probe({ title: 'Introduction to residuals (article) | Khan Academy' }),
    );
    expect(found.every((d) => d.repair === 'review')).toBe(true);
  });

  it('ignores punctuation, case and whitespace differences', () => {
    expect(
      checked(row({ title: "Euler's totient function." }), probe({ title: '  Euler’s   Totient function (article) | Khan Academy' })),
    ).toEqual([]);
  });

  it('disables itself rather than reporting a missing title as a mismatch', () => {
    expect(checked(row({ title: null }), probe())).toEqual([]);
    expect(checked(row(), probe({ title: null }))).toEqual([]);
    expect(checked(row({ title: '   ' }), probe({ title: '| Khan Academy' }))).toEqual([]);
  });
});

describe('a row can lie about more than one thing at a time', () => {
  it('returns two discrepancies for two simultaneous defects', () => {
    // A stale type AND a stale title, each with its own repair: the type is retyped off the
    // URL's own kind, the title only ever goes to a human.
    const found = checked(
      row({ type: 'video', title: 'Sampling distribution of the sample mean' }),
      probe({ pageKind: 'article-like' }),
    );
    expect(kinds(found)).toEqual(['type-contradicts-url', 'title-contradicts-page']);
    expect(found.map((d) => d.repair)).toEqual(['retype', 'review']);
  });

  // Two independent signals agreeing about the same field are both real findings and both
  // reported; a caller counts ROWS failing clause 6, never discrepancies.
  it('reports the free rule and the page rule separately when they agree', () => {
    const found = checked(row({ type: 'interactive' }), probe());
    expect(kinds(found)).toEqual(['type-contradicts-url', 'type-contradicts-page']);
    expect(found.every((d) => d.repair === 'retype' && d.to === 'article')).toBe(true);
  });

  // ⚠️ Two retypes naming DIFFERENT targets are both reported rather than silently resolved.
  // A caller that means to act must treat the disagreement as an escalation.
  it('does not pick a winner when the two retype signals disagree', () => {
    const found = checked(row({ type: 'interactive' }), probe({ pageKind: 'video' }));
    const targets = found.filter((d) => d.repair === 'retype').map((d) => (d.repair === 'retype' ? d.to : null));
    expect(targets).toEqual(['article', 'video']);
  });
});

describe('a clean row, and "not checked" as its own outcome', () => {
  it('returns an empty list for a row whose page agrees with it', () => {
    expect(classifyMetadataIntegrity(row(), probe())).toEqual({
      pageChecked: true,
      discrepancies: [],
    });
  });

  // The distinction is held by the type checker, not by a convention: the two arms name
  // their lists differently, so a caller must narrow before it can read either — and cannot
  // count an unprobed row's empty list as "clean on all four comparisons".
  it('is distinguishable from a pass without reading a reason string', () => {
    const outcomes = [
      classifyMetadataIntegrity(row()),
      classifyMetadataIntegrity(row(), null),
      classifyMetadataIntegrity(row(), probe({ blocked: true })),
      classifyMetadataIntegrity(row(), probe()),
    ];
    expect(outcomes.map((o) => (o.pageChecked ? o.discrepancies.length : 'unchecked'))).toEqual([
      'unchecked',
      'unchecked',
      'unchecked',
      0,
    ]);
  });

  // A bot wall is someone else's page. Running the three page comparisons against it would
  // manufacture findings on a row nobody has actually seen — while the free rule, which
  // never needed the page, still stands.
  it('keeps the free rule and drops the page rules on a blocked probe', () => {
    const out = classifyMetadataIntegrity(
      row({ type: 'interactive' }),
      probe({ blocked: true, pageKind: 'video', title: 'Access denied', url: VIDEO_URL }),
    );
    if (out.pageChecked) throw new Error('a blocked probe must not be page-checked');
    expect(out.reason).toBe('blocked');
    expect(kinds(out.rowDiscrepancies)).toEqual(['type-contradicts-url']);
  });
});
