// Live verification for Phase 2.5h block 2c (the YouTube Data API prong + channel
// source resolution + engagement trust).
//   npx tsx --env-file=.env.local scripts/verify-youtube-prong.ts
//
// Hits the real Data API (spends ~100 quota units on one search.list) + Vertex (the
// concept-derivation call), persists a couple of sourced videos through the real
// decompose → upsert tail, reads them back, and asserts:
//   - a seeded channel (3Blue1Brown) resolves to its channel Source + high prior;
//   - an unseeded channel resolves to the neutral `youtube` Source (0.5);
//   - viewCount/likeCount/youtubeChannelId are persisted;
//   - trustScore reflects the engagement signal on top of the prior.
// Cleans up the rows it inserts so the library is untouched (the intentional wipe
// is block 2f).

import { prisma } from '../src/lib/db';
import { searchYouTubeForConcept } from '../src/lib/agents/tools/youtube-search';
import { decompose } from '../src/lib/agents/decomposition/decompose';
import { upsertResource } from '../src/lib/agents/decomposition/upsert-resource';

const TOPIC = 'linear-algebra';
const CONCEPT = 'eigenvalues and eigenvectors';
const THREEB1B_CHANNEL = 'UCYO_jab_esuFRV4b17AJtAw';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`, detail ?? '');
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function persistOne(row: Awaited<ReturnType<typeof searchYouTubeForConcept>>[number]) {
  const result = await decompose({
    url: row.url,
    title: row.title,
    type: row.type,
    topic: TOPIC,
    difficulty: row.difficulty,
    summary: row.summary,
    conceptsTaught: row.conceptsTaught,
  });
  const { outcome } = await upsertResource(TOPIC, row, result);
  const read = await prisma.resource.findUnique({
    where: { url: row.url },
    select: {
      trustScore: true, viewCount: true, likeCount: true, youtubeChannelId: true,
      source: { select: { slug: true, trustScore: true } },
    },
  });
  return { outcome, read };
}

// Remove this harness's own prior inserts so each run starts clean and actually
// exercises insertion. Test artifacts are the only pending_review rows carrying
// engagement stats (seed resources never have viewCount); they're unattached, so
// safe to delete. Seed rows (no viewCount) and anything referenced are untouched.
async function cleanPriorArtifacts(): Promise<void> {
  const removed = await prisma.resource.deleteMany({
    where: { status: 'pending_review', viewCount: { not: null }, lessonResources: { none: {} }, conceptResources: { none: {} } },
  });
  if (removed.count > 0) console.log(`[setup] cleared ${removed.count} prior test artifact(s)`);
}

async function main() {
  await cleanPriorArtifacts();
  console.log(`\n── searching YouTube for "${CONCEPT}" (${TOPIC}) ──────────────`);
  const rows = await searchYouTubeForConcept({ topic: TOPIC, conceptTitle: CONCEPT, maxResults: 12 });
  check(`prong returned videos`, rows.length > 0, `(${rows.length})`);
  if (rows.length === 0) return;

  for (const r of rows.slice(0, 6)) {
    const ratio = r.youtube.likeCount != null ? (r.youtube.likeCount / r.youtube.viewCount) : null;
    console.log(`   • ${r.youtube.channelId === THREEB1B_CHANNEL ? '[3b1b] ' : ''}views=${r.youtube.viewCount} likes=${r.youtube.likeCount} ratio=${ratio ? (ratio * 100).toFixed(2) + '%' : 'hidden'} | ${r.title.slice(0, 55)}`);
  }

  const inserted: string[] = [];
  try {
    const seeded = rows.find((r) => r.youtube.channelId === THREEB1B_CHANNEL);
    const unseeded = rows.find((r) => r.youtube.channelId !== THREEB1B_CHANNEL);

    if (seeded) {
      console.log('\n── seeded channel (3Blue1Brown) ───────────────────────────────');
      const { outcome, read } = await persistOne(seeded);
      if (outcome === 'inserted') inserted.push(seeded.url);
      // Source resolution holds whether freshly inserted or read back from an
      // existing seed row (3b1b's eigenvalues video is in the seed library, so it
      // dedups — that's correct). Column persistence is asserted on the unseeded
      // fresh insert below.
      check('resolved to 3Blue1Brown channel Source', read?.source.slug === 'three-blue-one-brown', read?.source.slug);
      check('channel prior is high (0.95)', read?.source.trustScore === 0.95, read?.source.trustScore);
      check(`dedup: ${outcome}`, outcome === 'inserted' || outcome === 'skipped', outcome);
      if (outcome === 'inserted') {
        check('viewCount persisted', (read?.viewCount ?? 0) > 0, read?.viewCount);
        check('youtubeChannelId persisted', read?.youtubeChannelId === THREEB1B_CHANNEL, read?.youtubeChannelId);
      }
    } else {
      console.log('\n(no 3Blue1Brown video in results — skipping seeded-channel checks)');
    }

    if (unseeded) {
      console.log('\n── unseeded channel → neutral youtube Source ──────────────────');
      const { outcome, read } = await persistOne(unseeded);
      if (outcome === 'inserted') inserted.push(unseeded.url);
      check('resolved to neutral `youtube` Source (not a wrong channel)', read?.source.slug === 'youtube', read?.source.slug);
      check('neutral prior is 0.5', read?.source.trustScore === 0.5, read?.source.trustScore);
      if (outcome === 'inserted') {
        check('trustScore moved off the 0.5 prior via engagement', read?.trustScore !== 0.5, read?.trustScore);
        check('viewCount persisted', (read?.viewCount ?? 0) > 0, read?.viewCount);
        check('youtubeChannelId persisted (its real channel)', !!read?.youtubeChannelId && read?.youtubeChannelId !== THREEB1B_CHANNEL, read?.youtubeChannelId);
      } else {
        console.log('   (unseeded video already in library — rerun dedup; columns validated on a prior run)');
      }
    }
  } finally {
    if (inserted.length > 0) {
      await prisma.resource.deleteMany({ where: { url: { in: inserted } } });
      console.log(`\n[cleanup] removed ${inserted.length} test row(s)`);
    }
  }

  console.log(failures === 0 ? '\n✅ all YouTube-prong checks passed\n' : `\n❌ ${failures} check(s) failed\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
