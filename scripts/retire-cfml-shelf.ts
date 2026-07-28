// Retire the `calculus-for-machine-learning` shelf — the first of the two follow-ups the
// topic filing plan closes with.
//
//   npx tsx --env-file=.env.local scripts/retire-cfml-shelf.ts [--apply]
//
// Run with the compose workers STOPPED (`docker compose --profile workers stop worker`):
// this rewrites primaries in bulk and a live worker filing into the same shelves would
// race the plan against its own snapshot.
//
// WHY THIS SHELF, AND WHY BY HAND — see the header of src/lib/curation/shelf-retire.ts.
// Short version: cfml is a curriculum framing, not a subject; 117 of its 132 rows are
// children of five containers that are plainly calculus / linear-algebra / graph theory;
// and k-NN cannot adjudicate it because the mis-filed shelf is its own neighbourhood. The
// verdicts below are provenance judgements, written with `origin: review`.
//
// ── WHAT THIS DOES NOT TOUCH, AND WHY ───────────────────────────────────────────────
//
// The cfml **Path and its Track are left intact.** Retiring them is not safely possible
// today and is deliberately out of scope:
//   - `PathStatus` has no `archived` state, so there is nowhere to retire a Path TO
//     without a migration.
//   - `Track.pathId` is `onDelete: Cascade` and the live Track is `ready` with **12 built
//     Lessons** (plus Section / CourseRequest / ProgramPath references), so deleting the
//     Path destroys real delivered work.
//   - Retargeting the Path to `calculus` would produce a SECOND `calculus` Path alongside
//     the existing 22-concept one.
// Refiling costs the Path nothing: `ResourceSourcedFor` links concept↔resource with no
// topic column, so its 9 existing attachments survive (T4b measured the same property as
// "0 attached `teaches` rows lost"). What changes is future sourcing, which will now reach
// the real calculus/linear-algebra shelves instead of a mislabelled copy of them.

import {
  planShelfRetirement,
  summarizeMoves,
  type ShelfRow,
  type Slate,
} from '../src/lib/curation/shelf-retire';
import { setPrimaryTopic, checkMembershipInvariants } from '../src/lib/curation/resource-topics';
import { repointCanonical } from '../src/lib/agents/topic-registry';
import { prisma } from '../src/lib/db';

const RETIRING = 'calculus-for-machine-learning';

// Reads the PRE-write doubt flag, so the report counts doubts this run closes rather than
// the (already-false) value the plan decided on.
const rowWasContested = (rows: ShelfRow[], id: string) =>
  rows.find((r) => r.id === id)?.contested ?? false;

// Where a scoped variant folds when nothing more specific applies. This is the verdict the
// program plan pass's scoped-topic reconciler already reaches for this exact slug, so the
// fallback is the system's own existing policy rather than a fresh opinion.
const FALLBACK = 'calculus';

// The operator slate. Keyed by container resource id; the title is carried alongside and
// VERIFIED before anything is written, so a stale id fails loudly instead of refiling the
// wrong subtree.
const SLATE: { id: string; title: string; to: string; why: string }[] = [
  {
    id: 'cmr276agz0061kom5lrltjqne',
    title: 'Limits and continuity | Calculus 1 | Math | Khan Academy',
    to: 'calculus',
    why: 'Khan Calculus 1 unit — plain single-variable calculus, nothing ML-specific',
  },
  {
    id: 'cmr26mjja003ekom53ny25spr',
    title: 'Linear Algebra',
    to: 'linear-algebra',
    why: 'general linear algebra course; T4b already split its eigenvalue/systems units out',
  },
  {
    id: 'cmr26mjjy003fkom5j7cyehmc',
    title: 'Linear Algebra Course – Mathematics for Machine Learning and Generative AI',
    to: 'linear-algebra',
    why: 'a linear-algebra course with an ML framing — the subject is linear algebra',
  },
  {
    id: 'cmr4svfgh0001mmm5cud86pdm',
    title: "An Algorithmist's Toolkit: Spectral Graph Theory (Lectures 1–10)",
    to: 'discrete-mathematics',
    why: 'spectral graph theory — graph theory, not calculus; one sibling already sits on dsa',
  },
  {
    id: 'cmr4j19qf001wd2m5vmmo4c0f',
    title: 'Introduction to Convex Optimization',
    to: 'convex-optimization',
    why: 'straggler: 18 of its 19 children already sit on convex-optimization (T4b mint)',
  },
];

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — retiring "${RETIRING}"\n`);

  // ---- verify the slate against the live DB before planning anything ------------
  const slate: Slate = new Map();
  for (const entry of SLATE) {
    const found = await prisma.resource.findUnique({
      where: { id: entry.id },
      select: { title: true, topic: true },
    });
    if (!found) throw new Error(`slate container ${entry.id} (${entry.title}) not found`);
    if (found.title !== entry.title) {
      throw new Error(
        `slate container ${entry.id} title drift:\n  expected: ${entry.title}\n  actual:   ${found.title}`,
      );
    }
    slate.set(entry.id, entry.to);
    console.log(`  ✓ ${entry.title.slice(0, 58)}\n      -> ${entry.to}  (${entry.why})`);
  }
  console.log();

  // ---- population: every row on the shelf, plus every descendant of a slate container --
  // The descendants matter even when already filed elsewhere: the plan reports them as
  // `untouched`, which is how we verify T4b's splits were not clobbered.
  const ids = [...slate.keys()];
  const rows = await prisma.$queryRaw<ShelfRow[]>`
    WITH RECURSIVE sub AS (
      SELECT r.id, r.title, r.topic, r."parentResourceId" AS "parentId"
      FROM "Resource" r WHERE r.id = ANY(${ids})
      UNION ALL
      SELECT r.id, r.title, r.topic, r."parentResourceId"
      FROM "Resource" r JOIN sub s ON r."parentResourceId" = s.id
    )
    SELECT DISTINCT ON (x.id) x.id, x.title, x.topic, x."parentId",
           coalesce(rt.contested, false) AS contested,
           coalesce(rt.origin::text, 'inherited') AS origin
    FROM (
      SELECT id, title, topic, "parentId" FROM sub
      UNION
      SELECT id, title, topic, "parentResourceId" FROM "Resource" WHERE topic = ${RETIRING}
    ) x
    LEFT JOIN "ResourceTopic" rt ON rt."resourceId" = x.id AND rt."isPrimary"
    ORDER BY x.id
  `;

  const plan = planShelfRetirement(rows, slate, RETIRING, FALLBACK);

  console.log(`population: ${rows.length} rows in scope`);
  console.log(`  moves:     ${plan.moves.length}`);
  console.log(`  settles:   ${plan.settles.length}  (already moved by a previous run; doubt still to clear)`);
  console.log(`  no-op:     ${plan.noop.length}`);
  console.log(`  untouched: ${plan.untouched.length}  (filed off the shelf by an earlier pass)`);
  console.log();

  console.log('DESTINATIONS');
  for (const [topic, n] of [...summarizeMoves(plan.moves)].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  -> ${topic}`);
  }
  const all = [...plan.moves, ...plan.settles];
  const closed = all.filter((m) => m.operatorDecided && rowWasContested(rows, m.id)).length;
  const keptDoubt = all.filter((m) => m.contested).length;
  console.log(`\n  review doubts CLOSED by a container verdict: ${closed}`);
  console.log(`  doubts kept (fallback-decided, drain still owes a verdict): ${keptDoubt}`);
  console.log();

  console.log('UNTOUCHED — earlier passes\' work, deliberately preserved');
  const byTopic = new Map<string, number>();
  for (const u of plan.untouched) byTopic.set(u.topic, (byTopic.get(u.topic) ?? 0) + 1);
  for (const [t, n] of [...byTopic].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`);
  }
  console.log();

  console.log('TOP-LEVEL ROWS folded to the fallback (no container to inherit from)');
  for (const m of plan.moves.filter((x) => x.viaContainer === null && !slate.has(x.id))) {
    console.log(`  ${m.contested ? 'contested' : '         '}  ${m.title.slice(0, 62)}`);
  }
  console.log();

  if (!apply) {
    console.log('dry run — nothing written. Re-run with --apply.');
    return;
  }

  // ---- write -------------------------------------------------------------------
  let done = 0;
  for (const m of [...plan.moves, ...plan.settles]) {
    // `origin: review` — an operator judgement, not a classifier verdict (the T4c
    // precedent). `relevance` is deliberately NOT set: the row keeps whatever measured
    // purity it already carries for the target when a membership exists, and a freshly
    // created one takes the schema default. Writing a purity here would be recording the
    // circular k-NN reading this whole pass exists to route around.
    await setPrimaryTopic(m.id, m.to, { origin: 'review', contested: m.contested });
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  wrote ${done}/${all.length}`);
  }
  console.log(`\r  wrote ${done}/${all.length}  (${plan.moves.length} moved, ${plan.settles.length} settled)\n`);

  // ---- delete the vacated shelf's memberships ----------------------------------
  // ⚠️ DELETE, not retain — the opposite of T4b's rule, and the same call T4c made for
  // `differentiation`. T4b retains a vacated topic as an uncontested secondary because the
  // goal there is keeping a live shelf reachable through a split. Here the goal is to
  // RETIRE the slug, so retention would defeat the operation and leave a dead topic alive
  // in every membership-derived listing. One principle: retain when the vacated topic is
  // still a place, delete when it never was.
  const { count: dropped } = await prisma.resourceTopic.deleteMany({
    where: { topic: RETIRING, isPrimary: false },
  });
  console.log(`dropped ${dropped} vacated "${RETIRING}" memberships`);

  // ---- retire the vocabulary entry ---------------------------------------------
  // Repoints both the gate's phrasing→cfml alias and its self-alias onto `calculus`, so
  // the phrasing short-circuits at tier 2 to the parent topic next time it is requested.
  const repointed = await repointCanonical(RETIRING, FALLBACK);
  console.log(`repointed ${repointed} TopicAlias rows: ${RETIRING} -> ${FALLBACK}`);

  const leftover = await prisma.resourceTopic.count({ where: { topic: RETIRING } });
  const stillFiled = await prisma.resource.count({ where: { topic: RETIRING } });
  console.log(`\nresidue: ${stillFiled} resources, ${leftover} memberships still on "${RETIRING}"`);

  const inv = await checkMembershipInvariants();
  console.log('MEMBERSHIP INVARIANTS', inv);
  if (inv.noMembership || inv.badPrimaryCount || inv.mirrorDrift) {
    console.error('⚠️  invariant violation — investigate before proceeding');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
