import { describe, it, expect } from 'vitest';
import { classifyServeability, urlKind, type ServeabilityInput } from './serveability';

const KHAN = 'https://www.khanacademy.org/math/statistics-probability/x1:analyzing';

const row = (over: Partial<ServeabilityInput> = {}): ServeabilityInput => ({
  type: 'article',
  url: `${KHAN}/a/intro-to-residuals`,
  decompositionStatus: 'atomic',
  ...over,
});

describe('interactive is excluded as a class', () => {
  it('fails clause 5 on the recorded form alone, whatever the host', () => {
    expect(classifyServeability({ type: 'interactive', url: 'https://visualgo.net/en/heap' })).toEqual({
      serveable: false,
      clause: 5,
      reason: 'interactive-type',
    });
  });

  it('fails an interactive row on a host with no rules of its own', () => {
    const out = classifyServeability(row({ type: 'interactive', url: 'https://openlearninglibrary.mit.edu/courses/x/jump_to/block-v1' }));
    expect(out).toMatchObject({ serveable: false, reason: 'interactive-type' });
  });

  // The standard's answer to "but it genuinely teaches" is clause 6 — correct the recorded
  // form — never an exception carved into this rule.
  it('fails an interactive row even on a Khan article URL', () => {
    expect(classifyServeability(row({ type: 'interactive' })).serveable).toBe(false);
  });

  it('admits every other recorded form on the same URL', () => {
    for (const type of ['article', 'video', 'course', 'docs', 'book'] as const) {
      expect(classifyServeability(row({ type })).serveable).toBe(true);
    }
  });

  // `interactive` is a CONTAINER_TYPE, so an interactive root is the type most likely to be
  // a real decomposed container — and a container is not being served to anyone. Excluding
  // one would also drop it out of the review queue (roots + `pending_review`), so it could
  // never be approved and its children would never surface under it.
  it('exempts a decomposed container, whose children are what get served', () => {
    expect(
      classifyServeability(row({ type: 'interactive', decompositionStatus: 'decomposed' })),
    ).toEqual({ serveable: true });
  });

  // The exemption is `decomposed` ONLY, never "not atomic" — an explicit stored type is a
  // strong signal, so anything short of an explicit container status still fails.
  it('fires on an atomic row, and on every status that is not decomposed', () => {
    for (const decompositionStatus of ['atomic', 'pending', 'human_review', 'unsupported'] as const) {
      expect(
        classifyServeability(row({ type: 'interactive', decompositionStatus })),
      ).toMatchObject({ serveable: false, reason: 'interactive-type' });
    }
  });

  it('fires when the caller does not know the decomposition status', () => {
    const url = 'https://visualgo.net/en/heap';
    expect(classifyServeability({ type: 'interactive', url }).serveable).toBe(false);
    expect(
      classifyServeability({ type: 'interactive', url, decompositionStatus: null }).serveable,
    ).toBe(false);
  });
});

describe('Khan content kinds whose substance is performed', () => {
  it.each([
    ['e', 'khan-exercise'],
    ['pt', 'khan-project-task'],
    ['pi', 'khan-project-item'],
  ])('fails clause 5 on a /%s/ URL', (kind, reason) => {
    expect(classifyServeability(row({ url: `${KHAN}/${kind}/some-slug` }))).toEqual({
      serveable: false,
      clause: 5,
      reason,
    });
  });

  // The URL is Khan's own statement of what the page is, so a stale stored type cannot
  // rescue it — eight rows in the library carry a type their URL contradicts.
  it('fails regardless of the stored type', () => {
    for (const type of ['article', 'video', 'course', 'docs', 'book'] as const) {
      expect(classifyServeability(row({ type, url: `${KHAN}/pt/challenge-slug` }))).toMatchObject({
        reason: 'khan-project-task',
      });
    }
  });

  it('applies to the bare host as well as www', () => {
    expect(classifyServeability(row({ url: 'https://khanacademy.org/math/x/pi/challenge' })).serveable).toBe(false);
  });

  it('admits the two kinds that carry content', () => {
    expect(classifyServeability(row({ type: 'article', url: `${KHAN}/a/intro-to-residuals` })).serveable).toBe(true);
    expect(classifyServeability(row({ type: 'video', url: `${KHAN}/v/intro-unit-vector-notation` })).serveable).toBe(true);
  });

  // The kind is a whole path segment. A slug that merely reads like one of them is a
  // resemblance, and a resemblance never decides alone.
  it('does not fire on a slug containing a kind letter', () => {
    expect(classifyServeability(row({ url: `${KHAN}/a/pi-and-the-unit-circle` })).serveable).toBe(true);
    expect(classifyServeability(row({ url: `${KHAN}/v/e-as-a-limit` })).serveable).toBe(true);
  });
});

describe('a Khan URL with no content-kind segment', () => {
  const unit = 'https://www.khanacademy.org/math/multivariable-calculus/multivariable-derivatives';

  it('fails clause 3 when the row is filed as a pickable leaf', () => {
    expect(classifyServeability(row({ url: unit, decompositionStatus: 'atomic' }))).toEqual({
      serveable: false,
      clause: 3,
      reason: 'khan-container-url',
    });
  });

  // A container is not required to teach — that is what its children are for.
  it('admits the same URL on a decomposed row', () => {
    expect(classifyServeability(row({ url: unit, decompositionStatus: 'decomposed' })).serveable).toBe(true);
  });

  it('admits it when the caller does not know the decomposition status', () => {
    expect(classifyServeability({ type: 'article', url: unit }).serveable).toBe(true);
    expect(classifyServeability({ type: 'article', url: unit, decompositionStatus: null }).serveable).toBe(true);
  });

  it('still reads the recorded form on a container URL', () => {
    expect(classifyServeability({ type: 'interactive', url: unit }).serveable).toBe(false);
  });
});

describe('hosts with no rules of their own', () => {
  it.each([
    'https://react.dev/learn/state-a-components-memory',
    'https://docs.python.org/3/tutorial/classes.html',
    'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms',
  ])('admits %s typed article — no rule fires on a hostname', (url) => {
    expect(classifyServeability({ type: 'article', url, decompositionStatus: 'atomic' })).toEqual({ serveable: true });
  });

  // The Khan rules are host-gated, so a `/pi/` segment elsewhere is just a path.
  it('does not apply the Khan kind rules off Khan', () => {
    expect(classifyServeability({ type: 'article', url: 'https://example.com/pi/spigot-algorithm' }).serveable).toBe(true);
  });

  it('does not match a hostname that merely ends in the brand', () => {
    expect(classifyServeability({ type: 'article', url: 'https://khanacademy.org.example.com/pi/x' }).serveable).toBe(true);
  });

  // Called per child on the decomposition path, where a malformed URL must not throw.
  it('does not throw on a value that is not a URL', () => {
    expect(classifyServeability({ type: 'article', url: 'not a url', decompositionStatus: 'atomic' }).serveable).toBe(true);
  });
});

// Moved here from `khan-probe-duration.ts` so Khan's content-kind parsing has one home;
// `proposeKhanDuration` imports it back and its behaviour is unchanged.
describe('urlKind', () => {
  it('reads the content-kind segment', () => {
    expect(urlKind(`${KHAN}/a/intro-to-residuals`)).toBe('a');
    expect(urlKind(`${KHAN}/v/intro-unit-vector`)).toBe('v');
    expect(urlKind(`${KHAN}/e/exercise-slug`)).toBe('e');
    expect(urlKind(`${KHAN}/pt/task-slug`)).toBe('pt');
    expect(urlKind(`${KHAN}/pi/item-slug`)).toBe('pi');
  });

  it('is null for a landing or unit page', () => {
    expect(urlKind('https://www.khanacademy.org/math/multivariable-calculus/multivariable-derivatives')).toBeNull();
    expect(urlKind('https://www.khanacademy.org/')).toBeNull();
  });
});
