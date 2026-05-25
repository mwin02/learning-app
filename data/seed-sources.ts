// Hand-curated launch sources (publishers / authors / channels).
// Trust-score rubric and how to add a new source live in `data/README.md`.

import type { SourceSeedInput } from '@/types/source';

// Gold = 0.95 (canonical, decades-of-trust publishers)
// Strong = 0.85 (well-regarded, broadly recommended)
// Solid  = 0.70 (good but narrower track record or single-work entries)

export const seedSources: SourceSeedInput[] = [
  // ── official_docs ────────────────────────────────────────────────────────
  {
    slug: 'mdn',
    name: 'MDN Web Docs',
    url: 'https://developer.mozilla.org',
    kind: 'official_docs',
    trustScore: 0.95,
  },
  {
    slug: 'react-dev',
    name: 'React (react.dev)',
    url: 'https://react.dev',
    kind: 'official_docs',
    trustScore: 0.95,
  },
  {
    slug: 'python-docs',
    name: 'Python Official Documentation',
    url: 'https://docs.python.org',
    kind: 'official_docs',
    trustScore: 0.95,
  },
  {
    slug: 'numpy-docs',
    name: 'NumPy Documentation',
    url: 'https://numpy.org',
    kind: 'official_docs',
    trustScore: 0.85,
  },
  {
    slug: 'pandas-docs',
    name: 'pandas Documentation',
    url: 'https://pandas.pydata.org',
    kind: 'official_docs',
    trustScore: 0.85,
  },
  {
    slug: 'matplotlib-docs',
    name: 'Matplotlib Documentation',
    url: 'https://matplotlib.org',
    kind: 'official_docs',
    trustScore: 0.85,
  },
  {
    slug: 'scikit-learn-docs',
    name: 'scikit-learn Documentation',
    url: 'https://scikit-learn.org',
    kind: 'official_docs',
    trustScore: 0.85,
  },

  // ── educator ─────────────────────────────────────────────────────────────
  {
    slug: 'three-blue-one-brown',
    name: '3Blue1Brown (Grant Sanderson)',
    url: 'https://www.youtube.com/@3blue1brown',
    kind: 'educator',
    trustScore: 0.95,
  },
  {
    slug: 'gilbert-strang',
    name: 'Gilbert Strang',
    url: 'https://math.mit.edu/~gs/',
    kind: 'educator',
    trustScore: 0.95,
  },
  {
    slug: 'corey-schafer',
    name: 'Corey Schafer',
    url: 'https://www.youtube.com/@coreyms',
    kind: 'educator',
    trustScore: 0.85,
  },
  {
    slug: 'statquest',
    name: 'StatQuest with Josh Starmer',
    url: 'https://www.youtube.com/@statquest',
    kind: 'educator',
    trustScore: 0.85,
  },
  {
    slug: 'pauls-online-math-notes',
    name: "Paul's Online Math Notes (Paul Dawkins)",
    url: 'https://tutorial.math.lamar.edu',
    kind: 'educator',
    trustScore: 0.85,
  },
  {
    slug: 'javascript-info',
    name: 'The Modern JavaScript Tutorial (Ilya Kantor)',
    url: 'https://javascript.info',
    kind: 'educator',
    trustScore: 0.85,
  },
  {
    slug: 'freecodecamp',
    name: 'freeCodeCamp',
    url: 'https://www.freecodecamp.org',
    kind: 'educator',
    trustScore: 0.85,
  },
  {
    slug: 'professor-leonard',
    name: 'Professor Leonard',
    url: 'https://www.youtube.com/@professorleonard',
    kind: 'educator',
    trustScore: 0.7,
  },

  // ── course_platform ──────────────────────────────────────────────────────
  {
    slug: 'khan-academy',
    name: 'Khan Academy',
    url: 'https://www.khanacademy.org',
    kind: 'course_platform',
    trustScore: 0.95,
  },
  {
    slug: 'mit-ocw',
    name: 'MIT OpenCourseWare',
    url: 'https://ocw.mit.edu',
    kind: 'course_platform',
    trustScore: 0.95,
  },

  // ── textbook ─────────────────────────────────────────────────────────────
  {
    slug: 'openstax',
    name: 'OpenStax',
    url: 'https://openstax.org',
    kind: 'textbook',
    trustScore: 0.95,
  },
  {
    slug: 'linear-algebra-done-right',
    name: 'Linear Algebra Done Right (Sheldon Axler)',
    url: 'https://linear.axler.net',
    kind: 'textbook',
    trustScore: 0.95,
  },
  {
    slug: 'mml-book',
    name: 'Mathematics for Machine Learning (Deisenroth, Faisal, Ong)',
    url: 'https://mml-book.github.io',
    kind: 'textbook',
    trustScore: 0.85,
  },
  {
    slug: 'eloquent-javascript',
    name: 'Eloquent JavaScript (Marijn Haverbeke)',
    url: 'https://eloquentjavascript.net',
    kind: 'textbook',
    trustScore: 0.7,
  },
  {
    slug: 'automate-the-boring-stuff',
    name: 'Automate the Boring Stuff with Python (Al Sweigart)',
    url: 'https://automatetheboringstuff.com',
    kind: 'textbook',
    trustScore: 0.7,
  },
  {
    slug: 'immersive-math',
    name: 'Immersive Linear Algebra (Ström, Åström, Akenine-Möller)',
    url: 'https://immersivemath.com/ila/',
    kind: 'textbook',
    trustScore: 0.7,
  },
];
