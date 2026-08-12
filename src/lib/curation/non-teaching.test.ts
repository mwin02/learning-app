import { describe, expect, it } from 'vitest';
import { classifyNonTeaching, JUNK_CENTROID_FLOOR } from './non-teaching';

// Every title below is a REAL row from the dev library (2,018 rows, 2026-08-12), not an
// invented example: a fixture written from memory only proves the rules match the rules.
// The furniture list is the whole of plan defect P6 as it actually exists; the lesson
// list is a random sample plus every near-miss the rules could plausibly trip on.

const FURNITURE: { title: string; url?: string }[] = [
  { title: 'About the course', url: 'https://www.khanacademy.org/math/ap-calculus-ab/ab-limits-new/ap-ab-about/v/khan-academy-in-the-classroom-bill-scott' },
  { title: 'Course Prerequisites', url: 'https://www.youtube.com/watch?v=rSjt1E9WHaQ&t=1670s' },
  { title: 'Feedback', url: 'https://www.khanacademy.org/computing/computer-science/cryptography/ciphers/a/feedback' },
  { title: 'Checkpoint', url: 'https://www.khanacademy.org/computing/computer-science/cryptography/cryptochallenge/a/checkpoint' },
  { title: "What's next?", url: 'https://www.khanacademy.org/computing/computer-science/cryptography/cryptochallenge/a/cryptochallenge-whats-next' },
  { title: "Summary (what's next?)", url: 'https://www.khanacademy.org/computing/computer-science/cryptography/comp-number-theory/v/rsa-encryption-checkpoint' },
  { title: 'Appendix', url: 'https://docs.python.org/3/tutorial/appendix.html' },
  { title: 'What Now?', url: 'https://docs.python.org/3/tutorial/whatnow.html' },
  { title: 'Whetting Your Appetite', url: 'https://docs.python.org/3/tutorial/appetite.html' },
  { title: 'Sal interviews the AP Calculus Lead at College Board', url: 'https://www.khanacademy.org/math/ap-calculus-ab/ab-limits-new/ap-ab-about/v/sal-interviews-the-ap-calculus-lead-at-college-board' },
  { title: 'MIT OCW 6.034: Artificial Intelligence - Exams', url: 'https://ocw.mit.edu/courses/6-034-artificial-intelligence-fall-2010/pages/exams' },
];

const LESSONS: string[] = [
  'Session 2: Chapter 1.7–1.9',
  'Joining tables to themselves with self-joins',
  'Calculating the area between curves',
  'Chapter 9: SQL (Structured Query Language)',
  'Add React to an Existing Project',
  'Two-way tables',
  'Determining limits of trigonometric functions',
  'More on Generating Functions, Two Squares Theorem',
  'Model evaluation: quantifying the quality of predictions',
  'Getting Started with Python',
  'Unweighted Bipartite Matching | Network Flow | Graph Theory',
  'ReactJS Tutorial - 4 - Components',
  'Ways to pick officers',
  'Conditional probability explained visually',
  'RECURRENCE RELATIONS - DISCRETE MATHEMATICS',
  'Another least squares example',
  'Chapter 2: What is a Database?',
  'HOW TO USE Matplotlib in 4 MINUTES (2020 Python Tutorial)',
  'Concurrency in Rust - Creating Threads',
  '4.2 Laplace Transforms',
  'The Gram-Schmidt process',
  'Worked example identifying observational study',
  'MIT OpenCourseWare: Lecture 9: Independence, Basis, and Dimension',
  'Worked example: determining domain word problem (real numbers)',
  'Preserving and Resetting State',
  'Time Series Analysis',
  'CS50P - Lecture 6 - File I/O',
  'Using the washer method: rotating around vertical line (not y-axis), part 2',
  'Model persistence',
  'Conditions for valid t intervals',
  'Primality test with sieve',
  'Getting Started with Orange 07: Model Evaluation and Scoring',
  'Top 10 INTEGRATION Rules and Methods (ultimate study guide)',
  'Lecture 4: Convex optimization problems',
  'More Control Flow Tools',
  // Near-misses: each contains a furniture WORD and teaches anyway.
  'Interpreting determinants in terms of area',
  'Examples of bias in surveys',
  'Further learning in SQL',
  'Installation',
  'Getting started tutorials',
  'What should we learn next?',
  'Optional videos',
  'Reference: Conditions for inference on a mean',
  'Conditions for inference on slope',
];

describe('classifyNonTeaching', () => {
  it('flags every piece of P6 furniture in the library', () => {
    const missed = FURNITURE.filter((f) => !classifyNonTeaching(f).nonTeaching);
    expect(missed.map((m) => m.title)).toEqual([]);
  });

  it('flags no genuine lesson — zero false positives is the bar', () => {
    const wrong = LESSONS.filter((title) => classifyNonTeaching({ title }).nonTeaching);
    expect(wrong).toEqual([]);
  });

  it('matches whole titles, never substrings', () => {
    expect(classifyNonTeaching({ title: 'Feedback' }).nonTeaching).toBe(true);
    expect(classifyNonTeaching({ title: 'Feedback loops in control systems' }).nonTeaching).toBe(false);
    expect(classifyNonTeaching({ title: 'Negative feedback' }).nonTeaching).toBe(false);
    expect(classifyNonTeaching({ title: 'Appendix' }).nonTeaching).toBe(true);
    expect(classifyNonTeaching({ title: 'The appendix of the AP exam' }).nonTeaching).toBe(false);
  });

  it('reads a trailing index-page segment, but only from the stricter tail list', () => {
    expect(classifyNonTeaching({ title: '6.006 Introduction to Algorithms - Exams' })).toEqual({
      nonTeaching: true,
      reason: 'furniture-tail',
    });
    // `feedback` is deliberately absent from the tail list: it names real lessons.
    expect(classifyNonTeaching({ title: 'Control systems - Feedback' }).nonTeaching).toBe(false);
  });

  it('takes a furniture URL slug when the title alone is uninformative', () => {
    expect(
      classifyNonTeaching({ title: 'Bill Scott on Khan Academy', url: 'https://example.org/course/about-the-course' }),
    ).toEqual({ nonTeaching: true, reason: 'furniture-url' });
    // index.html addresses real container pages, so it is never a furniture slug.
    expect(
      classifyNonTeaching({ title: 'Getting started', url: 'https://pandas.pydata.org/docs/getting_started/index.html' })
        .nonTeaching,
    ).toBe(false);
  });

  it('survives a malformed url instead of throwing at decomposition time', () => {
    expect(classifyNonTeaching({ title: 'Two-way tables', url: 'not a url' }).nonTeaching).toBe(false);
  });

  it('needs BOTH halves of the junk-leaf tier', () => {
    const title = 'Why These Prerequisites Matter';
    expect(classifyNonTeaching({ title, centroidSimilarity: 0.543 })).toEqual({
      nonTeaching: true,
      reason: 'junk-leaf',
    });
    // A weak phrase with no centroid number (the decomposition caller) passes through.
    expect(classifyNonTeaching({ title }).nonTeaching).toBe(false);
    expect(classifyNonTeaching({ title, centroidSimilarity: null }).nonTeaching).toBe(false);
    // ...and so does one that sits comfortably inside its topic's cluster.
    expect(classifyNonTeaching({ title, centroidSimilarity: JUNK_CENTROID_FLOOR }).nonTeaching).toBe(false);
    // A low similarity alone never flags: plenty of honest rows sit off-centroid.
    expect(classifyNonTeaching({ title: 'The Gram-Schmidt process', centroidSimilarity: 0.2 }).nonTeaching).toBe(false);
  });

  it('normalizes punctuation and case so one key covers every spelling', () => {
    for (const spelling of ["What's next?", 'Whats Next', 'WHAT’S NEXT', 'What’s next!']) {
      expect(classifyNonTeaching({ title: spelling }).nonTeaching).toBe(true);
    }
  });
});
