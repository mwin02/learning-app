// How much of the library is a page we should not be serving? READ-ONLY.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/census-serveability.ts
//
// Sizes the populations `resource-standard.md` excludes, and — the number that actually
// decides whether the standard is affordable — how many of those rows are currently
// ATTACHED to a concept. An unattached bad row costs a retrieval slot; an attached one is
// already placed in somebody's track, so removing it reopens a spine hole.
//
// Every figure in `resource-serveability.md`'s diagnosis came from this script. It exists
// so those numbers are reproducible rather than quoted from a lost terminal buffer.
//
// ⚠️ ROW-LEVEL RULES ONLY — `type` and `url`, no page evidence. It therefore measures the
// standard's clauses 3 and 5 only, and CANNOT see the two defects that motivated the
// standard in the first place (a practice page and a chain page, both ordinary `/a/`
// articles typed `article`). The page-level half needs probe evidence and is block S5's
// `report-serveability.ts`, which supersedes this file. Extend that one, not this one.

import type { DecompositionStatus, ResourceStatus, ResourceType } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { resolveTarget } from './target-guard';

// Khan's content-kind path segment. Same shape as `urlKind` in khan-probe-duration.ts,
// duplicated here rather than imported because this script predates the move planned in
// S1 — after S1 lands it should import the real one.
const KHAN_KIND = /\/(a|v|e|pt|pi)\/[^/?#]+/;
const KHAN_HOST = 'khanacademy.org';

type Row = {
  id: string;
  url: string;
  type: ResourceType;
  status: ResourceStatus;
  decompositionStatus: DecompositionStatus;
  durationMin: number | null;
};

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // A malformed URL is a finding, not a crash — it must still appear in the tally.
    return '(unparseable)';
  }
}

function khanKind(url: string): string | null {
  return KHAN_KIND.exec(url)?.[1] ?? null;
}

const isKhan = (r: Row) => host(r.url) === KHAN_HOST;

// What retrieval can serve today. Derived, never stored — see the Resource comment in
// schema.prisma on why there is no `pickable` column.
const isPickable = (r: Row) => r.status === 'active' && r.decompositionStatus === 'atomic';

function tally<T>(rows: T[], key: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return new Map([...m].sort((a, b) => b[1] - a[1]));
}

function print(title: string, m: Map<string, number>) {
  console.log(`\n${title}`);
  for (const [k, v] of m) console.log(`  ${String(v).padStart(6)}  ${k}`);
}

// all / pickable / pickable-and-attached — the three numbers every population needs.
// The first says how much is in the table, the second how much retrieval can reach, and
// the third is the only one that costs anything to remove.
function counts(rows: Row[], attached: Set<string>, pred: (r: Row) => boolean): string {
  const all = rows.filter(pred);
  const pick = all.filter(isPickable);
  const att = pick.filter((r) => attached.has(r.id));
  return `${String(all.length).padStart(5)} / ${String(pick.length).padStart(5)} / ${String(att.length).padStart(5)}`;
}

async function main() {
  console.log(`[census] target: ${resolveTarget().label}`);

  const rows: Row[] = await prisma.resource.findMany({
    select: {
      id: true,
      url: true,
      type: true,
      status: true,
      decompositionStatus: true,
      durationMin: true,
    },
  });
  const attached = new Set(
    (
      await prisma.conceptResource.findMany({
        select: { resourceId: true },
        distinct: ['resourceId'],
      })
    ).map((r) => r.resourceId),
  );
  const pickable = rows.filter(isPickable);

  console.log(`[census] ${rows.length} resource rows`);
  console.log(`[census] ${pickable.length} pickable (active + atomic)`);
  console.log(`[census] ${attached.size} rows attached to at least one concept`);

  print('ALL ROWS by type', tally(rows, (r) => r.type));
  print('PICKABLE by type', tally(pickable, (r) => r.type));

  const khan = rows.filter(isKhan);
  console.log(`\nKHAN rows: ${khan.length} (pickable: ${khan.filter(isPickable).length})`);
  print('KHAN all rows by URL kind', tally(khan, (r) => khanKind(r.url) ?? '(container/unit page)'));
  print(
    'KHAN pickable by URL kind + stored type',
    tally(khan.filter(isPickable), (r) => `${khanKind(r.url) ?? '(none)'}  type=${r.type}`),
  );

  // Populations the standard excludes. Clause numbers are the standard's.
  const exclusions: Array<[string, (r: Row) => boolean]> = [
    ['clause 5  type=interactive', (r) => r.type === 'interactive'],
    ['clause 5  khan /e/ exercise', (r) => isKhan(r) && khanKind(r.url) === 'e'],
    ['clause 5  khan /pi/ project item (challenge)', (r) => isKhan(r) && khanKind(r.url) === 'pi'],
    ['clause 5  khan /pt/ project task (talkthrough+challenge)', (r) => isKhan(r) && khanKind(r.url) === 'pt'],
    ['clause 5  slug segment begins practice-', (r) => /\/practice-[^/?#]*$/.test(r.url)],
    ['clause 4  khan cryptochallenge chain', (r) => /\/cryptochallenge\//.test(r.url)],
    ['clause 3  khan URL with no content-kind segment', (r) => isKhan(r) && khanKind(r.url) === null],
    // Clause 6's one free rule: the stored type contradicts the stored URL's own kind, no
    // page needed. The repair is a re-type, NOT an exclusion — see the plan's precedence
    // rule — so this line is a repair population that happens to overlap the ones above.
    ['clause 6  stored type vs stored URL kind', (r) => isKhanTypeMismatch(r)],
  ];

  console.log('\nEXCLUDED BY THE STANDARD (all / pickable / pickable+attached)');
  for (const [label, pred] of exclusions) {
    console.log(`  ${counts(rows, attached, pred)}  ${label}`);
  }

  // Measured and deliberately NOT excluded. Printed so the rejection stays visible: a
  // future reader tempted to add a rule for either of these can see what it would cost.
  const notExcluded: Array<[string, (r: Row) => boolean]> = [
    ['khan "… review" article (teaches in prose — kept)', (r) => isKhan(r) && /review[^/]*$/.test(r.url)],
    ['durationMin IS NULL (library-quality B4, not a serveability defect)', (r) => r.durationMin === null],
  ];
  console.log('\nMEASURED BUT NOT EXCLUDED (all / pickable / pickable+attached)');
  for (const [label, pred] of notExcluded) {
    console.log(`  ${counts(rows, attached, pred)}  ${label}`);
  }

  // The interactive rows are the largest exclusion, and the re-type-vs-deprecate split is
  // per-host: Khan's are genuine challenges, while another host's may be misclassified
  // readings. Nobody can decide that from a count, so the URLs are printed.
  console.log('\nPICKABLE type=interactive, by host (attached / total)');
  const byHost = new Map<string, { attached: number; total: number }>();
  for (const r of pickable.filter((r) => r.type === 'interactive')) {
    const e = byHost.get(host(r.url)) ?? { attached: 0, total: 0 };
    e.total++;
    if (attached.has(r.id)) e.attached++;
    byHost.set(host(r.url), e);
  }
  for (const [h, e] of [...byHost].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(e.attached).padStart(3)} / ${String(e.total).padStart(3)}  ${h}`);
  }

  console.log('\nPICKABLE type=interactive on a NON-Khan host — candidates for a re-type, not a deprecate');
  for (const r of pickable.filter((r) => r.type === 'interactive' && !isKhan(r))) {
    console.log(`  ${attached.has(r.id) ? 'attached' : '        '}  ${r.url}`);
  }

  await prisma.$disconnect();
}

// A Khan row whose stored `type` disagrees with what its own URL says it is: an `/a/` URL
// is an article and a `/v/` URL is a video, whatever the row claims. Only these two kinds
// are checked — `/e/`, `/pi/` and `/pt/` are excluded outright above, so a type mismatch on
// one of them is not a finding anybody would act on.
function isKhanTypeMismatch(r: Row): boolean {
  if (!isKhan(r)) return false;
  const kind = khanKind(r.url);
  if (kind === 'a') return r.type !== 'article';
  if (kind === 'v') return r.type !== 'video';
  return false;
}

main();
