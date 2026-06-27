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
    youtubeChannelId: 'UCYO_jab_esuFRV4b17AJtAw',
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
    youtubeChannelId: 'UCCezIgC97PvUuR4_gbFUs5g',
  },
  {
    slug: 'statquest',
    name: 'StatQuest with Josh Starmer',
    url: 'https://www.youtube.com/@statquest',
    kind: 'educator',
    trustScore: 0.85,
    youtubeChannelId: 'UCtYLUTtgS3k1Fg4y5tAhLbw',
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
    youtubeChannelId: 'UCoHhuummRZaIVX7bD4t2czg',
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

  // ── community (blanket buckets for agent-discovered resources) ──────────
  // Phase 2.5h: neutral prior for YouTube videos from a channel we have NOT
  // seeded above. The Data API prong resolves a video to its seeded channel
  // Source by channelId; failing that, it lands here — a KNOWN PLATFORM but an
  // unvetted channel, so trust sits just above the open-web bucket and lets the
  // engagement signal do the discriminating. Fixes the old hostname collision
  // where every youtube.com URL matched one seeded channel row.
  {
    slug: 'youtube',
    name: 'YouTube (unseeded channel)',
    url: 'https://www.youtube.com',
    kind: 'community',
    trustScore: 0.5,
  },
  // The web-fallback agent attributes finds to a specific seeded Source when
  // the URL's domain matches one above; otherwise it falls back to this row.
  // trustScore deliberately below the 0.5 default so the sequencer prefers
  // curated resources when both are available for the same topic.
  {
    slug: 'web',
    name: 'Open web (agent-discovered)',
    url: 'https://',
    kind: 'community',
    trustScore: 0.4,
  },
];
