import { describe, it, expect } from 'vitest';
import { MIN_CONTENT_WORDS } from './duration-estimate';
import {
  classifyServeabilityFromProbe,
  type ProbeEvidence,
  type ProbeServeabilityRow,
} from './serveability-probe';

const ARTICLE_URL =
  'https://www.khanacademy.org/math/statistics-probability/modeling-distributions/a/basic-normal-calculations';

// A probed article that passes everything, so each test below changes exactly one thing.
const probe = (over: Partial<ProbeEvidence> = {}): ProbeEvidence => ({
  url: ARTICLE_URL,
  title: 'Basic normal calculations (article) | Khan Academy',
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

// `serveable` deliberately does not exist on the no-evidence arm, so reaching a verdict
// requires narrowing. This asserts the narrowing once instead of at every call site.
const verdict = (p: ProbeEvidence | null, r: ProbeServeabilityRow) => {
  const out = classifyServeabilityFromProbe(p, r);
  if (!out.evidence) throw new Error(`expected a verdict, got no evidence: ${out.reason}`);
  return out;
};

const row = (over: Partial<ProbeServeabilityRow> = {}): ProbeServeabilityRow => ({
  url: ARTICLE_URL,
  title: 'Basic normal calculations',
  ...over,
});

describe('the practice page — prose under the floor around exercise widgets', () => {
  // Measured: 189 words of prose wrapped around 6 problem widgets. The cost of the page is
  // the problems, which belongs to the learner and which no word count can see.
  it('fails clause 5 when the floor and the widget count agree', () => {
    expect(classifyServeabilityFromProbe(probe({ articleWords: 189, widgets: 6 }), row())).toEqual({
      evidence: true,
      serveable: false,
      clause: 5,
      reason: 'practice-page',
    });
  });

  // ⚠️ THE LOAD-BEARING NEGATIVE. Six probed rows sit under the floor carrying zero widgets
  // and are real short lessons. The floor alone is never a verdict.
  it('admits the same prose with no widgets', () => {
    expect(classifyServeabilityFromProbe(probe({ articleWords: 189, widgets: 0 }), row())).toEqual({
      evidence: true,
      serveable: true,
    });
  });

  // A probe artifact predating the `widgets` field cannot pair, so it cannot exclude.
  it('admits when the probe did not report a widget count', () => {
    expect(
      verdict(probe({ articleWords: 189, widgets: undefined }), row()).serveable,
    ).toBe(true);
  });

  // Over the floor is over the floor. `Calculating the mean` is 492 words around 31 widgets
  // and is a real lesson — the words-per-widget ratio that would catch the practice pages
  // catches this too, which is why it was measured and rejected.
  it('admits a lesson that clears the floor whatever the widget count', () => {
    expect(classifyServeabilityFromProbe(probe({ articleWords: 492, widgets: 31 }), row())).toEqual({
      evidence: true,
      serveable: true,
    });
    expect(verdict(probe({ articleWords: 741, widgets: 36 }), row()).serveable).toBe(true);
  });

  it('treats the floor as exclusive at its own boundary', () => {
    expect(
      verdict(probe({ articleWords: MIN_CONTENT_WORDS, widgets: 9 }), row()).serveable,
    ).toBe(true);
    expect(
      verdict(probe({ articleWords: MIN_CONTENT_WORDS - 1, widgets: 1 }), row()).serveable,
    ).toBe(false);
  });
});

describe('the widget shell — an article body that is a caption on something else', () => {
  // `Unbiased estimate of population variance`: the article reads "Make a spinoff here!" —
  // four words — inside a page rendering 1,126.
  it('fails clause 5 on the measured shell row', () => {
    expect(
      classifyServeabilityFromProbe(probe({ articleWords: 4, mainWords: 1126, widgets: 1 }), row()),
    ).toEqual({ evidence: true, serveable: false, clause: 5, reason: 'widget-shell' });
  });

  // The shell is a more specific diagnosis than the practice page, so it is reported even
  // when the widget count would also have fired — and it fires with no widgets at all.
  it('fires with zero widgets', () => {
    expect(
      classifyServeabilityFromProbe(probe({ articleWords: 4, mainWords: 1126, widgets: 0 }), row()),
    ).toMatchObject({ serveable: false, reason: 'widget-shell' });
  });

  // `main` carries Khan's comment thread, so a real lesson under a long discussion runs a
  // ratio in the low single digits, and a review article with a big thread reaches the
  // teens. None of those is a shell.
  it('does not fire on a real lesson buried under a comment thread', () => {
    expect(
      verdict(probe({ articleWords: 1356, mainWords: 3238 }), row()).serveable,
    ).toBe(true);
    expect(
      verdict(probe({ articleWords: 156, mainWords: 2884, widgets: 0 }), row()).serveable,
    ).toBe(true);
  });

  // Both halves are required: the prose must be under the floor, and the page around it
  // must clear the floor on its own, so a page that is merely short never qualifies.
  it('does not fire when the prose clears the floor', () => {
    expect(
      verdict(probe({ articleWords: 500, mainWords: 500 * 60 }), row()).serveable,
    ).toBe(true);
  });

  it('does not fire when the page around the article is itself empty', () => {
    expect(verdict(probe({ articleWords: 2, mainWords: 300 }), row()).serveable).toBe(true);
  });

  // An older probe artifact with no `mainWords` disables the rule rather than guessing.
  it('does not fire when the probe did not report mainWords', () => {
    expect(
      verdict(probe({ articleWords: 4, mainWords: undefined, widgets: 0 }), row()).serveable,
    ).toBe(true);
  });
});

describe('a code editor with nothing to read', () => {
  it('fails clause 5 when there is no article at all', () => {
    expect(
      classifyServeabilityFromProbe(probe({ hasEditor: true, articleWords: null, mainWords: null }), row()),
    ).toEqual({ evidence: true, serveable: false, clause: 5, reason: 'editor-no-prose' });
  });

  it('fails clause 5 when the article is under the content floor', () => {
    expect(
      classifyServeabilityFromProbe(probe({ hasEditor: true, articleWords: 120, widgets: 0 }), row()),
    ).toMatchObject({ serveable: false, reason: 'editor-no-prose' });
  });

  // A real lesson may embed an editor beside its prose; the editor alone decides nothing.
  it('admits an editor sitting next to a lesson', () => {
    expect(classifyServeabilityFromProbe(probe({ hasEditor: true, articleWords: 900 }), row())).toEqual({
      evidence: true,
      serveable: true,
    });
  });

  // A `/v/` page reports no article and no editor, and is not a failure of anything.
  it('admits a page with no article and no editor', () => {
    expect(
      verdict(
        probe({ pageKind: 'video', articleWords: null, mainWords: null, hasEditor: false }),
        row(),
      ).serveable,
    ).toBe(true);
  });
});

describe('the chain step — clause 4', () => {
  it.each(['Clue #4', 'Clue #1 (article) | Cryptography | Khan Academy', 'Level 3: Challenge', 'Level 10: Fermat Primality Test'])(
    'fails clause 4 on the title %s',
    (title) => {
      expect(classifyServeabilityFromProbe(probe({ title }), row({ title: null }))).toEqual({
        evidence: true,
        serveable: false,
        clause: 4,
        reason: 'chain-step',
      });
    },
  );

  it('reads the stored title as well as the rendered one', () => {
    expect(
      classifyServeabilityFromProbe(probe({ title: null }), row({ title: 'Clue #4' })),
    ).toMatchObject({ serveable: false, clause: 4, reason: 'chain-step' });
  });

  it('fails clause 4 on a URL under a challenge container', () => {
    const url = 'https://www.khanacademy.org/computing/computer-science/cryptography/cryptochallenge/a/clue-2';
    expect(classifyServeabilityFromProbe(probe({ url, title: 'The discovery' }), row({ url }))).toMatchObject({
      clause: 4,
      reason: 'chain-step',
    });
  });

  it('fires when only the landed URL is inside the chain', () => {
    const landed = 'https://www.khanacademy.org/computing/computer-science/cryptography/cryptochallenge/a/the-discovery';
    expect(
      verdict(probe({ url: landed, title: 'The discovery' }), row()).serveable,
    ).toBe(false);
  });

  it('does not fire on an ordinary lesson title', () => {
    for (const title of ['Control Systems - Feedback Loops', 'Introduction to residuals', 'Partial derivatives 2']) {
      expect(verdict(probe({ title }), row({ title })).serveable).toBe(true);
    }
  });

  // ⚠️ THE SECOND LOAD-BEARING NEGATIVE. Dozens of Khan lessons carry a TRAILING part
  // number because one lesson was split for length; each teaches in place. Only a title
  // that names its step BEFORE it names its subject is announcing a chain position.
  it.each([
    'Determining limits at infinity of quotients (Part 2) (video) | Khan Academy',
    'Exploring the formal definition of limits Part 1: intuition review (video) | Khan Academy',
    'RSA encryption: Step 3 (video) | Khan Academy',
    'Sampling distribution of the sample mean (part 2) (video) | Khan Academy',
  ])('does not fire on the split lesson %s', (title) => {
    expect(verdict(probe({ title }), row({ title })).serveable).toBe(true);
  });

  // Only the container segments are read. A video ABOUT a challenge is a video.
  it('does not read the leaf slug as a container', () => {
    const url = 'https://www.khanacademy.org/computing/computer-science/cryptography/comp-number-theory/v/primality-test-challenge';
    expect(
      verdict(probe({ url, title: 'Primality test challenge (video) | Khan Academy' }), row({ url })).serveable,
    ).toBe(true);
  });

  it('does not read the last segment of a kindless URL as a container', () => {
    const url = 'https://www.khanacademy.org/computing/computer-science/cryptography/cryptochallenge';
    expect(verdict(probe({ url, title: 'Cryptochallenge' }), row({ url })).serveable).toBe(true);
  });

  // Malformed and `generated://` URLs both reach this classifier. Neither may throw, and
  // neither may exclude: an unparseable URL cannot be shown to agree with the probe's, so the
  // probe is withheld rather than believed.
  it('does not throw on a value that is not a URL', () => {
    const out = classifyServeabilityFromProbe(probe({ url: 'not a url' }), row({ url: 'generated://onramp/x' }));
    expect(out).toEqual({ evidence: false, reason: 'probe-voided' });
  });
});

describe('no evidence is its own outcome, never a verdict', () => {
  // A bot wall means we read someone else's page. Reporting it as either verdict would put
  // a quality failure on a row nobody has actually seen.
  it('returns no evidence for a blocked page', () => {
    expect(classifyServeabilityFromProbe(probe({ blocked: true, articleWords: 12, widgets: 4 }), row())).toEqual({
      evidence: false,
      reason: 'blocked',
    });
  });

  it('returns no evidence when the row was never probed', () => {
    expect(classifyServeabilityFromProbe(null, row())).toEqual({ evidence: false, reason: 'no-probe' });
  });

  // A probe is keyed by resourceId, so it describes the page the row pointed at WHEN PROBED.
  // The regression this arm exists for: a repointed `/pt/` row still carrying the Khan
  // challenge page's probe (`hasEditor`, no article) was deprecated on that page's shape,
  // destroying the ten attached SQL lessons the repoint had just rescued.
  it('returns no evidence when the probe landed on another host', () => {
    expect(
      classifyServeabilityFromProbe(
        probe({
          url: 'https://www.khanacademy.org/computing/sql/pt/challenge-book-list',
          hasEditor: true,
          articleWords: null,
          mainWords: null,
        }),
        row({ url: 'https://www.youtube.com/watch?v=abc123' }),
      ),
    ).toEqual({ evidence: false, reason: 'probe-voided' });
  });

  // The other half: the stored URL now serves a different content kind, which is exactly what
  // `url-redirects-across-kinds` reports — so the landed page cannot also be the evidence that
  // condemns this row.
  it('returns no evidence when the landed page is a different content kind', () => {
    expect(
      classifyServeabilityFromProbe(
        probe({ url: ARTICLE_URL.replace('/a/', '/pt/'), hasEditor: true, articleWords: null }),
        row(),
      ),
    ).toEqual({ evidence: false, reason: 'probe-voided' });
  });

  // ⚠️ THE THIRD LOAD-BEARING NEGATIVE. Khan re-slugs constantly, and voiding on slug drift
  // would silently discard most of the page evidence the library has.
  it('still counts a probe that merely drifted slug', () => {
    expect(
      classifyServeabilityFromProbe(
        probe({ url: `${ARTICLE_URL}-and-inserting-data`, hasEditor: true, articleWords: null }),
        row(),
      ),
    ).toMatchObject({ serveable: false, reason: 'editor-no-prose' });
  });

  // We cannot show the two agree, and an unproven signal does not get to exclude.
  it('voids on an unparseable URL on either side', () => {
    expect(
      classifyServeabilityFromProbe(probe({ url: 'not a url', hasEditor: true, articleWords: null }), row()),
    ).toEqual({ evidence: false, reason: 'probe-voided' });
    expect(
      classifyServeabilityFromProbe(probe({ hasEditor: true, articleWords: null }), row({ url: 'generated://onramp/x' })),
    ).toEqual({ evidence: false, reason: 'probe-voided' });
  });

  // `blocked` still outranks it, so the two reasons never race for the same probe.
  it('reports a blocked probe as blocked even when it also fails to describe the row', () => {
    expect(
      classifyServeabilityFromProbe(probe({ blocked: true, url: 'https://example.invalid/x' }), row()),
    ).toEqual({ evidence: false, reason: 'blocked' });
  });

  // `blocked` outranks every rule, including the ones that would otherwise fire on the
  // error page's own shape.
  it('does not let a blocked page fall through to a rule', () => {
    const out = classifyServeabilityFromProbe(
      probe({ blocked: true, title: 'Clue #4', hasEditor: true, articleWords: null }),
      row({ title: 'Clue #4' }),
    );
    expect(out.evidence).toBe(false);
  });

  // The distinction is held by the type checker, not by a convention: `serveable` does not
  // exist on the no-evidence arm, so a caller must narrow on `evidence` to reach a verdict.
  it('is distinguishable from a pass without reading a reason string', () => {
    const outcomes = [
      classifyServeabilityFromProbe(null, row()),
      classifyServeabilityFromProbe(probe(), row()),
    ];
    expect(outcomes.map((o) => (o.evidence ? o.serveable : 'unknown'))).toEqual(['unknown', true]);
  });
});
