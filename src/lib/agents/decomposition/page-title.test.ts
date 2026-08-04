// Unit tests for the fetched-<title> credibility guard. Pure; no DB, no network.
// The real-world rows here are the ones that motivated the fix (production,
// 2026-08-02) — a correction that must land, and the interstitials a naive
// version would have written over good data with.
import { describe, it, expect } from 'vitest';
import { cleanPageTitle, crediblePageTitle } from './page-title';

describe('cleanPageTitle', () => {
  it('collapses whitespace', () => {
    expect(cleanPageTitle('  Loops   and\n iteration ')).toBe('Loops and iteration');
  });

  it('keeps a title that is already short enough', () => {
    expect(cleanPageTitle('Functions - JavaScript | MDN')).toBe('Functions - JavaScript | MDN');
  });

  it('drops trailing site furniture beyond the first two segments', () => {
    expect(
      cleanPageTitle(
        'Lecture Notes | Database Systems | Electrical Engineering and Computer Science | MIT OpenCourseWare',
      ),
    ).toBe('Lecture Notes | Database Systems');
    expect(cleanPageTitle('Conic sections | Precalculus | Math | Khan Academy')).toBe(
      'Conic sections | Precalculus',
    );
  });

  it('strips the site-name segment when the URL identifies it', () => {
    const khan = 'https://www.khanacademy.org/computing/computer-programming/sql';
    // Without this the "correction" would only bolt the site name onto a good title.
    expect(cleanPageTitle('Intro to SQL: Querying and managing data | Khan Academy', khan)).toBe(
      'Intro to SQL: Querying and managing data',
    );
    expect(
      cleanPageTitle(
        'Exams | Artificial Intelligence | Electrical Engineering and Computer Science | MIT OpenCourseWare',
        'https://ocw.mit.edu/courses/6-034-artificial-intelligence-fall-2010/pages/exams',
      ),
    ).toBe('Exams | Artificial Intelligence');
  });

  it('matches the site name at word level, so a segment merely CONTAINING a host token survives', () => {
    // "mit" is a host token of ocw.mit.edu and "Limits" contains it as a substring.
    expect(
      cleanPageTitle('Limits | MIT OpenCourseWare', 'https://ocw.mit.edu/courses/18-01/limits'),
    ).toBe('Limits');
  });

  it('strips a trailing content-type marker (redundant with Resource.type)', () => {
    const khan = 'https://www.khanacademy.org/math/statistics-probability/probability-library/a/probability-the-basics';
    expect(cleanPageTitle('Probability: the basics (article) | Khan Academy', khan)).toBe(
      'Probability: the basics',
    );
    // Only when it is the trailing marker — a parenthetical that is part of the name stays.
    expect(cleanPageTitle('Analysis of variance (ANOVA) | Statistics', khan)).toBe(
      'Analysis of variance (ANOVA) | Statistics',
    );
  });

  it('never strips every segment', () => {
    expect(cleanPageTitle('Khan Academy', 'https://www.khanacademy.org/math')).toBe('Khan Academy');
  });
});

describe('crediblePageTitle', () => {
  const ocwUrl = 'https://ocw.mit.edu/courses/15-071-the-analytics-edge-spring-2017/pages/lecture-and-recitation-notes';

  it('replaces a title that names a sub-lecture with the container page own title', () => {
    expect(
      crediblePageTitle(
        'Lecture and Recitation Notes | The Analytics Edge | Sloan School of Management | MIT OpenCourseWare',
        'MIT OCW: The Analytics Edge - Lecture 6.2: Recommendation Systems',
        ocwUrl,
      ),
    ).toBe('Lecture and Recitation Notes | The Analytics Edge');
  });

  it('rejects a bot-wall interstitial rather than overwriting a plausible title', () => {
    expect(
      crediblePageTitle(
        'Client Challenge',
        'Graphs of trigonometric functions',
        'https://www.khanacademy.org/math/precalculus/x9e81a4f98389efdf:trig',
      ),
    ).toBeNull();
  });

  it('rejects a soft-404', () => {
    expect(
      crediblePageTitle(
        'Error - Page Missing',
        'Calculus III - Multiple Integrals',
        'https://tutorial.math.lamar.edu/classes/calciii/multipleintegrals.aspx',
      ),
    ).toBeNull();
  });

  it('rejects a title sharing no content word with the stored title or the URL path', () => {
    expect(
      crediblePageTitle('Sign in to continue', 'Binary search trees', 'https://example.com/ds/bst'),
    ).toBeNull();
  });

  it('accepts on URL-path evidence alone when the stored title is entirely wrong', () => {
    expect(
      crediblePageTitle(
        'Exams | Artificial Intelligence',
        'Some Unrelated Sub-Lecture',
        'https://ocw.mit.edu/courses/6-034-artificial-intelligence-fall-2010/pages/exams',
      ),
    ).toBe('Exams | Artificial Intelligence');
  });

  it('returns null when the cleaned title matches what is already stored', () => {
    expect(
      crediblePageTitle(
        'Conic sections | Precalculus | Math | Khan Academy',
        'Conic sections | Precalculus',
        'https://www.khanacademy.org/math/precalculus/x9e81a4f98389efdf:conics',
      ),
    ).toBeNull();
  });

  it('returns null on a missing or empty fetched title', () => {
    expect(crediblePageTitle(undefined, 'Anything', 'https://example.com/a')).toBeNull();
    expect(crediblePageTitle('   ', 'Anything', 'https://example.com/a')).toBeNull();
  });

  it('does not treat generic words as evidence', () => {
    // "Documentation" overlaps only on words that appear on every docs page.
    expect(
      crediblePageTitle('Documentation | Learn', 'Python Tutorial', 'https://example.com/docs/guide'),
    ).toBeNull();
  });
});
