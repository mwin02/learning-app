// Repair doc-tree child titles that were extracted in a non-English locale (the
// doctoc Accept-Language bug — see src/lib/agents/decomposition/doctoc.ts).
//
//   npx tsx --env-file=.env.local scripts/fix-decomposition-language.ts <resourceId> [--apply]
//
// Re-runs decomposition on the container with the FIXED fetch (Accept-Language:
// en) and updates each EXISTING child's title in place, matched by its stable
// canonical URL. It does NOT delete/recreate children — they're linked to spine
// concepts (ConceptResource), so re-creating would orphan those links and could
// re-open a spine hole. Only titles change; URLs / structure / concepts / links
// are untouched. Updated rows are re-embedded (title feeds the embedding text).
//
// Dry-run by default (prints the diff); pass --apply to write.

import { prisma } from '../src/lib/db';
import { decompose, type ChildInput } from '../src/lib/agents/decomposition/decompose';
import { embedMissing } from '../src/lib/ai/embeddings';

function flatten(children: ChildInput[]): ChildInput[] {
  return children.flatMap((c) => [c, ...(c.children ? flatten(c.children) : [])]);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: tsx --env-file=.env.local scripts/fix-decomposition-language.ts <resourceId> [--apply]');
    process.exit(1);
  }

  const parent = await prisma.resource.findUnique({
    where: { id },
    select: {
      id: true, url: true, title: true, type: true, topic: true, difficulty: true,
      summary: true, conceptsTaught: true, decompositionStatus: true,
      children: { select: { id: true, url: true, title: true } },
    },
  });
  if (!parent) {
    console.error(`No Resource '${id}'.`);
    process.exit(1);
  }
  if (parent.decompositionStatus !== 'decomposed') {
    console.error(`Resource is '${parent.decompositionStatus}', not 'decomposed' — nothing to repair.`);
    process.exit(1);
  }

  console.log(`Re-decomposing "${parent.title}" (${parent.children.length} children)\n  ${parent.url}`);
  const result = await decompose({
    url: parent.url,
    title: parent.title,
    type: parent.type,
    topic: parent.topic,
    difficulty: parent.difficulty,
    summary: parent.summary,
    conceptsTaught: parent.conceptsTaught,
  });
  if (result.status !== 'decomposed') {
    console.error(`Re-decompose returned '${result.status}' (${result.reason ?? 'no reason'}); aborting — won't touch existing rows.`);
    process.exit(1);
  }

  // Map freshly-extracted (English) titles by canonical URL.
  const freshTitleByUrl = new Map(flatten(result.children).map((c) => [c.url, c.title]));

  const updates: { id: string; from: string; to: string }[] = [];
  for (const child of parent.children) {
    const fresh = freshTitleByUrl.get(child.url);
    if (fresh && fresh !== child.title) updates.push({ id: child.id, from: child.title, to: fresh });
  }

  console.log(`\n${updates.length} title change(s)${apply ? ' (APPLYING)' : ' (dry-run; pass --apply to write)'}:`);
  for (const u of updates) console.log(`  "${u.from}"\n    → "${u.to}"`);

  const missingUrls = parent.children.filter((c) => !freshTitleByUrl.has(c.url)).map((c) => c.url);
  if (missingUrls.length > 0) {
    console.log(`\n${missingUrls.length} existing child URL(s) not found in the fresh extraction (left unchanged):`);
    missingUrls.forEach((u) => console.log(`  ${u}`));
  }

  if (apply && updates.length > 0) {
    await prisma.$transaction(updates.map((u) => prisma.resource.update({ where: { id: u.id }, data: { title: u.to } })));
    const embedded = await embedMissing();
    console.log(`\nApplied ${updates.length} update(s); re-embedded ${embedded} stale row(s).`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
