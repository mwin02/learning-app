// One-off backfill for resources whose stored `title` describes the concept that
// DEMANDED them rather than the page they point at.
//
// Root cause (fixed forward in doctoc → decompose → persistDiscovered): discovery's
// `title` is free text the sourcing model wrote about what it went LOOKING for, and
// nothing ever reconciled it against the fetched page. The visible symptom is a
// container titled after one lesson inside it — "MIT OCW: The Analytics Edge -
// Lecture 6.2: Recommendation Systems" pointing at the course's whole 26-lecture
// notes index.
//
// Title is a third of the embedded text (lib/ai/embeddings), and the pre-insert
// embedding is also what `decideFiling` votes on — so a wrong title is not just a
// wrong string: the row is mis-routed in pgvector and was filed on bad evidence.
// Every correction here therefore re-embeds.
//
// Scope is a HAND-CONFIRMED list, not a query. The obvious detector ("title looks
// like the demanding concept") is a false positive machine — Khan and MDN
// legitimately name pages after the concept — so each id below was verified by
// fetching the page and comparing. Ids are inert once corrected: the run is
// idempotent because crediblePageTitle returns null when the stored title already
// matches the page.
//
// Run (dry-run first — prints every proposed change and writes nothing):
//   npx tsx --env-file=.env.local scripts/backfill-page-titles.ts --prod
//   npx tsx --env-file=.env.local scripts/backfill-page-titles.ts --prod --apply
//
// --prod targets the Supabase pooler. The connection string is read from
// SUPABASE_POOLER_URL inside this process and assigned before @/lib/db is loaded,
// so the secret never becomes a shell word (AGENTS.md "Secrets") — this is safer
// than the documented `DATABASE_URL="$SUPABASE_POOLER_URL" …` prefix, which needs
// the value present in the shell.

import { readFile } from 'node:fs/promises';

// ⚠️ NOTHING from src/ may be imported statically here. Static imports are hoisted
// above the DATABASE_URL assignment below, and doctoc transitively pulls in
// @/lib/db — which reads DATABASE_URL at module-eval and would silently bind to
// whatever .env.local says (localhost), while every log line still claims success.
// This bit once already: the first dry-run of this script reported "MISSING" for a
// production row because it had connected to the local DB. Every src/ import lives
// inside main(), after the override.

// Confirmed offenders: stored title names a sub-unit, URL is the container.
// Verified 2026-08-02 by fetching each page.
const OFFENDERS = [
  'cmsa46gy8008jatm5geoe9nfx', // python-data-ml — Analytics Edge lecture-notes index
  'cmr7trh5i007118m5vpid108h', // sql — Database Systems lecture-notes index
  'cmrd4kdr5006pm5m56vnlb5nb', // discrete-mathematics — 6.042J course root
  'cmr4svfgh0001mmm5cud86pdm', // discrete-mathematics — Algorithmist's Toolkit notes index
  'cms49vg1b001s56m52m07inm0', // data-structures-algorithms — 6.034 exams page
];

const FETCH_UA =
  'Mozilla/5.0 (compatible; LearningPathBot/1.0; +https://learning-app-sau6bxtxta-uw.a.run.app)';

const apply = process.argv.includes('--apply');

// `--titles=<file>` supplies page titles gathered ELSEWHERE, as a { url: title } JSON
// map, and selects rows by URL instead of using OFFENDERS. It exists for Khan Academy:
// khanacademy.org bot-walls the crawler (every server fetch returns a 200 page titled
// "Client Challenge") and is a client-rendered SPA, so even an unblocked fetch of the
// HTML yields the generic shell title. The real title only exists after the SPA boots,
// which means a browser. Titles collected that way still go through crediblePageTitle
// here — the source of a title changes nothing about how much it is trusted.
const titlesFile = process.argv.find((a) => a.startsWith('--titles='))?.slice('--titles='.length);

if (process.argv.includes('--prod')) {
  const pooler = process.env.SUPABASE_POOLER_URL;
  if (!pooler) throw new Error('SUPABASE_POOLER_URL is not set (expected in .env.local)');
  process.env.DATABASE_URL = pooler;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': FETCH_UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  // See the warning at the top of this file: these must stay dynamic.
  const { extractTitle } = await import('../src/lib/agents/decomposition/doctoc');
  const { crediblePageTitle } = await import('../src/lib/agents/decomposition/page-title');
  const { prisma } = await import('../src/lib/db');
  const { embedTexts, buildEmbeddingText, storeEmbedding } = await import('../src/lib/ai/embeddings');

  let corrected = 0;
  let skipped = 0;

  const supplied: Record<string, string | null> = titlesFile
    ? JSON.parse(await readFile(titlesFile, 'utf8'))
    : {};
  const select = {
    id: true, title: true, url: true, topic: true, summary: true,
    conceptsTaught: true, decompositionStatus: true,
  } as const;
  const rows = titlesFile
    ? await prisma.resource.findMany({ where: { url: { in: Object.keys(supplied) } }, select })
    : (await prisma.resource.findMany({ where: { id: { in: OFFENDERS } }, select }));
  console.log(`rows: ${rows.length}${titlesFile ? ` (from ${titlesFile})` : ''}\n`);

  for (const row of rows) {
    const id = row.id;

    let fetched: string;
    if (titlesFile) {
      const t = supplied[row.url];
      if (!t) {
        console.log(`NO-TITLE  ${id} (not captured) ${row.url}`);
        skipped += 1;
        continue;
      }
      fetched = t;
    } else {
      try {
        fetched = extractTitle(await fetchHtml(row.url));
      } catch (err) {
        // Loud and skipped, never guessed: a page we can't read is exactly the case
        // where overwriting the title would do damage.
        console.log(`FETCH-FAIL ${id} ${(err as Error).message} ${row.url}`);
        skipped += 1;
        continue;
      }
    }

    const next = crediblePageTitle(fetched, row.title, row.url);
    if (!next) {
      console.log(`NO-CHANGE ${id} (page title not credible or already correct)`);
      console.log(`   stored: ${row.title}`);
      console.log(`   page:   ${fetched}`);
      skipped += 1;
      continue;
    }

    console.log(`${apply ? 'APPLY' : 'DRY  '}    ${id}  ${row.decompositionStatus}  [${row.topic}]`);
    console.log(`   from: ${row.title}`);
    console.log(`   to:   ${next}`);
    console.log(`   url:  ${row.url}`);

    if (apply) {
      await prisma.resource.update({ where: { id }, data: { title: next } });
      const [vec] = await embedTexts([
        buildEmbeddingText({ title: next, summary: row.summary, conceptsTaught: row.conceptsTaught }),
      ]);
      await storeEmbedding(id, vec);
      console.log('   re-embedded');
    }
    corrected += 1;
  }

  console.log(`\n${apply ? 'applied' : 'would correct'}: ${corrected}, skipped: ${skipped}`);
  await prisma.$disconnect();
}

main();
