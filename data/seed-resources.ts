// Hand-curated launch resources, source of truth for `npm run db:seed`.
// Curation rules and concept-tag conventions live in `data/README.md`.

import type { ResourceSeedInput } from '@/types/resource';

const pythonDataMl: ResourceSeedInput[] = [
  {
    slug: 'python-data-ml-python-official-tutorial',
    topic: 'python-data-ml',
    title: 'The Python Tutorial',
    url: 'https://docs.python.org/3/tutorial/',
    type: 'docs',
    durationMin: 360,
    summary:
      "The official Python tutorial. Walks through the language end-to-end: syntax, data structures, control flow, functions, modules, errors, classes. The canonical starting point.",
    difficulty: 'beginner',
    prerequisiteConcepts: [],
    conceptsTaught: [
      'python-syntax',
      'python-data-types',
      'control-flow',
      'functions',
      'modules-imports',
      'object-oriented-programming',
      'error-handling',
    ],
  },
  {
    slug: 'python-data-ml-fcc-python-mike-dane',
    topic: 'python-data-ml',
    title: 'Learn Python — Full Course for Beginners (freeCodeCamp / Mike Dane)',
    url: 'https://www.youtube.com/watch?v=rfscVS0vtbw',
    type: 'course',
    durationMin: 266,
    summary:
      "Mike Dane's full Python intro on freeCodeCamp's channel. Covers variables, types, control flow, functions, and basic OOP in one continuous video. Good first-exposure option for learners who prefer narration.",
    difficulty: 'beginner',
    prerequisiteConcepts: [],
    conceptsTaught: [
      'python-syntax',
      'python-data-types',
      'control-flow',
      'functions',
      'object-oriented-programming',
    ],
  },
  {
    slug: 'python-data-ml-corey-schafer-python-tutorials',
    topic: 'python-data-ml',
    title: 'Python Tutorials (Corey Schafer)',
    url: 'https://www.youtube.com/playlist?list=PL-osiE80TeTskrapNbzXhwoFUiLCjGgY7',
    type: 'course',
    durationMin: 720,
    summary:
      "Corey Schafer's Python Basics playlist. Methodically covers strings, lists, tuples, sets, dictionaries, conditionals, loops, functions, modules, file I/O, and OOP. The standard recommendation once the absolute basics click.",
    difficulty: 'intermediate',
    prerequisiteConcepts: ['python-syntax', 'control-flow'],
    conceptsTaught: [
      'python-data-types',
      'list-comprehensions',
      'functions',
      'modules-imports',
      'object-oriented-programming',
      'file-io',
      'error-handling',
    ],
  },
  {
    slug: 'python-data-ml-automate-boring-stuff',
    topic: 'python-data-ml',
    title: 'Automate the Boring Stuff with Python (online edition)',
    url: 'https://automatetheboringstuff.com/',
    type: 'book',
    tier: 'optional',
    durationMin: 720,
    summary:
      "Al Sweigart's project-driven Python book, free to read online under CC. Teaches Python through small practical automation tasks (files, regex, web scraping). Excellent supplemental reading; not core because the path agent can't sequence a full book.",
    difficulty: 'beginner',
    prerequisiteConcepts: [],
    conceptsTaught: [
      'python-syntax',
      'control-flow',
      'functions',
      'file-io',
      'error-handling',
    ],
  },
  {
    slug: 'python-data-ml-numpy-absolute-basics',
    topic: 'python-data-ml',
    title: 'NumPy: the absolute basics for beginners',
    url: 'https://numpy.org/doc/stable/user/absolute_beginners.html',
    type: 'docs',
    durationMin: 45,
    summary:
      "NumPy's own intro for newcomers to array programming. Covers ndarray creation, shapes, basic indexing, and arithmetic. The right first NumPy resource.",
    difficulty: 'beginner',
    prerequisiteConcepts: ['python-syntax', 'python-data-types'],
    conceptsTaught: ['numpy-arrays', 'numpy-indexing'],
  },
  {
    slug: 'python-data-ml-numpy-quickstart',
    topic: 'python-data-ml',
    title: 'NumPy Quickstart',
    url: 'https://numpy.org/doc/stable/user/quickstart.html',
    type: 'docs',
    durationMin: 60,
    summary:
      "Step up from the absolute basics. Covers broadcasting, shape manipulation, fancy indexing, and linear-algebra helpers. The bridge between knowing arrays exist and using them for real work.",
    difficulty: 'intermediate',
    prerequisiteConcepts: ['python-syntax', 'numpy-arrays'],
    conceptsTaught: [
      'numpy-broadcasting',
      'numpy-indexing',
      'array-operations',
    ],
  },
  {
    slug: 'python-data-ml-pandas-getting-started',
    topic: 'python-data-ml',
    title: 'Pandas — Getting started',
    url: 'https://pandas.pydata.org/docs/getting_started/intro_tutorials/index.html',
    type: 'docs',
    durationMin: 90,
    summary:
      "Pandas' official 'Getting started' tutorial series. Nine short lessons that walk through reading data, selecting and filtering, computing aggregates, and reshaping. Best entry point for tabular data work.",
    difficulty: 'beginner',
    prerequisiteConcepts: ['python-syntax'],
    conceptsTaught: [
      'pandas-series',
      'pandas-dataframes',
      'data-cleaning',
      'data-aggregation',
    ],
  },
  {
    slug: 'python-data-ml-pandas-10-minutes',
    topic: 'python-data-ml',
    title: '10 minutes to pandas',
    url: 'https://pandas.pydata.org/docs/user_guide/10min.html',
    type: 'docs',
    durationMin: 30,
    summary:
      "A whirlwind reference-style tour of pandas. Use after the Getting Started tutorials as a one-page cheat sheet you actually understand. Realistic completion time is closer to 30 min than 10.",
    difficulty: 'intermediate',
    prerequisiteConcepts: [
      'python-syntax',
      'pandas-series',
      'pandas-dataframes',
    ],
    conceptsTaught: [
      'data-aggregation',
      'data-cleaning',
      'time-series',
      'merging-joining',
    ],
  },
  {
    slug: 'python-data-ml-matplotlib-quickstart',
    topic: 'python-data-ml',
    title: 'Matplotlib — Quick start guide',
    url: 'https://matplotlib.org/stable/users/explain/quick_start.html',
    type: 'docs',
    durationMin: 30,
    summary:
      "Matplotlib's canonical quick start. Introduces Figures, Axes, and the pyplot interface, with enough code to make sensible plots from arrays or dataframes. Skip the older 'pyplot tutorial' — this replaced it.",
    difficulty: 'intermediate',
    prerequisiteConcepts: ['python-syntax', 'numpy-arrays'],
    conceptsTaught: ['matplotlib-basics', 'data-visualization'],
  },
  {
    slug: 'python-data-ml-scikit-learn-getting-started',
    topic: 'python-data-ml',
    title: 'scikit-learn — Getting Started',
    url: 'https://scikit-learn.org/stable/getting_started.html',
    type: 'docs',
    durationMin: 30,
    summary:
      "scikit-learn's own intro: estimators, fit/predict, pipelines, model evaluation, and parameter search. Compact enough to read in one sitting; gives the API mental model the rest of scikit-learn assumes.",
    difficulty: 'intermediate',
    prerequisiteConcepts: [
      'python-syntax',
      'numpy-arrays',
      'pandas-dataframes',
    ],
    conceptsTaught: [
      'scikit-learn-basics',
      'supervised-learning',
      'model-evaluation',
    ],
  },
  {
    slug: 'python-data-ml-statquest-ml-fundamentals',
    topic: 'python-data-ml',
    title: 'Machine Learning Fundamentals (StatQuest with Josh Starmer)',
    url: 'https://www.youtube.com/playlist?list=PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF',
    type: 'course',
    durationMin: 600,
    summary:
      "Josh Starmer's conceptual ML series. Bias-variance, cross-validation, ROC/AUC, regression, regularization, trees, and more — explained visually without code. Pair with scikit-learn for the implementation side.",
    difficulty: 'advanced',
    prerequisiteConcepts: [],
    conceptsTaught: [
      'supervised-learning',
      'model-evaluation',
      'linear-regression',
      'classification',
      'regularization',
    ],
  },
];

export const seedResources: ResourceSeedInput[] = [
  ...pythonDataMl,
  // javascript-react — populated in next block
  // calculus — populated in next block
  // linear-algebra — populated in next block
];
